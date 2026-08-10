/**
 * Langfuse LLM trace 上报模块（官方 SDK 方式）。
 *
 * 使用 Langfuse 官方 SDK（@langfuse/tracing + @langfuse/otel）上报 LLM 调用。
 *
 * 隐私边界：traceId 每次随机生成，不从 session/user/key 派生。这样无法跨请求按
 * user/session/turn 做稳定归并；导出仅支持单次调用的总量和固定类别指标。
 *
 * 设计原则：
 *   - Fire-and-forget：span 由 LangfuseSpanProcessor 异步批量导出
 *   - 配置缺失 / SDK 初始化失败时 graceful degradation（全部 no-op）
 *   - 与 Opik 上报完全独立（各用各的 traceId）
 */

import { randomUUID } from "node:crypto";
import { TraceFlags } from "@opentelemetry/api";
import { startObservation, LangfuseOtelSpanAttributes } from "@langfuse/tracing";
import type { ProxyConfig } from "./types.js";
import { log } from "./report/log.js";
import {
  privacySafeMetadata,
  privacySafeSessionId,
  privacySafeTags,
  privacySafeText,
  privacySafeUsage,
  summarizeTelemetryValue,
} from "./telemetry-privacy.js";

// ============================
// 生命周期
// ============================

let _enabled = false;
let _initCalled = false;
// OpenTelemetry NodeSDK 实例（用于优雅关闭时 flush）。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _sdk: { shutdown: () => Promise<void> } | null = null;

/**
 * 初始化 Langfuse 上报。在 server 启动时调用一次，后续调用为 no-op。
 * 返回是否成功启用。
 */
export async function initLangfuse(config: ProxyConfig): Promise<boolean> {
  if (_initCalled) return _enabled;
  _initCalled = true;

  const lf = config.langfuse;
  if (!lf.enabled || !lf.host || !lf.publicKey || !lf.secretKey) {
    log.info("langfuse.disabled", { reason: "config not complete" });
    return false;
  }

  try {
    const [{ NodeSDK }, { LangfuseSpanProcessor }] = await Promise.all([
      import("@opentelemetry/sdk-node"),
      import("@langfuse/otel"),
    ]);

    const baseUrl = lf.host.replace(/\/$/, "");
    const processor = new LangfuseSpanProcessor({
      publicKey: lf.publicKey,
      secretKey: lf.secretKey,
      baseUrl,
    });

    const sdk = new NodeSDK({ spanProcessors: [processor] });
    sdk.start();
    _sdk = sdk;
    _enabled = true;

    log.info("langfuse.initialized", { baseUrl });
    return true;
  } catch (err: unknown) {
    log.warn("langfuse.init_failed", { error: String(err) });
    _enabled = false;
    return false;
  }
}

/**
 * 优雅关闭 Langfuse 上报，确保所有待发送 span 已 flush。
 */
export async function shutdownLangfuse(): Promise<void> {
  if (_sdk) {
    try {
      await _sdk.shutdown();
    } catch (err: unknown) {
      log.warn("langfuse.shutdown_error", { error: String(err) });
    }
    _sdk = null;
  }
  _enabled = false;
  _initCalled = false;
}

// ============================
// 不可跨请求关联的 request traceId
// ============================

/**
 * 把本次请求已有的 UUID traceId 规范化为 32 位小写 hex。它只在同一 HTTP 请求
 * 内关联各 sink，不从 session/user/key 派生，也不提供跨请求稳定关联。
 */
export function langfuseTurnTraceId(requestTraceId: string): string {
  const normalized = requestTraceId.replaceAll("-", "").toLowerCase();
  if (/^[0-9a-f]{32}$/.test(normalized)) return normalized;
  return randomUUID().replaceAll("-", "");
}

// ============================
// 上报：generation observation
// ============================

/**
 * Langfuse 请求 trace 上下文。类型名保留 `Turn` 以避免破坏现有 API，
 * 但每个实例仅对应一次 HTTP 请求，不在工具循环或 session 之间稳定关联。
 */
export interface LangfuseTurnContext {
  /** 本次请求的随机 traceId（langfuseTurnTraceId 生成）。 */
  traceId: string;
  /** 进程内 turn 序号；隐私安全导出不承诺按 session/turn 稳定聚合。 */
  turnSeq: number;
  /** In-process trace name; outbound value is fixed redaction. */
  traceName: string;
  /** In-process userId; outbound value is fixed redaction. */
  userId: string;
  /** trace sessionId（导出时固定脱敏，不可用于关联）。 */
  sessionId: string;
  /**
   * trace 级标签导出前只保留 protocol/stream 等固定类别；session 标签固定脱敏，
   * 不可用于跨请求关联。
   */
  tags: string[];
  /**
   * 本次请求的 observation 级附加标签 —— 随请求变化，写入 generation 的
   * observation metadata，而非 trace 级 tags。宿主默认不填充。
   */
  routeTags: string[];
  /**
   * 去噪后的最新用户问题；工具循环延续请求为 ""。
   * 用于生成当前请求 trace 的 input 摘要，不导出原文。
   */
  userQuery: string;
}

/** 一次 LLM 调用的上报参数（挂到当前请求 trace 下的 generation）。 */
export interface LangfuseGenerationReport {
  /** 所属请求的随机 traceId（langfuseTurnTraceId 生成）。 */
  traceId: string;
  /** observation 名称（一般为模型名，或 `[internal] <model>`）。 */
  name: string;
  /** 模型名。 */
  model: string;
  /** ISO 8601 开始时间。 */
  startTime: string;
  /** ISO 8601 结束时间。 */
  endTime: string;
  /** generation 输入（导出前只保留类型和计数摘要）。 */
  input?: unknown;
  /** generation 输出（导出前只保留类型和计数摘要）。 */
  output?: unknown;
  /** 原始 usage 对象（会被归一化为 Langfuse usageDetails）。 */
  usage?: Record<string, unknown>;
  /** observation 级别（默认 DEFAULT；失败时传 ERROR）。 */
  level?: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";
  /** 状态信息（一般用于 ERROR，描述失败原因）。 */
  statusMessage?: string;
  // ── trace 级属性（仅限本次随机 trace；不提供跨请求稳定关联）──
  /** In-process trace name; outbound value is fixed redaction. */
  traceName: string;
  /** In-process userId; outbound value is fixed redaction. */
  userId: string;
  /** trace sessionId（导出时固定脱敏，不可用于关联）。 */
  sessionId: string;
  /** trace 标签。 */
  tags?: string[];
  /**
   * trace 级 input 来源。新人类输入请求可传入，导出时只保留摘要。
   * 工具循环延续请求应留空，避免把 tool_result 作为请求输入摘要。
   * 内部路由等子步骤也应留空，避免污染 trace 级输入。
   */
  traceInput?: unknown;
  /**
   * trace 级 output —— 传当前请求的输出摘要。
   */
  traceOutput?: unknown;
  /** trace 级 metadata。 */
  traceMetadata?: Record<string, unknown>;
  /** observation 级 metadata。 */
  observationMetadata?: Record<string, unknown>;
}

/**
 * 派生一个合法的 phantom parent spanId（16 位 hex，非零）。
 * 用于把 generation 挂到本次随机 traceId 下。同一 traceId 始终得到同一 spanId，
 * 因此单次上报内 generation 的 parent 一致（指向同一个不存在的 root span，
 * Langfuse 据此把它们都视为该 trace 下的顶层 observation）。
 */
function deriveParentSpanId(traceId: string): string {
  return traceId.slice(0, 16);
}

/**
 * 归一化原始 LLM usage → Langfuse usageDetails（Record<string, number>）。
 *
 * Token 口径与 ClickHouse 的 `buildClickHouseRow` 保持一致（此处独立复刻，不跨模块依赖），
 * 覆盖 Anthropic / OpenAI / DeepSeek 三种 usage 格式：
 *   - Anthropic(TokenHub)：`input_tokens` 已排除 cache，总输入 = input + cache_read + cache_write，
 *     且响应无 `total_tokens`，需回退为 prompt + completion。
 *   - OpenAI / DeepSeek：`prompt_tokens` 即含 cache 的总输入，通常也带 `total_tokens`。
 *
 * 输出遵循 Langfuse 惯例（各分项之和 = total，避免与内置 cost 计算重复计数）：
 *   - `input`：未命中缓存的输入（= 总输入 − cache_read − cache_write），按 input 单价计费
 *   - `cache_read_input_tokens` / `cache_creation_input_tokens`：缓存读 / 写
 *   - `output`：输出
 *   - `total`：总 token（= 总输入 + 输出）
 *
 * 修复要点：此前 `total = input_tokens + output_tokens` 对 Anthropic 会漏掉 cache token
 * （cache 常占绝大多数），导致 Langfuse 的 total 少一到两个数量级。
 *
 * Exported for unit testing.
 */
export function normalizeUsageDetails(usage: Record<string, unknown>): Record<string, number> {
  const promptDetails = usage.prompt_tokens_details as Record<string, unknown> | undefined;

  const cacheRead =
    num(usage.prompt_cache_hit_tokens) ||
    num(usage.cache_read_input_tokens) ||
    num(promptDetails?.cached_tokens);
  const cacheWrite =
    num(usage.prompt_cache_write_tokens) ||
    num(usage.cache_creation_input_tokens);

  // 总输入（含缓存）：OpenAI/DeepSeek 取 prompt_tokens；
  // Anthropic 无 prompt_tokens，用 input_tokens(已排除 cache) 加回 cache_read + cache_write。
  const inputTokens = num(usage.input_tokens);
  const promptTokens = num(usage.prompt_tokens) || inputTokens + cacheRead + cacheWrite;
  const outputTokens = num(usage.completion_tokens) || num(usage.output_tokens);
  // 总 token：优先上游给的 total_tokens，否则 prompt + completion（prompt 已含缓存）。
  const totalTokens = num(usage.total_tokens) || promptTokens + outputTokens;

  // 未命中缓存的输入（分项之和 = total，不与 cache_* 重复计数）。
  const uncachedInput = Math.max(promptTokens - cacheRead - cacheWrite, 0);

  const out: Record<string, number> = {
    input: uncachedInput,
    output: outputTokens,
    total: totalTokens,
  };
  if (cacheRead > 0) out.cache_read_input_tokens = cacheRead;
  if (cacheWrite > 0) out.cache_creation_input_tokens = cacheWrite;
  return out;
}

/** 取数值字段（非数值按 0），与 ClickHouse 的 `num()` 口径一致。 */
function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

/** 把任意值转为可写入 OTel 属性的字符串。 */
function asAttrString(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

/**
 * 上报一次 LLM 调用：在指定请求 trace 下创建一个 generation observation，
 * 并把 trace 级属性写到该 span 上（SDK 会据此设置所属 trace 的字段）。
 *
 * 失败静默（仅 debug 日志），绝不影响业务请求。
 */
export function langfuseReportGeneration(report: LangfuseGenerationReport): void {
  if (!_enabled) return;

  try {
    const generation = startObservation(
      privacySafeText(report.name),
      {
        model: privacySafeText(report.model),
        input: summarizeTelemetryValue(report.input),
        output: summarizeTelemetryValue(report.output),
        usageDetails: report.usage
          ? normalizeUsageDetails(privacySafeUsage(report.usage))
          : undefined,
        metadata: privacySafeMetadata(report.observationMetadata),
        level: report.level,
        statusMessage: report.statusMessage ? "[redacted]" : undefined,
      },
      {
        asType: "generation",
        startTime: new Date(report.startTime),
        parentSpanContext: {
          traceId: report.traceId,
          spanId: deriveParentSpanId(report.traceId),
          traceFlags: TraceFlags.SAMPLED,
          isRemote: true,
        },
      },
    );

    // trace 级属性：直接写 OTel 属性，SDK 会传播到所属 trace。
    const span = generation.otelSpan;
    span.setAttribute(
      LangfuseOtelSpanAttributes.TRACE_NAME,
      privacySafeText(report.traceName),
    );
    span.setAttribute(
      LangfuseOtelSpanAttributes.TRACE_USER_ID,
      privacySafeText(report.userId),
    );
    span.setAttribute(
      LangfuseOtelSpanAttributes.TRACE_SESSION_ID,
      privacySafeSessionId(report.sessionId),
    );
    if (report.tags && report.tags.length > 0) {
      span.setAttribute(
        LangfuseOtelSpanAttributes.TRACE_TAGS,
        JSON.stringify(privacySafeTags(report.tags)),
      );
    }
    // trace 级 input/output 与 observation 级解耦：仅在显式传入时写。
    // 当前请求可分别传入 traceInput / traceOutput 摘要。
    if (report.traceInput !== undefined) {
      span.setAttribute(
        LangfuseOtelSpanAttributes.TRACE_INPUT,
        asAttrString(summarizeTelemetryValue(report.traceInput)),
      );
    }
    if (report.traceOutput !== undefined) {
      span.setAttribute(
        LangfuseOtelSpanAttributes.TRACE_OUTPUT,
        asAttrString(summarizeTelemetryValue(report.traceOutput)),
      );
    }
    if (report.traceMetadata) {
      span.setAttribute(
        LangfuseOtelSpanAttributes.TRACE_METADATA,
        JSON.stringify(privacySafeMetadata(report.traceMetadata)),
      );
    }

    generation.end(new Date(report.endTime));
  } catch (err: unknown) {
    log.debug("langfuse.report_error", {
      errorCategory: err instanceof Error ? "error" : "unknown",
    });
  }
}

/** 一次失败请求的上报参数（上游错误 / 转发失败）。 */
export interface LangfuseFailureReport {
  /** 当前请求 trace 上下文。 */
  lf: LangfuseTurnContext;
  /** observation 名称（一般为模型名）。 */
  model: string;
  /** ISO 8601 开始时间。 */
  startTime: string;
  /** ISO 8601 结束时间。 */
  endTime: string;
  /** 该请求的输入 messages（导出时只保留摘要）。 */
  input?: unknown;
  /** HTTP 状态码（转发异常时可缺省）。 */
  status?: number;
  /** 失败描述（如错误体片段或 "timeout/error"）。 */
  statusMessage: string;
  /** 额外标签（如 ["error"]）。 */
  extraTags?: string[];
  /** observation 级 metadata。 */
  observationMetadata?: Record<string, unknown>;
}

/**
 * 上报一次失败请求：在当前请求 trace 下创建一个 ERROR generation。
 * 不设 trace 级 input/output，仅记录该次失败的安全类别与状态。
 */
export function langfuseReportFailure(report: LangfuseFailureReport): void {
  if (!_enabled) return;

  const { lf } = report;
  langfuseReportGeneration({
    traceId: lf.traceId,
    name: report.model,
    model: report.model,
    startTime: report.startTime,
    endTime: report.endTime,
    input: report.input,
    output: report.status !== undefined
      ? { error: true, status: report.status, message: report.statusMessage }
      : { error: true, message: report.statusMessage },
    level: "ERROR",
    statusMessage: report.statusMessage,
    traceName: lf.traceName,
    userId: lf.userId,
    sessionId: lf.sessionId,
    tags: report.extraTags && report.extraTags.length > 0 ? [...lf.tags, ...report.extraTags] : lf.tags,
    // 失败 trace 只记录用户输入摘要，不导出原文或写 trace output。
    traceInput: lf.userQuery || undefined,
    observationMetadata: {
      ...report.observationMetadata,
      ...(lf.routeTags.length > 0 ? { route: lf.routeTags } : {}),
    },
  });
}
