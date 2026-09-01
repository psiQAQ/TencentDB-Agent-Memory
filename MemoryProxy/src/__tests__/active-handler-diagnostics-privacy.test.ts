import { afterEach, describe, expect, it, vi } from "vitest";

import { initAuth } from "../auth.js";
import { DEFAULT_CONFIG } from "../config.js";
import { createApp } from "../server.js";
import { __resetSessionStoreForTests, getSessionStore } from "../session/store.js";

const PRIVATE_VALUE = "private-active-handler-value";

function containsPrivateValue(value: unknown): boolean {
  const seen = new Set<object>();

  const visit = (item: unknown): boolean => {
    if (typeof item === "string") return item.includes(PRIVATE_VALUE);
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

afterEach(() => {
  initAuth(DEFAULT_CONFIG.auth);
  __resetSessionStoreForTests();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("active handler diagnostics privacy", () => {
  it("detects private values nested in error causes", () => {
    const nested = new Error("safe", { cause: PRIVATE_VALUE });
    expect(containsPrivateValue(new AggregateError([nested], "safe"))).toBe(true);
  });

  it.each([
    ["claude-code", false],
    ["opencode", true],
  ])("keeps %s mem-command diagnostics private", async (agentSource, stream) => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const config = structuredClone(DEFAULT_CONFIG);
    config.memCommand = { enabled: true, allowedCommands: [] };
    config.sessionInit.enabled = false;
    config.injection.enabled = false;
    config.extraction = { enabled: false, extractors: [] };
    config.creditReport.url = "";
    config.log.backend = "noop";
    initAuth(config.auth);
    const app = createApp(config);

    const response = await app.request(`http://proxy/${agentSource}/space-1/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "memory-user-key",
        "x-session-id": "ses_safe",
      },
      body: JSON.stringify({
        model: "test-model",
        max_tokens: 16,
        stream,
        messages: [{
          role: "user",
          content: [{ type: "text", text: `mem:${PRIVATE_VALUE}\nunknown` }],
        }],
      }),
    });

    expect(response.status).toBe(200);
    expect(containsPrivateValue(consoleLog.mock.calls)).toBe(false);
    expect(consoleLog).toHaveBeenCalledWith(
      "[mem-command] blocked session=<redacted> reason=session_not_initialized",
    );
  });

  it("keeps a completed Claude mem-command diagnostic private", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ code: 0, data: { items: [] } })));
    const store = getSessionStore();
    vi.spyOn(store, "getOrRecover").mockResolvedValue({
      status: "initialized",
      keyId: "key-safe",
      startedAt: 0,
      attemptCount: 0,
      userId: "user-safe",
      sessionInfo: {
        session_id: "ses_safe",
        team_id: "team-safe",
        agent_id: "agent-safe",
        user_id: "user-safe",
        space_id: "space-1",
      },
    });
    const config = structuredClone(DEFAULT_CONFIG);
    config.memCommand = { enabled: true, allowedCommands: [] };
    config.sessionInit.enabled = true;
    config.injection.enabled = false;
    config.extraction = { enabled: false, extractors: [] };
    config.creditReport.url = "";
    config.log.backend = "noop";
    initAuth(config.auth);
    const app = createApp(config);

    const response = await app.request("http://proxy/claude-code/space-1/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "memory-user-key",
        "x-session-id": "ses_safe",
      },
      body: JSON.stringify({
        model: "test-model",
        max_tokens: 16,
        messages: [{
          role: "user",
          content: [{ type: "text", text: `mem:${PRIVATE_VALUE}\nunknown` }],
        }],
      }),
    });

    expect(response.status).toBe(200);
    expect(containsPrivateValue(consoleLog.mock.calls)).toBe(false);
    expect(consoleLog).toHaveBeenCalledWith(
      "[mem-command] completed session=<redacted> success=false",
    );
  });

  it("keeps OpenAI request-tail diagnostics and outbound summaries private", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("PROXY_DEBUG_DUMP_OUTBOUND_MD5", "1");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      id: "chatcmpl-safe",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })));
    const config = structuredClone(DEFAULT_CONFIG);
    config.upstream.url = "https://upstream.invalid/v1";
    config.upstream.apiKey = "server-key";
    config.sessionInit.enabled = true;
    config.injection.enabled = false;
    config.rateLimit = { tpm: 0, qpm: 0 };
    config.extraction = { enabled: false, extractors: [] };
    config.creditReport.url = "";
    config.log.backend = "noop";
    initAuth(config.auth);
    const app = createApp(config);

    const response = await app.request("http://proxy/codebuddy/space-1/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer memory-user-key" },
      body: JSON.stringify({
        model: "test-model",
        messages: [
          { role: "system", content: PRIVATE_VALUE },
          { role: "assistant", content: "ok" },
          { role: "user", content: PRIVATE_VALUE, tool_call_id: PRIVATE_VALUE },
        ],
      }),
    });
    const calls = [...consoleLog.mock.calls, ...consoleWarn.mock.calls, ...consoleError.mock.calls];

    expect(response.status).toBe(200);
    expect.soft(containsPrivateValue(calls)).toBe(false);
    expect(JSON.stringify(calls).includes("Md5=")).toBe(false);
  });

  it("keeps Anthropic source/config diagnostics and outbound summaries private", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("PROXY_DEBUG_DUMP_OUTBOUND_MD5", "1");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      id: "msg-safe",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      model: "test-model",
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    })));
    const config = structuredClone(DEFAULT_CONFIG);
    config.upstream.url = "https://upstream.invalid/anthropic/v1";
    config.upstream.apiKey = "server-key";
    config.upstream.agents.opencode = {
      url: "https://upstream.invalid/anthropic/v1",
      apiKey: "server-key",
    };
    config.sessionInit.enabled = false;
    config.injection.enabled = false;
    config.injection.injectors = [PRIVATE_VALUE as never];
    config.rateLimit = { tpm: 0, qpm: 0 };
    config.extraction = { enabled: false, extractors: [] };
    config.creditReport.url = "";
    config.log.backend = "noop";
    initAuth(config.auth);
    const app = createApp(config);

    const response = await app.request(`http://proxy/opencode/${PRIVATE_VALUE}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "memory-user-key",
        "x-session-id": "ses_safe",
      },
      body: JSON.stringify({
        model: "test-model",
        max_tokens: 16,
        system: PRIVATE_VALUE,
        messages: [{ role: "user", content: PRIVATE_VALUE }],
      }),
    });
    const calls = [...consoleLog.mock.calls, ...consoleWarn.mock.calls, ...consoleError.mock.calls];

    expect(response.status).toBe(200);
    expect.soft(containsPrivateValue(calls)).toBe(false);
    expect(JSON.stringify(calls).includes("Md5=")).toBe(false);
  });
});
