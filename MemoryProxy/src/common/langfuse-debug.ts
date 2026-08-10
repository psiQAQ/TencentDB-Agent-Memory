/**
 * Langfuse debug helpers —— 由 `langfuse.debug=true` 门控，用来把 LLM 请求
 * 的原生结构 + 客户端指纹尽量塞进 Langfuse 上报，供**排障 / 客户端逆向**用。
 *
 * 现状拆解（合并前的坑）：
 *   1. Anthropic 侧 `anthropicHandler.buildLangfuseInput` 已有 debug 分支，但
 *      只保留 messages+system 原生结构；output 仍取 text 拼接（tool_use /
 *      thinking / stop_reason 丢失）；metadata 只有 stream/retried/upstreamUrl。
 *   2. OpenAI 协议 handler.ts 的 5 处 langfuse 上报**完全不读 debug flag**，
 *      硬编码走 flattenMessagesForOpik 压平 —— CodeBuddy 请求走的正是这条路径，
 *      开 debug 也抓不到 CB 原生 body。
 *
 * 本文件补的是**共用**部分 —— OpenAI 协议的 input builder + 通用 debug metadata。
 * Anthropic 侧的 input builder (`buildLangfuseInput`) 已在 anthropicHandler.ts 内联，
 * 不搬过来避免循环依赖。output 处理由各自 handler 自己按 debug flag 分岔。
 *
 * 详见 docs/design/2026-07-30-cc-request-routing-plan.md 附录以及本次提交的
 * commit message。
 */

import type { CcRequestKind } from "./cc-request-classifier.js";
import { findLastCacheControlIndex } from "./cc-request-classifier.js";

// ─── 白名单与截断上限 ────────────────────────────────────────────────────────
// 请求头前缀：跟 identity.ts:172 一致，避免各处对 CB header 认知漂移。
const HEADER_PREFIX_WHITELIST = ["x-", "cb-", "codebuddy-"];

/**
 * OpenAI 协议 messages 的 langfuse input builder。
 *
 * - `debug=true`: 原样返回 messages 数组（保留 CodeBuddy 可能塞的字符串/数组
 *   content、`<additional_data>` / `<question_answer>` 等内部 tag、cache_control
 *   marker、tool_use 原生形态、thinking block 等）。
 * - `debug=false`: 走调用方传入的 fallback（一般是 handler.ts:flattenMessagesForOpik），
 *   把 content 数组压平为 role+string 形态，节省 langfuse 存储成本 2-5x。
 *
 * 参数 `fallback` 显式传入而非 import，是为了让 handler 保留自己那份 flatten
 * 实现（有 opik/opik-fork 侧其它调用点复用），本文件不负责 flatten 语义。
 */
export function buildLangfuseInputChat(
  messages: unknown[],
  debug: boolean,
  fallback: (m: unknown[]) => unknown[],
): unknown {
  if (debug) {
    // 直接返回原始 messages 数组 —— 保留 role/content 原生结构。
    return messages;
  }
  return fallback(messages);
}

// ─── Debug metadata ─────────────────────────────────────────────────────────

export interface RequestDebugMetadataInput {
  body: Record<string, unknown>;
  headers?: Record<string, string>;
  agentSource?: string;
  requestKind?: CcRequestKind;
  spaceId?: string;
  turnSeq?: number;
  requestPath?: string;
  protocol?: "anthropic" | "openai";
  debug: boolean;
}

/**
 * 从 body / headers / 路由上下文抽取"客户端指纹 + 请求分类关键字段"，塞进
 * Langfuse 的 observationMetadata / traceMetadata。
 *
 * `debug=false` 时恒返回**空对象**（不污染线上 metadata）。
 *
 * 抽取的字段（都是 flat key，方便 Langfuse UI 展示）：
 *   - `model` / `stream` / `max_tokens` / `temperature` / `top_p` / `top_k`
 *   - `thinking_type` / `stop_sequences_len` / `system_len` / `messages_len`
 *   - `tools_len` / `tools_summary` — 前 N 个 tool 的 name + desc 截断到 200 char
 *   - `cache_control_marker_idx` — messages 里最后一个 cache_control marker 位置
 *     （识别 CC fork/main/sidequery 的核心信号；详见 cc-request-classifier.ts）
 *   - `body_metadata` — Anthropic body.metadata（含 user_id 等）
 *   - `body_extra_keys` — body 顶层"非标准字段"名字（CB / cursor 常私塞 extension 字段）
 *   - `agent_source` / `request_kind` / `space_id` / `turn_seq` / `request_path`
 *   - `header_<name>` — 白名单前缀的 client header（x-* / cb-* / codebuddy-*）
 *
 * Tools/description 均截断以防单条上报膨胀。抽取失败静默返回已有字段
 * （debug 数据缺一两个字段不影响排障，不能因此抛异常影响业务）。
 */
export function buildRequestDebugMetadata(
  opts: RequestDebugMetadataInput,
): Record<string, unknown> {
  if (!opts.debug) return {};

  const out: Record<string, unknown> = {};
  try {
    const b = opts.body ?? {};

    // ── body 顶层常见字段 ──
    if (typeof b.model === "string") out.model = b.model;
    if (typeof b.stream === "boolean") out.stream = b.stream;
    if (typeof b.max_tokens === "number") out.max_tokens = b.max_tokens;
    if (typeof b.temperature === "number") out.temperature = b.temperature;
    if (typeof b.top_p === "number") out.top_p = b.top_p;
    if (typeof b.top_k === "number") out.top_k = b.top_k;

    // Anthropic thinking block
    const thinking = b.thinking as { type?: unknown } | undefined;
    if (thinking && typeof thinking === "object" && typeof thinking.type === "string") {
      out.thinking_type = thinking.type;
    }

    // stop_sequences（OpenAI: `stop`；Anthropic: `stop_sequences`）
    const stopSeq = Array.isArray(b.stop_sequences)
      ? (b.stop_sequences as unknown[])
      : Array.isArray(b.stop)
      ? (b.stop as unknown[])
      : null;
    if (stopSeq) out.stop_sequences_len = stopSeq.length;

    // system prompt 长度（Anthropic 有 body.system；OpenAI 塞在 messages[0].role='system'）
    if (typeof b.system === "string") {
      out.system_len = b.system.length;
    } else if (Array.isArray(b.system)) {
      let total = 0;
      for (const blk of b.system as unknown[]) {
        const t = (blk as { text?: unknown })?.text;
        if (typeof t === "string") total += t.length;
      }
      out.system_len = total;
    }

    const msgs = Array.isArray(b.messages) ? (b.messages as unknown[]) : [];
    out.messages_len = msgs.length;

    // Tools only contribute counts; names/descriptions can contain private text.
    if (Array.isArray(b.tools)) {
      const tools = b.tools as unknown[];
      out.tools_len = tools.length;
      out.tools_named_count = tools.filter((tool) => {
        const t = tool as Record<string, unknown> | undefined;
        const fn = (t?.function as Record<string, unknown> | undefined) ?? t;
        return typeof fn?.name === "string";
      }).length;
      out.tools_described_count = tools.filter((tool) => {
        const t = tool as Record<string, unknown> | undefined;
        const fn = (t?.function as Record<string, unknown> | undefined) ?? t;
        return typeof fn?.description === "string";
      }).length;
    }

    // Cache control marker 位置 —— CC 请求分类的核心信号
    if (msgs.length > 0) {
      const idx = findLastCacheControlIndex(msgs);
      if (idx >= 0) out.cache_control_marker_idx = idx;
    }

    // Metadata values may contain identities; retain names only.
    if (b.metadata && typeof b.metadata === "object" && !Array.isArray(b.metadata)) {
      out.body_metadata_keys = Object.keys(b.metadata as Record<string, unknown>);
    }

    // body 顶层非标准字段（客户端私塞的 extension keys —— 识别客户端指纹）
    const standardKeys = new Set([
      "model", "messages", "system", "tools", "tool_choice",
      "temperature", "top_p", "top_k", "max_tokens",
      "stream", "stream_options", "thinking",
      "stop", "stop_sequences", "metadata",
      "n", "user", "seed", "response_format", "presence_penalty", "frequency_penalty",
    ]);
    const extra = Object.keys(b).filter((k) => !standardKeys.has(k));
    if (extra.length) out.body_extra_keys = extra;

    // ── 路由上下文 ──
    if (opts.agentSource) out.agent_source = opts.agentSource;
    if (opts.requestKind) out.request_kind = opts.requestKind;
    if (opts.spaceId) out.space_id_present = true;
    if (typeof opts.turnSeq === "number") out.turn_seq = opts.turnSeq;
    if (opts.requestPath) out.request_path_segments = opts.requestPath.split("/").filter(Boolean).length;
    if (opts.protocol) out.protocol = opts.protocol;

    // ── 请求头（白名单前缀）──
    if (opts.headers) {
      out.header_names = Object.keys(opts.headers)
        .map((name) => name.toLowerCase())
        .filter((name) => name !== "authorization" && name !== "x-api-key" && name !== "cookie")
        .filter((name) => HEADER_PREFIX_WHITELIST.some((prefix) => name.startsWith(prefix)));
    }
  } catch {
    // debug metadata 只是辅助，绝不影响业务；抛异常就返回已经填的部分
  }
  return out;
}
