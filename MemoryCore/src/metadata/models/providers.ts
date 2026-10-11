import { createHash } from "node:crypto";
import { modelRequest, parseObject, record, type ModelFetch } from "./http.js";
import {
  ModelConnectionError,
  type CatalogModel,
  type ProviderId,
} from "./types.js";

export const PI_CATALOG_URL =
  "https://pi.dev/api/models?types=chat,image,classifier";
export const PROVIDERS = {
  deepseek: {
    base_url: "https://api.deepseek.com",
    protocols: ["openai-chat", "openai-responses", "anthropic"],
  },
  openai: {
    base_url: "https://api.openai.com/v1",
    protocols: ["openai-chat", "openai-responses"],
  },
  anthropic: {
    base_url: "https://api.anthropic.com/v1",
    protocols: ["anthropic"],
  },
  gemini: {
    base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
    protocols: ["openai-chat"],
  },
} as const;
export type DiscoveredProvider = keyof typeof PROVIDERS;
export function inferProvider(baseUrl: string): ProviderId {
  try {
    const url = new URL(baseUrl);
    for (const [provider, config] of Object.entries(PROVIDERS)) {
      if (url.origin === new URL(config.base_url).origin)
        return provider as DiscoveredProvider;
    }
    if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      return "local";
  } catch {
    /* Custom endpoints are validated by upstream settings. */
  }
  return "custom";
}
const positive = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
const price = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
const strings = (value: unknown) =>
  Array.isArray(value) && value.every((v) => typeof v === "string")
    ? (value as string[])
    : undefined;
export function digest(text: string): string {
  return `sha256-${createHash("sha256").update(text).digest("hex")}`;
}

export function parsePiCatalog(
  text: string,
  revision: string | null,
): CatalogModel[] {
  if (
    !revision ||
    !/^sha256-[a-f0-9]{64}$/.test(revision) ||
    digest(text) !== revision
  ) {
    throw new ModelConnectionError("CATALOG_REVISION_MISMATCH", 502);
  }
  const data = parseObject(text);
  const models: CatalogModel[] = [];
  for (const [upstream, provider] of Object.entries({
    deepseek: "deepseek",
    openai: "openai",
    anthropic: "anthropic",
    google: "gemini",
  } as const)) {
    const entries = data[upstream];
    if (!Array.isArray(entries))
      throw new ModelConnectionError("CATALOG_INVALID_PROVIDER", 502);
    const ids = new Set<string>();
    for (const item of entries) {
      if (!record(item))
        throw new ModelConnectionError("CATALOG_INVALID_MODEL", 502);
      if (item.type !== "chat") continue;
      if (
        typeof item.id !== "string" ||
        !item.id ||
        item.id.length > 256 ||
        typeof item.name !== "string" ||
        ids.has(item.id)
      ) {
        throw new ModelConnectionError("CATALOG_INVALID_MODEL", 502);
      }
      ids.add(item.id);
      const cost = record(item.cost) ? item.cost : {};
      models.push({
        id: item.id,
        name: item.name,
        provider_id: provider,
        context_window: positive(item.contextWindow),
        max_output_tokens: positive(item.maxTokens),
        reasoning:
          typeof item.reasoning === "boolean" ? item.reasoning : undefined,
        input_modalities: strings(item.input),
        reference_price: {
          input: price(cost.input),
          output: price(cost.output),
          cache_read: price(cost.cacheRead),
          cache_write: price(cost.cacheWrite),
        },
        // Pi's api field selects its adapter; it is not an exclusive model capability.
        protocols: [...PROVIDERS[provider].protocols],
        sources: ["pi"],
      });
    }
  }
  if (!models.length) throw new ModelConnectionError("CATALOG_EMPTY", 502);
  return models;
}

/** Discovery endpoints are local policy. Credentials never follow catalog URLs or redirects. */
export async function discoverModels(
  provider: DiscoveredProvider,
  apiKey: string,
  baseUrl: string,
  subscription = false,
  fetcher: ModelFetch = fetch,
): Promise<CatalogModel[]> {
  const config = PROVIDERS[provider];
  const base = baseUrl.replace(/\/+$/, "");
  if (
    !config ||
    (base !== config.base_url &&
      !(provider === "deepseek" && base === `${config.base_url}/v1`))
  ) {
    throw new ModelConnectionError(
      "MODEL_DISCOVERY_REQUIRES_OFFICIAL_ENDPOINT",
    );
  }
  if (!apiKey) throw new ModelConnectionError("MODEL_AUTH_REQUIRED", 401);
  if (subscription && provider !== "openai")
    throw new ModelConnectionError("MODEL_INVALID_AUTH_TYPE");
  const headers: Record<string, string> =
    provider === "anthropic"
      ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
      : { Authorization: `Bearer ${apiKey}` };
  const models: CatalogModel[] = [];
  const seen = new Set<string>();
  const cursors = new Set<string>();
  let cursor = "";
  const deadline = Date.now() + 60_000;
  for (let page = 0; page < 100; page++) {
    if (Date.now() >= deadline)
      throw new ModelConnectionError("MODEL_PAGINATION_TIMEOUT", 502);
    const url = new URL(`${config.base_url}/models`);
    if (provider === "anthropic") {
      url.searchParams.set("limit", "1000");
      if (cursor) url.searchParams.set("after_id", cursor);
    } else if (cursor) url.searchParams.set("pageToken", cursor);
    const { text } = await modelRequest(url.href, { headers }, fetcher);
    const data = parseObject(text);
    const entries = subscription ? data.models : data.data;
    if (!Array.isArray(entries))
      throw new ModelConnectionError("MODEL_INVALID_RESPONSE", 502);
    for (const item of entries) {
      if (!record(item))
        throw new ModelConnectionError("MODEL_INVALID_RESPONSE", 502);
      if (subscription && item.visibility !== "list") continue;
      const id = subscription ? item.slug : item.id;
      if (typeof id !== "string" || !id || id.length > 256)
        throw new ModelConnectionError("MODEL_INVALID_RESPONSE", 502);
      if (seen.has(id)) continue;
      seen.add(id);
      const capabilities = record(item.capabilities) ? item.capabilities : {};
      const effort = record(item.effort) ? item.effort : {};
      const effortLevels = strings(effort.supported_levels);
      const reasoning =
        typeof item.reasoning === "boolean"
          ? item.reasoning
          : record(capabilities.thinking) &&
              typeof capabilities.thinking.supported === "boolean"
            ? capabilities.thinking.supported
            : effortLevels
              ? effortLevels.length > 0
              : undefined;
      const apiCapabilities = record(item.api_capabilities)
        ? item.api_capabilities
        : {};
      const anthropic = record(apiCapabilities.anthropic_messages)
        ? apiCapabilities.anthropic_messages
        : {};
      models.push({
        id,
        name:
          typeof item.display_name === "string"
            ? item.display_name
            : typeof item.name === "string"
              ? item.name
              : id,
        provider_id: provider,
        context_window: positive(item.context_window),
        max_input_tokens: positive(item.max_input_tokens),
        max_output_tokens: positive(item.max_output_tokens ?? item.max_tokens),
        reasoning,
        effort_levels: effortLevels,
        capabilities: Object.keys(capabilities).length
          ? Object.fromEntries(
              Object.entries(capabilities).flatMap(([name, value]) =>
                record(value) && typeof value.supported === "boolean"
                  ? [[name, value.supported]]
                  : [],
              ),
            )
          : undefined,
        system_prompt_update:
          typeof anthropic.system_prompt_update === "string"
            ? anthropic.system_prompt_update
            : undefined,
        lifecycle:
          typeof item.lifecycle === "string" ? item.lifecycle : undefined,
        input_modalities: strings(item.input_modalities),
        output_modalities: strings(item.output_modalities),
        protocols: subscription ? ["openai-responses"] : [...config.protocols],
        sources: [subscription ? "chatgpt" : "account"],
      });
    }
    const next =
      provider === "anthropic"
        ? data.has_more
          ? data.last_id
          : undefined
        : data.nextPageToken;
    if (!next) {
      if (data.has_more === true)
        throw new ModelConnectionError("MODEL_INVALID_PAGINATION", 502);
      return models;
    }
    if (typeof next !== "string" || cursors.has(next))
      throw new ModelConnectionError("MODEL_INVALID_PAGINATION", 502);
    cursors.add(next);
    cursor = next;
  }
  throw new ModelConnectionError("MODEL_PAGINATION_LIMIT", 502);
}

export function mergeModel(
  account: CatalogModel,
  catalog: CatalogModel[],
): CatalogModel {
  const entry = catalog.find(
    (model) =>
      model.provider_id === account.provider_id && model.id === account.id,
  );
  if (!entry) return account;
  return {
    ...entry,
    ...Object.fromEntries(
      Object.entries(account).filter(([, value]) => value !== undefined),
    ),
    protocols: account.sources.includes("chatgpt")
      ? account.protocols
      : account.protocols.filter((protocol) =>
          entry.protocols.includes(protocol),
        ),
    name: account.name === account.id ? entry.name : account.name,
    sources: [...account.sources, "pi"],
  };
}
