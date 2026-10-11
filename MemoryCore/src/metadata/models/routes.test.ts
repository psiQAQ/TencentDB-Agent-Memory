import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { handleV3MetaRoute } from "../router/v3-meta-router.js";
import {
  supported,
  upstreamFixture,
} from "../service/upstream-group-test-fixture.js";

let fixture: ReturnType<typeof upstreamFixture>;
beforeEach(async () => {
  fixture = upstreamFixture();
  await fixture.service.initAdminUser({
    username: "catalog-admin",
    user_key: "synthetic-admin",
  });
  await fixture.service.createNormalUserWithKey({
    username: "catalog-user",
    user_key: "synthetic-user",
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  fixture.cleanup();
});

async function request(
  action: string,
  key?: string,
  body: Record<string, unknown> = {},
) {
  const req = new IncomingMessage(new Socket());
  req.headers = {
    "x-tdai-service-id": "catalog-test",
    ...(key ? { "x-tdai-user-key": key } : {}),
  };
  const res = new ServerResponse(req);
  let status = 0;
  let envelope: any;
  const handled = await handleV3MetaRoute(
    req,
    res,
    `/v3/meta/${action}`,
    "POST",
    async <T>() => body as T,
    (_response, code, payload) => {
      status = code;
      envelope = payload;
    },
    {
      getMetadataService: () => fixture.service,
      getSupportedAgents: () => supported,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    },
  );
  return { handled, status, envelope };
}

it.each([
  "model-catalog/list",
  "model-catalog/refresh",
  "model-catalog/discover",
  "model-connections/chatgpt/start",
])(
  "requires the existing model-setting administrator permission for %s",
  async (action) => {
    const body = action.endsWith("discover")
      ? {
          provider_id: "openai",
          base_url: "https://api.openai.com/v1",
          api_key: "synthetic-draft",
        }
      : {};
    expect((await request(action, undefined, body)).status).toBe(401);
    expect((await request(action, "synthetic-user", body)).status).toBe(403);
    expect(fixture.store.listModelStates("oauth:")).toEqual([]);
  },
);
it("serves a bundled catalog offline and reports source failures without rewriting settings", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("remote-secret-diagnostic");
    }),
  );
  const listed = await request("model-catalog/list", "synthetic-admin");
  expect(listed.status).toBe(200);
  expect(listed.envelope.data.public_catalog.models).toHaveLength(85);
  const updated = await request("model-catalog/refresh", "synthetic-admin");
  expect(updated.envelope.data).toMatchObject({
    status: "failed",
    results: [{ source: "pi", status: "failed" }],
  });
  expect(JSON.stringify(updated)).not.toContain("remote-secret");
  expect(fixture.store.listInstanceUpstreamGroups()).toEqual([]);
});
it("returns only the login URL and pending reference and sanitizes an invalid callback", async () => {
  const started = await request(
    "model-connections/chatgpt/start",
    "synthetic-admin",
  );
  expect(started.status).toBe(200);
  expect(started.envelope.data.authorization_url).toContain(
    "code_challenge_method=S256",
  );
  expect(started.envelope.data).not.toHaveProperty("verifier");
  const failed = await request(
    "model-connections/chatgpt/complete",
    "synthetic-admin",
    {
      reference: started.envelope.data.reference,
      state: "forged-state",
      authorization_code: "synthetic-code",
      client_id: "oaiapp_test",
    },
  );
  expect(failed.status).toBe(401);
  expect(failed.envelope.message).toBe("CHATGPT_STATE_INVALID");
});
