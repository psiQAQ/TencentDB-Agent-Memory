import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../guard-adapter.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../guard-adapter.js")>();
  return {
    ...original,
    resolveForwardTarget: vi.fn(),
  };
});

import { initAuth } from "../auth.js";
import { DEFAULT_CONFIG } from "../config.js";
import { resolveForwardTarget, type ForwardTarget } from "../guard-adapter.js";
import { createApp } from "../server.js";

const configuredOrigin = "https://configured.invalid";

function target(overrides: Partial<ForwardTarget> = {}): ForwardTarget {
  return {
    url: `${configuredOrigin}/v1/chat/completions`,
    model: "primary-model",
    authHeaders: null,
    bodyOverrides: null,
    retryTarget: null,
    turnSeq: 0,
    ...overrides,
  };
}

function config(apiKey = "server-global-key") {
  const value = structuredClone(DEFAULT_CONFIG);
  value.auth = { enabled: false, url: "", timeoutMs: 1_000 };
  value.upstream.url = `${configuredOrigin}/v1`;
  value.upstream.apiKey = apiKey;
  value.rateLimit = { tpm: 0, qpm: 0 };
  value.extraction = { enabled: false, extractors: [] };
  value.injection.enabled = false;
  value.creditReport.url = "";
  value.log.backend = "noop";
  return value;
}

function privateHeaders(): Record<string, string> {
  return {
    accept: "application/json",
    "anthropic-beta": "private-beta-feature",
    "anthropic-version": "2023-06-01",
    authorization: "Bearer private-caller-credential",
    "x-api-key": "private-memory-credential",
    cookie: "private-cookie-value",
    "x-team-id": "private-team-value",
    "x-agent-id": "private-agent-value",
    "x-task-id": "private-task-value",
    "x-conversation-id": "private-conversation-value",
    "x-session-id": "private-session-value",
    "x-claude-code-session-id": "private-claude-session-value",
    "x-vertex-ai-session-id": "private-vertex-session-value",
    "x-tdai-service-id": "private-service-value",
    "x-private-custom": "private-custom-value",
  };
}

function requestBody(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: "test-model",
    messages: [{ role: "user", content: "hello" }],
    ...extra,
  });
}

function assertSafe(headers: Headers, expectedAuthorization: string): void {
  const forbiddenNames = [
    "x-api-key",
    "cookie",
    "x-team-id",
    "x-agent-id",
    "x-task-id",
    "x-conversation-id",
    "x-session-id",
    "x-claude-code-session-id",
    "x-vertex-ai-session-id",
    "x-tdai-service-id",
    "x-private-custom",
    "anthropic-beta",
    "anthropic-version",
  ];
  const hasForbiddenName = forbiddenNames.some((name) => headers.has(name));
  const hasPrivateValue = [...headers.values()].some((value) => value.startsWith("private-"));

  expect(hasForbiddenName).toBe(false);
  expect(hasPrivateValue).toBe(false);
  expect(headers.get("authorization")).toBe(expectedAuthorization);
  expect(headers.get("accept")).toBe("application/json");
  expect(headers.get("content-type")).toBe("application/json");
}

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

describe("OpenAI upstream header privacy", () => {
  let upstreamHeaders: Headers[];
  let upstreamUrls: string[];
  let upstreamResponses: Response[];

  beforeEach(() => {
    upstreamHeaders = [];
    upstreamUrls = [];
    upstreamResponses = [];
    vi.mocked(resolveForwardTarget).mockResolvedValue(target());
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      upstreamUrls.push(input instanceof Request ? input.url : String(input));
      upstreamHeaders.push(new Headers(init?.headers));
      return upstreamResponses.shift() ?? Response.json({
        id: "chatcmpl-safe",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      });
    }));
  });

  afterEach(() => {
    initAuth(DEFAULT_CONFIG.auth);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(["codebuddy", "cursor", "openai"])(
    "sanitizes the %s main request with server authentication",
    async (source) => {
      const value = config();
      initAuth(value.auth);
      const response = await createApp(value).request(
        `http://proxy/${source}/space-1/v1/chat/completions`,
        { method: "POST", headers: privateHeaders(), body: requestBody() },
      );

      expect(response.status).toBe(200);
      expect(upstreamHeaders).toHaveLength(1);
      assertSafe(upstreamHeaders[0]!, "Bearer server-global-key");
    },
  );

  it.each([
    {
      name: "stream",
      body: { stream: true },
      response: () => new Response(
        'data: {"id":"chatcmpl-safe","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      ),
    },
    {
      name: "tool",
      body: { tools: [{ type: "function", function: { name: "safe_tool", parameters: {} } }] },
      response: () => Response.json({
        id: "chatcmpl-safe",
        object: "chat.completion",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call-1", type: "function", function: { name: "safe_tool", arguments: "{}" } }],
          },
          finish_reason: "tool_calls",
        }],
      }),
    },
    {
      name: "error",
      body: {},
      response: () => Response.json({ error: { type: "upstream_error" } }, { status: 500 }),
    },
  ])("uses the shared safe builder for the CodeBuddy $name path", async ({ body, response }) => {
    upstreamResponses.push(response());
    const value = config();
    initAuth(value.auth);
    const result = await createApp(value).request(
      "http://proxy/codebuddy/space-1/v1/chat/completions",
      { method: "POST", headers: privateHeaders(), body: requestBody(body) },
    );
    await result.arrayBuffer();

    expect(upstreamHeaders).toHaveLength(1);
    assertSafe(upstreamHeaders[0]!, "Bearer server-global-key");
  });

  it("falls back from a URL-only agent entry to the global server key", async () => {
    const value = config();
    value.upstream.agents.codebuddy = { url: `${configuredOrigin}/v1` };
    initAuth(value.auth);

    const response = await createApp(value).request(
      "http://proxy/codebuddy/space-1/v1/chat/completions",
      { method: "POST", headers: privateHeaders(), body: requestBody() },
    );

    expect(response.status).toBe(200);
    assertSafe(upstreamHeaders[0]!, "Bearer server-global-key");
  });

  it("fails closed before fetch when no server key is configured", async () => {
    const value = config("");
    initAuth(value.auth);

    const response = await createApp(value).request(
      "http://proxy/codebuddy/space-1/v1/chat/completions",
      { method: "POST", headers: privateHeaders(), body: requestBody() },
    );

    expect(response.status).toBe(503);
    expect(upstreamUrls).toEqual([]);
    expect(upstreamHeaders).toEqual([]);
  });

  it("allows a same-origin primary target to use the selected server key", async () => {
    vi.mocked(resolveForwardTarget).mockResolvedValueOnce(target({
      url: `${configuredOrigin}/alternate/chat/completions`,
    }));
    const value = config();
    initAuth(value.auth);

    const response = await createApp(value).request(
      "http://proxy/codebuddy/space-1/v1/chat/completions",
      { method: "POST", headers: privateHeaders(), body: requestBody() },
    );

    expect(response.status).toBe(200);
    expect(upstreamUrls).toEqual([`${configuredOrigin}/alternate/chat/completions`]);
    assertSafe(upstreamHeaders[0]!, "Bearer server-global-key");
  });

  it("fails closed before fetch for a cross-origin primary target without explicit server auth", async () => {
    vi.mocked(resolveForwardTarget).mockResolvedValueOnce(target({
      url: "https://extension-controlled.invalid/v1/chat/completions",
    }));
    const value = config();
    initAuth(value.auth);

    const response = await createApp(value).request(
      "http://proxy/codebuddy/space-1/v1/chat/completions",
      { method: "POST", headers: privateHeaders(), body: requestBody() },
    );

    expect(response.status).toBe(503);
    expect(upstreamUrls).toEqual([]);
    expect(upstreamHeaders).toEqual([]);
  });

  it("allows explicit server auth for a cross-origin primary target", async () => {
    vi.mocked(resolveForwardTarget).mockResolvedValueOnce(target({
      url: "https://extension-controlled.invalid/v1/chat/completions",
      authHeaders: { authorization: "Bearer server-extension-key" },
    }));
    const value = config();
    initAuth(value.auth);

    const response = await createApp(value).request(
      "http://proxy/codebuddy/space-1/v1/chat/completions",
      { method: "POST", headers: privateHeaders(), body: requestBody() },
    );

    expect(response.status).toBe(200);
    expect(upstreamUrls).toEqual(["https://extension-controlled.invalid/v1/chat/completions"]);
    assertSafe(upstreamHeaders[0]!, "Bearer server-extension-key");
  });

  it("prefers the selected per-agent server key over the global key", async () => {
    const value = config();
    value.upstream.agents.codebuddy = {
      url: `${configuredOrigin}/v1`,
      apiKey: "server-agent-key",
    };
    initAuth(value.auth);

    const response = await createApp(value).request(
      "http://proxy/codebuddy/space-1/v1/chat/completions",
      { method: "POST", headers: privateHeaders(), body: requestBody() },
    );

    expect(response.status).toBe(200);
    assertSafe(upstreamHeaders[0]!, "Bearer server-agent-key");
  });

  it("uses distinct explicit server credentials for a cross-origin retry", async () => {
    vi.mocked(resolveForwardTarget).mockResolvedValueOnce(target({
      authHeaders: { authorization: "Bearer server-primary-key" },
      retryTarget: {
        url: "https://retry.invalid/v1/chat/completions",
        model: "retry-model",
        authHeaders: { authorization: "Bearer server-retry-key" },
      },
    }));
    upstreamResponses.push(
      Response.json({ error: { type: "unauthorized" } }, { status: 401 }),
      Response.json({
        id: "chatcmpl-safe",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      }),
    );
    const value = config();
    initAuth(value.auth);

    const response = await createApp(value).request(
      "http://proxy/codebuddy/space-1/v1/chat/completions",
      { method: "POST", headers: privateHeaders(), body: requestBody() },
    );

    expect(response.status).toBe(200);
    expect(upstreamHeaders).toHaveLength(2);
    assertSafe(upstreamHeaders[0]!, "Bearer server-primary-key");
    assertSafe(upstreamHeaders[1]!, "Bearer server-retry-key");
  });

  it("may reuse sanitized server authentication for a same-origin retry", async () => {
    vi.mocked(resolveForwardTarget).mockResolvedValueOnce(target({
      retryTarget: {
        url: `${configuredOrigin}/retry/chat/completions`,
        model: "retry-model",
        authHeaders: null,
      },
    }));
    upstreamResponses.push(
      Response.json({ error: { type: "unauthorized" } }, { status: 401 }),
      Response.json({
        id: "chatcmpl-safe",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      }),
    );
    const value = config();
    initAuth(value.auth);

    const response = await createApp(value).request(
      "http://proxy/codebuddy/space-1/v1/chat/completions",
      { method: "POST", headers: privateHeaders(), body: requestBody() },
    );

    expect(response.status).toBe(200);
    expect(upstreamHeaders).toHaveLength(2);
    assertSafe(upstreamHeaders[0]!, "Bearer server-global-key");
    assertSafe(upstreamHeaders[1]!, "Bearer server-global-key");
  });

  it("fails closed before fetch for a cross-origin retry without explicit server auth", async () => {
    vi.mocked(resolveForwardTarget).mockResolvedValueOnce(target({
      retryTarget: {
        url: "https://retry.invalid/v1/chat/completions",
        model: "retry-model",
        authHeaders: null,
      },
    }));
    const value = config();
    initAuth(value.auth);

    const response = await createApp(value).request(
      "http://proxy/codebuddy/space-1/v1/chat/completions",
      { method: "POST", headers: privateHeaders(), body: requestBody() },
    );

    expect(response.status).toBe(503);
    expect(upstreamUrls).toEqual([]);
    expect(upstreamHeaders).toEqual([]);
  });

  it("sends no request to either origin for a cross-origin extension target without auth", async () => {
    vi.unstubAllGlobals();
    let configuredRequests = 0;
    let extensionRequests = 0;
    const configured = createServer((_request, response) => {
      configuredRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    const extension = createServer((_request, response) => {
      extensionRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    const configuredUrl = await listen(configured);
    const extensionUrl = await listen(extension);

    try {
      vi.mocked(resolveForwardTarget).mockResolvedValueOnce(target({
        url: `${extensionUrl}/v1/chat/completions`,
      }));
      const value = config();
      value.upstream.url = `${configuredUrl}/v1`;
      initAuth(value.auth);

      const response = await createApp(value).request(
        "http://proxy/codebuddy/space-1/v1/chat/completions",
        { method: "POST", headers: privateHeaders(), body: requestBody() },
      );

      expect(response.status).toBe(503);
      expect(configuredRequests).toBe(0);
      expect(extensionRequests).toBe(0);
    } finally {
      await Promise.all([close(configured), close(extension)]);
    }
  });

  it("does not follow a retry redirect to a second origin", async () => {
    vi.unstubAllGlobals();
    let retryRequests = 0;
    let receiverRequests = 0;
    const receiver = createServer((_request, response) => {
      receiverRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    const receiverUrl = await listen(receiver);
    const upstream = createServer((request, response) => {
      if (request.url === "/primary") {
        response.writeHead(401, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      retryRequests += 1;
      response.writeHead(302, { location: `${receiverUrl}/capture` });
      response.end();
    });
    const upstreamUrl = await listen(upstream);

    try {
      vi.mocked(resolveForwardTarget).mockResolvedValueOnce(target({
        url: `${upstreamUrl}/primary`,
        authHeaders: { authorization: "Bearer server-primary-key" },
        retryTarget: {
          url: `${upstreamUrl}/retry`,
          model: "retry-model",
          authHeaders: { authorization: "Bearer server-retry-key" },
        },
      }));
      const value = config();
      initAuth(value.auth);

      const response = await createApp(value).request(
        "http://proxy/codebuddy/space-1/v1/chat/completions",
        { method: "POST", headers: privateHeaders(), body: requestBody() },
      );

      expect(response.status).toBe(502);
      expect(retryRequests).toBe(1);
      expect(receiverRequests).toBe(0);
    } finally {
      await Promise.all([close(upstream), close(receiver)]);
    }
  });
});
