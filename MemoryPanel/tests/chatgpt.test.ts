import { beforeEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { InstanceRegistry } from "../src/panel/config/instance-registry.js";
import type { PanelDeps } from "../src/panel/panel-deps.js";
import { registerChatGPTRoutes } from "../src/panel/http/routes/chatgpt.js";
import { registerMetaProxyRoutes } from "../src/panel/http/routes/meta/proxy.js";

let app: Hono;
const invoke = vi.fn();
const headers = {
  "content-type": "application/json",
  "x-tdai-service-id": "a",
  "x-tdai-user-key": "synthetic-admin",
};
beforeEach(() => {
  invoke.mockReset().mockImplementation(async (action) => {
    if (action === "auth/verify")
      return {
        code: 0,
        data: { valid: true, user: { user_type: "system_admin" } },
      };
    if (action.endsWith("/start"))
      return {
        code: 0,
        data: {
          state: "synthetic-state",
          reference: "connection",
          expires_at: Date.now() + 600_000,
          authorization_url: "https://auth.openai.com/api/accounts/authorize",
        },
      };
    return { code: 0, data: { connection: { reference: "connection" } } };
  });
  app = new Hono();
  const api = new Hono();
  const deps = {
    instanceRegistry: new InstanceRegistry([
      {
        instance_id: "a",
        name: "A",
        gateway_endpoint: "http://core",
        api_key: "synthetic-gateway",
      },
      {
        instance_id: "b",
        name: "B",
        gateway_endpoint: "http://core",
        api_key: "synthetic-gateway",
      },
    ]),
    metaKernel: { invoke },
  } as unknown as PanelDeps;
  registerChatGPTRoutes(app, api, deps);
  registerMetaProxyRoutes(api, deps);
  app.route("/api/v1", api);
});
const post = (action: string, body: unknown = {}, override = {}) =>
  app.request(`/api/v1/meta/${action}`, {
    method: "POST",
    headers: { ...headers, ...override },
    body: JSON.stringify(body),
  });

it("binds callback state to the initiating instance and administrator without returning credentials", async () => {
  expect((await post("model-connections/chatgpt/start")).status).toBe(200);
  const mismatch = await post(
    "model-connections/chatgpt/result",
    { state: "synthetic-state" },
    { "x-tdai-service-id": "b" },
  );
  expect(mismatch.status).toBe(404);
  const wrongKey = await post(
    "model-connections/chatgpt/result",
    { state: "synthetic-state" },
    { "x-tdai-user-key": "different-admin" },
  );
  expect(wrongKey.status).toBe(404);
  const callback = await app.request(
    "/auth/callback?state=synthetic-state&code=synthetic-code&client_id=oaiapp_test",
  );
  expect(callback.status).toBe(200);
  expect(callback.headers.get("referrer-policy")).toBe("no-referrer");
  const call = invoke.mock.calls.find(([action]) =>
    action.endsWith("/complete"),
  )!;
  expect(call[1]).toMatchObject({
    state: "synthetic-state",
    authorization_code: "synthetic-code",
    reference: "connection",
  });
  expect(call[2].instanceId).toBe("a");
  expect(await callback.text()).not.toContain("synthetic");
  expect(
    (await app.request("/auth/callback?state=synthetic-state&code=replay"))
      .status,
  ).toBe(400);
  expect(
    (
      await (
        await post("model-connections/chatgpt/result", {
          state: "synthetic-state",
        })
      ).json()
    ).data.pending,
  ).toBe(false);
});
it("rejects direct completion and unknown states before contacting Core", async () => {
  expect(
    (
      await post("model-connections/chatgpt/complete", {
        state: "forged",
        authorization_code: "forged",
      })
    ).status,
  ).toBe(400);
  expect(
    (await app.request("/auth/callback?state=forged&code=forged")).status,
  ).toBe(400);
  expect(invoke).not.toHaveBeenCalled();
});
it("requires model-setting administrator permissions for sign-in", async () => {
  invoke.mockResolvedValue({
    code: 0,
    data: { valid: true, user: { user_type: "normal" } },
  });
  expect((await post("model-connections/chatgpt/start")).status).toBe(403);
  expect(invoke.mock.calls.every(([action]) => action === "auth/verify")).toBe(
    true,
  );
});
it("forwards model catalog actions while retaining instance credentials only on the Core request", async () => {
  for (const action of [
    "model-catalog/list",
    "model-catalog/refresh",
    "model-catalog/discover",
  ]) {
    const result = await post(
      action,
      action.endsWith("discover")
        ? { provider_id: "openai", api_key: "synthetic-draft-key" }
        : {},
    );
    expect(result.status).toBe(200);
  }
  const discovery = invoke.mock.calls.find(
    ([action]) => action === "model-catalog/discover",
  )!;
  expect(discovery[1].api_key).toBe("synthetic-draft-key");
  expect(discovery[2].instanceId).toBe("a");
});
