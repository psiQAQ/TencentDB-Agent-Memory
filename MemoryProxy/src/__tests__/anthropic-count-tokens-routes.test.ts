import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AnthropicMessageSource } from "../agent-adapters/anthropic-platform.js";
import { handleAuxiliaryEndpoint } from "../auxiliaryHandler.js";
import { initAuth } from "../auth.js";
import { DEFAULT_CONFIG } from "../config.js";
import { createApp } from "../server.js";
import type { ProxyConfig } from "../types.js";

const SOURCES = ["claude-code", "opencode", "pi"] as const;

function configWithAuth(): ProxyConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.auth = { enabled: true, url: "https://auth.invalid", timeoutMs: 1_000 };
  config.upstream.url = "https://global.invalid/anthropic/v1";
  config.upstream.apiKey = "global-key";
  config.upstream.agents = Object.fromEntries(SOURCES.map((source) => [
    source,
    { url: `https://${source}.upstream.invalid/anthropic/v1`, apiKey: `${source}-key` },
  ]));
  config.creditReport.url = "https://credit.invalid/report";
  config.log.backend = "noop";
  return config;
}

function request(body = JSON.stringify({ model: "test-model", messages: [] })): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "memory-user-key" },
    body,
  };
}

describe("route-bound Anthropic count_tokens", () => {
  let calls: Array<{ url: string; headers: Headers }>;

  beforeEach(() => {
    calls = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      calls.push({ url, headers });
      if (url.endsWith("/v3/meta/auth/verify")) {
        return Response.json({ code: 0, data: { valid: true, user: { user_id: "user-1" } } });
      }
      if (url === "https://credit.invalid/report") return Response.json({ code: 0 });
      return Response.json({ input_tokens: 7 });
    }));
  });

  afterEach(() => {
    initAuth(DEFAULT_CONFIG.auth);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(SOURCES)("uses the %s upstream URL and key", async (source) => {
    const config = configWithAuth();
    initAuth(config.auth);
    const app = createApp(config);

    const response = await app.request(
      `http://proxy/${source}/space-1/v1/messages/count_tokens`,
      request(),
    );

    expect(response.status).toBe(200);
    expect(calls.map((call) => call.url)).toEqual([
      "https://auth.invalid/v3/meta/auth/verify",
      `https://${source}.upstream.invalid/anthropic/v1/messages/count_tokens`,
      "https://credit.invalid/report",
    ]);
    expect(calls[1].headers.get("x-api-key")).toBe(`${source}-key`);
    expect(calls[1].headers.has("authorization")).toBe(false);
  });

  it("rejects an unknown source before auth, body, upstream, or credit", async () => {
    const config = configWithAuth();
    initAuth(config.auth);
    const app = createApp(config);

    const response = await app.request(
      "http://proxy/cursor/space-1/v1/messages/count_tokens",
      request("{not-json"),
    );

    expect(response.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("rejects a known but unbound source before side effects", async () => {
    const config = configWithAuth();
    initAuth(config.auth);
    const app = new Hono();
    app.post("/opencode/:spaceId/v1/messages/count_tokens", (c) =>
      handleAuxiliaryEndpoint(c, config));

    const response = await app.request(
      "http://proxy/opencode/space-1/v1/messages/count_tokens",
      request("{not-json"),
    );

    expect(response.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("rejects a path/source conflict before side effects", async () => {
    const config = configWithAuth();
    initAuth(config.auth);
    const app = new Hono();
    app.post("/opencode/:spaceId/v1/messages/count_tokens", (c) =>
      handleAuxiliaryEndpoint(c, config, "pi" as AnthropicMessageSource));

    const response = await app.request(
      "http://proxy/opencode/space-1/v1/messages/count_tokens",
      request("{not-json"),
    );

    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });
});
