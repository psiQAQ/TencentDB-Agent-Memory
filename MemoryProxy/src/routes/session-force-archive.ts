/**
 * POST /v3/session/force-archive-skill
 *
 * 手动强制归档当前 session 的 skill buffer（第三个触发条件）。
 *
 * 两种使用方式：
 *   1. 函数调用（mem:create-skill 内部用）— import forceArchiveSkill()
 *   2. HTTP 路由保留，但在没有可信 user-scoped lookup 前始终 fail-closed
 */

import type { Context } from "hono";
import type { ProxyConfig } from "../types.js";
import { getSessionStore, sessionStoreKey } from "../session/store.js";
import { getCoreSkillClient } from "../skill/core-client.js";
import type { SessionInitState } from "../session/types.js";
import { adminAuthError, checkAdminAuth } from "./admin-auth.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface ForceArchiveInput {
  sessionKey: string;
  agentSource: string;
  /** Trusted user id already resolved by the main handler's key verification. */
  userId: string;
  config: ProxyConfig;
  spaceId: string;
  reason?: string;
}

export interface ForceArchiveResult {
  success: boolean;
  status?: "archived" | "empty";
  taskId?: string;
  archiveKey?: string;
  archivedAtMs?: number;
  error?: string;
}

/** Core 接口返回类型 */
interface CoreForceArchiveResponse {
  status: "archived" | "empty";
  task_id?: string;
  archived_at_ms?: number;
  archive_key?: string;
  message?: string;
}

// ── Core Logic ─────────────────────────────────────────────────────────────

/**
 * 手动强制归档当前 session 的 skill buffer。
 *
 * 从 SessionStore 取 sessionInfo → 调 CoreSkillClient.forceArchive() → 返回结果
 */
export async function forceArchiveSkill(input: ForceArchiveInput): Promise<ForceArchiveResult> {
  const { sessionKey, agentSource, userId, config, spaceId, reason } = input;

  // 参数校验
  if (!sessionKey || !userId || !spaceId) {
    return { success: false, error: "trusted session identity is required" };
  }

  // 从 SessionStore 取 session 状态
  const compositeKey = sessionStoreKey({ userId, agentSource, sessionId: sessionKey, spaceId });
  const store = getSessionStore();
  const state: SessionInitState | undefined = store.get(compositeKey);

  if (!state || !state.sessionInfo) {
    return { success: false, error: `Session not found: ${sessionKey}` };
  }

  const sessionInfo = state.sessionInfo;
  if (
    sessionInfo.user_id !== userId
    || (state.userId && state.userId !== userId)
    || sessionInfo.session_id !== sessionKey
    || (state.keyId && state.keyId !== sessionKey)
    || sessionInfo.space_id !== spaceId
  ) {
    return { success: false, error: "Session identity mismatch" };
  }

  // 调用 Core 接口
  try {
    const client = getCoreSkillClient(config.coreSkill);
    const coreResult = await client.forceArchive(
      {
        space_id: sessionInfo.space_id || spaceId,
        user_id: sessionInfo.user_id,
        team_id: sessionInfo.team_id,
        agent_id: sessionInfo.agent_id,
        session_id: sessionInfo.session_id,
        reason,
        task_id: sessionInfo.task_id,
      },
      { serviceId: sessionInfo.space_id || spaceId },
    );

    const result = coreResult as CoreForceArchiveResponse;

    if (result.status === "empty") {
      return { success: true, status: "empty" };
    }

    return {
      success: true,
      status: "archived",
      taskId: result.task_id,
      archiveKey: result.archive_key,
      archivedAtMs: result.archived_at_ms,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── HTTP Handler ───────────────────────────────────────────────────────────

/**
 * Admin auth can authenticate an operator but cannot safely select a
 * user-scoped session. Keep the route fail-closed until such a lookup exists.
 */
export function createSessionForceArchiveHandler(config: ProxyConfig) {
  return async (c: Context): Promise<Response> => {
    const adminKey = config.admin.apiKey.trim();
    if (!adminKey) {
      return c.json({
        code: 50301,
        message: "Session archive HTTP endpoint requires a configured admin credential",
        request_id: `force-archive-${Date.now()}`,
      }, 503);
    }
    const authResult = checkAdminAuth(c, adminKey);
    if (authResult !== "ok") {
      return adminAuthError(c, authResult);
    }
    return c.json({
      code: 50101,
      message: "Secure user-scoped session lookup is unavailable over HTTP; use the authenticated mem:create-skill command",
      request_id: `force-archive-${Date.now()}`,
    }, 501);
  };
}
