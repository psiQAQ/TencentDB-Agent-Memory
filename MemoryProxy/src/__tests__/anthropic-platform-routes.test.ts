import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveAgentAdapter } from "../agent-adapters/index.js";
import { handleAnthropicMessages } from "../anthropicHandler.js";
import { initAuth } from "../auth.js";
import { DEFAULT_CONFIG } from "../config.js";
import { createApp } from "../server.js";
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

  beforeEach(() => {
    calls = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push(url);
      if (url.endsWith("/v3/meta/auth/verify")) {
        return new Response(JSON.stringify({
          code: 0,
          data: { valid: true, user: { user_id: "user-1" } },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
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
