import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { initAuth } from "../auth.js";
import { DEFAULT_CONFIG } from "../config.js";
import { createPipeline, writeLog } from "../logger.js";
import { createMemoryBridgeHandler } from "../memory/memory-bridge.js";
import { log } from "../report/log.js";
import { writeRequestLog } from "../requestLog.js";
import { handleSessionInit as handleClaudeSessionInit } from "../session/claude-code/init.js";
import {
  __resetSessionStoreForTests,
  getSessionStore,
  SessionStore,
} from "../session/store.js";
import {
  _resetSystemUsersForTest,
  initSystemUsers,
} from "../systemUser.js";
import { handleSystemUserPassthrough } from "../systemUserPassthrough.js";

const PRIVATE_VALUE = "private-active-diagnostics-value";
const PRIVATE_BODY_VALUE = "rawjsonx";
const PRIVATE_METHOD_VALUE = "rawmethodx";
const PRIVATE_REQUEST_ID = "reqpriv8";
const TEST_USER_KEY = "abc";
const TEST_USER_KEY_FINGERPRINT = "ba7816bf";

function containsPrivateValue(value: unknown): boolean {
  const needles = [
    PRIVATE_VALUE,
    PRIVATE_BODY_VALUE,
    PRIVATE_METHOD_VALUE,
    PRIVATE_REQUEST_ID,
    TEST_USER_KEY_FINGERPRINT,
  ];
  const seen = new Set<object>();

  const visit = (item: unknown): boolean => {
    if (typeof item === "string") {
      const normalized = item.toLowerCase();
      return needles.some((needle) => normalized.includes(needle.toLowerCase()));
    }
    if (item instanceof AggregateError) {
      return visit(item.message) || visit(item.stack) || visit(item.cause) || visit(item.errors);
    }
    if (item instanceof Error) {
      return visit(item.message) || visit(item.stack) || visit(item.cause);
    }
    if (!item || typeof item !== "object" || seen.has(item)) return false;
    seen.add(item);
    return Object.entries(item).some(([key, nested]) => visit(key) || visit(nested));
  };

  return visit(value);
}

beforeEach(() => {
  __resetSessionStoreForTests();
});

afterEach(() => {
  initAuth(DEFAULT_CONFIG.auth);
  __resetSessionStoreForTests();
  _resetSystemUsersForTest();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("active diagnostics privacy", () => {
  it("detects private values nested in error causes", () => {
    const nested = new Error("safe", { cause: PRIVATE_VALUE });
    expect(containsPrivateValue(new AggregateError([nested], "safe"))).toBe(true);
  });

  it("keeps private pipeline fields out of stderr and structured logs", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const debug = vi.spyOn(log, "debug").mockImplementation(() => {});
    const error = vi.spyOn(log, "error").mockImplementation(() => {});
    const config = structuredClone(DEFAULT_CONFIG);
    const pipe = createPipeline(config, PRIVATE_REQUEST_ID, PRIVATE_VALUE);

    pipe.requestReceived(1, false);
    pipe.forwardStart(`https://upstream.invalid/${PRIVATE_VALUE}`);
    pipe.streamDone({
      input_tokens: 1,
      [PRIVATE_VALUE]: PRIVATE_VALUE,
    });
    pipe.info(PRIVATE_VALUE, PRIVATE_VALUE);
    pipe.error(PRIVATE_VALUE, new Error(PRIVATE_VALUE));
    pipe.summary();

    expect.soft(containsPrivateValue(stderr.mock.calls)).toBe(false);
    expect.soft(containsPrivateValue([...debug.mock.calls, ...error.mock.calls])).toBe(false);
    expect(JSON.stringify(stderr.mock.calls)).toContain("msgs=1");
    expect(JSON.stringify(stderr.mock.calls)).toContain("input_tokens");
    expect(JSON.stringify(stderr.mock.calls)).toContain("OTHER");
  });

  it("keeps JSONL write failures free of paths and raw errors", async () => {
    const error = vi.spyOn(log, "error").mockImplementation(() => {});
    const config = structuredClone(DEFAULT_CONFIG);
    config.log.file = `/dev/null/${PRIVATE_VALUE}`;
    config.clickhouse.enabled = false;

    writeLog(config, {
      timestamp: new Date().toISOString(),
      event: "request",
      modelId: PRIVATE_VALUE,
      keyId: PRIVATE_VALUE,
      upstreamUrl: PRIVATE_VALUE,
      stream: false,
    });

    await vi.waitFor(() => expect(error).toHaveBeenCalled());
    expect(containsPrivateValue(error.mock.calls)).toBe(false);
    expect(error).toHaveBeenCalledWith("usage_log.write_failed", { backend: "jsonl" });
  });

  it("keeps memory-bridge identity, key fingerprint, and errors out of console", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const config = structuredClone(DEFAULT_CONFIG);
    config.auth = {
      enabled: true,
      url: "https://auth.invalid",
      timeoutMs: 100,
    };
    initAuth(config.auth);

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      code: 0,
      data: { valid: true, user: { user_id: "user-1" } },
    })));

    const store = getSessionStore();
    vi.spyOn(store, "get").mockReturnValue(undefined);
    vi.spyOn(store, "getOrRecover").mockResolvedValue({
      status: "initialized",
      keyId: PRIVATE_VALUE,
      startedAt: 0,
      attemptCount: 0,
      userId: "user-1",
      sessionInfo: {
        session_id: PRIVATE_VALUE,
        team_id: "team-1",
        agent_id: "agent-1",
        user_id: "user-1",
        space_id: PRIVATE_VALUE,
      },
    });

    const rejectingFetcher: typeof fetch = async () => {
      throw new Error(PRIVATE_VALUE);
    };
    const handler = createMemoryBridgeHandler(config, { fetcher: rejectingFetcher });
    const app = new Hono();
    app.post("/memory-bridge/*", (c) => handler(c));

    const response = await app.request(
      "http://proxy/memory-bridge/v3/scenario/read",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${TEST_USER_KEY}`,
          "content-type": "application/json",
          "x-conversation-id": PRIVATE_VALUE,
          "x-tdai-service-id": PRIVATE_VALUE,
        },
        body: "{}",
      },
    );

    expect(response.status).toBe(502);
    expect(containsPrivateValue([
      ...consoleLog.mock.calls,
      ...consoleWarn.mock.calls,
      ...consoleError.mock.calls,
    ])).toBe(false);
  });

  it("returns fixed memory-bridge rejection envelopes and diagnostics", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = structuredClone(DEFAULT_CONFIG);
    const store = getSessionStore();
    await store.set("ses_safe", {
      status: "initialized",
      keyId: "key-safe",
      startedAt: 0,
      attemptCount: 0,
      userId: "user-safe",
      sessionInfo: {
        session_id: "session-safe",
        team_id: "team-safe",
        agent_id: "agent-safe",
        user_id: "user-safe",
        space_id: "space-safe",
      },
    });
    const handler = createMemoryBridgeHandler(config);
    const app = new Hono();
    app.all("/memory-bridge/*", (c) => handler(c));

    const unknownPath = await app.request(
      `http://proxy/memory-bridge/${PRIVATE_VALUE}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    const forbiddenSubpath = await app.request(
      `http://proxy/memory-bridge/v3/${PRIVATE_VALUE}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    const invalidJson = await app.request(
      "http://proxy/memory-bridge/v3/scenario/read",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-session-id": "ses_safe" },
        body: PRIVATE_BODY_VALUE,
      },
    );
    const invalidMethod = await app.request(
      "http://proxy/memory-bridge/v3/scenario/read",
      {
        method: PRIVATE_METHOD_VALUE,
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    const responseBodies = await Promise.all([
      unknownPath.json(),
      forbiddenSubpath.json(),
      invalidJson.json(),
      invalidMethod.json(),
    ]);

    expect([
      unknownPath.status,
      forbiddenSubpath.status,
      invalidJson.status,
      invalidMethod.status,
    ]).toEqual([404, 403, 400, 405]);
    expect(containsPrivateValue(responseBodies)).toBe(false);
    expect(containsPrivateValue(consoleWarn.mock.calls)).toBe(false);
    expect(responseBodies.map(({ code, message }) => ({ code, message }))).toEqual([
      { code: 40401, message: "[memory-bridge] unknown path" },
      { code: 40301, message: "[memory-bridge] subpath not allowed via bridge" },
      { code: 40001, message: "[memory-bridge] invalid JSON body" },
      { code: 40501, message: "Method not allowed" },
    ]);
    expect(consoleWarn.mock.calls.map(([event]) => event)).toEqual([
      "[memory-bridge] request rejected reason=unknown_path",
      "[memory-bridge] request rejected reason=subpath_not_allowed",
      "[memory-bridge] request rejected reason=invalid_json",
      "[memory-bridge] request rejected reason=method_not_allowed",
    ]);
  });

  it("keeps request debug metadata free of the raw model", () => {
    const debug = vi.spyOn(log, "debug").mockImplementation(() => {});
    const config = structuredClone(DEFAULT_CONFIG);
    config.log.level = "debug";

    writeRequestLog(config, {
      model: PRIVATE_VALUE,
      messages: [{ role: "user", content: PRIVATE_VALUE }],
      stream: false,
    });

    expect(containsPrivateValue(debug.mock.calls)).toBe(false);
  });

  it("keeps system-user registry identities out of structured logs", () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => {});
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});

    initSystemUsers([
      { name: PRIVATE_VALUE, userId: PRIVATE_VALUE, displayName: PRIVATE_VALUE },
      { name: PRIVATE_VALUE, userId: PRIVATE_VALUE, displayName: PRIVATE_VALUE },
    ]);

    expect(containsPrivateValue([...info.mock.calls, ...warn.mock.calls])).toBe(false);
  });

  it("keeps system-user passthrough identity, route, model, and errors out of logs", async () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => {});
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const error = vi.spyOn(log, "error").mockImplementation(() => {});
    const config = structuredClone(DEFAULT_CONFIG);
    config.upstream.url = `https://upstream.invalid/${PRIVATE_VALUE}`;
    config.upstream.apiKey = "server-key";
    config.rateLimit = { tpm: 0, qpm: 0 };
    config.creditReport.url = "";
    config.log.file = "";
    config.clickhouse.enabled = false;
    config.opik.enabled = false;
    config.langfuse.enabled = false;
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error(PRIVATE_VALUE);
    }));

    const app = new Hono();
    app.post("*", (c) => handleSystemUserPassthrough(c, config, {
      name: PRIVATE_VALUE,
      userId: PRIVATE_VALUE,
      displayName: PRIVATE_VALUE,
    }, { model: PRIVATE_VALUE, messages: [] }));
    const response = await app.request(`http://proxy/claude-code/${PRIVATE_VALUE}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "memory-user-key",
        "x-session-id": "ses_safe",
      },
      body: JSON.stringify({ model: PRIVATE_VALUE, messages: [] }),
    });

    expect(response.status).toBe(502);
    const responseBody = await response.json();
    expect(containsPrivateValue(responseBody)).toBe(false);
    expect(responseBody).toEqual({
      error: "Upstream request failed",
      detail: "upstream_transport_error",
    });
    expect(containsPrivateValue([
      ...info.mock.calls,
      ...warn.mock.calls,
      ...error.mock.calls,
    ])).toBe(false);
    expect(error).toHaveBeenCalledWith("systemUser.forward_failed", {
      systemUser: true,
      timeout: false,
      category: "transport_error",
    });
  });

  it("keeps Claude session identity and prompt text out of console", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = new SessionStore();
    await store.set(`claude-code:${PRIVATE_VALUE}`, {
      status: "pending_asset_confirm",
      keyId: PRIVATE_VALUE,
      startedAt: 0,
      attemptCount: 0,
      userId: PRIVATE_VALUE,
      cachedTeams: [],
    });

    await handleClaudeSessionInit(
      PRIVATE_VALUE,
      PRIVATE_VALUE,
      [{ role: "user", content: PRIVATE_VALUE }],
      structuredClone(DEFAULT_CONFIG.sessionInit),
      store,
      { stream: false, modelId: PRIVATE_VALUE, protocol: "anthropic" },
    );

    expect(containsPrivateValue([
      ...consoleLog.mock.calls,
      ...consoleWarn.mock.calls,
      ...consoleError.mock.calls,
    ])).toBe(false);
  });

});
