import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveAgentAdapter } from "../agent-adapters/index.js";
import { handleAnthropicMessages } from "../anthropicHandler.js";
import { initAuth } from "../auth.js";
import { DEFAULT_CONFIG } from "../config.js";
import { createApp } from "../server.js";
import { _resetSystemUsersForTest, initSystemUsers } from "../systemUser.js";
import type { ProxyConfig } from "../types.js";

const SOURCES = ["claude-code", "opencode", "pi"] as const;

function configWithAuth(): ProxyConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.auth = {
    enabled: true,
    url: "https://memory-core.invalid",
    timeoutMs: 1_000,
  };
  config.upstream.url = "https://global-upstream.invalid/anthropic/v1";
  config.upstream.agents = Object.fromEntries(
    SOURCES.map((source) => [
      source,
      { url: `https://${source}.upstream.invalid/anthropic/v1`, apiKey: "server-key" },
    ]),
  );
  config.rateLimit = { tpm: 0, qpm: 0 };
  config.extraction = { enabled: false, extractors: [] };
  config.log.backend = "noop";
  return config;
}

function messagesRequest(sessionId?: string): RequestInit {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-api-key": "memory-user-key",
  };
  if (sessionId !== undefined) headers["x-session-id"] = sessionId;
  return {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "test-model",
      max_tokens: 32,
      messages: [{ role: "user", content: "hello" }],
    }),
  };
}

describe("native Anthropic platform routes", () => {
  let calls: string[];
  let upstreamHeaders: Headers[];

  beforeEach(() => {
    calls = [];
    upstreamHeaders = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push(url);
      if (url.endsWith("/v3/meta/auth/verify")) {
        return new Response(JSON.stringify({
          code: 0,
          data: { valid: true, user: { user_id: "user-1" } },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      upstreamHeaders.push(new Headers(init?.headers));
      return new Response(JSON.stringify({
        id: "msg-test",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        model: "test-model",
        stop_reason: "end_turn",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
  });

  afterEach(() => {
    initAuth(DEFAULT_CONFIG.auth);
    _resetSystemUsersForTest();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    ["claude-code", "550e8400-e29b-41d4-a716-446655440000"],
    ["opencode", "ses_open_code"],
    ["pi", "urn:uuid:a:b"],
  ] as const)("binds /%s/<space>/v1/messages to its real source", async (source, sessionId) => {
    const config = configWithAuth();
    initAuth(config.auth);
    const app = createApp(config);

    const response = await app.request(
      `http://proxy/${source}/space-1/v1/messages`,
      messagesRequest(sessionId),
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual([
      "https://memory-core.invalid/v3/meta/auth/verify",
      `https://${source}.upstream.invalid/anthropic/v1/messages`,
    ]);
    expect(resolveAgentAdapter(source).agentKind).toBe(source);
  });

  it.each(SOURCES)("does not forward private headers on the %s main route", async (source) => {
    const config = configWithAuth();
    initAuth(config.auth);
    const app = createApp(config);

    const response = await app.request(`http://proxy/${source}/space-1/v1/messages`, {
      ...messagesRequest("private-session-value"),
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "safe-feature",
        authorization: "Bearer private-caller-credential",
        "x-api-key": "private-memory-credential",
        "x-team-id": "private-team-value",
        "x-agent-id": "private-agent-value",
        "x-task-id": "private-task-value",
        "x-conversation-id": "private-conversation-value",
        "x-session-id": "private-session-value",
        "x-claude-code-session-id": "private-claude-session-value",
        "x-vertex-ai-session-id": "private-vertex-session-value",
        "x-tdai-service-id": "private-service-value",
        "x-tdai-user-key": "private-user-key-value",
        "x-tdai-user-id": "private-user-value",
        "x-tdai-extra": "private-extra-value",
      },
    });

    const headers = upstreamHeaders[0];
    const forbiddenNames = [
      "authorization",
      "x-team-id",
      "x-agent-id",
      "x-task-id",
      "x-conversation-id",
      "x-session-id",
      "x-claude-code-session-id",
      "x-vertex-ai-session-id",
      "x-tdai-service-id",
      "x-tdai-user-key",
      "x-tdai-user-id",
      "x-tdai-extra",
    ];
    const hasPrivateHeader = forbiddenNames.some((name) => headers?.has(name));
    const hasPrivateValue = [...(headers?.values() ?? [])]
      .some((value) => value.startsWith("private-"));

    expect(response.status).toBe(200);
    expect(hasPrivateHeader).toBe(false);
    expect(hasPrivateValue).toBe(false);
    expect(headers?.get("x-api-key")).toBe("server-key");
    expect(headers?.get("anthropic-version")).toBe("2023-06-01");
    expect(headers?.get("anthropic-beta")).toBe("safe-feature");
    expect(headers?.get("accept")).toBe("application/json");
  });

  it("falls back to the global server key for a URL-only agent override", async () => {
    const config = configWithAuth();
    config.upstream.apiKey = "global-server-key";
    config.upstream.agents.opencode = { url: "https://opencode.upstream.invalid/anthropic/v1" };
    initAuth(config.auth);
    const app = createApp(config);

    const response = await app.request(
      "http://proxy/opencode/space-1/v1/messages",
      messagesRequest("ses_global_fallback"),
    );

    expect(response.status).toBe(200);
    expect(upstreamHeaders).toHaveLength(1);
    expect(upstreamHeaders[0]?.get("x-api-key")).toBe("global-server-key");
  });

  it("rejects before upstream fetch when no server key is configured", async () => {
    const config = configWithAuth();
    config.upstream.apiKey = "";
    config.upstream.agents.pi = { url: "https://pi.upstream.invalid/anthropic/v1" };
    initAuth(config.auth);
    const app = createApp(config);

    const response = await app.request(
      "http://proxy/pi/space-1/v1/messages",
      messagesRequest("ses_missing_server_key"),
    );

    expect(response.status).toBe(503);
    expect(calls).toEqual(["https://memory-core.invalid/v3/meta/auth/verify"]);
    expect(upstreamHeaders).toHaveLength(0);
  });

  it("replaces a system user's caller credential with the global server key", async () => {
    const config = configWithAuth();
    config.upstream.apiKey = "global-system-key";
    initAuth(config.auth);
    initSystemUsers([{ name: "memory", userId: "user-1", displayName: "Memory" }]);
    const app = createApp(config);

    const response = await app.request("http://proxy/claude-code/space-1/v1/messages", {
      ...messagesRequest("system_user_session"),
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        authorization: "Bearer private-system-caller",
        "x-api-key": "private-system-memory-key",
        "x-session-id": "system_user_session",
        "x-team-id": "private-system-team",
      },
    });

    const headers = upstreamHeaders[0];
    const hasPrivateValue = [...(headers?.values() ?? [])]
      .some((value) => value.startsWith("private-"));
    expect(response.status).toBe(200);
    expect(upstreamHeaders).toHaveLength(1);
    expect(hasPrivateValue).toBe(false);
    expect(headers?.get("x-api-key")).toBe("global-system-key");
    expect(headers?.has("authorization")).toBe(false);
    expect(headers?.has("x-team-id")).toBe(false);
  });

  it.each([
    ["stream", { stream: true }],
    ["tool", { tools: [{ name: "safe-tool", description: "safe description" }] }],
  ])("uses the same safe header builder for a %s request", async (_label, extraBody) => {
    const config = configWithAuth();
    initAuth(config.auth);
    const app = createApp(config);
    const base = JSON.parse(String(messagesRequest("ses_variant").body)) as Record<string, unknown>;

    const response = await app.request("http://proxy/claude-code/space-1/v1/messages", {
      ...messagesRequest("ses_variant"),
      body: JSON.stringify({ ...base, ...extraBody }),
    });

    const headers = upstreamHeaders[0];
    expect(response.status).toBe(200);
    expect(headers?.get("x-api-key")).toBe("server-key");
    expect(headers?.has("x-session-id")).toBe(false);
  });

  it("uses the same safe header builder when upstream returns an error", async () => {
    const config = configWithAuth();
    initAuth(config.auth);
    const app = createApp(config);
    vi.mocked(fetch).mockImplementationOnce(async () => Response.json({
      code: 0,
      data: { valid: true, user: { user_id: "user-1" } },
    })).mockImplementationOnce(async (_input, init) => {
      upstreamHeaders.push(new Headers(init?.headers));
      return Response.json({ type: "error" }, { status: 401 });
    });

    const response = await app.request(
      "http://proxy/claude-code/space-1/v1/messages",
      messagesRequest("ses_error"),
    );

    expect(response.status).toBe(401);
    expect(upstreamHeaders[0]?.get("x-api-key")).toBe("server-key");
    expect(upstreamHeaders[0]?.has("x-session-id")).toBe(false);
  });

  it("rejects an unknown Anthropic-style prefix before auth or upstream", async () => {
    const config = configWithAuth();
    initAuth(config.auth);
    const app = createApp(config);

    const response = await app.request(
      "http://proxy/cursor/space-1/v1/messages",
      messagesRequest("session-1"),
    );

    expect(response.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("rejects a valid-looking but unbound source before side effects", async () => {
    const config = configWithAuth();
    initAuth(config.auth);
    const app = new Hono();
    app.post("/opencode/:spaceId/v1/messages", (c) => handleAnthropicMessages(c, config));

    const response = await app.request(
      "http://proxy/opencode/space-1/v1/messages",
      messagesRequest("session-1"),
    );

    expect(response.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("rejects a path/source conflict before side effects", async () => {
    const config = configWithAuth();
    initAuth(config.auth);
    const app = new Hono();
    app.post("/opencode/:spaceId/v1/messages", (c) =>
      handleAnthropicMessages(c, config, "pi"),
    );

    const response = await app.request(
      "http://proxy/opencode/space-1/v1/messages",
      messagesRequest("session-1"),
    );

    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("rejects a missing session before auth, body parsing, or upstream", async () => {
    const config = configWithAuth();
    initAuth(config.auth);
    const app = createApp(config);

    const response = await app.request(
      "http://proxy/claude-code/space-1/v1/messages",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "memory-user-key",
        },
        body: "{not-json",
      },
    );

    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it.each([
    ["blank", " "],
    ["space", "bad session"],
    ["slash", "bad/session"],
    ["traversal", "bad..session"],
    ["C0 control", "bad\u0001session"],
    ["DEL control", "bad\u007fsession"],
    ["too long", "s".repeat(257)],
  ])("rejects an invalid session (%s) before side effects", async (_label, sessionId) => {
    const config = configWithAuth();
    initAuth(config.auth);
    const app = createApp(config);

    const response = await app.request(
      "http://proxy/pi/space-1/v1/messages",
      messagesRequest(sessionId),
    );

    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("does not log a rejected raw session value", async () => {
    const rawSession = "private..session";
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = configWithAuth();
    initAuth(config.auth);
    const app = createApp(config);

    const response = await app.request(
      "http://proxy/opencode/space-1/v1/messages",
      messagesRequest(rawSession),
    );

    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
    const output = [...log.mock.calls, ...error.mock.calls, ...warn.mock.calls]
      .flat()
      .map(String)
      .join("\n");
    expect(output).not.toContain(rawSession);
  });

  it("does not log an accepted raw session value", async () => {
    const rawSession = "ses_private_value";
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = configWithAuth();
    initAuth(config.auth);
    const app = createApp(config);

    const response = await app.request(
      "http://proxy/opencode/space-1/v1/messages",
      messagesRequest(rawSession),
    );

    expect(response.status).toBe(200);
    const output = [...log.mock.calls, ...error.mock.calls, ...warn.mock.calls]
      .flat()
      .map(String)
      .join("\n");
    expect(output).not.toContain(rawSession);
  });

  it("keeps the known OpenAI CodeBuddy route working", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = configWithAuth();
    initAuth(config.auth);
    config.upstream.agents.codebuddy = {
      url: "https://codebuddy.upstream.invalid/openai/v1",
      apiKey: "server-key",
    };
    const app = createApp(config);

    const response = await app.request("http://proxy/codebuddy/space-1/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer memory-user-key",
        "x-session-id": "session-1",
      },
      body: JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(response.status).toBe(200);
    expect(calls).toEqual([
      "https://memory-core.invalid/v3/meta/auth/verify",
      "https://codebuddy.upstream.invalid/openai/v1/chat/completions",
    ]);
    const output = [...log.mock.calls, ...error.mock.calls, ...warn.mock.calls]
      .flat()
      .map(String)
      .join("\n");
    expect(output).not.toContain("session-1");
    expect(output).not.toContain("user-1");
  });
});
