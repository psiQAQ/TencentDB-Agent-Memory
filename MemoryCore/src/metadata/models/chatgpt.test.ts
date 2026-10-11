import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  upstreamFixture,
  supported,
} from "../service/upstream-group-test-fixture.js";
import {
  decryptUpstreamKey,
  encryptUpstreamKey,
} from "../service/upstream-profile-library.js";
import { ChatGPTConnections } from "./chatgpt.js";
import { ModelCatalog } from "./catalog.js";

describe("ChatGPT public client authentication", () => {
  let f: ReturnType<typeof upstreamFixture>;
  beforeEach(() => {
    f = upstreamFixture();
  });
  afterEach(() => f.cleanup());
  async function fixture() {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    const calls: Array<{ url: string; body: URLSearchParams }> = [];
    let nonce = "";
    let subject = "synthetic-account";
    let grant =
      "openid resource.invoke chatgpt.tokens.use.direct offline_access";
    let badSignature = false;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const body = new URLSearchParams(String(init?.body ?? ""));
      calls.push({ url, body });
      if (url.endsWith("jwks.json"))
        return Response.json({
          keys: [{ ...jwk, kid: "test", use: "sig", alg: "RS256" }],
        });
      if (url.endsWith("openid-configuration"))
        return Response.json({
          revocation_endpoint:
            "https://auth.openai.com/api/accounts/oauth/revoke",
        });
      if (url.endsWith("revoke")) return new Response(null, { status: 200 });
      if (url.endsWith("models"))
        return Response.json({
          models: [
            {
              slug: "account-model",
              display_name: "Account Model",
              visibility: "list",
            },
          ],
        });
      const id = await new SignJWT({
        nonce,
        email: "synthetic@example.invalid",
      })
        .setProtectedHeader({ alg: "RS256", kid: "test" })
        .setIssuer("https://auth.openai.com")
        .setSubject(subject)
        .setAudience(body.get("client_id")!)
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(privateKey);
      return Response.json({
        token_type: "Bearer",
        access_token: body.has("refresh_token")
          ? "synthetic-rotated-access"
          : "synthetic-access",
        refresh_token: body.has("refresh_token")
          ? "synthetic-rotated-refresh"
          : "synthetic-refresh",
        id_token: badSignature ? id.slice(0, -12) + "aaaaaaaaaaaa" : id,
        expires_in: 3600,
        scope: grant,
      });
    });
    const connections = new ChatGPTConnections(f.store, fetcher);
    async function start(reference?: string) {
      const attempt = await connections.start("admin", 8125, reference);
      nonce = new URL(attempt.authorization_url).searchParams.get("nonce")!;
      return attempt;
    }
    async function complete(
      attempt: Awaited<ReturnType<typeof start>>,
      clientId = "oaiapp_synthetic",
    ) {
      return connections.complete("admin", {
        reference: attempt.reference,
        state: attempt.state,
        authorization_code: "synthetic-code",
        client_id: clientId,
      });
    }
    return {
      connections,
      fetcher,
      calls,
      start,
      complete,
      setSubject: (v: string) => {
        subject = v;
      },
      setNonce: (v: string) => {
        nonce = v;
      },
      setGrant: (v: string) => {
        grant = v;
      },
      badSignature: () => {
        badSignature = true;
      },
    };
  }
  it("uses PKCE and stable host identity, validates a signed ID token, and reuses issued client IDs", async () => {
    const h = await fixture();
    const first = await h.start();
    const url = new URL(first.authorization_url);
    expect(url.origin + url.pathname).toBe(
      "https://auth.openai.com/api/accounts/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("agent_name_hint")).toBe(
      "TencentDB Agent Memory",
    );
    const info = await h.complete(first);
    expect(info).toMatchObject({
      status: "connected",
      client_id: "oaiapp_synthetic",
      subject: "synthetic-account",
    });
    expect(JSON.stringify(await h.connections.list())).not.toContain(
      "synthetic-access",
    );
    expect(JSON.stringify(f.store.listModelStates("oauth:"))).not.toContain(
      "synthetic-refresh",
    );
    const returning = await h.start(first.reference);
    const next = new URL(returning.authorization_url);
    expect(next.searchParams.get("client_id")).toBe("oaiapp_synthetic");
    expect(next.searchParams.get("ext_agent_host_id")).toBe(
      url.searchParams.get("ext_agent_host_id"),
    );
    expect(next.searchParams.has("agent_name_hint")).toBe(false);
    await h.connections.complete("admin", {
      reference: returning.reference,
      state: returning.state,
      authorization_code: "new-code",
    });
    expect(
      h.calls
        .find((c) => c.body.get("grant_type") === "authorization_code")
        ?.body.get("redirect_uri"),
    ).toBe("http://127.0.0.1:8125/auth/callback");
  });
  it.each(["state", "owner", "nonce", "signature", "scopes", "client_id"])(
    "rejects invalid %s without connecting",
    async (kind) => {
      const h = await fixture();
      const attempt = await h.start();
      if (kind === "nonce") h.setNonce("different");
      if (kind === "signature") h.badSignature();
      if (kind === "scopes") h.setGrant("openid profile");
      await expect(
        h.connections.complete(kind === "owner" ? "other-admin" : "admin", {
          reference: attempt.reference,
          state: kind === "state" ? "wrong" : attempt.state,
          authorization_code: "code",
          client_id:
            kind === "client_id" ? "dynamic_agent_client" : "oaiapp_synthetic",
        }),
      ).rejects.toThrow();
      expect(
        (await h.connections.list()).some((c) => c.status === "connected"),
      ).toBe(false);
    },
  );
  it("rejects callback replay and an account mismatch without overwriting an existing identity", async () => {
    const h = await fixture();
    const first = await h.start();
    await h.complete(first);
    await expect(h.complete(first)).rejects.toThrow("CHATGPT_STATE_INVALID");
    const second = await h.start(first.reference);
    h.setSubject("other-account");
    await expect(h.complete(second)).rejects.toThrow(
      "CHATGPT_ACCOUNT_MISMATCH",
    );
    expect((await h.connections.get(first.reference)).subject).toBe(
      "synthetic-account",
    );
  });
  it("serializes rotating refresh tokens across two Core service objects and stores replacement atomically", async () => {
    const h = await fixture();
    const first = await h.start();
    await h.complete(first);
    const state = f.store.getModelState(`oauth:${first.reference}`)!;
    const credential = JSON.parse(decryptUpstreamKey(state.value));
    credential.expires_at = 0;
    f.store.setModelState(
      state.key,
      encryptUpstreamKey(JSON.stringify(credential)),
      state.version,
    );
    const another = new ChatGPTConnections(f.store, h.fetcher);
    const tokens = await Promise.all([
      h.connections.accessToken(first.reference),
      another.accessToken(first.reference),
      h.connections.accessToken(first.reference),
    ]);
    expect(tokens).toEqual(Array(3).fill("synthetic-rotated-access"));
    expect(
      h.calls.filter((c) => c.body.get("grant_type") === "refresh_token"),
    ).toHaveLength(1);
    const saved = JSON.parse(
      decryptUpstreamKey(f.store.getModelState(state.key)!.value),
    );
    expect(saved).toMatchObject({
      access_token: "synthetic-rotated-access",
      refresh_token: "synthetic-rotated-refresh",
      status: "connected",
    });
    expect(saved.operation).toBeUndefined();
  });
  it("disconnects without exposing tokens, retains registration, and requires login for subsequent inference", async () => {
    const h = await fixture();
    const first = await h.start();
    await h.complete(first);
    expect(await h.connections.disconnect(first.reference)).toEqual({
      disconnected: true,
      remote_revocation_confirmed: true,
    });
    await expect(h.connections.accessToken(first.reference)).rejects.toThrow(
      "CHATGPT_REAUTH_REQUIRED",
    );
    const state = f.store.getModelState(`oauth:${first.reference}`)!;
    expect(JSON.parse(decryptUpstreamKey(state.value))).not.toHaveProperty(
      "refresh_token",
    );
    expect(
      new URL(
        (await h.start(first.reference)).authorization_url,
      ).searchParams.get("client_id"),
    ).toBe("oaiapp_synthetic");
  });
  it("expires pending PKCE records and marks rejected account credentials for a new login", async () => {
    const h = await fixture();
    const first = await h.start();
    const row = f.store.getModelState(`oauth-pending:${first.reference}`)!;
    const pending = JSON.parse(decryptUpstreamKey(row.value));
    pending.expires_at = 0;
    f.store.setModelState(
      row.key,
      encryptUpstreamKey(JSON.stringify(pending)),
      row.version,
    );
    const next = await h.start();
    expect(f.store.getModelState(row.key)).toBeNull();
    await h.complete(next);
    expect(f.store.getModelState(`oauth-pending:${next.reference}`)).toBeNull();
    const catalog = new ModelCatalog(
      f.store,
      async () => new Response(null, { status: 401 }),
      h.connections,
    );
    expect(
      await catalog.discover({
        credential_kind: "chatgpt_oauth",
        credential_ref: next.reference,
      }),
    ).toMatchObject({ status: "failed", error: "CHATGPT_REAUTH_REQUIRED" });
    expect((await h.connections.get(next.reference)).status).toBe(
      "reauth_required",
    );
  });
  it("limits subscription models to the account list and keeps token data out of upstream groups", async () => {
    const h = await fixture();
    const attempt = await h.start();
    const catalog = new ModelCatalog(f.store, h.fetcher, h.connections);
    await catalog.completeLogin("admin", {
      reference: attempt.reference,
      state: attempt.state,
      authorization_code: "code",
      client_id: "oaiapp_synthetic",
    });
    await expect(
      catalog.assertSubscriptionModel(
        attempt.reference,
        "not-an-account-model",
      ),
    ).rejects.toThrow("CHATGPT_MODEL_NOT_AVAILABLE");
    const group = await f.service.createInstanceUpstreamCustomGroup(
      {
        name: "Subscription",
        agents: [],
        mode: "custom_unified",
        base_url: "https://api.openai.com/v1",
        provider_id: "openai",
        credential_kind: "chatgpt_oauth",
        credential_ref: attempt.reference,
        model_id: "account-model",
      },
      supported,
    );
    const internal =
      await f.service.listInstanceUpstreamGroupsInternal(supported);
    expect(
      internal.items.find((r) => r.group_id === group.group_id)?.api_key,
    ).toBe("");
    expect(JSON.stringify(internal)).not.toMatch(
      /synthetic-(refresh|access)|id_token/,
    );
    await expect(
      f.service.updateInstanceUpstreamGroup(
        {
          group_id: String(group.group_id),
          group_type: "custom",
          credential_kind: "api_key",
        },
        supported,
      ),
    ).rejects.toThrow("own api_key");
  });
});
