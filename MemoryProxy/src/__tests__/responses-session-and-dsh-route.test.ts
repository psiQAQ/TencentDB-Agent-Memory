import { afterEach, describe, expect, it, vi } from "vitest";

import { initAuth } from "../auth.js";
import { extractCodexSessionId } from "../codexHandler.js";
import { DEFAULT_CONFIG } from "../config.js";
import { createApp } from "../server.js";
import { extractWorkbuddySessionId } from "../workbuddyHandler.js";

afterEach(() => {
  initAuth(DEFAULT_CONFIG.auth);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Responses session binding and DSH legacy route", () => {
  it("prefers the explicit Codex conversation binding over the SDK session", () => {
    expect(extractCodexSessionId(
      { "x-conversation-id": "explicit-session", "session-id": "sdk-session" },
      { client_metadata: { session_id: "body-session" } },
    )).toBe("explicit-session");
  });

  it("prefers the explicit WorkBuddy conversation binding over the SDK session", () => {
    expect(extractWorkbuddySessionId(
      { "x-conversation-id": "explicit-session", "session-id": "sdk-session" },
      { client_metadata: { session_id: "body-session" } },
    )).toBe("explicit-session");
  });

  it("normalizes the documented DSH bare route to the OpenAI upstream endpoint", async () => {
    const calls: Array<{ url: string; headers: Headers; redirect?: RequestRedirect }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers), redirect: init?.redirect });
      return Response.json({
        id: "chatcmpl-safe",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }));
    const config = structuredClone(DEFAULT_CONFIG);
    config.upstream.url = "https://upstream.invalid/v1";
    config.upstream.apiKey = "server-key";
    config.upstream.agents.dsh = { url: "https://upstream.invalid/v1" };
    config.sessionInit.enabled = false;
    config.injection.enabled = false;
    config.extraction = { enabled: false, extractors: [] };
    config.creditReport.url = "";
    config.log.backend = "noop";

    const response = await createApp(config).request(
      "http://proxy/dsh/space-1/chat/completions",
      {
        method: "POST",
        headers: {
          authorization: "Bearer client-key",
          "content-type": "application/json",
          "x-conversation-id": "session-1",
        },
        body: JSON.stringify({
          model: "test-model",
          stream: false,
          messages: [{ role: "user", content: "hello" }],
        }),
      },
    );

    expect(response.status).toBe(200);
    const upstreamCalls = calls.filter(
      (call) => call.url === "https://upstream.invalid/v1/chat/completions",
    );
    expect(upstreamCalls).toHaveLength(1);
    expect(upstreamCalls[0]?.headers.get("authorization")).toBe("Bearer server-key");
    expect(upstreamCalls[0]?.headers.get("x-conversation-id")).toBeNull();
    expect(upstreamCalls[0]?.redirect).toBe("manual");
  });
});
