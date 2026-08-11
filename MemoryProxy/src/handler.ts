/** Core request handler: intercept → forward → parse usage → log. */

import type { Context } from "hono";
import { writeLog, createPipeline } from "./logger.js";
import {
  apiKeyToKeyId,
  extractBearerToken,
  opikCreateLlmSpan,
  opikCreateTrace,
  opikUpdateTrace,
  uuidv7,
} from "./opik.js";
import {
  langfuseReportGeneration,
  langfuseReportFailure,
  langfuseTurnTraceId,
  type LangfuseTurnContext,
} from "./langfuse.js";
import {
  buildLangfuseInputChat,
  buildRequestDebugMetadata,
} from "./common/langfuse-debug.js";
import { countHumanTurns } from "./turnSeq.js";
import type { ProxyConfig } from "./types.js";
import {
  resolveForwardTarget,
  resolveSessionKey,
  resolveLatestUserQuery,
  type ForwardTarget,
} from "./guard-adapter.js";
import { hasCostGuardMarker, matchWhitelistEndpoint } from "./routes/whitelist.js";
import { writeRequestLog } from "./requestLog.js";
import { tryReportCreditFromPath, extractSpaceIdFromPath } from "./credit-reporter.js";
import { resolveModelId, isModelInPricing } from "./pricing.js";
import { inspectAndRecord } from "./identity.js";
import { writeFailedReportRaw } from "./clickhouse.js";
import { verifyUserKey } from "./auth.js";
import { matchSystemUserByUserId, hasSystemUsers } from "./systemUser.js";
import { handleSystemUserPassthrough } from "./systemUserPassthrough.js";
import { TdaiClient } from "./tdai/client.js";
import { deriveTdaiIdentity } from "./tdai/identity.js";
import { extractLatestUserMessage, recordTdaiTurn } from "./tdai/recorder.js";
import { trackWrite, withL0Retry } from "./tdai/pending-writes.js";
import type { TdaiIdentity, TdaiMessage } from "./tdai/types.js";
import { triggerSkillExtractIfReady } from "./skill/handler-glue.js";
import { isExtractionAllowed, logExtractionSkipped } from "./extraction-gate.js";
import {
  enforceRateLimit,
  isRateLimitExceededError,
  recordInputTokenUsage,
} from "./rate-limit/guard.js";
import {
  buildSafeUpstreamHeaders,
  MissingUpstreamCredentialError,
  sameOrigin,
} from "./upstream-headers.js";
import { SessionIdentityConflictError, sessionStoreKey } from "./session/store.js";
import {
  getOpenAISourceBindingError,
  type OpenAIChatSource,
} from "./agent-adapters/index.js";

/**
 * Build a per-request TdaiClient. `spaceId` (extracted from the request path
 * `/{agent}/{spaceId}/...`) overrides `config.tdai.serviceId` so writes/recalls
 * land on the correct kernel tenant. Falls back to config when the request
 * carries no spaceId (older single-tenant deployments).
 */
function createTdaiClient(config: ProxyConfig, spaceId?: string): TdaiClient | null {
  if (!config.tdai.enabled || !config.tdai.memory.enabled || !config.tdai.endpoint) return null;
  return new TdaiClient({
    enabled: config.tdai.enabled && config.tdai.memory.enabled,
    endpoint: config.tdai.endpoint,
    apiKey: config.tdai.apiKey,
    serviceId: spaceId || config.tdai.serviceId,
    writeL0: config.tdai.memory.writeL0,
    recallL1: config.tdai.memory.recallL1,
    injectL2L3: config.tdai.memory.injectL2L3,
    l1Limit: config.tdai.memory.l1Limit,
    l2Limit: config.tdai.memory.l2Limit,
    timeoutMs: config.tdai.memory.timeoutMs,
  });
}

/**
 * Flatten messages into Opik-friendly chat messages (no truncation).
 */
function flattenMessagesForOpik(messages: unknown[]): unknown[] {
  const result: unknown[] = [];
  for (const msg of messages) {
    const m = msg as Record<string, unknown>;
    const role = m.role as string;
    const content = m.content;

    if (typeof content === "string") {
      result.push(msg);
      continue;
    }

    if (!Array.isArray(content)) {
      if (role === "assistant" && Array.isArray(m.tool_calls)) {
        if (typeof content === "string" && content) {
          result.push({ role: "assistant", content });
        }
        for (const tc of m.tool_calls as unknown[]) {
          const t = tc as Record<string, unknown>;
          const fn = t.function as Record<string, unknown> | undefined;
          let argsStr = "";
          if (fn?.arguments) {
            argsStr = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments);
          }
          result.push({
            role: "assistant",
            content: JSON.stringify({ tool_call_id: t.id, tool_name: fn?.name ?? "unknown", arguments: argsStr }, null, 2),
          });
        }
        continue;
      }
      result.push(msg);
      continue;
    }

    if (role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: unknown[] = [];
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b.type === "text") {
          textParts.push(b.text as string);
        } else if (b.type === "tool_use") {
          toolCalls.push(b);
        } else if (b.type === "thinking" && b.thinking) {
          textParts.push(`[thinking] ${b.thinking as string}`);
        }
      }
      if (textParts.length > 0) {
        result.push({ role: "assistant", content: textParts.join("\n") });
      }
      for (const tc of toolCalls) {
        const t = tc as Record<string, unknown>;
        const inputStr = typeof t.input === "string" ? t.input : JSON.stringify(t.input);
        result.push({
          role: "assistant",
          content: JSON.stringify({ tool_call_id: t.id, tool_name: t.name, input: inputStr }, null, 2),
        });
      }
      const topLevelToolCalls = m.tool_calls;
      if (Array.isArray(topLevelToolCalls)) {
        for (const tc of topLevelToolCalls) {
          const t = tc as Record<string, unknown>;
          const fn = t.function as Record<string, unknown> | undefined;
          let argsStr = "";
          if (fn?.arguments) {
            argsStr = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments);
          }
          result.push({
            role: "assistant",
            content: JSON.stringify({ tool_call_id: t.id, tool_name: fn?.name ?? "unknown", arguments: argsStr }, null, 2),
          });
        }
      }
    } else if (role === "user") {
      const textParts: string[] = [];
      const toolResults: unknown[] = [];
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b.type === "text") {
          textParts.push(b.text as string);
        } else if (b.type === "tool_result") {
          toolResults.push(b);
        } else {
          textParts.push(JSON.stringify(b));
        }
      }
      if (textParts.length > 0) {
        result.push({ role: "user", content: textParts.join("\n") });
      }
      for (const tr of toolResults) {
        const t = tr as Record<string, unknown>;
        let resultContent: string;
        if (typeof t.content === "string") {
          resultContent = t.content;
        } else if (Array.isArray(t.content)) {
          resultContent = (t.content as Record<string, unknown>[])
            .map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
            .join("\n");
        } else {
          resultContent = JSON.stringify(t.content);
        }
        result.push({
          role: "tool",
          content: JSON.stringify({ tool_call_id: t.tool_use_id, is_error: t.is_error ?? false, result: resultContent }, null, 2),
        });
      }
    } else {
      const merged = content.map((b: unknown) => {
        const block = b as Record<string, unknown>;
        if (block.type === "text") return block.text as string;
        return JSON.stringify(block);
      }).join("\n");
      result.push({ role, content: merged });
    }
  }
  return result;
}

const SKIP_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "transfer-encoding",
  "content-length",
  "connection",
]);

/** Extract usage object from a block of OpenAI SSE text. */
export function extractSseUsage(sseText: string): Record<string, unknown> | null {
  let lastUsage: Record<string, unknown> | null = null;

  for (const line of sseText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const dataStr = trimmed.slice(5).trim();
    if (!dataStr || dataStr === "[DONE]") continue;

    try {
      const evt = JSON.parse(dataStr) as Record<string, unknown>;
      if (evt.usage && typeof evt.usage === "object") {
        lastUsage = evt.usage as Record<string, unknown>;
      }
    } catch {
      // ignore malformed SSE lines
    }
  }

  return lastUsage;
}

/**
 * Build upstream body from original body + cost guard overrides.
 * The host does NOT branch on routing — it just applies overrides if present.
 */
function buildUpstreamBody(
  body: Record<string, unknown>,
  target: ForwardTarget,
): Record<string, unknown> {
  let upstreamBody = body;
  if (target.bodyOverrides) {
    upstreamBody = { ...body, ...target.bodyOverrides };
  }
  return upstreamBody;
}

/**
 * Build upstream headers without letting an extension redirect configured credentials.
 */
function buildUpstreamHeaders(
  c: Context,
  target: ForwardTarget,
  credentialOrigin: string,
  effectiveApiKey?: string,
): Record<string, string> {
  const originBoundApiKey = target.authHeaders === null
    && sameOrigin(target.url, credentialOrigin)
    ? effectiveApiKey
    : undefined;
  return buildSafeUpstreamHeaders(c.req.raw.headers, {
    protocol: "openai",
    apiKey: originBoundApiKey,
    authHeaders: target.authHeaders,
  });
}

function buildRetryUpstreamHeaders(
  c: Context,
  target: ForwardTarget,
  primaryHeaders: Record<string, string>,
): Record<string, string> | null {
  if (!target.retryTarget) return null;
  if (target.retryTarget.authHeaders !== null) {
    return buildSafeUpstreamHeaders(c.req.raw.headers, {
      protocol: "openai",
      authHeaders: target.retryTarget.authHeaders,
    });
  }
  if (sameOrigin(target.url, target.retryTarget.url)) {
    return { ...primaryHeaders };
  }
  throw new MissingUpstreamCredentialError();
}

/**
 * Forward request to upstream and handle retry if retryTarget is set.
 */
async function forwardWithRetry(
  target: ForwardTarget,
  upstreamHeaders: Record<string, string>,
  retryHeaders: Record<string, string> | null,
  upstreamBody: Record<string, unknown>,
  originalBody: Record<string, unknown>,
  pipe: ReturnType<typeof createPipeline>,
  forwardTimeoutMs: number,
  rateLimitContext?: { config: ProxyConfig; instanceId?: string },
): Promise<{ resp: Response; retried: boolean }> {
  let upstreamResp: Response | undefined;
  let forwardFailed = false;

  // Compatibility flag retained, but privacy-safe diagnostics expose only
  // shape/count metadata and never a stable content-derived digest.
  if (process.env.PROXY_DEBUG_DUMP_OUTBOUND_MD5) {
    try {
      const msgs = (upstreamBody as { messages?: Array<{ role?: string; content?: unknown }> }).messages ?? [];
      const sysMsg = msgs.find((m) => m.role === "system");
      const sysStr = typeof sysMsg?.content === "string"
        ? sysMsg.content
        : sysMsg?.content ? JSON.stringify(sysMsg.content) : "";
      const msgsFullStr = JSON.stringify(msgs);
      // eslint-disable-next-line no-console
      console.log(
        `[outbound-summary] protocol=openai system_present=${sysMsg !== undefined} sysBytes=${sysStr.length} msgsCount=${msgs.length} msgsBytes=${msgsFullStr.length}`,
      );
    } catch {
      // eslint-disable-next-line no-console
      console.log("[outbound-summary] protocol=openai failed");
    }
  }

  const fetchOpts: RequestInit = {
    method: "POST",
    headers: upstreamHeaders,
    body: JSON.stringify(upstreamBody),
    redirect: "manual",
  };
  if (forwardTimeoutMs > 0) {
    fetchOpts.signal = AbortSignal.timeout(forwardTimeoutMs);
  }

  if (rateLimitContext) {
    await enforceRateLimit({
      config: rateLimitContext.config,
      instanceId: rateLimitContext.instanceId,
      modelId: target.model,
      protocol: "openai",
    });
  }
  try {
    upstreamResp = await fetch(target.url, fetchOpts);
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      pipe.error("FORWARD", `Timeout after ${forwardTimeoutMs / 1000}s`);
    } else {
      pipe.error("FORWARD", err);
    }
    forwardFailed = true;
  }

  if (upstreamResp && upstreamResp.status >= 300 && upstreamResp.status < 400) {
    pipe.forwardDone(upstreamResp.status);
    pipe.error("FORWARD_REDIRECT", "Upstream redirect rejected");
    throw new Error("Upstream redirect rejected");
  }

  if (upstreamResp) {
    pipe.forwardDone(upstreamResp.status);
  }

  const shouldRetry = target.retryTarget &&
    (forwardFailed || (upstreamResp && upstreamResp.status >= 400 && upstreamResp.status < 500));

  if (shouldRetry && target.retryTarget) {
    const reason = forwardFailed ? "timeout/error" : `${upstreamResp!.status}`;
    pipe.info("RETRY", `Routed model failed (${reason}), retryUrl=${target.retryTarget.url} model=${target.retryTarget.model}`);

    const retryBody = { ...originalBody, model: target.retryTarget.model };
    if (!retryHeaders) throw new MissingUpstreamCredentialError();

    try {
      if (rateLimitContext) {
        await enforceRateLimit({
          config: rateLimitContext.config,
          instanceId: rateLimitContext.instanceId,
          modelId: target.retryTarget.model,
          protocol: "openai",
        });
      }
      const retryFetchOpts: RequestInit = {
        method: "POST",
        headers: retryHeaders,
        body: JSON.stringify(retryBody),
        redirect: "manual",
      };
      if (forwardTimeoutMs > 0) {
        retryFetchOpts.signal = AbortSignal.timeout(forwardTimeoutMs);
      }
      upstreamResp = await fetch(target.retryTarget.url, retryFetchOpts);
      if (upstreamResp.status >= 300 && upstreamResp.status < 400) {
        throw new Error("Upstream redirect rejected");
      }
      if (upstreamResp.ok) {
        pipe.info("RETRY_SUCCESS", `Retry returned ${upstreamResp.status}`);
      } else {
        pipe.error("RETRY_FAILED", `Retry returned ${upstreamResp.status}`);
      }
      return { resp: upstreamResp, retried: true };
    } catch (retryErr: unknown) {
      if (isRateLimitExceededError(retryErr)) throw retryErr;
      if (retryErr instanceof DOMException && retryErr.name === "TimeoutError") {
        pipe.error("RETRY_FORWARD", `Timeout after ${forwardTimeoutMs / 1000}s`);
      } else {
        pipe.error("RETRY_FORWARD", retryErr);
      }
      throw new Error("Upstream request failed");
    }
  }

  if (forwardFailed && !shouldRetry) {
    throw new Error("Upstream request failed");
  }

  if (!upstreamResp) {
    throw new Error("No upstream response available");
  }

  return { resp: upstreamResp, retried: false };
}

/** Main handler for POST /v1/chat/completions (OpenAI compat). */
export async function handleChatCompletions(
  c: Context,
  config: ProxyConfig,
  boundAgentSource?: OpenAIChatSource,
): Promise<Response> {
  const endpoint = matchWhitelistEndpoint(c.req.path);
  if (!endpoint || endpoint.protocol !== "openai" || !endpoint.isPrimary) {
    return c.json(
      { error: { type: "not_found_error", message: "Unsupported OpenAI endpoint" } },
      404,
    );
  }
  // The URL route, not a caller header or arbitrary path prefix, binds the
  // product platform. Reject before auth, body parsing, cache/Core or logs.
  const sourceBindingError = getOpenAISourceBindingError(c.req.path, boundAgentSource);
  if (sourceBindingError === "unbound") {
    return c.json(
      { error: { type: "not_found_error", message: "Unsupported OpenAI platform route" } },
      404,
    );
  }
  if (sourceBindingError === "conflict") {
    return c.json(
      { error: { type: "invalid_request_error", message: "Platform route binding mismatch" } },
      400,
    );
  }
  const agentSource = boundAgentSource!;
  const startTime = new Date().toISOString();
  const traceId = uuidv7();

  // ── Early auth ──────────────────────────────────────────────────────────
  // Verify BEFORE parsing the body so a rejected caller never triggers body
  // parsing or the alias-gate. `earlyVerify.userId` is reused later for
  // both the systemUser short-circuit and the normal pipeline.
  const earlyAuthHeader = c.req.header("authorization") ?? c.req.header("Authorization") ?? "";
  const earlyApiKey = extractBearerToken(earlyAuthHeader);
  const earlySpaceId = extractSpaceIdFromPath(c.req.path) ?? "";
  const earlyVerify = await verifyUserKey(earlyApiKey, earlySpaceId);
  if (earlyVerify.rejected) {
    return c.json({ error: `Authentication failed: ${earlyVerify.rejectReason ?? "unknown"}` }, 401);
  }

  // ── Parse body ──────────────────────────────────────────────────────────
  // Body is parsed BEFORE the systemUser short-circuit so the alias-gate and
  // `resolveModelId` fire uniformly for internal AND external callers. The
  // parsed object is later handed to `handleSystemUserPassthrough` (which
  // serialises it) so we never double-read `c.req`.
  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  // ── Model gate: reject requests whose `model` is not a registered display name ──
  // 价目表已配置时，客户端 `model` 必须匹配某条 entry 的 `modelName`（展示名，
  // 大小写不敏感）。真实 model_id 是内部细节，不作为客户端入口。未匹配则直接
  // 400，避免请求转发成功却因无定价而漏计费。价目表为空时跳过（向后兼容）。
  //
  // 内部/外部用户一视同仁 —— internal callers must also request by
  // `modelName`, keeping upstream IDs and in-process pricing lookup aligned.
  // Privacy-safe telemetry exports do not retain the model identity.
  const requestedModel = typeof body.model === "string" ? body.model : "unknown";
  if (!isModelInPricing(config.creditPricing, requestedModel)) {
    return c.json(
      {
        error: {
          message: `Model '${requestedModel}' is not a registered display name in the credit pricing table`,
          type: "invalid_request_error",
          code: "model_not_found",
        },
      },
      400,
    );
  }

  // ── Model alias: rewrite client-facing modelName → real model_id ──────────
  // Clients may put a human-readable name (e.g. "claude-opus-4.7") in `model`;
  // resolve it back to the real upstream model_id (e.g. "ep-pksklwtb") BEFORE
  // routing / logging / forwarding, so model_id stays the canonical identity
  // across the whole pipeline. No-op when `model` is already a real id/unknown.
  const modelId = resolveModelId(config.creditPricing, requestedModel);
  const modelAliasApplied = typeof body.model === "string" && modelId !== requestedModel;
  if (modelAliasApplied) body.model = modelId;

  // ── System-user short-circuit ────────────────────────────────────────────
  // Internal service accounts (see `systemUsers` config) bypass the entire
  // pipeline: no session-init, no injection, no routing. Matching key is
  // the userId resolved by verifyUserKey — NOT the raw apiKey. Auth-disabled
  // requests (userId == "") never match, so the short-circuit is inert unless
  // auth is on.
  //
  // We hand the already-parsed+alias-resolved `body` to the passthrough so
  // upstream sees the canonical model_id, aligning internal traffic with
  // external.
  if (hasSystemUsers()) {
    const sysMatch = matchSystemUserByUserId(earlyVerify.userId);
    if (sysMatch) {
      return handleSystemUserPassthrough(c, config, sysMatch, body);
    }
  }

  let messages = Array.isArray(body.messages) ? body.messages : [];
  const isStream = body.stream === true;

  // Privacy-safe request-tail shape for session-init diagnosis.
  if (config.sessionInit?.enabled && messages.length > 2) {
    const tail = messages.slice(-3);
    const toolMessageCount = tail.filter((message: any) =>
      Boolean(message?.tool_call_id) || Array.isArray(message?.tool_calls)
    ).length;
    console.log("[session-init-debug] request_tail", {
      messageCount: messages.length,
      tailCount: tail.length,
      toolMessageCount,
    });
  }

  // ── Identity inspection ──────────────────────────────────────────────────
  const reqHeaders: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    reqHeaders[k] = v;
  }
  inspectAndRecord("POST", c.req.path, reqHeaders, body as Record<string, unknown>, agentSource);

  // ── Resolve apiKey → project name ──────────────────────────────────────
  const authHeader = c.req.header("authorization") ?? c.req.header("Authorization") ?? "";
  const apiKey = extractBearerToken(authHeader);
  let keyId = apiKey ? apiKeyToKeyId(apiKey) : "unknown";

  // ── Lowercased headers for agent profile detection + session key ──────────
  const lcHeaders: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    lcHeaders[k.toLowerCase()] = v;
  }

  // ── Session key: prefer conversation header, fallback to agent profile ───────────
  const { resolveConversationId } = await import("./session/session-key.js");
  const conversationId = resolveConversationId(c);
  const sessionKey = conversationId ?? resolveSessionKey(config, lcHeaders, c.req.path, body, keyId);

  // ── Auth verification (user_key → user_id) ──────────────────────────────────────
  // Reuse the early verify result — it ran before body parse to decide the
  // system-user short-circuit; running verify again here would double the
  // network round-trip for every request.
  const spaceId = earlySpaceId;
  const userId = earlyVerify.userId
    || c.req.header("x-user-id")
    || c.req.header("x-cb-user-id")
    || c.req.header("x-tdai-user-token")
    || "";
  if (userId) keyId = userId;

  // Activate Redis storage early — must run BEFORE session init.
  if (config.redis?.enabled) {
    const { getInjectionPipeline } = await import("./injection/index.js");
    getInjectionPipeline(config);
  }

  // ── Session Init (before injection pipeline) ─────────────────────────────
  let sessionInfo: Record<string, unknown> | null | undefined;
  let assetCapabilities: import("./injection/types.js").AssetCapabilityFlags | undefined;
  let injectedSkipped = !conversationId;
  let sessionJustRegistered = false;
  console.log("[injection-debug] request_config", {
    agentSourceRecognized: ["claude-code", "codebuddy"].includes(agentSource),
    sessionInitEnabled: config.sessionInit?.enabled === true,
    injectionEnabled: config.injection?.enabled === true,
    injectorCount: config.injection?.injectors?.length ?? 0,
    injectedSkipped,
  });
  if (config.sessionInit?.enabled && conversationId) {
    try {
      const { getSessionStore, handleSessionInit, parsePresetIdentity } = await import("./session/index.js");
      const { getMetadataClient } = await import("./meta/client.js");
      const store = getSessionStore();
      const metadataClient = getMetadataClient(config.coreSkill, spaceId, apiKey);
      const presetIdentity = parsePresetIdentity(config.sessionInit, lcHeaders);

      // ── Session Recovery: try L2b binding before falling into session-init form ──
      // Identity for repo/binding writes. userId 缺失时 fallback 到 `anonymous`
      // 复合键，保证 key path 分段合法（`u=anonymous` 走独立命名空间，天然与
      // 有 userId 的请求隔离）。参见 §4.4 边界处理。
      const identity = {
        userId: userId || "anonymous",
        agentSource,
        sessionId: sessionKey,
        spaceId,
        teamId: presetIdentity?.teamId,
        agentId: presetIdentity?.agentId,
        taskId: presetIdentity?.taskId,
      };
      const compositeKey = sessionStoreKey(identity);
      const recovered = await store.getOrRecover(compositeKey, identity, {
        metadataClient,
        messages: body.messages as Array<Record<string, unknown>> ?? [],
      });
      if (recovered?.contextSuppressed) {
        console.warn("[session-init] request rejected reason=context_unavailable");
        return c.json({ error: "session_context_unavailable" }, 409);
      }

      let initResult: Awaited<ReturnType<typeof handleSessionInit>>;
      // Only treat the session as "recovered" when it's in a terminal state
      // (initialized or bypassed). Pending / mid-form states MUST fall through
      // to handleSessionInit so the state machine can advance to the next form.
      const isTerminalState = recovered?.status === "initialized";
      // 记录本 turn 是否真的走了 handleSessionInit state machine（详见 anthropicHandler
      // 对称位置的注释）。sessionJustRegistered = wentThrough && justRegistered，覆盖
      // 正常注册 + bypass 两种终态转换（bypass 分支现在也带 justRegistered=true），让
      // mem-command 拦截块能在 bypass 转换那一 turn 通过 checkFirst 兜底捞出用户最初
      // 的 mem: 命令并返回"未初始化"文案，避免透传给上游 LLM 幻觉回答。
      // L2b recovery 分支 justRegistered=true 只是 prewarm 信号，走 recovered 分支时
      // wentThroughSessionInitStateMachine=false 会自然过滤掉，不进 sessionJustRegistered。
      let wentThroughSessionInitStateMachine = false;
      if (recovered && isTerminalState) {
        // Recovery hit: keep original messages, only re-inject <session_context>
        // so this turn's system message carries agent/task context again.
        // 用户对话永远保留原样，包括 session_init form 交互 — 不做任何删除。
        const { injectSessionContextWithToggles } = await import("./session/context-injector.js");
        const inMsgs = (body.messages as Array<Record<string, unknown>>) ?? [];
        const outMsgs = recovered.bypassed
          ? inMsgs
          : injectSessionContextWithToggles(
              inMsgs,
              recovered.agentDetail ?? null,
              recovered.taskDetail ?? null,
              config.sessionInit,
              sessionKey,
            );
        initResult = {
          intercepted: false,
          messages: outMsgs as Record<string, unknown>[],
          sessionInfo: recovered.sessionInfo,
          agentDetail: recovered.agentDetail,
          taskDetail: recovered.taskDetail,
          bypassed: recovered.bypassed,
          justRegistered: true, // triggers prewarm to refill hook cache
        };
      } else {
        wentThroughSessionInitStateMachine = true;
        initResult = await handleSessionInit(
          sessionKey,
          userId || null,
          body.messages as Array<Record<string, unknown>> ?? [],
          config.sessionInit,
          store,
          { stream: isStream, modelId: modelId as string, protocol: "openai" },
          agentSource,
          metadataClient,
          apiKey,
          spaceId,
          presetIdentity,
        );
      }

      // Case 1: Fake form returned → must not forward
      if (initResult.intercepted && initResult.response) {
        return initResult.response;
      }

      console.log(`[injection-debug] initResult session=<redacted> intercepted=${initResult.intercepted} bypassed=${initResult.bypassed} justRegistered=${initResult.justRegistered} hasSessionInfo=${!!initResult.sessionInfo} hasAgentDetail=${!!initResult.agentDetail}`);
      // 见 anthropicHandler 对称位置：只在真正走 sessionInit state machine 时继承。
      if (wentThroughSessionInitStateMachine && initResult.justRegistered) sessionJustRegistered = true;

      // Case 1.5: Bypass path → skip ALL injection hooks
      if (initResult.bypassed) {
        injectedSkipped = true;
        console.log("[session-init] session=<redacted> bypassed → skipping all injection");
      }

      if (!initResult.bypassed && initResult.sessionInfo) {
        try {
          const { fetchAssetCapabilities } = await import("./tdai/capabilities.js");
          assetCapabilities = await fetchAssetCapabilities({
            endpoint: config.tdai.endpoint,
            apiKey: config.tdai.apiKey,
            serviceId: config.tdai.serviceId,
            serviceIdOverride: spaceId,
            userId: (initResult.sessionInfo as { user_id?: string }).user_id,
            userKey: apiKey || null,
            timeoutMs: config.tdai.memory.timeoutMs,
          });
          console.log("[asset-capability] resolved user=present");
        } catch {
          console.warn("[asset-capability] resolve failed");
        }
      }

      // Restore space_id from the URL BEFORE prewarm. Recovery paths and
      // legacy sessions can hydrate a SessionInfo whose `space_id` is empty;
      // prewarm calls (skill-injector, memory-injector) route to the correct
      // kernel tenant via this field, so a missing value at this point
      // silently poisons the prewarm cache with empty results.
      // See BUG-skill-injection-multinode.md §3.3(B).
      const { restoreSessionSpaceId } = await import("./session/restore-space-id.js");
      restoreSessionSpaceId(
        initResult.sessionInfo as Record<string, unknown> | null | undefined,
        spaceId,
      );

      // Case 2 success → await prewarm so the first-turn pipeline always
      // hits the cache. A fire-and-forget void() here caused the bug where
      // the pipeline ran before the cache was populated, silently injecting
      // zero blocks for the entire first turn.
      if (
        !initResult.bypassed &&
        initResult.justRegistered &&
        initResult.sessionInfo &&
        config.injection?.enabled &&
        (config.injection.injectors?.length ?? 0) > 0
      ) {
        try {
          const mod = await import("./injection/index.js");
          await mod.prewarmFromConfig(config, {
            keyId: sessionKey,
            userId: userId || "anonymous",
            agentSource,
            sessionInfo: initResult.sessionInfo as import("./session/types.js").SessionInfo,
            agentDetail: initResult.agentDetail ?? null,
            taskDetail: initResult.taskDetail ?? null,
            assetCapabilities,
            // 透传 caller 的 sk-mem key，用于 prewarm 阶段 TDAI ACL 校验（x-tdai-user-key）
            callerUserKey: apiKey ?? undefined,
          });
        } catch {
          console.warn("[hook-cache] handler prewarm failed");
          // Don't re-throw: the pipeline's resolveHookBlocks has its own
          // cache-miss → execute() fallback as a safety net (see pipeline.ts).
        }
      }

      // Case 2: Messages were cleaned → update body
      if (initResult.messages) {
        body = { ...body, messages: initResult.messages };
        messages = initResult.messages as unknown[];
      }

      sessionInfo = initResult.sessionInfo as Record<string, unknown> | null | undefined;
      // Belt-and-suspenders: also restore on the local `sessionInfo` alias.
      // In practice this is the same object reference as
      // `initResult.sessionInfo` (already restored above), but the second
      // call is a no-op and guards against future refactors that copy
      // the object between these two lines.
      restoreSessionSpaceId(sessionInfo, spaceId);
    } catch (err) {
      if (err instanceof SessionIdentityConflictError) {
        console.warn("[session-init] request rejected reason=identity_conflict");
        return c.json({ error: "session_identity_conflict" }, 403);
      }
      console.error("[session-init] handleSessionInit failed");
      sessionInfo = undefined;
      injectedSkipped = true;
    }
  }

  // ── mem: command intercept ────────────────────────────────────────────────
  // 位置对齐 anthropicHandler.ts:847 —— session init 完成后、injection 之前。
  // 命中时：执行命令 → 写 L0 → 触发 skill extract → 伪造 OpenAI 响应返回，跳过
  // injection（不破坏 KV cache）和上游转发（零 token 消耗）。配置开关
  // memCommand.enabled 关闭时此段完全不执行，走原有链路。
  //
  // 解决的坑：CodeBuddy 走 OpenAI 协议命中本 handler，之前 mem-command intercept
  // 只挂在 anthropicHandler，CB 用户发 `mem:help` 会直接透传到上游 LLM，返回
  // LLM 幻觉出来的"帮助文本"（含 mem:atoms/mem:profile/mem:conversations 等
  // 根本不存在的命令）。本次抓包 (langfuse trace d814929a...) 实证后补齐。
  //
  // 请求分类：OpenAI 协议不做 CC 的 fork/sidequery 分流（handler.ts 没接 CC
  // routing），所有请求都视为 main —— 与 codebuddy adapter classifyRequest 一致。
  if (config.memCommand?.enabled) {
    const { parseMemCommand, isMemCommandAllowed, executeMemCommand, buildMemResponse } = await import("./mem-command/index.js");
    // 常规检测：最后一条 user message
    let memCmd = parseMemCommand(body as Record<string, unknown>, agentSource);
    // Session init 状态机在本 turn 完成终态（初始化 or bypass）时，最后一条
    // user message 是 init 交互回答（比如"否"），额外检查第一条 user message
    // —— 用户最初的原始意图。bypass 场景下 sessionInfo=null 走"未初始化"分支
    // 返回文案，避免首条 mem: 命令被吞进历史后落到 LLM 透传里。
    if (!memCmd && sessionJustRegistered) {
      memCmd = parseMemCommand(body as Record<string, unknown>, agentSource, { checkFirst: true });
    }
    if (memCmd && isMemCommandAllowed(config.memCommand, memCmd.command)) {
      // 会话未初始化时，命令不可用（同 anthropic 侧提示）
      if (!sessionInfo || injectedSkipped) {
        const errText = `⚠️ 会话未初始化，命令不可用。请先完成 session 初始化（选择 Team/Agent）后重试。`;
        const errResponse = buildMemResponse(errText, {
          protocol: "openai",
          stream: isStream,
          requestId: `mem-cmd-${Date.now()}`,
        });
        console.log("[mem-command] blocked session=<redacted> reason=session_not_initialized");
        return errResponse;
      }
      const memResult = await executeMemCommand(memCmd, {
        sessionKey,
        agentSource,
        config,
        spaceId,
        userId,
        apiKey: apiKey || "",
        sessionInfo: sessionInfo as Record<string, unknown>,
        protocol: "openai",
        stream: isStream,
        args: memCmd.args,
        // OpenAI 协议无 extended thinking 概念，恒 false
      });

      // L0 写入 — 同步 await 保证落盘再返回（跟主对话路径的 trackWrite/withL0Retry
      // 兜底不同，这里 mem 命令是"仅这一次"路径，必须显式等）。
      const tdaiClientForMem = createTdaiClient(config, spaceId);
      const tdaiIdentityForMem = deriveTdaiIdentity({
        sessionInfo: sessionInfo as Record<string, unknown> | null | undefined,
        userId: userId || null,
        sessionKey,
      });
      if (tdaiClientForMem && tdaiIdentityForMem && isExtractionAllowed(config, "tdai-memory")) {
        const userMsg = { role: "user" as const, content: memCmd.rawMessage };
        try {
          await recordTdaiTurn(tdaiClientForMem, tdaiIdentityForMem, userMsg, memResult.messageText);
        } catch {
          console.error("[mem-command] L0 write failed");
        }
      }

      // Skill extract trigger — 保证对话轮次计数正常累积（跟 anthropic 侧对称）
      if (isExtractionAllowed(config, "skill")) {
        try {
          // OpenAI 协议 assistant content 是字符串，normalize-conversation 那侧
          // 会走 convertOpenAIAssistant 兜底处理 string 形态。
          const assistantMsg = { role: "assistant", content: memResult.messageText };
          await triggerSkillExtractIfReady({
            config,
            sessionKey,
            agentSource,
            sessionInfo: sessionInfo as Record<string, unknown>,
            inputMessages: messages as unknown[],
            assistantMessage: assistantMsg,
            protocol: "openai",
            assetCapabilities,
          });
        } catch {
          console.warn("[mem-command] skill extract trigger failed");
        }
      }

      console.log(`[mem-command] completed session=<redacted> success=${memResult.success}`);

      return memResult.response;
    }
  }

  const tdaiClient = assetCapabilities?.chat_memory === false ? null : createTdaiClient(config, spaceId);
  const tdaiIdentity = injectedSkipped
    ? null
    : deriveTdaiIdentity({
        sessionInfo: sessionInfo as Record<string, unknown> | null | undefined,
        userId: userId || null,
        sessionKey,
      });
  const tdaiUserMessage = extractLatestUserMessage(messages);

  // ── Context injection (before cost guard) ──────────────────────────────
  if (!injectedSkipped && config.injection?.enabled && config.injection.injectors.length > 0) {
    try {
      const injectionTurnSeq = countHumanTurns(messages, "openai");
      const { getInjectionPipeline } = await import("./injection/index.js");
      const pipeline = getInjectionPipeline(config);
      const injectedBody = await pipeline.process(body, {
        protocol: "openai",
        traceId,
        keyId,
        modelId: modelId as string,
        stream: isStream,
        agentSource,
        userId: userId || "anonymous",
        spaceId,
        sessionKey,
        turnSeq: injectionTurnSeq,
        // 透传原始请求路径 —— AssetReflectionInjector 用它判断 `/analyse` marker。
        // 其它 injector 不依赖此字段。
        requestPath: c.req.path,
        custom: sessionInfo
          ? {
              session: sessionInfo,
              assetCapabilities,
              userKey: apiKey || undefined,
            }
          : undefined,
      });
      body = injectedBody;
      messages = Array.isArray(injectedBody.messages) ? injectedBody.messages : messages;
    } catch (err: unknown) {
      // Injection failure is non-fatal — fall back to original body
    }
  }

  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;

  // ── Resolve forward target (opaque extension — no routing logic here) ──
  // upstream.agents[agent] is a single map keyed by agent name — same lookup
  // as anthropicHandler. Empty / missing entry → fall back to upstream.url,
  // preserving legacy behavior for configs that don't declare `agents:` at all.
  const agentUpstreamEntry = config.upstream.agents?.[agentSource];
  // Caller credentials terminate at MemoryProxy. URL-only agent entries use
  // the global server key; if no server key exists, forwarding fails closed.
  const credentialOrigin = agentUpstreamEntry?.url ?? config.upstream.url;
  const effectiveApiKey = agentUpstreamEntry?.apiKey?.trim() || config.upstream.apiKey.trim();
  // Normalize the request path to the canonical upstream endpoint so the
  // extension's URL joining matches the host whitelist behavior.
  const forwardEndpoint = matchWhitelistEndpoint(c.req.path)?.upstreamEndpoint ?? "/chat/completions";
  // Isolation key is user-namespaced (`${user}:${session}`) so two users that
  // share the same client session id can't contaminate each other's state /
  // turn counting. ClickHouse writes fixed-redaction session/user columns;
  // this composite remains in-process and is internal to the extension only.
  const target: ForwardTarget = await resolveForwardTarget(config, {
    keyId: `${keyId}:${sessionKey}`,
    messages,
    protocol: "openai",
    hasTools,
    body,
    modelId,
    defaultUpstreamUrl: agentUpstreamEntry?.url ?? config.upstream.url,
    requestPath: forwardEndpoint,
    headers: lcHeaders,
    traceId,
    startTime,
    spaceId,
    // markerOptIn=false (default/prod): every request goes through the router
    //   regardless of the URL (`/cost-guard` routes are 404 in this mode).
    // markerOptIn=true (test env): only requests with the `/cost-guard`
    //   segment activate the router; bare paths passthrough.
    useGuard: config.costGuard.markerOptIn ? hasCostGuardMarker(c.req.path) : true,
    agentName: agentSource,
  });

  // ── Create pipeline logger ──────────────────────────────────────────────
  const pipe = createPipeline(config, traceId, target.model);
  pipe.requestReceived(messages.length, isStream);

  // ── Trace-level tags ──
  const traceTags: string[] = [
    "protocol:openai",
    isStream ? "stream" : "non-stream",
    `session:${sessionKey}`,
  ];

  // ── Langfuse request context: one random request trace per proxy call ─────
  // turnSeq remains useful for in-process ordering, but privacy-safe export
  // deliberately provides no deterministic cross-request/session grouping.
  const turnSeq = target.turnSeq > 0 ? target.turnSeq : countHumanTurns(messages, "openai");
  const lf: LangfuseTurnContext = {
    traceId: langfuseTurnTraceId(traceId),
    turnSeq,
    traceName: `${target.model} / ${keyId}`,
    userId: keyId,
    sessionId: sessionKey,
    tags: traceTags,
    routeTags: [],
    userQuery: resolveLatestUserQuery(config, lcHeaders, c.req.path, body, messages),
  };

  // ── Langfuse debug metadata (only when config.langfuse.debug=true) ────────
  // CB / cursor / windsurf 走 OpenAI 协议命中本 handler；开 debug 时把请求
  // 结构 + 客户端指纹塞进 Langfuse observationMetadata，供抓包分析用。
  // 默认关（{}），不污染线上 trace。详见 common/langfuse-debug.ts。
  const langfuseDebug = config.langfuse.debug === true;
  const debugMetadata = buildRequestDebugMetadata({
    debug: langfuseDebug,
    body: body as Record<string, unknown>,
    headers: reqHeaders,
    agentSource,
    // 本 handler 不做 CC 客户端的 fork/sidequery 分流（只 anthropicHandler 走那套）
    spaceId,
    turnSeq,
    requestPath: c.req.path,
    protocol: "openai",
  });

  // ── Opik: create trace ───────────────────────────────────────────────────
  const forkTraceId = opikCreateTrace(config, {
    traceId,
    projectName: keyId,
    name: `${target.model} / ${keyId}`,
    startTime,
    input: { messages: flattenMessagesForOpik(messages) },
    tags: traceTags,
    forkProjectName: "request_log",
    forkMetadata: {
      keyId,
      modelId: target.model,
      stream: isStream,
      upstreamUrl: target.url,
    },
  });

  // ── Request debug log ────────────────────────────────────────────────────
  writeRequestLog(config, body);

  // ── Build upstream request ───────────────────────────────────────────────
  const upstreamBody = buildUpstreamBody(body, target);
  let upstreamHeaders: Record<string, string>;
  let retryHeaders: Record<string, string> | null;
  try {
    upstreamHeaders = buildUpstreamHeaders(c, target, credentialOrigin, effectiveApiKey);
    retryHeaders = buildRetryUpstreamHeaders(c, target, upstreamHeaders);
  } catch (err: unknown) {
    if (err instanceof MissingUpstreamCredentialError) {
      return c.json({ error: err.message }, 503);
    }
    throw err;
  }

  // Inject stream_options.include_usage for OpenAI compat
  if (isStream) {
    upstreamBody.stream_options = {
      ...(typeof upstreamBody.stream_options === "object" && upstreamBody.stream_options !== null
        ? (upstreamBody.stream_options as object)
        : {}),
      include_usage: true,
    };
  }

  // ── Forward to upstream (with automatic retry if configured) ──────────────
  const forwardTimeoutMs = config.server.forwardTimeoutMs ?? 600_000;
  pipe.forwardStart();
  let upstreamResp: Response;
  let retried = false;

  try {
    const result = await forwardWithRetry(
      target, upstreamHeaders, retryHeaders, upstreamBody,
      body,
      pipe, forwardTimeoutMs,
      { config, instanceId: spaceId || undefined },
    );
    upstreamResp = result.resp;
    retried = result.retried;
  } catch (err: unknown) {
    if (isRateLimitExceededError(err)) {
      pipe.info("RATE_LIMIT", "TPM/QPM exceeded");
      return err.response;
    }
    langfuseReportFailure({
      lf,
      model: target.model,
      startTime,
      endTime: new Date().toISOString(),
      input: buildLangfuseInputChat(messages, langfuseDebug, flattenMessagesForOpik),
      statusMessage: err instanceof Error ? err.message : "Upstream request failed",
      extraTags: ["error"],
      observationMetadata: { stage: "forward", ...debugMetadata },
    });
    return c.json({ error: "Upstream request failed" }, 502);
  }

  // Build response headers (strip hop-by-hop)
  const respHeaders = new Headers();
  for (const [k, v] of upstreamResp.headers.entries()) {
    if (!SKIP_RESPONSE_HEADERS.has(k.toLowerCase())) {
      respHeaders.set(k, v);
    }
  }

  // Upstream request id from response header (tokenhub / OpenAI-compatible
  // gateways set `x-request-id`). Used for cross-system tracing/audit.
  const upstreamRequestId = upstreamResp.headers.get("x-request-id") ?? "";

  const effectiveModel = retried && target.retryTarget
    ? target.retryTarget.model
    : target.model;

  // ── Streaming response ───────────────────────────────────────────────────
  if (isStream) {
    if (!upstreamResp.body) {
      pipe.streamDone(null);
      return new Response(null, { status: upstreamResp.status, headers: respHeaders });
    }

    // Log upstream error body for 4xx responses
    if (!retried && upstreamResp.status >= 400 && upstreamResp.status < 500) {
      const [errBodyStream, clientPassStream] = upstreamResp.body.tee();
      const errText = await new Response(errBodyStream).text();
      pipe.error("UPSTREAM_4xx", `status=${upstreamResp.status} body=${errText.slice(0, 1000)}`);
      writeLog(config, {
        timestamp: new Date().toISOString(),
        event: "usage",
        modelId: target.model,
        keyId,
        sessionKey,
        upstreamUrl: target.url,
        stream: true,
        usage: { error: true, status: upstreamResp.status, body: errText.slice(0, 500) },
        spaceId,
        upstreamRequestId,
      });
      langfuseReportFailure({
        lf,
        model: effectiveModel,
        startTime,
        endTime: new Date().toISOString(),
        input: buildLangfuseInputChat(messages, langfuseDebug, flattenMessagesForOpik),
        status: upstreamResp.status,
        statusMessage: errText.slice(0, 500),
        extraTags: ["error"],
        observationMetadata: { stage: "upstream", stream: true, ...debugMetadata },
      });
      pipe.streamDone(null);
      return new Response(clientPassStream, { status: upstreamResp.status, headers: respHeaders });
    }

    pipe.streamStart();

    const tapCtx: TapContext = {
      config,
      modelId: effectiveModel,
      keyId,
      sessionKey,
      upstreamUrl: target.url,
      requestPath: c.req.path,
      traceId,
      forkTraceId,
      startTime,
      inputMessages: messages,
      retried,
      logMeta: retried ? { retrySuccess: true } : {},
      tdaiClient,
      tdaiIdentity,
      tdaiUserMessage,
      assetCapabilities,
      pipe,
      sessionKeyForSkill: sessionKey,
      agentSource,
      sessionInfo,
      lf,
      spaceId,
      upstreamRequestId,
      langfuseDebug,
      debugMetadata,
    };
    const passthrough = createUsageTapTransform(tapCtx);
    const tappedStream = upstreamResp.body.pipeThrough(passthrough);

    return new Response(tappedStream, { status: upstreamResp.status, headers: respHeaders });
  }

  // ── Non-streaming response ───────────────────────────────────────────────
  const respText = await upstreamResp.text();
  const endTime = new Date().toISOString();

  let usage: Record<string, unknown> | null = null;
  let assistantMessage: Record<string, unknown> | null = null;
  try {
    const respJson = JSON.parse(respText) as Record<string, unknown>;
    if (respJson.usage && typeof respJson.usage === "object") {
      usage = respJson.usage as Record<string, unknown>;
    }
    const choices = respJson.choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const msg = (choices[0] as Record<string, unknown>).message;
      if (msg && typeof msg === "object") {
        assistantMessage = msg as Record<string, unknown>;
      }
    }
  } catch {
    // non-JSON upstream response
  }

  const logMeta = retried ? { retrySuccess: true } : {};

  if (usage) {
    await recordInputTokenUsage({
      config,
      instanceId: spaceId || undefined,
      modelId: effectiveModel,
      usage,
      protocol: "openai",
    });
    writeLog(config, {
      timestamp: endTime,
      event: "usage",
      modelId: effectiveModel,
      keyId,
      sessionKey,
      turnSeq: lf.turnSeq,
      userInput: lf.userQuery || undefined,
      upstreamUrl: target.url,
      stream: false,
      usage,
      spaceId,
      upstreamRequestId,
      ...logMeta,
    });

    const outputMessages = assistantMessage ? [assistantMessage] : [];
    opikUpdateTrace(config, {
      traceId,
      projectName: keyId,
      endTime,
      output: outputMessages,
      usage,
    });
    if (forkTraceId && !config.opik.stripRequestLogContent) {
      opikUpdateTrace(config, {
        traceId: forkTraceId,
        projectName: "request_log",
        endTime,
        output: outputMessages,
        usage,
      });
    }

    if (tdaiClient && isExtractionAllowed(config, "tdai-memory")) {
      await recordTdaiTurn(tdaiClient, tdaiIdentity, tdaiUserMessage, assistantContentForTdai(assistantMessage));
    } else if (tdaiClient) {
      logExtractionSkipped(config, "tdai-memory", sessionKey);
    }

    opikCreateLlmSpan(config, {
      traceId,
      projectName: keyId,
      name: effectiveModel,
      startTime,
      endTime,
      inputMessages: flattenMessagesForOpik(messages),
      outputMessage: assistantMessage,
      model: effectiveModel,
      usage,
      tags: [
        "non-stream",
        ...(retried ? ["retry"] : []),
      ],
      forkProjectName: "request_log",
      forkTraceId,
      forkMetadata: {
        keyId,
        modelId: effectiveModel,
        stream: false,
        upstreamUrl: target.url,
      },
    });

    // Langfuse: report this LLM call under the current request trace.
    langfuseReportGeneration({
      traceId: lf.traceId,
      name: effectiveModel,
      model: effectiveModel,
      startTime,
      endTime,
      input: buildLangfuseInputChat(messages, langfuseDebug, flattenMessagesForOpik),
      output: assistantMessage,
      usage,
      traceName: lf.traceName,
      userId: lf.userId,
      sessionId: lf.sessionId,
      tags: lf.tags,
      traceInput: lf.userQuery || undefined,
      traceOutput: assistantMessage ?? undefined,
      traceMetadata: { stream: false, retried, upstreamUrl: target.url, ...logMeta, ...debugMetadata },
      observationMetadata: { retried, ...logMeta, ...debugMetadata },
    });
  } else if (upstreamResp.status >= 400) {
    pipe.error("UPSTREAM_4xx", `status=${upstreamResp.status} body=${respText.slice(0, 1000)}`);
    langfuseReportFailure({
      lf,
      model: effectiveModel,
      startTime,
      endTime,
      input: buildLangfuseInputChat(messages, langfuseDebug, flattenMessagesForOpik),
      status: upstreamResp.status,
      statusMessage: respText.slice(0, 500),
      extraTags: ["error"],
      observationMetadata: { stage: "upstream", stream: false, ...debugMetadata },
    });
  }

  pipe.responseDone(usage);

  // Skill extract trigger — count tool calls + buffer conversation.
  // 同步 await：直到 store 落盘再继续，保证下一轮跨节点读到最新数据。
  if (isExtractionAllowed(config, "skill")) {
    await triggerSkillExtractIfReady({
      config,
      sessionKey,
      agentSource,
      sessionInfo,
      inputMessages: messages,
      assistantMessage,
      protocol: "openai",
      assetCapabilities,
    });
  } else {
    logExtractionSkipped(config, "skill", sessionKey);
  }

  // Credit usage reporting (non-streaming). Failures are surfaced to the client
  // via the `x-credit-report-error` response header but never replace the
  // upstream LLM response body — the user-facing answer is preserved.
  const creditOutcome = await tryReportCreditFromPath(
    config.creditReport,
    c.req.path,
    usage,
    config.creditPricing,
    effectiveModel,
    target.url,
    "usage",
  );
  if (creditOutcome.attempted && !creditOutcome.ok) {
    pipe.error("CREDIT_REPORT", creditOutcome.errorMessage ?? "unknown");
    if (creditOutcome.errorHeader) {
      respHeaders.set("x-credit-report-error", creditOutcome.errorHeader);
    }
    // Persist the failed report as a raw record for auditing / retry pipelines.
    writeFailedReportRaw(
      {
        timestamp: new Date().toISOString(),
        event: "usage",
        modelId: effectiveModel,
        keyId,
        sessionKey,
        upstreamUrl: target.url,
        stream: false,
        usage: usage === null ? undefined : usage,
        upstreamRequestId,
        pricingConfig: config.creditPricing,
      },
      creditOutcome.errorMessage ?? "unknown",
    );
  }

  return new Response(respText, { status: upstreamResp.status, headers: respHeaders });
}


function assistantContentForTdai(message: Record<string, unknown> | null): string | null {
  if (!message) return null;
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      const p = part as Record<string, unknown>;
      if (typeof p.text === "string") return p.text;
      if (typeof p.content === "string") return p.content;
      return "";
    }).filter(Boolean).join("\n") || null;
  }
  return content == null ? null : JSON.stringify(content);
}

function outputMessageContent(message: Record<string, unknown> | null): string | null {
  return assistantContentForTdai(message);
}

// ── Internal helpers ─────────────────────────────────────────────────────────

interface TapContext {
  config: ProxyConfig;
  modelId: string;
  keyId: string;
  sessionKey: string;
  upstreamUrl: string;
  traceId: string;
  forkTraceId: string;
  requestPath: string;
  startTime: string;
  inputMessages: unknown[];
  retried: boolean;
  logMeta: Record<string, unknown>;
  tdaiClient: TdaiClient | null;
  tdaiIdentity: TdaiIdentity | null;
  tdaiUserMessage: TdaiMessage | null;
  assetCapabilities?: import("./injection/types.js").AssetCapabilityFlags;
  pipe: ReturnType<typeof createPipeline>;
  /** For skill extract trigger; null when session_init is disabled. */
  sessionKeyForSkill: string;
  /** Client type (URL path 第一段) — 透传给 extract trigger 作为三段隔离键之一。 */
  agentSource: string;
  sessionInfo: Record<string, unknown> | null | undefined;
  /** Langfuse request-scoped trace context (historical type name retained). */
  lf: LangfuseTurnContext;
  /** Space/tenant ID from request path. */
  spaceId?: string;
  /** Upstream response header `x-request-id` (empty when not returned). */
  upstreamRequestId?: string;
  /** `config.langfuse.debug === true` 的求值结果。 */
  langfuseDebug: boolean;
  /** buildRequestDebugMetadata 结果；debug=false 时为 {}。 */
  debugMetadata: Record<string, unknown>;
}

/** Accumulated tool call state during SSE streaming. */
interface ToolCallAccumulator {
  id: string;
  type: string;
  functionName: string;
  functionArguments: string;
}

/** Result of extracting content + tool_calls from SSE text. */
interface SseExtractResult {
  content: string;
  toolCallDeltas: Array<{ index: number; id?: string; type?: string; functionName?: string; functionArguments?: string }>;
}

/** Extract assistant content and tool_call deltas from OpenAI SSE text. */
function extractSseContentAndTools(sseText: string): SseExtractResult {
  let content = "";
  const toolCallDeltas: SseExtractResult["toolCallDeltas"] = [];

  for (const line of sseText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const dataStr = trimmed.slice(5).trim();
    if (!dataStr || dataStr === "[DONE]") continue;
    try {
      const evt = JSON.parse(dataStr) as Record<string, unknown>;
      const choices = evt.choices;
      if (Array.isArray(choices) && choices.length > 0) {
        const delta = (choices[0] as Record<string, unknown>).delta as Record<string, unknown> | undefined;
        if (typeof delta?.content === "string") {
          content += delta.content;
        }
        const tcArr = delta?.tool_calls;
        if (Array.isArray(tcArr)) {
          for (const tc of tcArr) {
            const t = tc as Record<string, unknown>;
            const idx = typeof t.index === "number" ? t.index : 0;
            const fn = t.function as Record<string, unknown> | undefined;
            toolCallDeltas.push({
              index: idx,
              id: typeof t.id === "string" ? t.id : undefined,
              type: typeof t.type === "string" ? t.type : undefined,
              functionName: typeof fn?.name === "string" ? fn.name : undefined,
              functionArguments: typeof fn?.arguments === "string" ? fn.arguments : undefined,
            });
          }
        }
      }
    } catch {
      // ignore malformed SSE lines
    }
  }
  return { content, toolCallDeltas };
}

/** Merge accumulated tool_call deltas into complete tool_call objects. */
function mergeToolCallDeltas(
  accumulators: Map<number, ToolCallAccumulator>,
  deltas: SseExtractResult["toolCallDeltas"],
): void {
  for (const d of deltas) {
    let acc = accumulators.get(d.index);
    if (!acc) {
      acc = { id: "", type: "function", functionName: "", functionArguments: "" };
      accumulators.set(d.index, acc);
    }
    if (d.id) acc.id = d.id;
    if (d.type) acc.type = d.type;
    if (d.functionName) acc.functionName += d.functionName;
    if (d.functionArguments) acc.functionArguments += d.functionArguments;
  }
}

/** Create a TransformStream that passes bytes through unchanged,
 *  while extracting usage/content/tool_calls from SSE events in-band.
 */
function createUsageTapTransform(ctx: TapContext): TransformStream<Uint8Array, Uint8Array> {
  const { config, modelId, keyId, sessionKey, upstreamUrl, traceId, forkTraceId, startTime, inputMessages, retried, logMeta, pipe, lf, spaceId, upstreamRequestId } = ctx;

  const decoder = new TextDecoder();
  let sseBuf = "";
  let lastUsage: Record<string, unknown> | null = null;
  let assistantContent = "";
  const toolCallAccumulators = new Map<number, ToolCallAccumulator>();

  function processSseChunk(chunk: string): void {
    sseBuf += chunk;
    const parts = sseBuf.split("\n\n");
    sseBuf = parts.pop() ?? "";
    for (const part of parts) {
      const usage = extractSseUsage(part);
      if (usage) lastUsage = usage;
      const { content, toolCallDeltas } = extractSseContentAndTools(part);
      assistantContent += content;
      mergeToolCallDeltas(toolCallAccumulators, toolCallDeltas);
    }
  }

  async function finalize(): Promise<void> {
    if (sseBuf.trim()) {
      const usage = extractSseUsage(sseBuf);
      if (usage) lastUsage = usage;
      const { content, toolCallDeltas } = extractSseContentAndTools(sseBuf);
      assistantContent += content;
      mergeToolCallDeltas(toolCallAccumulators, toolCallDeltas);
    }

    const endTime = new Date().toISOString();

    let outputMessage: Record<string, unknown> | null = null;
    if (assistantContent || toolCallAccumulators.size > 0) {
      if (toolCallAccumulators.size > 0) {
        const toolCallEntries = Array.from(toolCallAccumulators.entries())
          .sort(([a], [b]) => a - b)
          .map(([, acc]) => JSON.stringify({ tool_call_id: acc.id, tool_name: acc.functionName, arguments: acc.functionArguments }, null, 2))
          .join("\n\n");
        const parts: string[] = [];
        if (assistantContent) parts.push(assistantContent);
        parts.push(toolCallEntries);
        outputMessage = { role: "assistant", content: parts.join("\n\n") };
      } else {
        outputMessage = { role: "assistant", content: assistantContent };
      }
    }

    if (lastUsage) {
      await recordInputTokenUsage({
        config,
        instanceId: spaceId || undefined,
        modelId,
        usage: lastUsage,
        protocol: "openai",
      });
      try {
        writeLog(config, {
          timestamp: endTime,
          event: "usage",
          modelId,
          keyId,
          sessionKey,
          turnSeq: lf.turnSeq,
          userInput: lf.userQuery || undefined,
          upstreamUrl,
          stream: true,
          usage: lastUsage,
          spaceId,
          upstreamRequestId,
        });
      } catch (logErr: unknown) {
        pipe.error("LOG_WRITE", logErr);
      }

      try {
        const outputMessages = outputMessage ? [outputMessage] : [];
        opikUpdateTrace(config, {
          traceId,
          projectName: keyId,
          endTime,
          output: outputMessages,
          usage: lastUsage,
        });
        if (ctx.forkTraceId && !config.opik.stripRequestLogContent) {
          opikUpdateTrace(config, {
            traceId: ctx.forkTraceId,
            projectName: "request_log",
            endTime,
            output: outputMessages,
            usage: lastUsage,
          });
        }

        opikCreateLlmSpan(config, {
          traceId,
          projectName: keyId,
          name: modelId,
          startTime,
          endTime,
          inputMessages,
          outputMessage,
          model: modelId,
          usage: lastUsage,
          tags: [
            "stream",
            ...(retried ? ["retry"] : []),
          ],
          forkProjectName: "request_log",
          forkTraceId: ctx.forkTraceId,
          forkMetadata: {
            keyId,
            modelId,
            stream: true,
            upstreamUrl,
          },
        });
      } catch (opikErr: unknown) {
        pipe.error("OPIK_SPAN", opikErr);
      }

      // Langfuse: report this LLM call under the current request trace.
      // 流式路径 inputMessages 保持原样（其它下游流水线也用同一份引用）；
      // debug=true 时把 tool_call 累积计数塞进 metadata 兜底。
      try {
        const streamDebugExtra = ctx.langfuseDebug
          ? {
              stream_tool_call_count: toolCallAccumulators.size,
              stream_assistant_content_len: assistantContent.length,
            }
          : {};
        langfuseReportGeneration({
          traceId: lf.traceId,
          name: modelId,
          model: modelId,
          startTime,
          endTime,
          input: buildLangfuseInputChat(inputMessages, ctx.langfuseDebug, flattenMessagesForOpik),
          output: outputMessage,
          usage: lastUsage,
          traceName: lf.traceName,
          userId: lf.userId,
          sessionId: lf.sessionId,
          tags: lf.tags,
          traceInput: lf.userQuery || undefined,
          traceOutput: outputMessage ?? undefined,
          traceMetadata: {
            stream: true, retried, upstreamUrl, ...logMeta,
            ...ctx.debugMetadata, ...streamDebugExtra,
          },
          observationMetadata: {
            retried, ...logMeta,
            ...ctx.debugMetadata, ...streamDebugExtra,
          },
        });
      } catch (langfuseErr: unknown) {
        pipe.error("LANGFUSE_SPAN", langfuseErr);
      }
    }

    if (ctx.tdaiClient && isExtractionAllowed(ctx.config, "tdai-memory")) {
      // Streaming 不 await（会拖慢 SSE 关流体感），改成 trackWrite + 重试：
      //   - trackWrite 注册 in-flight promise 到全局 set；SIGTERM 时 index.ts 会
      //     flushPendingWrites 等待或超时兜底，避免 pod rolling 时丢 L0。
      //   - withL0Retry 应对 tdai kernel 瞬断 / 5xx（3 次退避 ~3.5s 总时长）。
      trackWrite(
        withL0Retry(() => recordTdaiTurn(
          ctx.tdaiClient!, ctx.tdaiIdentity, ctx.tdaiUserMessage,
          outputMessageContent(outputMessage),
        )).catch((err: unknown) => pipe.error("TDAI_L0", err))
      );
    } else if (ctx.tdaiClient) {
      logExtractionSkipped(ctx.config, "tdai-memory", ctx.sessionKeyForSkill);
    }

    pipe.streamDone(lastUsage);

    // Skill extract trigger — after stream finalization.
    // 同步 await：直到 store 落盘再继续，保证下一轮跨节点读到最新数据。
    if (isExtractionAllowed(ctx.config, "skill")) {
      await triggerSkillExtractIfReady({
        config: ctx.config,
        sessionKey: ctx.sessionKeyForSkill,
        agentSource: ctx.agentSource,
        sessionInfo: ctx.sessionInfo,
        inputMessages: ctx.inputMessages,
        assistantMessage: outputMessage,
        protocol: "openai",
        assetCapabilities: ctx.assetCapabilities,
        toolCallCountOverride: toolCallAccumulators.size,
      });
    } else {
      logExtractionSkipped(ctx.config, "skill", ctx.sessionKeyForSkill);
    }

    // Credit usage reporting for streaming responses. The stream has already
    // been forwarded to the client; failures here are best-effort and can
    // only be observed via server logs (no way to retro-add response headers).
    tryReportCreditFromPath(
      ctx.config.creditReport,
      ctx.requestPath,
      lastUsage,
      ctx.config.creditPricing,
      ctx.modelId,
      ctx.upstreamUrl,
      "usage",
    )
      .then((outcome) => {
        if (outcome.attempted && !outcome.ok) {
          pipe.error("CREDIT_REPORT", `[stream] ${outcome.errorMessage ?? "unknown"}`);
          // Persist failed report as a raw record.
          writeFailedReportRaw(
            {
              timestamp: new Date().toISOString(),
              event: "usage",
              modelId: ctx.modelId,
              keyId: ctx.keyId,
              sessionKey: ctx.sessionKey,
              upstreamUrl: ctx.upstreamUrl,
              stream: true,
              usage: lastUsage === null ? undefined : lastUsage,
              upstreamRequestId: ctx.upstreamRequestId,
              pricingConfig: ctx.config.creditPricing,
            },
            outcome.errorMessage ?? "unknown",
          );
        }
      })
      .catch((err: unknown) => pipe.error("CREDIT_REPORT", err));
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      try {
        processSseChunk(decoder.decode(chunk, { stream: true }));
      } catch (err: unknown) {
        pipe.error("STREAM_TAP", err);
      }
    },
    async flush() {
      try {
        await finalize();
      } catch (err: unknown) {
        pipe.error("STREAM_FINALIZE", err);
      }
    },
  });
}
