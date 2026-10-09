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

describe.each(cases)("configuration failure: %s", (kind) => {
  it.each(routes)("uses the official fallback without exposing errors on %s", async (path) => {
    const diagnostics = [vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(log, "warn")];
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input); calls.push(url);
      if (url.includes("core.invalid")) return failure(kind);
      return Response.json({ id: "ok", output: [], content: [], choices: [], usage: {} });
    }));
    const config = configuration(); config.creditPricing.models = []; config.costGuard.enabled = false;
    const response = await createApp(config).request(`http://proxy${path}`, request());
    expect(response.status).toBe(200);
    expect(calls.some((url) => url.startsWith("https://deployment.invalid"))).toBe(true);
    expect(JSON.stringify(diagnostics.map((spy) => spy.mock.calls))).not.toContain(PRIVATE);
  });
  it("keeps refresh failures private and explicit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => failure(kind)));
    const response = await createApp(configuration()).request("http://proxy/internal/upstream/refresh", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${PRIVATE}`, "x-tdai-service-id": "test" }, body: "{}",
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "core_unavailable" });
  });
});

it("uses the last good groups after the 30-second cache expires and Core fails", async () => {
  const row = { group_id: "main", group_type: "custom", name: "Main", agents: ["codebuddy"], enabled: true,
    mode: "custom_unified", base_url: "https://supplier.invalid/v1", api_key: "supplier-test-key", model_id: "model" };
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ code: 0, data: { items: [row] } })).mockRejectedValue(new Error(PRIVATE));
  vi.stubGlobal("fetch", fetchMock);
  const config = configuration();
  expect(await getInstanceUpstreamConfigs(config.coreSkill, "test")).toEqual([row]);
  expect(await getInstanceUpstreamConfigs(config.coreSkill, "test")).toEqual([row]);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now + 31000);
  expect(await getInstanceUpstreamConfigs(config.coreSkill, "test")).toEqual([row]);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
