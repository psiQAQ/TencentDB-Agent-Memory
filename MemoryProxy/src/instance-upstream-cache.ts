/**
 * Instance Upstream Config Cache — per-instance LLM upstream configuration
 * fetched from Core and cached with TTL + stale-if-error.
 *
 * Pattern: modeled after CoreKnowledgeClient._cachedFetch (knowledge/core-client.ts).
 *
 * Cache semantics:
 *   - Key: spaceId (one entry per instance, covering all agent_source + type rows)
 *   - TTL: 5 minutes (hard expiry, not refreshed on access)
 *   - Stale-if-error: on fetch failure, return last known good value
 *   - First-time failure: return empty array (= all official, no overrides)
 *   - Max entries: 256, evict oldest-written on overflow
 */

import type { CoreSkillConfig } from "./types.js";
import type { ProxyConfig } from "./types.js";

const TAG = "[instance-upstream-cache]";
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ENTRIES = 256;

// ── Types ────────────────────────────────────────────────────────────────────

export type UpstreamConfigType = "conversation" | "extraction";
export type UpstreamConfigMode = "official" | "custom_unified" | "custom_passthrough";

/** A single row from meta_instance_upstream_config (internal API returns full api_key). */
export interface InstanceUpstreamConfigEntry {
  agent_source: string;
  type: UpstreamConfigType;
  mode: UpstreamConfigMode;
  base_url: string;
  api_key: string;
  credential_ref?: string;
  model_id: string;
}

interface CacheEntry {
  items: InstanceUpstreamConfigEntry[];
  expiresAt: number;
}

// ── Module state ─────────────────────────────────────────────────────────────

const cache = new Map<string, CacheEntry>();
const lastGood = new Map<string, InstanceUpstreamConfigEntry[]>();

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
  lastGood.set(spaceId, fresh);
  return fresh;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Get all upstream config rows for an instance (cached, TTL 5min, stale-if-error).
 *
 * Returns empty array when:
 *   - Instance has no config (= all official)
 *   - Core unreachable AND no prior cached value
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
    // Success → write cache + lastGood
    evictIfNeeded();
    cache.set(spaceId, { items: fresh, expiresAt: Date.now() + DEFAULT_TTL_MS });
    lastGood.set(spaceId, fresh);
    return fresh;
  }

  // Fetch failed → stale-if-error fallback
  const stale = lastGood.get(spaceId);
  if (stale !== undefined) {
    console.warn(`${TAG} fetch failed; using cached instance configuration`);
    return stale;
  }

  // First-time failure, no history → return empty (= all official)
  if (fetchErr) {
    console.warn(
      `${TAG} fetch failed; no cached instance configuration`,
    );
  }
  return [];
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
    // Keep lastGood for stale-if-error — only remove from TTL cache
  }
}

/** Clear all cache (for testing). */
export function clearCache(): void {
  cache.clear();
  lastGood.clear();
}
