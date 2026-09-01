/**
 * RedisSessionRepo — Redis-backed persistence for SessionInitState.
 *
 * New keys store one versioned, collision-safe encoded identity tuple under
 * the `inj:sess:` prefix.
 *
 * 由于 sessionKey === sessionId 恒成立、by-sid 反查已在 SessionRepo 接口中
 * 删除（详见 `2026-07-10-cos-ttl-nottl-split-plan.md`），本实现也一并
 * 删除反向索引写入。
 *
 * Writes degrade explicitly via `false`; read failures throw a fixed error so
 * callers never confuse an outage with an authoritative miss.
 */
import type { Redis } from "ioredis";
import {
  SessionRepoReadError,
  type SessionRepo,
  type HydratedSessionRow,
} from "./sessionRepo.js";
import {
  isLegacyPersistedSessionOwnershipProof,
  isPersistedSessionInitState,
  normalizePersistedSessionInitState,
  type SessionInitState,
} from "../session/types.js";
import {
  legacyPersistedSessionIdentityKey,
  parsePersistedSessionIdentityKey,
  persistedSessionIdentityKey,
  persistedStateOwnsIdentity,
  type PersistedSessionIdentity,
} from "./session-identity-key.js";

const KEY_PREFIX = "inj:sess:";
const DEFAULT_TTL = 30 * 60; // 30 minutes

function compositeKey(
  spaceId: string,
  userId: string,
  agentSource: string,
  sessionId: string,
): string {
  return persistedSessionIdentityKey(spaceId, userId, agentSource, sessionId);
}

function identityOf(
  spaceId: string,
  userId: string,
  agentSource: string,
  sessionId: string,
): PersistedSessionIdentity {
  return { spaceId, userId, agentSource, sessionId };
}

export class RedisSessionRepo implements SessionRepo {
  private ttl: number;

  constructor(
    private redis: Redis,
    ttlSeconds?: number,
  ) {
    const ttl = ttlSeconds ?? DEFAULT_TTL;
    if (!Number.isSafeInteger(ttl) || ttl <= 0) {
      throw new Error("invalid Redis session TTL");
    }
    this.ttl = ttl;
  }

  async upsert(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    state: SessionInitState,
  ): Promise<boolean> {
    const key = KEY_PREFIX + compositeKey(spaceId, userId, agentSource, sessionId);
    if (!isPersistedSessionInitState(state)) return false;
    // await write-through：多节点部署下 pod A 关流前 L2a 必须落盘，
    // 否则 pod B turn-2 会 L2a miss → tryHistoryScan bypass 直接透传 LLM。
    // 见 2026-07-13 修复；写失败仍静默降级（L1 依旧是权威 fast path）。
    try {
      await this.redis.setex(key, this.ttl, JSON.stringify(state));
      return true;
    } catch {
      /* silent — L1 authoritative fast path 仍然生效 */
      return false;
    }
  }

  async getBySessionId(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
  ): Promise<SessionInitState | null> {
    try {
      const identity = identityOf(spaceId, userId, agentSource, sessionId);
      const currentKey = KEY_PREFIX + compositeKey(spaceId, userId, agentSource, sessionId);
      const raw = await this.redis.get(currentKey);
      if (raw !== null) {
        const parsed = JSON.parse(raw) as unknown;
        const current = normalizePersistedSessionInitState(parsed);
        if (!current) throw new SessionRepoReadError();
        if (!persistedStateOwnsIdentity(current, identity)) throw new SessionRepoReadError();
        return current;
      }

      const legacyTail = legacyPersistedSessionIdentityKey(
        spaceId,
        userId,
        agentSource,
        sessionId,
      );
      if (!legacyTail) return null;
      const legacyKey = KEY_PREFIX + legacyTail;
      const legacyRaw = await this.redis.get(legacyKey);
      if (!legacyRaw) return null;
      if (await this.redis.ttl(legacyKey) <= 0) return null;
      const parsedLegacyState = JSON.parse(legacyRaw) as unknown;
      const legacyState = normalizePersistedSessionInitState(parsedLegacyState);
      if (!legacyState) throw new SessionRepoReadError();
      if (!persistedStateOwnsIdentity(legacyState, identity, spaceId === "")) return null;
      return legacyState;
    } catch {
      throw new SessionRepoReadError();
    }
  }

  async deleteBySessionId(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
  ): Promise<boolean> {
    const identity = identityOf(spaceId, userId, agentSource, sessionId);
    const currentKey = KEY_PREFIX + compositeKey(spaceId, userId, agentSource, sessionId);
    const legacyTail = legacyPersistedSessionIdentityKey(
      spaceId,
      userId,
      agentSource,
      sessionId,
    );
    try {
      await this.redis.del(currentKey);
      if (!legacyTail) return true;
      const legacyKey = KEY_PREFIX + legacyTail;
      const raw = await this.redis.get(legacyKey);
      if (!raw) return true;
      const state = JSON.parse(raw) as unknown;
      if (!isLegacyPersistedSessionOwnershipProof(state)) return false;
      if (persistedStateOwnsIdentity(state, identity, spaceId === "")) {
        await this.redis.del(legacyKey);
      }
      return true;
    } catch {
      return false;
    }
  }

  async loadAllInitialized(): Promise<HydratedSessionRow[]> {
    try {
      const keys = await this.scanKeys(KEY_PREFIX + "v2:*");
      if (keys.length === 0) return [];
      const raws = await this.redis.mget(...keys);
      const result: HydratedSessionRow[] = [];
      for (let i = 0; i < keys.length; i++) {
        if (raws[i] === null) continue;
        const parsedState = JSON.parse(raws[i]!) as unknown;
        const state = normalizePersistedSessionInitState(parsedState);
        const tail = keys[i].slice(KEY_PREFIX.length);
        const identity = parsePersistedSessionIdentityKey(tail);
        if (
          !state
          || !identity
          || !persistedStateOwnsIdentity(state, identity)
        ) throw new SessionRepoReadError();
        if (state.status !== "initialized") continue;
        result.push({
          ...identity,
          state,
        });
      }
      return result;
    } catch {
      throw new SessionRepoReadError();
    }
  }

  private async scanKeys(pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = "0";
    do {
      const reply = await this.redis.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        "100",
      );
      cursor = reply[0];
      keys.push(...reply[1]);
    } while (cursor !== "0");
    return keys;
  }
}
