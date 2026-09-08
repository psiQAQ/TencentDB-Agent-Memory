// Keep route/identity assertions independent of instance configuration discovery.
// The discovery and override paths are covered by instance-upstream-merge.test.ts.
vi.mock("../instance-upstream-cache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../instance-upstream-cache.js")>();
  return { ...actual, getInstanceUpstreamConfigs: async () => [] };
});

import { afterEach, describe, expect, it, vi } from "vitest";

import { initAuth } from "../auth.js";
import { DEFAULT_CONFIG } from "../config.js";
import { createApp } from "../server.js";

type ResponsesSource = "codex" | "workbuddy";

function config(source: ResponsesSource, agentUrl = "https://upstream.invalid/v1") {
  const value = structuredClone(DEFAULT_CONFIG);
  value.upstream.url = "https://upstream.invalid/v1";
  value.upstream.apiKey = "server-upstream-key";
  value.upstream.agents[source] = { url: agentUrl };
  value.sessionInit.enabled = false;
  value.injection.enabled = false;
  value.extraction = { enabled: false, extractors: [] };
  value.creditReport.url = "";
  value.log.backend = "noop";
  return value;
}

function request(source: ResponsesSource): [string, RequestInit] {
  return [
    `http://proxy/${source}/space-1/v1/responses`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: "Bearer client-memory-key",
        "content-type": "application/json",
        "x-api-key": "client-memory-key-2",
        "x-session-id": "private-session",
        "x-tdai-agent-id": "private-agent",
        "x-tdai-task-id": "private-task",
        "x-tdai-team-id": "private-team",
      },
      body: JSON.stringify({
        model: "test-model",
        stream: false,
        input: [{ type: "message", role: "user", content: "hello" }],
      }),
    },
  ];
}

afterEach(() => {
  initAuth(DEFAULT_CONFIG.auth);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Responses upstream credential boundary", () => {
  it.each(["codex", "workbuddy"] as const)(
    "%s uses an explicit server key without forwarding identity headers",
    async (source) => {
      const calls: Array<{ headers: Headers; redirect?: RequestRedirect }> = [];
      vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        calls.push({ headers: new Headers(init?.headers), redirect: init?.redirect });
        return Response.json({ id: "response-safe", output: [], usage: {} });
      }));

      const value = config(source);
      value.upstream.agents[source].apiKey = "server-upstream-key";
      const response = await createApp(value).request(...request(source));

      expect(response.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.headers.get("authorization")).toBe("Bearer server-upstream-key");
      expect(calls[0]?.headers.get("x-api-key")).toBeNull();
      expect(calls[0]?.headers.get("x-session-id")).toBeNull();
      expect(calls[0]?.headers.get("x-tdai-agent-id")).toBeNull();
      expect(calls[0]?.headers.get("x-tdai-task-id")).toBeNull();
      expect(calls[0]?.headers.get("x-tdai-team-id")).toBeNull();
      expect(calls[0]?.redirect).toBe("manual");
    },
  );

  it.each(["codex", "workbuddy"] as const)(
    "%s accepts an explicitly configured cross-origin upstream",
    async (source) => {
      const fetchMock = vi.fn().mockResolvedValue(Response.json({ id: "response-passthrough", output: [], usage: {} }));
      vi.stubGlobal("fetch", fetchMock);

      const response = await createApp(
        config(source, "https://other-upstream.invalid/v1"),
      ).request(...request(source));

      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).toBe("https://other-upstream.invalid/v1/responses");
      const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
      expect(headers.get("authorization")).toBe(source === "codex"
        ? "Bearer client-memory-key" : "Bearer server-upstream-key");
      expect(headers.has("x-session-id")).toBe(false);
    },
  );

  it.each(["codex", "workbuddy"] as const)(
    "%s returns a controlled error for an upstream redirect",
    async (source) => {
      const redirects: Array<RequestRedirect | undefined> = [];
      vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        redirects.push(init?.redirect);
        return new Response(null, {
          status: 302,
          headers: { location: "https://receiver.invalid/capture" },
        });
      }));

      const response = await createApp(config(source)).request(...request(source));

      expect(response.status).toBe(502);
      expect(redirects).toEqual(["manual"]);
    },
  );
});
