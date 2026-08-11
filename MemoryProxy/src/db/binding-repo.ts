/**
 * BindingRepo — 长期 session binding 持久化。
 *
 * 在 KV 里存一份"小纸条"，只记 outcome + id 组，永不自动清理（`nottl/` 前缀）。
 * 用于沉睡对话唤醒：热缓存(30min)过期后，从 binding 恢复 agent/task 选择。
 *
 * ── Signature note ────────────────────────────────────────────────────────
 * 见 docs/design/2026-07-12-cos-shark-sts-credential-plan.md §3.6：所有方法
 * 第一个参数是 `spaceId`（kernel-sts 模式下 STS 权限按 space 隔离，key 路径
 * 也随之带 spaceId 段）；空 spaceId 上下文的老 caller 传 `""` / `undefined`
 * 时会被 sessionDirOf 内部当作 `_default` 兜底段处理。
 *
 * 原方案 (2026-07-10) 仅有 (userId, agentSource, sessionId) 三段，spaceId
 * 层是 P4 kernel-sts 支持新增。
 */

import type { Redis } from "ioredis";
import {
  legacyPersistedSessionIdentityKey,
  persistedSessionIdentityKey,
} from "./session-identity-key.js";

const REDIS_KEY_PREFIX = "inj:binding:";
const DEFAULT_BINDING_TTL_DAYS = 30;
const TOUCH_IF_PRESENT_SCRIPT = `
if redis.call("EXISTS", KEYS[1]) == 0 then return 0 end
redis.call("HSET", KEYS[1], "last_seen", ARGV[1])
redis.call("EXPIRE", KEYS[1], ARGV[2])
return 1
`;

export interface SessionBinding {
  outcome: "initialized" | "bypassed";
  userId?: string;
  teamId?: string;
  agentId?: string;
  taskId?: string;
}

export interface BindingRepo {
  getBinding(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
  ): Promise<SessionBinding | null>;
  putBinding(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    binding: SessionBinding,
  ): Promise<boolean>;
  deleteBinding(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
  ): Promise<void>;
  touchLastSeen(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
  ): Promise<void>;
}

function ttlSeconds(days: number): number {
  return days * 86400;
}

function redisKey(
  spaceId: string,
  userId: string,
  agentSource: string,
  sessionId: string,
): string {
  return REDIS_KEY_PREFIX
    + persistedSessionIdentityKey(spaceId, userId, agentSource, sessionId);
}

function legacyRedisKey(
  spaceId: string,
  userId: string,
  agentSource: string,
  sessionId: string,
): string | null {
  // Legacy binding hashes have no space metadata, so `_default` cannot prove
  // whether it represented an empty space or the literal `_default` space.
  if (spaceId === "") return null;
  const tail = legacyPersistedSessionIdentityKey(
    spaceId,
    userId,
    agentSource,
    sessionId,
  );
  return tail ? REDIS_KEY_PREFIX + tail : null;
}

function bindingFromHash(all: Record<string, string>): SessionBinding {
  return {
    outcome: (all.outcome as "initialized" | "bypassed") || "initialized",
    userId: all.user_id || undefined,
    teamId: all.team_id || undefined,
    agentId: all.agent_id || undefined,
    taskId: all.task_id || undefined,
  };
}

export class RedisBindingRepo implements BindingRepo {
  private readonly bindingTtlSeconds: number;

  constructor(
    private redis: Redis,
    bindingTtlDays: number = DEFAULT_BINDING_TTL_DAYS,
  ) {
    const seconds = ttlSeconds(bindingTtlDays);
    if (!Number.isSafeInteger(seconds) || seconds <= 0) {
      throw new Error("invalid Redis binding TTL");
    }
    this.bindingTtlSeconds = seconds;
  }

  async getBinding(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
  ): Promise<SessionBinding | null> {
    try {
      const currentKey = redisKey(spaceId, userId, agentSource, sessionId);
      const current = await this.redis.hgetall(currentKey);
      if (current && Object.keys(current).length > 0) {
        if (current.user_id && current.user_id !== userId) return null;
        return bindingFromHash(current);
      }

      const legacyKey = legacyRedisKey(spaceId, userId, agentSource, sessionId);
      if (!legacyKey) return null;
      const legacy = await this.redis.hgetall(legacyKey);
      if (!legacy || Object.keys(legacy).length === 0 || legacy.user_id !== userId) {
        return null;
      }
      if (await this.redis.ttl(legacyKey) <= 0) return null;
      return bindingFromHash(legacy);
    } catch {
      return null;
    }
  }

  async putBinding(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    binding: SessionBinding,
  ): Promise<boolean> {
    const now = Date.now().toString();
    try {
      const fields: Record<string, string> = {
        outcome: binding.outcome,
        created_at: now,
        last_seen: now,
      };
      if (binding.userId) fields.user_id = binding.userId;
      if (binding.teamId) fields.team_id = binding.teamId;
      if (binding.agentId) fields.agent_id = binding.agentId;
      if (binding.taskId) fields.task_id = binding.taskId;

      const key = redisKey(spaceId, userId, agentSource, sessionId);
      const results = await this.redis
        .multi()
        .hset(key, fields)
        .expire(key, this.bindingTtlSeconds)
        .exec();
      return results !== null && results.every(([error]) => error === null);
    } catch {
      /* ignore */
      return false;
    }
  }

  async deleteBinding(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
  ): Promise<void> {
    try {
      await this.redis.del(redisKey(spaceId, userId, agentSource, sessionId));
      const legacyKey = legacyRedisKey(spaceId, userId, agentSource, sessionId);
      if (!legacyKey) return;
      const legacy = await this.redis.hgetall(legacyKey);
      if (legacy.user_id === userId) await this.redis.del(legacyKey);
    } catch {
      /* ignore */
    }
  }

  async touchLastSeen(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
  ): Promise<void> {
    try {
      const key = redisKey(spaceId, userId, agentSource, sessionId);
      await this.redis.eval(
        TOUCH_IF_PRESENT_SCRIPT,
        1,
        key,
        Date.now().toString(),
        this.bindingTtlSeconds.toString(),
      );
    } catch {
      /* ignore */
    }
  }
}

/** Null repo for when Redis is disabled. */
export class NullBindingRepo implements BindingRepo {
  async getBinding(
    _spaceId: string,
    _userId: string,
    _agentSource: string,
    _sessionId: string,
  ): Promise<SessionBinding | null> { return null; }
  async putBinding(
    _spaceId: string,
    _userId: string,
    _agentSource: string,
    _sessionId: string,
    _binding: SessionBinding,
  ): Promise<boolean> { return false; }
  async deleteBinding(
    _spaceId: string,
    _userId: string,
    _agentSource: string,
    _sessionId: string,
  ): Promise<void> {}
  async touchLastSeen(
    _spaceId: string,
    _userId: string,
    _agentSource: string,
    _sessionId: string,
  ): Promise<void> {}
}
