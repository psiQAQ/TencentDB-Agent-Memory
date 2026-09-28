/**
 * Instance Upstream Config Cache — per-instance LLM upstream configuration
 * fetched from Core on each request.
 *
 * A failed Core read does not reuse stale credentials. A successful empty list
 * means no active model is selected for the instance.
 */

import type { CoreSkillConfig } from "./types.js";
import type { ProxyConfig } from "./types.js";

const TAG = "[instance-upstream-cache]";
const DEFAULT_TTL_MS = 0; // Every request observes activation and deletion.
const MAX_ENTRIES = 256;

// ── Types ────────────────────────────────────────────────────────────────────

export type UpstreamConfigType = "conversation" | "extraction";
export type UpstreamConfigMode = "official" | "custom_unified" | "custom_passthrough";

/** An active Panel profile from Core's internal API. */
export interface InstanceUpstreamConfigEntry {
  agent_source: string;
  type: UpstreamConfigType;
  mode: UpstreamConfigMode;
  base_url: string;
  api_key: string;
  credential_ref?: string;
  model_id: string;
  ready_protocols?: string[];
}

interface CacheEntry {
  items: InstanceUpstreamConfigEntry[];
  expiresAt: number;
}

// ── Module state ─────────────────────────────────────────────────────────────

const cache = new Map<string, CacheEntry>();

// ── Fetch from Core ──────────────────────────────────────────────────────────

async function fetchFromCore(
  config: Pick<CoreSkillConfig, "endpoint" | "serviceToken" | "timeoutMs">,
  spaceId: string,
): Promise<InstanceUpstreamConfigEntry[]> {
  const url = `${config.endpoint.replace(/\/$/, "")}/v3/internal/meta/instance-upstream/list`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.serviceToken}`,
      "x-tdai-service-id": spaceId,
      "Content-Type": "application/json",
    },
    body: "{}",
    signal: AbortSignal.timeout(config.timeoutMs || 3000),
  });

  if (!resp.ok) {
    throw new Error(`${TAG} HTTP ${resp.status} from ${url}`);
  }

  const env = await resp.json() as { code?: number; data?: { items?: InstanceUpstreamConfigEntry[] } };
  if (env.code !== 0) {
    throw new Error(`${TAG} envelope error code=${env.code}`);
  }
  return env.data?.items ?? [];
}

/** Force a fresh Core read after a Panel save; failed reads leave the prior cache intact. */
export async function refreshInstanceUpstreamConfigs(
  config: Pick<CoreSkillConfig, "endpoint" | "serviceToken" | "timeoutMs">,
  spaceId: string,
): Promise<InstanceUpstreamConfigEntry[]> {
  const fresh = await fetchFromCore(config, spaceId);
  evictIfNeeded();
  cache.set(spaceId, { items: fresh, expiresAt: Date.now() + DEFAULT_TTL_MS });
  return fresh;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Get active upstream rows for an instance.
 *
 * Returns an empty array only when Core reports no active model.
 */
export async function getInstanceUpstreamConfigs(
  config: Pick<CoreSkillConfig, "endpoint" | "serviceToken" | "timeoutMs">,
  spaceId: string,
): Promise<InstanceUpstreamConfigEntry[]> {
  if (!spaceId) return [];

  // Check cache (TTL-based, not LRU — access does NOT refresh expiry)
  const cached = cache.get(spaceId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.items;
  }

  // Cache miss or expired → fetch from Core
  let fresh: InstanceUpstreamConfigEntry[] | null = null;
  let fetchErr: unknown = null;
  try {
    fresh = await fetchFromCore(config, spaceId);
  } catch (err) {
    fetchErr = err;
  }

  if (fresh !== null) {
    // Successful Core read.
    evictIfNeeded();
    cache.set(spaceId, { items: fresh, expiresAt: Date.now() + DEFAULT_TTL_MS });
    return fresh;
  }

  throw fetchErr ?? new Error(`${TAG} configuration unavailable`);
}

export function isReadyForProtocol(cfg: InstanceUpstreamConfigEntry | null, protocol: string): boolean {
  return !!cfg && cfg.mode === "custom_unified" && !!cfg.api_key &&
    (cfg.ready_protocols ?? []).includes(protocol);
}

/**
 * Resolve a single upstream config from the cached list.
 *
 * Match priority:
 *   1. Exact (agentSource, type) match
 *   2. Fallback ("default", type) match
 *   3. null (= no config = official behavior)
 */
export function resolveUpstreamConfig(
  items: InstanceUpstreamConfigEntry[],
  agentSource: string | undefined,
  type: UpstreamConfigType,
): InstanceUpstreamConfigEntry | null {
  if (items.length === 0) return null;

  // Try exact match first
  if (agentSource && agentSource !== "default") {
    const exact = items.find((i) => i.agent_source === agentSource && i.type === type);
    if (exact) return exact;
  }

  // Fallback to "default"
  const fallback = items.find((i) => i.agent_source === "default" && i.type === type);
  return fallback ?? null;
}

/**
 * Check if a resolved config should override upstream (non-null and mode != official).
 */
export function shouldOverride(cfg: InstanceUpstreamConfigEntry | null): cfg is InstanceUpstreamConfigEntry {
  return cfg !== null && cfg.mode !== "official" && cfg.base_url !== "";
}

/** Resolve a deployment key only for the same HTTPS supplier origin. */
export function resolveInstanceCredential(
  cfg: InstanceUpstreamConfigEntry,
  proxy: ProxyConfig,
  agentSource?: string,
): string | null {
  if (cfg.mode !== "custom_unified") return "";
  if (!cfg.credential_ref) return cfg.api_key || null;
  if (cfg.credential_ref !== "deployment_default") return null;
  const deployed = (agentSource ? proxy.upstream.agents?.[agentSource] : undefined);
  const deployedUrl = deployed?.url || proxy.upstream.url;
  const deployedKey = deployed?.apiKey || proxy.upstream.apiKey;
  try {
    const target = new URL(cfg.base_url);
    const expected = new URL(deployedUrl);
    if (target.protocol !== "https:" || target.origin !== expected.origin ||
        target.username || target.password || target.search || target.hash) return null;
    return deployedKey || null;
  } catch {
    return null;
  }
}

/** DeepSeek has distinct Anthropic and Responses prefixes behind one supplier host. */
export function resolveInstanceTargetUrl(cfg: InstanceUpstreamConfigEntry, original: string): string {
  try {
    const base = new URL(cfg.base_url);
    if (base.hostname !== "api.deepseek.com") return original;
    if (/\/messages$/.test(original)) return `${base.origin}/anthropic/v1/messages`;
    if (/\/responses$/.test(original)) return `${base.origin}/responses`;
    if (/\/chat\/completions$/.test(original)) return `${base.origin}/chat/completions`;
  } catch { /* Invalid endpoints are rejected by credential resolution. */ }
  return original;
}

// ── Internals ────────────────────────────────────────────────────────────────

function evictIfNeeded(): void {
  if (cache.size < MAX_ENTRIES) return;
  // Evict oldest-written entry (first key in insertion-order Map)
  const oldestKey = cache.keys().next().value as string | undefined;
  if (oldestKey) {
    cache.delete(oldestKey);
  }
}

/** Clear all cache (for testing). */
export function clearCache(): void {
  cache.clear();
}
