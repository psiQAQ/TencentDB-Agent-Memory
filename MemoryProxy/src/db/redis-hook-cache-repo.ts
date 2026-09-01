/**
 * RedisHookCacheRepo — Redis-backed persistence for prewarmed injection blocks.
 *
 * Each Redis Hash stores one versioned, collision-safe encoded identity tuple
 * under `inj:hook:`; fields remain hookId -> ContextBlock[] JSON.
 *
 * TTL follows session lifetime (default 30min).
 * All errors degrade silently — callers treat null/no-cache as equivalent
 * to cacheStrategy=none.
 */
import type { Redis } from "ioredis";
import type { HookCacheRepo, HookCacheEntry } from "./hookCacheRepo.js";
import type { ContextBlock } from "../injection/types.js";
import {
  legacyPersistedSessionIdentityKey,
  persistedSessionIdentityKey,
} from "./session-identity-key.js";

const KEY_PREFIX = "inj:hook:";
const DEFAULT_TTL = 30 * 60; // 30 minutes

function keyOf(
  spaceId: string,
  userId: string,
  agentSource: string,
  sessionId: string,
): string {
  return KEY_PREFIX + persistedSessionIdentityKey(
    spaceId,
    userId,
    agentSource,
    sessionId,
  );
}

function legacyKeyOf(
  spaceId: string,
  userId: string,
  agentSource: string,
  sessionId: string,
): string | null {
  // Hook payloads contain no owner/space metadata, so the old empty-space
  // `_default` sentinel cannot be authenticated safely.
  if (spaceId === "") return null;
  const tail = legacyPersistedSessionIdentityKey(
    spaceId,
    userId,
    agentSource,
    sessionId,
  );
  return tail ? KEY_PREFIX + tail : null;
}

export class RedisHookCacheRepo implements HookCacheRepo {
  private ttl: number;

  constructor(
    private redis: Redis,
    ttlSeconds?: number,
  ) {
    const ttl = ttlSeconds ?? DEFAULT_TTL;
    if (!Number.isSafeInteger(ttl) || ttl <= 0) {
      throw new Error("invalid Redis hook TTL");
    }
    this.ttl = ttl;
  }

  async put(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    hookId: string,
    blocks: ContextBlock[],
  ): Promise<void> {
    const key = keyOf(spaceId, userId, agentSource, sessionId);
    await this.redis.hset(key, hookId, JSON.stringify(blocks)).catch(() => {});
    this.redis.expire(key, this.ttl).catch(() => {});
  }

  async putMany(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    entries: HookCacheEntry[],
  ): Promise<void> {
    if (entries.length === 0) return;
    const key = keyOf(spaceId, userId, agentSource, sessionId);
    const args: string[] = [];
    for (const e of entries) {
      args.push(e.hookId, JSON.stringify(e.blocks));
    }
    await this.redis.hset(key, ...args).catch(() => {});
    this.redis.expire(key, this.ttl).catch(() => {});
  }

  async get(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    hookId: string,
  ): Promise<ContextBlock[] | null> {
    try {
      const currentKey = keyOf(spaceId, userId, agentSource, sessionId);
      const current = await this.redis.hgetall(currentKey);
      let raw: string | undefined;
      if (current && Object.keys(current).length > 0) {
        raw = current[hookId];
      } else {
        const legacyKey = legacyKeyOf(spaceId, userId, agentSource, sessionId);
        if (!legacyKey) return null;
        const legacy = await this.redis.hgetall(legacyKey);
        if (!legacy || Object.keys(legacy).length === 0) return null;
        if (await this.redis.ttl(legacyKey) <= 0) return null;
        raw = legacy[hookId];
      }
      if (!raw) return null;
      const parsed = JSON.parse(raw) as ContextBlock[];
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async getAllForSession(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
  ): Promise<HookCacheEntry[]> {
    try {
      const currentKey = keyOf(spaceId, userId, agentSource, sessionId);
      let all = await this.redis.hgetall(currentKey);
      if (!all || Object.keys(all).length === 0) {
        const legacyKey = legacyKeyOf(spaceId, userId, agentSource, sessionId);
        if (!legacyKey) return [];
        all = await this.redis.hgetall(legacyKey);
        if (!all || Object.keys(all).length === 0) return [];
        if (await this.redis.ttl(legacyKey) <= 0) return [];
      }
      const out: HookCacheEntry[] = [];
      for (const [hookId, raw] of Object.entries(all)) {
        try {
          const blocks = JSON.parse(raw) as ContextBlock[];
          if (Array.isArray(blocks)) {
            out.push({ hookId, blocks });
          }
        } catch {
          /* skip corrupt */
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  async clearBySession(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
  ): Promise<void> {
    await this.redis.del(keyOf(spaceId, userId, agentSource, sessionId)).catch(() => {});
  }
}
