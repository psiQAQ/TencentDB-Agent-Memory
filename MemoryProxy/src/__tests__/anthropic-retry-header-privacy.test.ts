import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../guard-adapter.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../guard-adapter.js")>();
  return {
    ...original,
    resolveForwardTarget: vi.fn(async () => ({
      url: "https://primary.invalid/messages",
      model: "primary-model",
      authHeaders: { "x-api-key": "server-primary-key" },
      bodyOverrides: null,
      retryTarget: {
        url: "https://retry.invalid/messages",
        model: "retry-model",
        authHeaders: { "x-api-key": "server-retry-key" },
      },
      turnSeq: 0,
    })),
  };
});

import { initAuth } from "../auth.js";
import { DEFAULT_CONFIG } from "../config.js";
import { createApp } from "../server.js";

describe("Anthropic retry header privacy", () => {
  let upstreamHeaders: Headers[];
  let upstreamUrls: string[];

  beforeEach(() => {
    upstreamHeaders = [];
    upstreamUrls = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/v3/meta/auth/verify")) {
        return Response.json({ code: 0, data: { valid: true, user: { user_id: "user-1" } } });
      }
      upstreamUrls.push(url);
      upstreamHeaders.push(new Headers(init?.headers));
      return Response.json(
        { id: "msg-test", type: "message", role: "assistant", content: [], model: "test" },
        { status: upstreamHeaders.length === 1 ? 401 : 200 },
      );
    }));
  });

  afterEach(() => {
    initAuth(DEFAULT_CONFIG.auth);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("rebuilds retry authentication without caller or identity headers", async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.auth = { enabled: true, url: "https://auth.invalid", timeoutMs: 1_000 };
    config.rateLimit = { tpm: 0, qpm: 0 };
    config.extraction = { enabled: false, extractors: [] };
    config.log.backend = "noop";
    initAuth(config.auth);
    const app = createApp(config);

    const response = await app.request("http://proxy/claude-code/space-1/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "safe-feature",
        authorization: "Bearer private-caller-credential",
        "x-api-key": "private-memory-credential",
        "x-session-id": "private-session-value",
        "x-team-id": "private-team-value",
        "x-agent-id": "private-agent-value",
        "x-task-id": "private-task-value",
        "x-tdai-service-id": "private-service-value",
      },
      body: JSON.stringify({
        model: "test-model",
        max_tokens: 32,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    const retryHeaders = upstreamHeaders[1];
    const forbiddenNames = [
      "authorization",
      "x-session-id",
      "x-team-id",
      "x-agent-id",
      "x-task-id",
      "x-tdai-service-id",
      "x-vertex-ai-session-id",
    ];
    const hasPrivateHeader = forbiddenNames.some((name) => retryHeaders?.has(name));
    const hasPrivateValue = [...(retryHeaders?.values() ?? [])]
      .some((value) => value.startsWith("private-"));

    expect(response.status).toBe(200);
    expect(upstreamHeaders).toHaveLength(2);
    expect(upstreamUrls).toEqual([
      "https://primary.invalid/messages",
      "https://retry.invalid/messages",
    ]);
    expect(upstreamHeaders[0]?.get("x-api-key")).toBe("server-primary-key");
    expect(hasPrivateHeader).toBe(false);
    expect(hasPrivateValue).toBe(false);
    expect(retryHeaders?.get("x-api-key")).toBe("server-retry-key");
    expect(retryHeaders?.get("anthropic-version")).toBe("2023-06-01");
    expect(retryHeaders?.get("anthropic-beta")).toBe("safe-feature");
    expect(retryHeaders?.get("accept")).toBe("application/json");
  });
});
