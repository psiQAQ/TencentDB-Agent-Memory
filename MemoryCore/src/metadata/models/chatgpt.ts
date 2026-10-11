import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  createLocalJWKSet,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
} from "jose";
import type { IMetadataStore } from "../store/interface.js";
import {
  encryptUpstreamKey,
  decryptUpstreamKey,
} from "../service/upstream-profile-library.js";
import { modelRequest, parseObject, type ModelFetch } from "./http.js";
import { ModelConnectionError, type ModelState } from "./types.js";

const ISSUER = "https://auth.openai.com";
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const RESOURCE = "https://api.openai.com/v1";
const SCOPES =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
interface Credential {
  reference: string;
  client_id: string;
  subject?: string;
  email?: string;
  status: "connected" | "reauth_required" | "signed_out";
  generation: number;
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_at?: number;
  scopes?: string[];
  operation?: { id: string; expires_at: number };
}
interface Attempt {
  reference: string;
  owner: string;
  state: string;
  nonce: string;
  verifier: string;
  redirect_uri: string;
  expires_at: number;
  client_id?: string;
}
export interface ConnectionInfo {
  reference: string;
  client_id: string;
  subject?: string;
  email?: string;
  status: Credential["status"];
  generation: number;
  updated_at: string;
}
type VerifyIdentity = (
  token: string,
  clientId: string,
  nonce?: string,
) => Promise<JWTPayload>;
const random = () => randomBytes(32).toString("base64url");

/** All credential records and PKCE attempts are encrypted with the existing Docker Secret. */
export class ChatGPTConnections {
  private readonly refreshing = new Map<string, Promise<string>>();
  constructor(
    private readonly store: IMetadataStore,
    private readonly fetcher: ModelFetch = fetch,
    private readonly verifyIdentity: VerifyIdentity = async (
      token,
      clientId,
      nonce,
    ) => {
      const { text } = await modelRequest(
        `${ISSUER}/.well-known/jwks.json`,
        {},
        fetcher,
      );
      const keys = parseObject(text) as unknown as JSONWebKeySet;
      try {
        const { payload } = await jwtVerify(token, createLocalJWKSet(keys), {
          issuer: ISSUER,
          audience: clientId,
          algorithms: ["RS256"],
          requiredClaims: ["sub", "exp", "iat"],
        });
        if (nonce !== undefined && payload.nonce !== nonce)
          throw new Error("nonce");
        return payload;
      } catch {
        throw new ModelConnectionError("CHATGPT_IDENTITY_INVALID", 401);
      }
    },
  ) {}

  private read<T>(row: ModelState): T {
    return JSON.parse(decryptUpstreamKey(row.value)) as T;
  }
  private async credential(
    reference: string,
  ): Promise<{ row: ModelState; value: Credential }> {
    const row = await this.store.getModelState(`oauth:${reference}`);
    if (!row)
      throw new ModelConnectionError("CHATGPT_CONNECTION_NOT_FOUND", 404);
    return { row, value: this.read<Credential>(row) };
  }
  private async save(value: Credential, version: number): Promise<ModelState> {
    const result = await this.store.setModelState(
      `oauth:${value.reference}`,
      encryptUpstreamKey(JSON.stringify(value)),
      version,
    );
    if (!result) throw new ModelConnectionError("MODEL_CONNECTION_BUSY", 409);
    return result;
  }
  private info(value: Credential, row: ModelState): ConnectionInfo {
    return {
      reference: value.reference,
      client_id: value.client_id,
      subject: value.subject,
      email: value.email,
      status: value.status,
      generation: value.generation,
      updated_at: row.updated_at,
    };
  }
  async list(): Promise<ConnectionInfo[]> {
    return (await this.store.listModelStates("oauth:")).map((row) =>
      this.info(this.read<Credential>(row), row),
    );
  }
  async get(reference: string): Promise<ConnectionInfo> {
    const { value, row } = await this.credential(reference);
    return this.info(value, row);
  }
  async markReauthRequired(reference: string): Promise<void> {
    const { value, row } = await this.credential(reference);
    if (value.status === "connected" && !value.operation) {
      await this.store.setModelState(
        row.key,
        encryptUpstreamKey(
          JSON.stringify({ ...value, status: "reauth_required" }),
        ),
        row.version,
      );
    }
  }
  private async hostId(): Promise<string> {
    const old = await this.store.getModelState("oauth-host");
    if (old) return old.value;
    const row = await this.store.setModelState(
      "oauth-host",
      `urn:uuid:${randomUUID()}`,
      0,
    );
    return (row ?? (await this.store.getModelState("oauth-host")))!.value;
  }
  async start(owner: string, port: number, reference?: string) {
    if (!owner || !Number.isInteger(port) || port < 1024 || port > 65535)
      throw new ModelConnectionError("CHATGPT_INVALID_CALLBACK");
    const saved = reference
      ? (await this.credential(reference)).value
      : undefined;
    if (!saved && (await this.list()).length >= 50)
      throw new ModelConnectionError("CHATGPT_CONNECTION_LIMIT");
    let pendingCount = 0;
    for (const row of await this.store.listModelStates("oauth-pending:")) {
      if (!row.value || this.read<Attempt>(row).expires_at < Date.now())
        await this.store.deleteModelState(row.key, row.version);
      else pendingCount++;
    }
    if (pendingCount >= 50)
      throw new ModelConnectionError("CHATGPT_LOGIN_BUSY", 429);
    const attempt: Attempt = {
      reference: reference ?? randomUUID(),
      owner,
      state: random(),
      nonce: random(),
      verifier: random(),
      redirect_uri: `http://127.0.0.1:${port}/auth/callback`,
      expires_at: Date.now() + 600_000,
      client_id: saved?.client_id,
    };
    const params = new URLSearchParams({
      client_id: saved?.client_id ?? "dynamic_agent_client",
      ext_agent_host_id: await this.hostId(),
      response_type: "code",
      redirect_uri: attempt.redirect_uri,
      scope: SCOPES,
      resource: RESOURCE,
      state: attempt.state,
      nonce: attempt.nonce,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256")
        .update(attempt.verifier)
        .digest("base64url"),
    });
    if (!saved) params.set("agent_name_hint", "TencentDB Agent Memory");
    if (saved?.id_token) params.set("id_token_hint", saved.id_token);
    if (saved?.email) params.set("login_hint", saved.email);
    // One pending attempt per connection. Starting another login invalidates the earlier callback.
    const key = `oauth-pending:${attempt.reference}`;
    const old = await this.store.getModelState(key);
    if (
      !(await this.store.setModelState(
        key,
        encryptUpstreamKey(JSON.stringify(attempt)),
        old?.version ?? 0,
      ))
    ) {
      throw new ModelConnectionError("MODEL_CONNECTION_BUSY", 409);
    }
    return {
      authorization_url: `${ISSUER}/api/accounts/authorize?${params}`,
      state: attempt.state,
      reference: attempt.reference,
      expires_at: attempt.expires_at,
      redirect_uri: attempt.redirect_uri,
    };
  }
  private async exchange(params: Record<string, string>) {
    const { text } = await modelRequest(
      TOKEN_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...params, resource: RESOURCE }),
      },
      this.fetcher,
    );
    return parseObject(text);
  }
  private tokens(
    data: Record<string, unknown>,
    previous?: Credential,
  ): Pick<
    Credential,
    "access_token" | "refresh_token" | "id_token" | "scopes" | "expires_at"
  > {
    const scopes =
      typeof data.scope === "string"
        ? data.scope.split(/\s+/)
        : previous?.scopes;
    if (
      !scopes?.includes("chatgpt.tokens.use.direct") ||
      !scopes.includes("resource.invoke")
    ) {
      throw new ModelConnectionError("CHATGPT_PLAN_PERMISSION_REQUIRED", 403);
    }
    if (
      typeof data.access_token !== "string" ||
      !data.access_token ||
      typeof data.expires_in !== "number" ||
      data.expires_in <= 0 ||
      !Number.isFinite(data.expires_in) ||
      String(data.token_type).toLowerCase() !== "bearer"
    ) {
      throw new ModelConnectionError("CHATGPT_INVALID_TOKEN_RESPONSE", 502);
    }
    const refresh =
      typeof data.refresh_token === "string" && data.refresh_token
        ? data.refresh_token
        : previous?.refresh_token;
    if (!refresh)
      throw new ModelConnectionError("CHATGPT_REFRESH_TOKEN_MISSING", 502);
    return {
      access_token: data.access_token,
      refresh_token: refresh,
      id_token:
        typeof data.id_token === "string" ? data.id_token : previous?.id_token,
      scopes,
      expires_at: Date.now() + data.expires_in * 1000,
    };
  }
  async complete(
    owner: string,
    input: {
      reference: string;
      state: string;
      authorization_code?: string;
      client_id?: string;
      error?: string;
    },
  ) {
    const key = `oauth-pending:${input.reference}`;
    const pending = await this.store.getModelState(key);
    if (!pending || !pending.value)
      throw new ModelConnectionError("CHATGPT_STATE_INVALID", 401);
    const attempt = this.read<Attempt>(pending);
    if (
      attempt.owner !== owner ||
      attempt.state !== input.state ||
      attempt.expires_at < Date.now()
    )
      throw new ModelConnectionError("CHATGPT_STATE_INVALID", 401);
    if (!(await this.store.deleteModelState(key, pending.version)))
      throw new ModelConnectionError("CHATGPT_STATE_INVALID", 401);
    if (input.error)
      throw new ModelConnectionError("CHATGPT_AUTHORIZATION_DENIED", 403);
    const clientId = attempt.client_id ?? input.client_id;
    if (
      !clientId ||
      clientId === "dynamic_agent_client" ||
      (attempt.client_id &&
        input.client_id &&
        attempt.client_id !== input.client_id)
    ) {
      throw new ModelConnectionError("CHATGPT_CLIENT_ID_INVALID", 401);
    }
    if (!input.authorization_code)
      throw new ModelConnectionError("CHATGPT_CODE_MISSING");
    let existing = await this.store.getModelState(`oauth:${attempt.reference}`);
    const old = existing ? this.read<Credential>(existing) : undefined;
    if (old?.operation && old.operation.expires_at > Date.now())
      throw new ModelConnectionError("MODEL_CONNECTION_BUSY", 409);
    const base: Credential = old ?? {
      reference: attempt.reference,
      client_id: clientId,
      generation: 0,
      status: "signed_out",
    };
    // Persist the issued ID before exchange, including when an authorization code has expired.
    const lease = {
      ...base,
      operation: { id: randomUUID(), expires_at: Date.now() + 60_000 },
    };
    existing = await this.save(lease, existing?.version ?? 0);
    try {
      const data = await this.exchange({
        grant_type: "authorization_code",
        client_id: clientId,
        code: input.authorization_code,
        code_verifier: attempt.verifier,
        redirect_uri: attempt.redirect_uri,
      });
      if (typeof data.id_token !== "string")
        throw new ModelConnectionError("CHATGPT_IDENTITY_INVALID", 401);
      const identity = await this.verifyIdentity(
        data.id_token,
        clientId,
        attempt.nonce,
      );
      if (!identity.sub || (old?.subject && identity.sub !== old.subject))
        throw new ModelConnectionError("CHATGPT_ACCOUNT_MISMATCH", 401);
      const next: Credential = {
        ...base,
        ...this.tokens(data),
        status: "connected",
        subject: identity.sub,
        email: typeof identity.email === "string" ? identity.email : undefined,
        generation: base.generation + 1,
        operation: undefined,
      };
      const row = await this.save(next, existing.version);
      return this.info(next, row);
    } catch (error) {
      await this.save({ ...base, operation: undefined }, existing.version);
      throw error;
    }
  }
  async accessToken(reference: string): Promise<string> {
    const running = this.refreshing.get(reference);
    if (running) return running;
    const task = this.resolveToken(reference);
    this.refreshing.set(reference, task);
    try {
      return await task;
    } finally {
      this.refreshing.delete(reference);
    }
  }
  private async resolveToken(reference: string): Promise<string> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const { row, value } = await this.credential(reference);
      if (value.operation) {
        if (value.operation.expires_at < Date.now())
          throw new ModelConnectionError("CHATGPT_REAUTH_REQUIRED", 401);
        await new Promise((resolve) => setTimeout(resolve, 200));
        continue;
      }
      if (value.status !== "connected" || !value.refresh_token)
        throw new ModelConnectionError("CHATGPT_REAUTH_REQUIRED", 401);
      if (value.access_token && (value.expires_at ?? 0) > Date.now() + 60_000)
        return value.access_token;
      const lease = {
        ...value,
        operation: { id: randomUUID(), expires_at: Date.now() + 60_000 },
      };
      const claimed = await this.store.setModelState(
        row.key,
        encryptUpstreamKey(JSON.stringify(lease)),
        row.version,
      );
      if (!claimed) continue;
      try {
        const data = await this.exchange({
          grant_type: "refresh_token",
          client_id: value.client_id,
          refresh_token: value.refresh_token,
        });
        if (typeof data.id_token === "string") {
          const identity = await this.verifyIdentity(
            data.id_token,
            value.client_id,
          );
          if (identity.sub !== value.subject)
            throw new ModelConnectionError("CHATGPT_ACCOUNT_MISMATCH", 401);
        }
        const next = {
          ...value,
          ...this.tokens(data, value),
          operation: undefined,
        };
        await this.save(next, claimed.version);
        return next.access_token!;
      } catch (error) {
        // A lost refresh response can have consumed a rotating token. Require login instead of racing a retry.
        await this.save(
          { ...value, status: "reauth_required", operation: undefined },
          claimed.version,
        );
        throw error;
      }
    }
    throw new ModelConnectionError("MODEL_CONNECTION_BUSY", 409);
  }
  async disconnect(reference: string) {
    const { row, value } = await this.credential(reference);
    if (value.operation && value.operation.expires_at > Date.now())
      throw new ModelConnectionError("MODEL_CONNECTION_BUSY", 409);
    // Stop new requests before attempting revocation. Keep mapping for a later sign-in.
    const signedOut: Credential = {
      reference,
      client_id: value.client_id,
      subject: value.subject,
      email: value.email,
      generation: value.generation + 1,
      status: "signed_out",
    };
    await this.save(signedOut, row.version);
    let revoked = !value.refresh_token;
    if (value.refresh_token) {
      try {
        const { text } = await modelRequest(
          `${ISSUER}/.well-known/openid-configuration`,
          {},
          this.fetcher,
        );
        const endpoint = parseObject(text).revocation_endpoint;
        if (typeof endpoint !== "string" || new URL(endpoint).origin !== ISSUER)
          throw new Error("invalid issuer");
        for (let retry = 0; retry < 2; retry++) {
          try {
            await modelRequest(
              endpoint,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/x-www-form-urlencoded",
                },
                body: new URLSearchParams({
                  token: value.refresh_token,
                  token_type_hint: "refresh_token",
                  client_id: value.client_id,
                }),
              },
              this.fetcher,
            );
            revoked = true;
            break;
          } catch {
            if (retry === 0)
              await new Promise((resolve) => setTimeout(resolve, 250));
          }
        }
      } catch {
        /* Local sign-out is complete; expose remote revocation uncertainty. */
      }
    }
    return { disconnected: true, remote_revocation_confirmed: revoked };
  }
}
