import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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
import { resolveForwardTarget } from "../guard-adapter.js";
import { createApp } from "../server.js";

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

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

  it("rejects a cross-origin retry without an explicit server credential", async () => {
    vi.mocked(resolveForwardTarget).mockResolvedValueOnce({
      url: "https://primary.invalid/messages",
      model: "primary-model",
      authHeaders: { "x-api-key": "server-primary-key" },
      bodyOverrides: null,
      retryTarget: {
        url: "https://other-origin.invalid/messages",
        model: "retry-model",
        authHeaders: null,
      },
      turnSeq: 0,
    });

    const config = structuredClone(DEFAULT_CONFIG);
    config.auth = { enabled: true, url: "https://auth.invalid", timeoutMs: 1_000 };
    config.upstream.apiKey = "server-primary-key";
    config.rateLimit = { tpm: 0, qpm: 0 };
    config.extraction = { enabled: false, extractors: [] };
    config.log.backend = "noop";
    initAuth(config.auth);
    const app = createApp(config);

    const response = await app.request("http://proxy/claude-code/space-1/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": "private-memory-credential",
        "x-session-id": "private-session-value",
      },
      body: JSON.stringify({
        model: "test-model",
        max_tokens: 32,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(response.status).toBe(503);
    expect(upstreamUrls).toEqual([]);
    expect(upstreamHeaders).toEqual([]);
  });

  it("rejects a cross-origin primary target without an explicit server credential", async () => {
    vi.mocked(resolveForwardTarget).mockResolvedValueOnce({
      url: "https://extension-controlled.invalid/messages",
      model: "primary-model",
      authHeaders: null,
      bodyOverrides: null,
      retryTarget: null,
      turnSeq: 0,
    });

    const config = structuredClone(DEFAULT_CONFIG);
    config.auth = { enabled: true, url: "https://auth.invalid", timeoutMs: 1_000 };
    config.upstream.url = "https://configured.invalid/anthropic/v1";
    config.upstream.apiKey = "server-primary-key";
    config.rateLimit = { tpm: 0, qpm: 0 };
    config.extraction = { enabled: false, extractors: [] };
    config.log.backend = "noop";
    initAuth(config.auth);
    const app = createApp(config);

    const response = await app.request("http://proxy/claude-code/space-1/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": "private-memory-credential",
        "x-session-id": "private-session-value",
      },
      body: JSON.stringify({
        model: "test-model",
        max_tokens: 32,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(response.status).toBe(503);
    expect(upstreamUrls).toEqual([]);
    expect(upstreamHeaders).toEqual([]);
  });

  it("may reuse the primary server credential for a same-origin retry", async () => {
    vi.mocked(resolveForwardTarget).mockResolvedValueOnce({
      url: "https://primary.invalid/messages",
      model: "primary-model",
      authHeaders: { "x-api-key": "server-primary-key" },
      bodyOverrides: null,
      retryTarget: {
        url: "https://primary.invalid/retry/messages",
        model: "retry-model",
        authHeaders: null,
      },
      turnSeq: 0,
    });

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
        "anthropic-version": "2023-06-01",
        "x-api-key": "private-memory-credential",
        "x-session-id": "private-session-value",
      },
      body: JSON.stringify({
        model: "test-model",
        max_tokens: 32,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(response.status).toBe(200);
    expect(upstreamUrls).toEqual([
      "https://primary.invalid/messages",
      "https://primary.invalid/retry/messages",
    ]);
    expect(upstreamHeaders[1]?.get("x-api-key")).toBe("server-primary-key");
  });

  it("returns a controlled error instead of following a retry redirect", async () => {
    const redirects: Array<RequestRedirect | undefined> = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/v3/meta/auth/verify")) {
        return Response.json({ code: 0, data: { valid: true, user: { user_id: "user-1" } } });
      }
      upstreamUrls.push(url);
      upstreamHeaders.push(new Headers(init?.headers));
      redirects.push(init?.redirect);
      if (upstreamUrls.length === 1) {
        return Response.json({ type: "error" }, { status: 401 });
      }
      return new Response(null, {
        status: 302,
        headers: { location: "https://redirect-receiver.invalid/capture" },
      });
    });

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
        "x-api-key": "private-memory-credential",
        "x-session-id": "private-session-value",
      },
      body: JSON.stringify({
        model: "test-model",
        max_tokens: 32,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(response.status).toBe(502);
    expect(redirects).toEqual(["manual", "manual"]);
  });

  it("keeps a retry redirect credential away from the second origin", async () => {
    vi.unstubAllGlobals();
    let receiverRequests = 0;
    let retryRequests = 0;
    const receiver = createServer((_request, response) => {
      receiverRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "message", role: "assistant", content: [] }));
    });
    const receiverOrigin = await listen(receiver);
    const upstream = createServer((request, response) => {
      if (request.url?.endsWith("/v3/meta/auth/verify")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          code: 0,
          data: { valid: true, user: { user_id: "user-1" } },
        }));
        return;
      }
      if (request.url === "/primary") {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ type: "error" }));
        return;
      }
      retryRequests += 1;
      response.writeHead(302, { location: `${receiverOrigin}/capture` });
      response.end();
    });
    const upstreamOrigin = await listen(upstream);

    try {
      vi.mocked(resolveForwardTarget).mockResolvedValueOnce({
        url: `${upstreamOrigin}/primary`,
        model: "primary-model",
        authHeaders: { "x-api-key": "server-primary-key" },
        bodyOverrides: null,
        retryTarget: {
          url: `${upstreamOrigin}/retry`,
          model: "retry-model",
          authHeaders: { "x-api-key": "server-retry-key" },
        },
        turnSeq: 0,
      });
      const config = structuredClone(DEFAULT_CONFIG);
      config.auth = { enabled: true, url: upstreamOrigin, timeoutMs: 1_000 };
      config.rateLimit = { tpm: 0, qpm: 0 };
      config.extraction = { enabled: false, extractors: [] };
      config.log.backend = "noop";
      initAuth(config.auth);
      const app = createApp(config);

      const response = await app.request("http://proxy/claude-code/space-1/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "memory-user-key",
          "x-session-id": "session-1",
        },
        body: JSON.stringify({
          model: "test-model",
          max_tokens: 32,
          messages: [{ role: "user", content: "hello" }],
        }),
      });

      expect(response.status).toBe(502);
      expect(retryRequests).toBe(1);
      expect(receiverRequests).toBe(0);
    } finally {
      await Promise.all([close(upstream), close(receiver)]);
    }
  });
});
