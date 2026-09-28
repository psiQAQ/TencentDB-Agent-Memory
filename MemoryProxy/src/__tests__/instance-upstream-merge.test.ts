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

function entry(type: "conversation" | "extraction" = "conversation"): InstanceUpstreamConfigEntry {
  return {
    agent_source: "default", type, mode: "custom_unified",
    base_url: "https://instance.invalid/v1",
    api_key: "instance-model-key",
    model_id: "instance-model",
    ready_protocols: type === "extraction" ? ["chat"] : ["chat", "responses", "anthropic"],
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

describe("selected Panel upstream", () => {
  it.each(routes)("applies configured credentials to %s/%s", async (source, endpoint, authHeader) => {
    const config = configuration();
    initAuth(config.auth);
    const calls: Array<{ url: string; headers: Headers; body: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: new Headers(init?.headers), body: String(init?.body ?? "") });
      if (url.endsWith("/v3/internal/meta/instance-upstream/list")) {
        return Response.json({ code: 0, data: { items: [entry()] } });
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
    const key = "instance-model-key";
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
      if (url.endsWith("/v3/internal/meta/instance-upstream/list")) return Response.json({ code: 0, data: { items: [entry("extraction")] } });
      expect(url).toBe("https://instance.invalid/v1/chat/completions");
      forwarded.push(new Headers(init?.headers));
      return Response.json({ id: "test-response", content: [], usage: {} });
    }));
    const response = await createApp(config).request("http://proxy/codebuddy/space-test/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-id": "session-test", authorization: "Bearer client-model-key" },
      body: JSON.stringify(requestBody("chat/completions")),
    });
    await response.text();
    expect(response.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].get("authorization")).toBe("Bearer instance-model-key");
  });
});

it("returns unconfigured without a selected conversation profile", async () => {
  const config = configuration();
  initAuth(config.auth);
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    if (String(input).endsWith("/v3/internal/meta/instance-upstream/list")) {
      return Response.json({ code: 0, data: { items: [] } });
    }
    throw new Error("unexpected supplier call");
  });
  vi.stubGlobal("fetch", fetchMock);
  const response = await createApp(config).request("http://proxy/codebuddy/space-test/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer user-key" },
    body: JSON.stringify(requestBody("chat/completions")),
  });
  expect(response.status).toBe(503);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("rejects a protocol that did not pass activation", async () => {
  const config = configuration();
  initAuth(config.auth);
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    if (String(input).endsWith("/v3/internal/meta/instance-upstream/list")) {
      return Response.json({ code: 0, data: { items: [{ ...entry(), ready_protocols: ["chat"] }] } });
    }
    throw new Error("unexpected supplier call");
  });
  vi.stubGlobal("fetch", fetchMock);
  const response = await createApp(config).request("http://proxy/codex/space-test/v1/responses", {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer user-key" },
    body: JSON.stringify(requestBody("responses")),
  });
  expect(response.status).toBe(503);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("fails closed when Core becomes unavailable", async () => {
  const config = configuration();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const rows = [entry()];
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ code: 0, data: { items: rows } }))
    .mockRejectedValue(new Error("private-service-token private-host"));
  vi.stubGlobal("fetch", fetchMock);
  expect(await getInstanceUpstreamConfigs(config.coreSkill, "private-space")).toEqual(rows);
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 6 * 60 * 1000);
  await expect(getInstanceUpstreamConfigs(config.coreSkill, "private-space")).rejects.toThrow();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(warn.mock.calls)).not.toContain("private-");
});

it("disables the direct route without a Panel instance", async () => {
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
  expect(response.status).toBe(410);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(resolveForwardTarget).not.toHaveBeenCalled();
});
