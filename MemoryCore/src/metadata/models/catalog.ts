import type { IMetadataStore } from "../store/interface.js";
import type { InstanceUpstreamConfigEntity } from "../types.js";
import { decryptUpstreamKey } from "../service/upstream-profile-library.js";
import { BUILTIN_CATALOG } from "./builtin-catalog.js";
import { ChatGPTConnections } from "./chatgpt.js";
import { modelRequest, type ModelFetch } from "./http.js";
import {
  digest,
  discoverModels,
  inferProvider,
  mergeModel,
  parsePiCatalog,
  PI_CATALOG_URL,
  PROVIDERS,
  type DiscoveredProvider,
} from "./providers.js";
import {
  ModelConnectionError,
  type ModelSnapshot,
  type CatalogModel,
  type ModelAuthFields,
  type ProviderId,
} from "./types.js";

export interface DiscoveryInput extends ModelAuthFields {
  provider_id?: ProviderId;
  base_url?: string;
  api_key?: string;
  group_id?: string;
}
interface Source {
  id: string;
  key: string;
  provider_id: ProviderId;
  credential_kind: "api_key" | "chatgpt_oauth";
  label: string;
  group_id?: string;
  reference?: string;
  row?: InstanceUpstreamConfigEntity;
}
interface RefreshResult {
  source: string;
  status: "succeeded" | "failed";
  added: number;
  removed: number;
  changed: number;
  error?: string;
  updated_at: string | null;
  revision?: string;
}
export class ModelCatalog {
  readonly chatgpt: ChatGPTConnections;
  private readonly refreshing = new Map<string, Promise<RefreshResult>>();
  constructor(
    private readonly store: IMetadataStore,
    private readonly fetcher: ModelFetch = fetch,
    chatgpt?: ChatGPTConnections,
  ) {
    this.chatgpt = chatgpt ?? new ChatGPTConnections(store, fetcher);
  }
  private async snapshot(key: string): Promise<ModelSnapshot | null> {
    const row = await this.store.getModelState(key);
    if (!row) return null;
    try {
      const value = JSON.parse(row.value) as ModelSnapshot;
      if (Array.isArray(value.models)) return value;
    } catch {
      /* Restore bundled metadata if a cache is invalid. */
    }
    return null;
  }
  async publicCatalog(): Promise<ModelSnapshot> {
    return (await this.snapshot("catalog:pi")) ?? BUILTIN_CATALOG;
  }
  private async sourceForGroup(
    row: InstanceUpstreamConfigEntity,
  ): Promise<Source> {
    if (row.credential_kind === "chatgpt_oauth")
      return this.sourceForOAuth(row.credential_ref ?? "");
    const provider = row.provider_id ?? inferProvider(row.base_url);
    return {
      id: row.group_id,
      label: row.name || "总结模型",
      group_id: row.group_id,
      row,
      provider_id: provider,
      credential_kind: "api_key",
      key: `account:${row.group_id}:${digest(JSON.stringify([provider, row.base_url, row.api_key]))}`,
    };
  }
  private async sourceForOAuth(reference: string): Promise<Source> {
    const info = await this.chatgpt.get(reference);
    return {
      id: reference,
      label: info.email ?? "ChatGPT 订阅",
      reference,
      key: `account:oauth:${reference}:${info.generation}`,
      provider_id: "openai",
      credential_kind: "chatgpt_oauth",
    };
  }
  private async sources(): Promise<Source[]> {
    const rows = await this.store.listInstanceUpstreamGroups();
    const sources = await Promise.all(
      rows
        .filter(
          (r) =>
            r.group_type !== "default" &&
            r.mode === "custom_unified" &&
            r.credential_kind !== "chatgpt_oauth" &&
            r.api_key,
        )
        .map((r) => this.sourceForGroup(r)),
    );
    for (const info of await this.chatgpt.list())
      sources.push(await this.sourceForOAuth(info.reference));
    return sources;
  }
  async list() {
    const catalog = await this.publicCatalog();
    const connections = await Promise.all(
      (await this.sources()).map(async (source) => ({
        connection_id: source.id,
        group_id: source.group_id,
        reference: source.reference,
        provider_id: source.provider_id,
        credential_kind: source.credential_kind,
        base_url: source.row?.base_url,
        snapshot: await this.snapshot(source.key),
      })),
    );
    return {
      providers: PROVIDERS,
      public_catalog: catalog,
      connections,
      subscriptions: await this.chatgpt.list(),
    };
  }
  private update(
    key: string,
    source: string,
    load: () => Promise<ModelSnapshot>,
    stillValid: () => Promise<boolean> = async () => true,
  ): Promise<RefreshResult> {
    const pending = this.refreshing.get(key);
    if (pending) return pending;
    const task = this.performUpdate(key, source, load, stillValid).finally(
      () => {
        this.refreshing.delete(key);
      },
    );
    this.refreshing.set(key, task);
    return task;
  }
  private async performUpdate(
    key: string,
    source: string,
    load: () => Promise<ModelSnapshot>,
    stillValid: () => Promise<boolean>,
  ): Promise<RefreshResult> {
    const row = await this.store.getModelState(key);
    const old =
      (await this.snapshot(key)) ??
      (key === "catalog:pi" ? BUILTIN_CATALOG : null);
    try {
      const next = await load();
      if (!(await stillValid()))
        throw new ModelConnectionError("MODEL_CREDENTIALS_CHANGED", 409);
      if (
        !(await this.store.setModelState(
          key,
          JSON.stringify(next),
          row?.version ?? 0,
        ))
      )
        throw new ModelConnectionError("MODEL_REFRESH_CONFLICT", 409);
      const before = new Map(
        (old?.models ?? []).map((m) => [
          `${m.provider_id}/${m.id}`,
          JSON.stringify(m),
        ]),
      );
      const after = new Map(
        next.models.map((m) => [`${m.provider_id}/${m.id}`, JSON.stringify(m)]),
      );
      return {
        source,
        status: "succeeded",
        revision: next.revision,
        updated_at: next.updated_at,
        added: [...after.keys()].filter((id) => !before.has(id)).length,
        removed: [...before.keys()].filter((id) => !after.has(id)).length,
        changed: [...after.keys()].filter(
          (id) => before.has(id) && before.get(id) !== after.get(id),
        ).length,
      };
    } catch (error) {
      const code =
        error instanceof ModelConnectionError
          ? error.code
          : "MODEL_SOURCE_UNAVAILABLE";
      const retained =
        old ??
        (key === "catalog:pi"
          ? BUILTIN_CATALOG
          : { revision: "", updated_at: "", models: [] });
      // CAS prevents a failed concurrent request from overwriting a successful snapshot.
      await this.store.setModelState(
        key,
        JSON.stringify({
          ...retained,
          error: code,
          attempted_at: new Date().toISOString(),
        }),
        row?.version ?? 0,
      );
      return {
        source,
        status: "failed",
        error: code,
        added: 0,
        removed: 0,
        changed: 0,
        updated_at: retained.updated_at || null,
      };
    }
  }
  private async loadAccount(source: Source): Promise<ModelSnapshot> {
    const subscription = source.credential_kind === "chatgpt_oauth";
    const token = subscription
      ? await this.chatgpt.accessToken(source.reference!)
      : decryptUpstreamKey(source.row!.api_key);
    const base = subscription
      ? PROVIDERS.openai.base_url
      : source.row!.base_url;
    try {
      const models = await discoverModels(
        source.provider_id as DiscoveredProvider,
        token,
        base,
        subscription,
        this.fetcher,
      );
      return {
        revision: digest(JSON.stringify(models)),
        updated_at: new Date().toISOString(),
        models,
      };
    } catch (error) {
      if (
        subscription &&
        error instanceof ModelConnectionError &&
        error.code === "MODEL_AUTH_REQUIRED"
      ) {
        await this.chatgpt.markReauthRequired(source.reference!);
        throw new ModelConnectionError("CHATGPT_REAUTH_REQUIRED", 401);
      }
      throw error;
    }
  }
  private async refreshSource(source: Source) {
    const result = await this.update(
      source.key,
      source.id,
      () => this.loadAccount(source),
      async () => {
        if (source.reference)
          return (
            (await this.sourceForOAuth(source.reference)).key === source.key
          );
        const row = await this.store.getInstanceUpstreamGroup(source.group_id!);
        return !!row && (await this.sourceForGroup(row)).key === source.key;
      },
    );
    return { ...result, source_label: source.label };
  }
  async refresh() {
    const publicUpdate = this.update("catalog:pi", "pi", async () => {
      const { response, text } = await modelRequest(
        PI_CATALOG_URL,
        { headers: { "User-Agent": "TencentDB-Agent-Memory/model-catalog" } },
        this.fetcher,
      );
      const revision = response.headers.get("x-pi-model-catalog-revision");
      return {
        revision: revision!,
        models: parsePiCatalog(text, revision),
        updated_at: new Date().toISOString(),
      };
    });
    const results = await Promise.all([
      publicUpdate,
      ...(await this.sources()).map((source) => this.refreshSource(source)),
    ]);
    return {
      status: results.every((r) => r.status === "succeeded")
        ? "succeeded"
        : results.every((r) => r.status === "failed")
          ? "failed"
          : "partial",
      results,
    };
  }
  async discover(input: DiscoveryInput) {
    let source: Source | undefined;
    if (input.credential_kind === "chatgpt_oauth") {
      if (input.api_key)
        throw new ModelConnectionError("MODEL_INVALID_AUTH_TYPE");
      source = await this.sourceForOAuth(input.credential_ref ?? "");
    } else if (input.group_id && input.api_key === undefined) {
      const row = await this.store.getInstanceUpstreamGroup(input.group_id);
      if (!row) throw new ModelConnectionError("MODEL_GROUP_NOT_FOUND", 404);
      if (
        row.credential_kind === "chatgpt_oauth" ||
        (input.base_url && input.base_url !== row.base_url) ||
        (input.provider_id &&
          input.provider_id !==
            (row.provider_id ?? inferProvider(row.base_url)))
      )
        throw new ModelConnectionError("MODEL_CREDENTIALS_CHANGED");
      source = await this.sourceForGroup(row);
    }
    const catalog = await this.publicCatalog();
    if (source) {
      const result = await this.refreshSource(source);
      const snapshot = await this.snapshot(source.key);
      return {
        ...result,
        models: (snapshot?.models ?? []).map((m) =>
          mergeModel(m, catalog.models),
        ),
        persisted: true,
      };
    }
    // Draft keys exist only in this request. No draft credential or account snapshot is persisted.
    const models = await discoverModels(
      input.provider_id as DiscoveredProvider,
      input.api_key ?? "",
      input.base_url ?? "",
      false,
      this.fetcher,
    );
    return {
      status: "succeeded" as const,
      models: models.map((m) => mergeModel(m, catalog.models)),
      persisted: false,
      updated_at: new Date().toISOString(),
    };
  }
  async assertSubscriptionModel(reference: string, modelId: string) {
    const info = await this.chatgpt.get(reference);
    if (info.status !== "connected")
      throw new ModelConnectionError("CHATGPT_REAUTH_REQUIRED", 401);
    const source = await this.sourceForOAuth(reference);
    const snapshot = await this.snapshot(source.key);
    if (!snapshot?.models.some((m) => m.id === modelId))
      throw new ModelConnectionError("CHATGPT_MODEL_NOT_AVAILABLE");
  }
  async completeLogin(
    owner: string,
    input: Parameters<ChatGPTConnections["complete"]>[1],
  ) {
    const connection = await this.chatgpt.complete(owner, input);
    const discovery = await this.refreshSource(
      await this.sourceForOAuth(connection.reference),
    );
    return { connection, discovery };
  }
  async resolveSubscription(input: {
    group_id?: string;
    credential_ref?: string;
    model_id: string;
  }) {
    let reference = input.credential_ref;
    if (input.group_id) {
      const row = await this.store.getInstanceUpstreamGroup(input.group_id);
      if (
        !row?.enabled ||
        row.credential_kind !== "chatgpt_oauth" ||
        row.model_id !== input.model_id
      )
        throw new ModelConnectionError("MODEL_CREDENTIALS_CHANGED", 409);
      reference = row.credential_ref;
    }
    if (!reference)
      throw new ModelConnectionError("CHATGPT_CONNECTION_NOT_FOUND", 404);
    await this.assertSubscriptionModel(reference, input.model_id);
    return {
      access_token: await this.chatgpt.accessToken(reference),
      base_url: PROVIDERS.openai.base_url,
    };
  }
}
