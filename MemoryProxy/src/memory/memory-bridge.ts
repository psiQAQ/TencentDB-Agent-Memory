/**
 * memory-bridge — reverse proxy for `<proxy>/memory-bridge/v3/*` → tdai gateway.
 *
 * 设计思路与 src/skill/skill-bridge.ts 同形：
 *   - 不在 body.tools 里塞 native tool 定义（agent host 不识别）
 *   - 注入文本 `<tdai_memory_tools>` 引导 LLM 用 Bash curl 这个 bridge
 *   - bridge 强制注入 session IdFields + serviceToken 鉴权后转发到 tdai
 *
 * 行为：
 *   1. 路径必须是 /memory-bridge/v3/{sub} ；sub 在 ALLOWED_SUBPATHS 内
 *   2. 强制 POST + Content-Type application/json
 *   3. 必须能识别 session（x-conversation-id / x-session-id ...），否则 401
 *   4. body 里 team_id/user_id/agent_id/session_id 一律被 session 值覆盖（防伪造）
 *   5. 转发到 ${coreSkill.endpoint}/v3/{sub}，添加 Bearer + service-id 头
 *   6. 透传 status 和 JSON body
 *
 * 安全：
 *   - allowlist 限定只有 search / read 类只读 subpath；mutation 走主链路
 *   - 不接受 atomic/update / scenario/write / core/write 等写操作
 *   - v3 strict isolation: 强制注入 session_id，满足 L0/L1 必填要求
 */

import type { Context } from "hono";
import { extractBearerToken } from "../opik.js";
import {
  getSessionStore,
  SessionIdentityConflictError,
  sessionStoreKey,
  type SessionIdentity,
} from "../session/store.js";
import { resolveConversationId } from "../session/session-key.js";
import { verifyUserKey, isAuthEnabled } from "../auth.js";
import type { ProxyConfig } from "../types.js";
import { getMetadataClient } from "../meta/client.js";
import type { AgentContext } from "../injection/types.js";
import { resolveFixedAssetCtxs, type FixedAssetCtx } from "../injection/injectors/tdai-fixed-asset.js";
import type { TdaiIdentity } from "../tdai/types.js";
import { assertAgentSource } from "../storage/key-utils.js";
import { isRegisteredAgentSource } from "../agent-adapters/index.js";

const TAG = "[memory-bridge]";

/**
 * 允许通过 bridge 转发的 tdai 子路径（**只读**，LLM 通过 Bash 工具按需调用）。
 *
 * 设计取舍：
 *   - L0/L1 不再每轮自动召回，改为静态工具按需检索（cache 友好），因此放行
 *     atomic/* 与 conversation/* 的 search/query。
 *   - L2：system 给索引 `<l2_scene_index>`，正文按需读 → 放行 scenario/ls + scenario/read。
 *   - L3（persona）：直接注入 system，无需工具 → **不放行** core/read。
 *
 * 写操作（write / rm / add / update / delete）一律不在 allowlist 里；写入走主链路。
 */
const ALLOWED_SUBPATHS = new Set<string>([
  "atomic/search",        // L1 原子记忆 hybrid search
  "atomic/query",         // L1 按 type/时间/分页
  "conversation/search",  // L0 对话 hybrid search
  "conversation/query",   // L0 按 session 取历史
  "scenario/ls",          // L2 场景列表（path 索引）
  "scenario/read",        // L2 按 path 读全文
]);

interface SessionIdFields {
  user_id: string;
  team_id: string;
  agent_id: string;
  session_id: string;
  task_id?: string;
  /**
   * Kernel tenant/instance ID for `x-tdai-service-id`. Extracted from
   * `SessionInfo.space_id`（原本来自请求路径 `/{agent}/{spaceId}/...`）。
   * 用它做 tenant 路由是正确形态；`config.tdai.serviceId` /
   * `config.coreSkill.serviceId` 只作为老 session（迁移前缓存）的兜底。
   */
  space_id?: string;
}

function toIdFields(
  state: import("../session/types.js").SessionInitState | undefined,
  identity: SessionIdentity,
): SessionIdFields | null {
  if (
    !state
    || state.status !== "initialized"
    || state.contextSuppressed
    || !state.sessionInfo
  ) return null;
  const s = state.sessionInfo;
  if (!s.user_id || !s.team_id || !s.agent_id || !s.session_id) return null;
  if (
    s.user_id !== identity.userId
    || (state.userId && state.userId !== identity.userId)
    || (state.keyId && state.keyId !== identity.sessionId)
    || s.session_id !== identity.sessionId
    || (s.space_id && s.space_id !== identity.spaceId)
  ) {
    return null;
  }
  return {
    user_id: s.user_id,
    team_id: s.team_id,
    agent_id: s.agent_id,
    session_id: s.session_id,
    task_id: s.task_id,
    space_id: identity.spaceId,
  };
}

/**
 * Resolve an authenticated, identity-scoped session through L1/L2.
 *
 * 这是 §6.1 修复：跨 pod 部署时，LLM 手中 curl 走 gateway，gateway 路由到
 * 与 sessionInit 不同的 pod → L1 miss → 401。加了这一层后，跨 pod 也能
 * 从共享 COS 里恢复 session 状态。
 *
 * 代价：每个 bridge 调用多一次 auth/verify roundtrip（~50ms）。这是读取 L1
 * victim identity 前必须支付的安全边界；same-user L1 hit 仍不访问持久层。
 */
async function loadSessionIds(
  config: ProxyConfig,
  userKey: string,
  identity: SessionIdentity,
): Promise<SessionIdFields | null> {
  try {
    const metadataClient = getMetadataClient(
      config.coreSkill,
      identity.spaceId ?? "",
      userKey,
    );
    const recovered = await getSessionStore().getOrRecover(
      sessionStoreKey(identity),
      identity,
      { metadataClient },
    );
    return toIdFields(recovered, identity);
  } catch (err) {
    if (err instanceof SessionIdentityConflictError) throw err;
    console.warn(`${TAG} session recovery failed`);
    return null;
  }
}

function envelope(code: number, message: string, httpStatus = 200): Response {
  return new Response(
    JSON.stringify({ code, message, request_id: `mem-bridge-${Date.now()}` }),
    { status: httpStatus, headers: { "content-type": "application/json" } },
  );
}

function extractSubpath(path: string): string | null {
  const m = path.match(/^\/memory-bridge\/v3\/(.+)$/);
  if (!m) return null;
  return m[1].replace(/\/+$/, "");
}

function selfCtx(ids: SessionIdFields): FixedAssetCtx {
  return { teamId: ids.team_id, userId: ids.user_id, agentId: ids.agent_id, agentName: ids.agent_id, isSelf: true };
}

async function resolveMemoryCtxs(
  config: ProxyConfig,
  ids: SessionIdFields,
  sessionKey: string,
  userKey: string,
  spaceId: string,
): Promise<FixedAssetCtx[]> {
  try {
    const metadataClient = getMetadataClient(config.coreSkill, spaceId, userKey);
    const identity: TdaiIdentity = {
      teamId: ids.team_id,
      userId: ids.user_id,
      agentId: ids.agent_id,
      sessionId: ids.session_id,
      taskId: ids.task_id,
      userKey,
    };
    const fakeCtx: AgentContext = {
      messages: [],
      tools: [],
      requestParams: {},
      metadata: {
        protocol: "anthropic",
        traceId: `memory-bridge:${sessionKey}`,
        keyId: sessionKey,
        modelId: "memory-bridge",
        stream: false,
        agentSource: "memory-bridge",
        custom: { session: ids, userKey },
      },
    };
    return await resolveFixedAssetCtxs(fakeCtx, identity, metadataClient);
  } catch {
    console.warn(`${TAG} fixed asset ctx resolve failed`);
    return [selfCtx(ids)];
  }
}

function selectTargetCtx(ctxs: FixedAssetCtx[], requestedAgentId: unknown): FixedAssetCtx {
  if (typeof requestedAgentId === "string" && requestedAgentId.trim()) {
    const found = ctxs.find((ctx) => ctx.agentId === requestedAgentId.trim());
    if (found) return found;
  }
  return ctxs.find((ctx) => ctx.isSelf) ?? ctxs[0];
}

const MULTI_SEARCH_SUBPATHS = new Set(["atomic/search", "conversation/search"]);

function limitFromBody(body: Record<string, unknown>, fallback = 5): number {
  const n = typeof body.limit === "number" ? body.limit : fallback;
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 50) : fallback;
}

export interface MemoryBridgeDeps {
  fetcher?: typeof fetch;
  now?: () => number;
}

export function createMemoryBridgeHandler(
  config: ProxyConfig,
  deps: MemoryBridgeDeps = {},
): (c: Context) => Promise<Response> {
  const fetcher = deps.fetcher ?? globalThis.fetch.bind(globalThis);

  return async (c: Context): Promise<Response> => {
    const t0 = (deps.now ?? Date.now)();

    const path = new URL(c.req.url).pathname;
    const sub = extractSubpath(path);
    if (!sub) {
      console.warn(`${TAG} request rejected reason=unknown_path`);
      return envelope(40401, `${TAG} unknown path`, 404);
    }
    if (!ALLOWED_SUBPATHS.has(sub)) {
      console.warn(`${TAG} request rejected reason=subpath_not_allowed`);
      return envelope(40301, `${TAG} subpath not allowed via bridge`, 403);
    }
    if (c.req.method !== "POST") {
      console.warn(`${TAG} request rejected reason=method_not_allowed`);
      return envelope(40501, "Method not allowed", 405);
    }

    const ct = c.req.header("content-type") ?? "";
    if (!ct.toLowerCase().includes("application/json")) {
      return envelope(41501, `${TAG} content-type must be application/json`, 415);
    }

    if (!isAuthEnabled()) {
      return envelope(50301, `${TAG} user authentication is required`, 503);
    }
    const authorization = (c.req.header("authorization") ?? "").trim();
    const xApiKey = (c.req.header("x-api-key") ?? "").trim();
    if (authorization && xApiKey) {
      return envelope(40002, `${TAG} ambiguous authentication headers`, 400);
    }
    const bearer = extractBearerToken(authorization);
    if ((authorization && !bearer) || (!bearer && !xApiKey)) {
      return envelope(40102, `${TAG} valid Bearer or x-api-key authentication is required`, 401);
    }
    const userKey = bearer || xApiKey;

    const spaceId = (c.req.header("x-tdai-service-id") ?? "").trim();
    if (!spaceId) {
      return envelope(40003, `${TAG} x-tdai-service-id is required`, 400);
    }
    const agentSource = (c.req.header("x-tdai-agent-source") ?? "").trim();
    try {
      assertAgentSource(agentSource);
      if (!isRegisteredAgentSource(agentSource)) {
        throw new Error("unregistered agent source");
      }
    } catch {
      return envelope(40004, `${TAG} valid x-tdai-agent-source is required`, 400);
    }
    const sessionKey = resolveConversationId(c)?.trim() ?? "";
    if (!sessionKey) {
      return envelope(40101, `${TAG} session identity is unavailable`, 401);
    }

    const verified = await verifyUserKey(userKey, spaceId);
    if (verified.rejected || !verified.userId) {
      return envelope(40302, `${TAG} authentication rejected`, 403);
    }

    let inboundBody: Record<string, unknown> = {};
    try {
      const raw = await c.req.text();
      if (raw && raw.trim()) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          inboundBody = parsed as Record<string, unknown>;
        } else {
          return envelope(40001, `${TAG} body must be a JSON object`, 400);
        }
      }
    } catch {
      console.warn(`${TAG} request rejected reason=invalid_json`);
      return envelope(40001, `${TAG} invalid JSON body`, 400);
    }

    // 强制注入 session IdFields — LLM 不能伪造身份。
    // search 类默认同时查 self + 借入 chat_memory；非 search 类默认 self，可通过 body.agent_id
    // 选择 <tdai_profile_memory> 里暴露的 imported agent_id。
    const modelSessionId =
      typeof inboundBody.session_id === "string" && inboundBody.session_id.trim()
        ? inboundBody.session_id.trim()
        : undefined;
    const modelTaskId =
      typeof inboundBody.task_id === "string" && inboundBody.task_id.trim()
        ? inboundBody.task_id.trim()
        : undefined;

    const identity: SessionIdentity = {
      userId: verified.userId,
      agentSource,
      sessionId: sessionKey,
      spaceId,
      taskId: modelTaskId,
    };
    let ids: SessionIdFields | null;
    try {
      ids = await loadSessionIds(config, userKey, identity);
    } catch (err) {
      if (err instanceof SessionIdentityConflictError) {
        return envelope(40303, `${TAG} session identity conflict`, 403);
      }
      throw err;
    }
    if (!ids) {
      return envelope(40101, `${TAG} session identity is unavailable`, 401);
    }
    if (modelTaskId && modelTaskId !== ids.task_id) {
      return envelope(40303, `${TAG} task identity conflict`, 403);
    }

    const upstreamUrl = `${config.coreSkill.endpoint.replace(/\/$/, "")}/v3/${sub}`;
    const upstreamToken =
      config.tdai?.apiKey || config.coreSkill.serviceToken || "local-proxy";
    const headers: Record<string, string> = {
      "Authorization": `Bearer ${upstreamToken}`,
      "x-tdai-service-id": spaceId,
      "Content-Type": "application/json",
    };

    const ctxs = await resolveMemoryCtxs(config, ids, sessionKey, userKey, spaceId);
    // session_id remains caller-selectable for explicit cross-session search.
    // task_id is an authenticated identity dimension and always comes from the
    // recovered session; a conflicting caller value was rejected above.
    const effectiveTaskId = ids.task_id;
    const makeOutbound = (target: FixedAssetCtx): Record<string, unknown> => ({
      ...inboundBody,
      user_id: target.userId,
      team_id: target.teamId,
      agent_id: target.agentId,
      ...(modelSessionId ? { session_id: modelSessionId } : {}),
      ...(effectiveTaskId ? { task_id: effectiveTaskId } : {}),
    });

    const callUpstream = async (target: FixedAssetCtx): Promise<{ status: number; text: string; contentType: string }> => {
      const resp = await fetcher(upstreamUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(makeOutbound(target)),
        signal: AbortSignal.timeout(Math.max(5000, config.coreSkill.timeoutMs * 4)),
      });
      return { status: resp.status, text: await resp.text().catch(() => ""), contentType: resp.headers.get("content-type") ?? "application/json" };
    };

    if (MULTI_SEARCH_SUBPATHS.has(sub) && typeof inboundBody.agent_id !== "string") {
      const limit = limitFromBody(inboundBody);
      const settled = await Promise.allSettled(ctxs.map(async (target) => ({ target, ...(await callUpstream(target)) })));
      const items: Record<string, unknown>[] = [];
      let okCount = 0;
      for (const r of settled) {
        if (r.status !== "fulfilled" || r.value.status < 200 || r.value.status >= 300) continue;
        okCount++;
        try {
          const env = JSON.parse(r.value.text) as { data?: { items?: unknown[] } };
          for (const item of env.data?.items ?? []) {
            if (!item || typeof item !== "object") continue;
            items.push({
              ...(item as Record<string, unknown>),
              source_agent_id: r.value.target.agentId,
              source_agent_name: r.value.target.agentName,
              source_agent_role: r.value.target.isSelf ? "self" : "imported_from",
            });
          }
        } catch {
          // ignore malformed upstream response from this target
        }
      }
      items.sort((a, b) => (typeof b.score === "number" ? b.score : 0) - (typeof a.score === "number" ? a.score : 0));
      const elapsed = (deps.now ?? Date.now)() - t0;
      console.log(`${TAG} sub=${sub} multi targets=${ctxs.length} ok=${okCount} items=${items.length} elapsed=${elapsed}ms`);
      return new Response(JSON.stringify({
        code: 0,
        message: "ok",
        request_id: `mem-bridge-${Date.now()}`,
        data: { items: items.slice(0, limit), searched_agents: ctxs.map((x) => ({ agent_id: x.agentId, name: x.agentName, role: x.isSelf ? "self" : "imported_from" })) },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    let upstream;
    try {
      upstream = await callUpstream(selectTargetCtx(ctxs, inboundBody.agent_id));
    } catch {
      console.warn(
        `${TAG} upstream fetch failed sub=${sub}`,
      );
      return envelope(50301, `${TAG} upstream unavailable`, 502);
    }

    const respText = upstream.text;
    const elapsed = (deps.now ?? Date.now)() - t0;
    console.log(`${TAG} sub=${sub} status=${upstream.status} elapsed=${elapsed}ms`);

    return new Response(respText, {
      status: upstream.status,
      headers: {
        "content-type": upstream.contentType,
      },
    });
  };
}
