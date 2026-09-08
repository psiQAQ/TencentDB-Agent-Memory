import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../guard-adapter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../guard-adapter.js")>();
  return { ...actual, resolveForwardTarget: vi.fn() };
});

import { initAuth } from "../auth.js";
import { DEFAULT_CONFIG } from "../config.js";
import { resolveForwardTarget } from "../guard-adapter.js";
import {
  clearCache,
  getInstanceUpstreamConfigs,
  type InstanceUpstreamConfigEntry,
} from "../instance-upstream-cache.js";
import { createApp } from "../server.js";
import { __resetSessionStoreForTests } from "../session/store.js";
import { _resetSystemUsersForTest, initSystemUsers } from "../systemUser.js";

function configuration() {
  const config = structuredClone(DEFAULT_CONFIG);
  config.auth = { enabled: false, url: "", timeoutMs: 1000 };
  config.upstream = { url: "https://global.invalid/v1", apiKey: "global-model-key", agents: {} };
  config.coreSkill = { endpoint: "https://core.invalid", serviceToken: "core-service-key", serviceId: "test", timeoutMs: 1000 };
  config.sessionInit.enabled = false;
  config.injection.enabled = false;
  config.extraction = { enabled: false, extractors: [] };
  config.workbuddyRequestRouting.enabled = false;
  config.creditReport.url = "";
  config.log.backend = "noop";
  config.rateLimit = { tpm: 0, qpm: 0 };
  return config;
}

function entry(mode: "custom_unified" | "custom_passthrough", type: "conversation" | "extraction" = "conversation"): InstanceUpstreamConfigEntry {
  return {
    agent_source: "default", type, mode,
    base_url: "https://instance.invalid/v1",
    api_key: mode === "custom_unified" ? "instance-model-key" : "",
    model_id: "instance-model",
  };
}

const routes = [
  ["claude-code", "messages", "x-api-key"],
  ["codebuddy", "chat/completions", "authorization"],
  ["codex", "responses", "authorization"],
  ["workbuddy", "responses", "authorization"],
  ["pi", "messages/count_tokens", "x-api-key"],
  ["codebuddy", "embeddings", "authorization"],
] as const;

function requestBody(endpoint: string) {
  return endpoint === "responses"
    ? { model: "client-model", stream: false, input: [{ type: "message", role: "user", content: "hello" }] }
    : { model: "client-model", max_tokens: 32, messages: [{ role: "user", content: "hello" }] };
}

beforeEach(() => {
  clearCache();
  __resetSessionStoreForTests();
  vi.mocked(resolveForwardTarget).mockImplementation(async (_config, args) => ({
    url: `${args.defaultUpstreamUrl}${args.requestPath}`,
    model: args.modelId,
    authHeaders: null,
    bodyOverrides: null,
    retryTarget: null,
    turnSeq: 0,
    logLine: "",
    logLineExtra: "",
    tags: [],
    analyzerTrace: null,
    logMeta: {},
    routedFrom: "",
  }));
});

afterEach(() => {
  clearCache();
  initAuth(DEFAULT_CONFIG.auth);
  _resetSystemUsersForTest();
  __resetSessionStoreForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(["custom_unified", "custom_passthrough"] as const)("merged instance upstream: %s", (mode) => {
  it.each(routes)("applies configured credentials to %s/%s", async (source, endpoint, authHeader) => {
    const config = configuration();
    initAuth(config.auth);
    const calls: Array<{ url: string; headers: Headers; body: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: new Headers(init?.headers), body: String(init?.body ?? "") });
      if (url.endsWith("/v3/internal/meta/instance-upstream/list")) {
        return Response.json({ code: 0, data: { items: [entry(mode)] } });
      }
      return Response.json({ id: "test-response", output: [], content: [], choices: [], usage: {} });
    }));

    const response = await createApp(config).request(`http://proxy/${source}/space-test/v1/${endpoint}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-id": "session-test",
        "x-team-id": "private-team",
        [authHeader]: authHeader === "authorization" ? "Bearer client-model-key" : "client-model-key",
      },
      body: JSON.stringify(requestBody(endpoint)),
    });
    await response.text();

    expect(response.status).toBe(200);
    const discovery = calls.filter((call) => call.url.startsWith("https://core.invalid/"));
    expect(discovery).toHaveLength(1);
    expect(discovery[0].headers.get("authorization")).toBe("Bearer core-service-key");
    const forwarded = calls.filter((call) => call.url.startsWith("https://instance.invalid/"));
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].url).toBe(`https://instance.invalid/v1/${endpoint}`);
    const key = mode === "custom_unified" ? "instance-model-key" : "client-model-key";
    expect(forwarded[0].headers.get(authHeader)).toBe(authHeader === "authorization" ? `Bearer ${key}` : key);
    expect(forwarded[0].headers.has("x-team-id")).toBe(false);
    expect(forwarded[0].headers.has("x-session-id")).toBe(false);
    expect([...forwarded[0].headers.values()].join(" ")).not.toContain("core-service-key");
  });

  it("uses extraction configuration for an authenticated system user", async () => {
    const config = configuration();
    config.auth = { enabled: true, url: "https://auth.invalid", timeoutMs: 1000 };
    initAuth(config.auth);
    initSystemUsers([{ name: "extractor", userId: "system-user", displayName: "Extractor" }]);
    const forwarded: Headers[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v3/meta/auth/verify")) return Response.json({ code: 0, data: { valid: true, user: { user_id: "system-user" } } });
      if (url.endsWith("/v3/internal/meta/instance-upstream/list")) return Response.json({ code: 0, data: { items: [entry(mode, "extraction")] } });
      expect(url).toBe("https://instance.invalid/v1/messages");
      forwarded.push(new Headers(init?.headers));
      return Response.json({ id: "test-response", content: [], usage: {} });
    }));
    const response = await createApp(config).request("http://proxy/claude-code/space-test/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-id": "session-test", "x-api-key": "client-model-key" },
      body: JSON.stringify(requestBody("messages")),
    });
    await response.text();
    expect(response.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].get("x-api-key")).toBe(mode === "custom_unified" ? "instance-model-key" : "client-model-key");
  });
});

it("keeps instance lookup failures out of diagnostics while using the last known configuration", async () => {
  const config = configuration();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const rows = [entry("custom_unified")];
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ code: 0, data: { items: rows } }))
    .mockRejectedValue(new Error("private-service-token private-host"));
  vi.stubGlobal("fetch", fetchMock);
  expect(await getInstanceUpstreamConfigs(config.coreSkill, "private-space")).toEqual(rows);
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 6 * 60 * 1000);
  expect(await getInstanceUpstreamConfigs(config.coreSkill, "private-space")).toEqual(rows);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(warn.mock.calls)).not.toContain("private-");
});

it("preserves the upstream direct route's caller credentials and raw body without business auth or rewriting", async () => {
  const config = configuration();
  config.auth = { enabled: true, url: "https://auth.invalid", timeoutMs: 1000 };
  initAuth(config.auth);
  const rawBody = '{ "model": "client-model", "messages": [] }';
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ choices: [], usage: {} }));
  vi.stubGlobal("fetch", fetchMock);
  const response = await createApp(config).request("http://proxy/direct/v1/chat/completions?seed=7", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer client-model-key" },
    body: rawBody,
  });
  await response.text();
  expect(response.status).toBe(200);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe("https://global.invalid/v1/chat/completions?seed=7");
  expect(new Headers(init.headers).get("authorization")).toBe("Bearer client-model-key");
  expect(new TextDecoder().decode(init.body)).toBe(rawBody);
  expect(resolveForwardTarget).not.toHaveBeenCalled();
});
