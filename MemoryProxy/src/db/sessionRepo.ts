/**
 * SessionRepo — persistence layer for SessionInitState.
 *
 * The proxy's runtime continues to use the in-memory `SessionStore` as L1
 * cache. This Repo provides a durable L2 so that on process restart
 * we can hydrate `status='initialized'` rows back into memory and avoid
 * forcing the user through session_init again.
 *
 * Persistence semantics:
 *   - upsert:            write-through on every store.set().
 *   - getBySessionId:    main lookup — read the current state for
 *                        (spaceId, userId, agentSource, sessionId).
 *   - deleteBySessionId: drop the row.
 *   - loadAllInitialized: hydrate on startup (bulk read of initialized rows).
 *
 * All SQL goes through prepared statements with bound parameters.
 *
 * ── History note ────────────────────────────────────────────────────────────
 * 上一版 (2026-07-10) 只有 (userId, agentSource, sessionId) 三段主键。
 * P4 (2026-07-12) 新增 spaceId 段以支持 kernel-sts 权限隔离 —— 存 sqlite
 * 复合主键时 spaceId 段作为第一段（老 caller 缺省时用 `_default` 兜底）。
 */

import type Database from "better-sqlite3";

import { getDb } from "./index.js";
import {
  isLegacyPersistedSessionInitState,
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

export interface PersistedSessionRow {
  session_id: string;
  session_key: string;
  status: string;
  agent_id: string | null;
  task_id: string | null;
  user_id: string | null;
  cb_user_id: string | null;
  agent_detail_json: string | null;
  task_detail_json: string | null;
  session_info_json: string | null;
  state_json: string;
  created_at: number;
  updated_at: number;
}

/**
 * Collision-safe, versioned id used in the `sessions` table for a state.
 * The raw identity fields are kept inside one canonical encoded tuple.
 */
export function sessionRowId(
  spaceId: string,
  userId: string,
  agentSource: string,
  sessionId: string,
): string {
  return persistedSessionIdentityKey(spaceId, userId, agentSource, sessionId);
}

function jsonOrNull<T>(v: T | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

function rowFromState(
  spaceId: string,
  userId: string,
  agentSource: string,
  sessionId: string,
  state: SessionInitState,
): PersistedSessionRow {
  const now = Date.now();
  return {
    session_id: sessionRowId(spaceId, userId, agentSource, sessionId),
    session_key: sessionId,
    status: state.status,
    agent_id: state.sessionInfo?.agent_id ?? state.agentDetail?.id ?? null,
    task_id: state.sessionInfo?.task_id ?? state.taskDetail?.id ?? null,
    user_id: state.sessionInfo?.user_id ?? userId,
    cb_user_id: state.userId ?? null,
    agent_detail_json: jsonOrNull(state.agentDetail ?? null),
    task_detail_json: jsonOrNull(state.taskDetail ?? null),
    session_info_json: jsonOrNull(state.sessionInfo ?? null),
    state_json: JSON.stringify(state),
    created_at: now,
    updated_at: now,
  };
}

function parseState(
  s: string | null | undefined,
  legacy = false,
): SessionInitState {
  try {
    const parsed = JSON.parse(s ?? "") as unknown;
    if (legacy) {
      if (!isLegacyPersistedSessionInitState(parsed)) throw new SessionRepoReadError();
      return parsed;
    }
    const normalized = normalizePersistedSessionInitState(parsed);
    if (!normalized) throw new SessionRepoReadError();
    return normalized;
  } catch {
    throw new SessionRepoReadError();
  }
}

function rowToState(row: PersistedSessionRow, legacy = false): SessionInitState {
  const state = parseState(row.state_json, legacy);
  if (row.status !== state.status) throw new SessionRepoReadError();
  return state;
}

function identityOf(
  spaceId: string,
  userId: string,
  agentSource: string,
  sessionId: string,
): PersistedSessionIdentity {
  return { spaceId, userId, agentSource, sessionId };
}

const UPSERT_SQL = `
INSERT INTO sessions (
  session_id, session_key, status, agent_id, task_id, user_id, cb_user_id,
  agent_detail_json, task_detail_json, session_info_json, state_json,
  created_at, updated_at
) VALUES (
  @session_id, @session_key, @status, @agent_id, @task_id, @user_id, @cb_user_id,
  @agent_detail_json, @task_detail_json, @session_info_json, @state_json,
  @created_at, @updated_at
)
ON CONFLICT(session_id) DO UPDATE SET
  session_key       = excluded.session_key,
  status            = excluded.status,
  agent_id          = excluded.agent_id,
  task_id           = excluded.task_id,
  user_id           = excluded.user_id,
  cb_user_id        = excluded.cb_user_id,
  agent_detail_json = excluded.agent_detail_json,
  task_detail_json  = excluded.task_detail_json,
  session_info_json = excluded.session_info_json,
  state_json        = excluded.state_json,
  updated_at        = excluded.updated_at
`;

/**
 * `loadAllInitialized` 返回结构：包含 spaceId / userId / agentSource / sessionId
 * 四段身份，配合装配层一次性把身份塞回 SessionStore。CosStorage 后端永远返回空数组
 * （启动全量 list 太慢，走 probeL2a 懒加载即可）。
 */
export interface HydratedSessionRow {
  spaceId: string;
  userId: string;
  agentSource: string;
  sessionId: string;
  state: SessionInitState;
}

/** Fixed, non-sensitive signal that a durable session read failed. */
export class SessionRepoReadError extends Error {
  constructor() {
    super("session repository read failed");
    this.name = "SessionRepoReadError";
  }
}

export interface SessionRepo {
  /**
   * Write-through 语义：await 完成时 L2a 已落盘（或失败已被静默降级）。
   *
   * 见 2026-07-13 修复：原 fire-and-forget 语义在多节点部署下会让 pod A
   * 关流时 COS PUT 还在飞，pod B 的 turn-2 因 L2a miss 掉进
   * `tryHistoryScan` 兜底 → bypass → 请求透传 LLM，session 状态机被跳过。
   *
   * 实现细节：写失败不 throw（保留"L1 是权威、L2a 是持久化备份"的降级契约），
   * 但必须返回明确 durability result；只有 true 可作为跨 identity owner proof。
   */
  upsert(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    state: SessionInitState,
  ): Promise<boolean>;
  /** `null` is an authoritative miss; backend failures reject with a fixed read error. */
  getBySessionId(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
  ): Promise<SessionInitState | null>;
  deleteBySessionId(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
  ): Promise<boolean>;
  loadAllInitialized(): Promise<HydratedSessionRow[]>;
}

class SqliteSessionRepo implements SessionRepo {
  constructor(private db: Database.Database) {}

  async upsert(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    state: SessionInitState,
  ): Promise<boolean> {
    // better-sqlite3 是同步 API；包 async 只是为了对齐 SessionRepo 契约，
    // 让 store 侧的 await 语义统一（跨节点部署走 KvSessionRepo/RedisSessionRepo
    // 都是真异步）。
    if (!isPersistedSessionInitState(state)) return false;
    try {
      const row = rowFromState(spaceId, userId, agentSource, sessionId, state);
      this.db.prepare(UPSERT_SQL).run(row);
      return true;
    } catch (err) {
      console.warn(
        "[session-db] upsert failed:",
        err instanceof Error ? err.message : String(err),
      );
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
      const select = this.db.prepare("SELECT * FROM sessions WHERE session_id = ?");
      const identity = identityOf(spaceId, userId, agentSource, sessionId);
      const row = select.get(sessionRowId(spaceId, userId, agentSource, sessionId)) as
        | PersistedSessionRow
        | undefined;
      if (row) {
        const state = rowToState(row);
        if (!persistedStateOwnsIdentity(state, identity)) throw new SessionRepoReadError();
        return state;
      }

      const legacyId = legacyPersistedSessionIdentityKey(
        spaceId,
        userId,
        agentSource,
        sessionId,
      );
      if (!legacyId) return null;
      const legacyRow = select.get(legacyId) as PersistedSessionRow | undefined;
      const legacyState = legacyRow ? rowToState(legacyRow, true) : null;
      if (
        !legacyRow
        || legacyRow.session_key !== sessionId
        || !legacyState
        || !persistedStateOwnsIdentity(legacyState, identity, spaceId === "")
      ) return null;
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
    try {
      const select = this.db.prepare("SELECT * FROM sessions WHERE session_id = ?");
      const remove = this.db.prepare("DELETE FROM sessions WHERE session_id = ?");
      remove.run(sessionRowId(spaceId, userId, agentSource, sessionId));

      const legacyId = legacyPersistedSessionIdentityKey(
        spaceId,
        userId,
        agentSource,
        sessionId,
      );
      if (!legacyId) return true;
      const legacyRow = select.get(legacyId) as PersistedSessionRow | undefined;
      const legacyState = legacyRow ? rowToState(legacyRow, true) : null;
      if (
        legacyRow?.session_key === sessionId
        && legacyState
        && persistedStateOwnsIdentity(
          legacyState,
          identityOf(spaceId, userId, agentSource, sessionId),
          spaceId === "",
        )
      ) remove.run(legacyId);
      return true;
    } catch {
      console.warn("[session-db] delete failed");
      return false;
    }
  }

  async loadAllInitialized(): Promise<HydratedSessionRow[]> {
    try {
      const rows = this.db.prepare("SELECT * FROM sessions").all() as PersistedSessionRow[];
      const out: HydratedSessionRow[] = [];
      for (const r of rows) {
        if (!r.session_id.startsWith("v2:")) continue;
        const parsed = parsePersistedSessionIdentityKey(r.session_id);
        if (!parsed) throw new SessionRepoReadError();
        const s = rowToState(r);
        if (!persistedStateOwnsIdentity(s, parsed)) throw new SessionRepoReadError();
        if (s.status !== "initialized") continue;
        out.push({ ...parsed, state: s });
      }
      return out;
    } catch {
      throw new SessionRepoReadError();
    }
  }
}

/** Null repo used when SQLite init fails — silently no-ops on writes. */
class NullSessionRepo implements SessionRepo {
  async upsert(): Promise<boolean> { return false; }
  async getBySessionId(): Promise<SessionInitState | null> {
    return null;
  }
  async deleteBySessionId(): Promise<boolean> { return true; }
  async loadAllInitialized(): Promise<HydratedSessionRow[]> {
    return [];
  }
}

let _repo: SessionRepo | null = null;

export function getSessionRepo(): SessionRepo {
  if (_repo) return _repo;
  const db = getDb();
  _repo = db ? new SqliteSessionRepo(db) : new NullSessionRepo();
  return _repo;
}

/** Replace the singleton with a Redis-backed repo (called at injection pipeline init). */
export function setSessionRepo(repo: SessionRepo): void {
  _repo = repo;
}

/** Reset singleton — tests only. */
export function __resetSessionRepoForTests(): void {
  _repo = null;
}
