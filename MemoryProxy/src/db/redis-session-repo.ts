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
import type { SessionInitState } from "../session/types.js";
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
        const current = JSON.parse(raw) as SessionInitState;
        return persistedStateOwnsIdentity(current, identity) ? current : null;
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
      const legacyState = JSON.parse(legacyRaw) as SessionInitState;
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
  ): Promise<void> {
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
      if (!legacyTail) return;
      const legacyKey = KEY_PREFIX + legacyTail;
      const raw = await this.redis.get(legacyKey);
      if (!raw) return;
      const state = JSON.parse(raw) as SessionInitState;
      if (persistedStateOwnsIdentity(state, identity, spaceId === "")) {
        await this.redis.del(legacyKey);
      }
    } catch {
      // silent
    }
  }

  async loadAllInitialized(): Promise<HydratedSessionRow[]> {
    try {
      const keys = await this.scanKeys(KEY_PREFIX + "v2:*");
      if (keys.length === 0) return [];
      const raws = await this.redis.mget(...keys);
      const result: HydratedSessionRow[] = [];
      for (let i = 0; i < keys.length; i++) {
        if (!raws[i]) continue;
        try {
          const state = JSON.parse(raws[i]!) as SessionInitState;
          if (state.status !== "initialized") continue;
          const tail = keys[i].slice(KEY_PREFIX.length);
          const identity = parsePersistedSessionIdentityKey(tail);
          if (!identity || !persistedStateOwnsIdentity(state, identity)) continue;
          result.push({
            ...identity,
            state,
          });
        } catch {
          /* skip corrupt */
        }
      }
      return result;
    } catch {
      return [];
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
