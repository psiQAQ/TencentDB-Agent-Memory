import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import { clearCache, getInstanceUpstreamConfigs } from "../instance-upstream-cache.js";
import { initAuth } from "../auth.js";
import { createApp } from "../server.js";
import { log } from "../report/log.js";
import { _resetSystemUsersForTest, initSystemUsers } from "../systemUser.js";

const PRIVATE = "private-config-failure-marker";
const cases = ["network", "timeout", "http", "envelope", "json", "items", "row"] as const;
const routes = [
  "/codebuddy/test/v1/chat/completions",
  "/claude-code/test/v1/messages",
  "/codex/test/v1/responses",
  "/workbuddy/test/v1/responses",
  "/pi/test/v1/messages/count_tokens",
  "/codebuddy/test/v1/embeddings",
] as const;

function configuration() {
  const config = structuredClone(DEFAULT_CONFIG);
  config.auth = { enabled: false, url: "", timeoutMs: 1000 };
  config.coreSkill = { endpoint: "https://core.invalid", serviceToken: PRIVATE, serviceId: "test", timeoutMs: 1000 };
  config.upstream = { url: "https://deployment.invalid/v1", apiKey: PRIVATE, agents: {} };
  config.sessionInit.enabled = false;
  config.injection.enabled = false;
  config.extraction = { enabled: false, extractors: [] };
  config.creditReport.url = "";
  config.log.backend = "noop";
  return config;
}

function failure(kind: typeof cases[number]): Response {
  if (kind === "network") throw new Error(PRIVATE, { cause: PRIVATE });
  if (kind === "timeout") throw new DOMException(PRIVATE, "TimeoutError");
  if (kind === "http") return new Response(PRIVATE, { status: 403 });
  if (kind === "envelope") return Response.json({ code: 403, message: PRIVATE });
  if (kind === "json") return new Response(PRIVATE);
  if (kind === "items") return Response.json({ code: 0, data: { items: PRIVATE } });
  return Response.json({ code: 0, data: { items: [{ api_key: PRIVATE }] } });
}

function request() {
  return {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer user-test-key", "x-api-key": "user-test-key", "x-session-id": "config-failure-session" },
    body: JSON.stringify({ model: "test-model", max_tokens: 32, stream: false,
      messages: [{ role: "user", content: "hello" }], input: "hello" }),
  };
}

beforeEach(() => clearCache());
afterEach(() => {
  clearCache();
  initAuth(DEFAULT_CONFIG.auth);
  _resetSystemUsersForTest();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(cases)("configuration read failure: %s", (kind) => {
  it.each(routes)("returns a private-safe 503 without model traffic on %s", async (path) => {
    const diagnostics = [vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(log, "warn")];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe("https://core.invalid/v3/internal/meta/instance-upstream/list");
      return failure(kind);
    });
    vi.stubGlobal("fetch", fetchMock);
    const response = await createApp(configuration()).request(`http://proxy${path}`, request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "upstream_config_unavailable" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(diagnostics.map((spy) => spy.mock.calls))).not.toContain(PRIVATE);
  });

  it("fails closed for extraction and keeps refresh's existing 502 contract", async () => {
    const config = configuration();
    config.auth = { enabled: true, url: "https://auth.invalid", timeoutMs: 1000 };
    initSystemUsers([{ name: "extractor", userId: "system-test-user", displayName: "Extractor" }]);
    initAuth(config.auth);
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/v3/meta/auth/verify")) return Response.json({ code: 0, data: { valid: true, user: { user_id: "system-test-user" } } });
      expect(url).toBe("https://core.invalid/v3/internal/meta/instance-upstream/list");
      return failure(kind);
    }));
    const app = createApp(config);
    const response = await app.request("http://proxy/codebuddy/test/v1/chat/completions", request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "upstream_config_unavailable" });
    const refreshed = await app.request("http://proxy/internal/upstream/refresh", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${PRIVATE}`, "x-tdai-service-id": "test" },
      body: JSON.stringify({ agent_source: "default", type: "conversation", base_url: "https://supplier.invalid", model_id: "model", credential_ref: "stored" }),
    });
    expect(refreshed.status).toBe(502);
    expect(await refreshed.json()).toEqual({ error: "core_unavailable" });
    expect(urls).toHaveLength(3);
  });
});

it("never reuses a previous successful configuration after Core becomes unavailable", async () => {
  const row = { agent_source: "default", type: "conversation", mode: "custom_unified",
    base_url: "https://supplier.invalid/v1", api_key: "supplier-test-key", model_id: "model", ready_protocols: ["chat"] };
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ code: 0, data: { items: [row] } }))
    .mockRejectedValue(new Error(PRIVATE));
  vi.stubGlobal("fetch", fetchMock);
  const config = configuration();
  expect(await getInstanceUpstreamConfigs(config.coreSkill, "test")).toEqual([row]);
  const response = await createApp(config).request("http://proxy/codebuddy/test/v1/chat/completions", request());
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "upstream_config_unavailable" });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

describe.each(["none", "protocol", "key", "whitespace-key", "legacy-reference", "passthrough", "official", "target", "model"])(
  "inactive profile: %s", (kind) => {
    it.each(routes)("rejects before supplier traffic on %s", async (path) => {
      const row = { agent_source: "default", type: "conversation", mode: "custom_unified",
        base_url: "https://supplier.invalid/v1", api_key: "supplier-test-key", model_id: "model",
        credential_ref: "", ready_protocols: ["chat", "anthropic", "responses"] };
      if (kind === "protocol") row.ready_protocols = [];
      if (kind === "key" || kind === "legacy-reference") row.api_key = "";
      if (kind === "whitespace-key") row.api_key = "   ";
      if (kind === "legacy-reference") row.credential_ref = "deployment_default";
      if (kind === "passthrough") row.mode = "custom_passthrough";
      if (kind === "official") row.mode = "official";
      if (kind === "target") row.base_url = "";
      if (kind === "model") row.model_id = "";
      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        expect(String(input)).toBe("https://core.invalid/v3/internal/meta/instance-upstream/list");
        return Response.json({ code: 0, data: { items: kind === "none" ? [] : [row] } });
      });
      vi.stubGlobal("fetch", fetchMock);
      const response = await createApp(configuration()).request(`http://proxy${path}`, request());
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "model_not_configured_or_protocol_unavailable" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  },
);
