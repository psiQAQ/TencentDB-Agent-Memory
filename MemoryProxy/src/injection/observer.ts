/**
 * InjectionObserver — 注入管线可观测性抽象。
 *
 * 设计目标：
 *   钩子开发者不需要写任何观测代码。管线在关键生命周期节点自动回调观察者，
 *   观察者实现（Noop/Logging）由管线构造时注入，永不阻断业务逻辑。
 *
 * 架构：
 *   InjectionPipeline → try/catch → InjectionObserver.onXxx() → log facade
 *
 * 原则：
 *   - Fire-and-forget：observer 内部可以异步，但不 await
 *   - 错误隔离：observer 的任何异常都不传播到管线
 *   - 默认 Noop：未配置时零开销
 */

import type { AgentContextMetadata, ContextBlock, InjectionHook, InjectionPoint } from "./types.js";
import { log } from "../report/log.js";
import { TraceFlags } from "@opentelemetry/api";
import { startObservation, LangfuseOtelSpanAttributes } from "@langfuse/tracing";
import { privacySafeSessionId } from "../telemetry-privacy.js";
import { langfuseTurnTraceId } from "../langfuse.js";

const SAFE_POINTS = new Set<InjectionPoint>([
  "system.prefix",
  "system.suffix",
  "system.before_tools",
  "system.after_tools",
  "user.before",
  "user.after",
  "user.first_turn",
  "tools.append",
  "tools.prepend",
]);
const SAFE_CACHE_STRATEGIES = new Set(["none", "session_init", "hybrid"]);

function safePoint(point: unknown): InjectionPoint | "unknown" {
  return SAFE_POINTS.has(point as InjectionPoint) ? point as InjectionPoint : "unknown";
}

function safeProtocol(protocol: unknown): "openai" | "anthropic" | "unknown" {
  return protocol === "openai" || protocol === "anthropic" ? protocol : "unknown";
}

export function safeCacheStrategy(strategy: unknown): string {
  return typeof strategy === "string" && SAFE_CACHE_STRATEGIES.has(strategy)
    ? strategy
    : "unknown";
}

// ── Hook execution result ─────────────────────────────────────────────────────

/** 单个钩子的执行结果汇总，由管线在 onPipelineEnd 时聚合上报。 */
export interface HookResult {
  hookId: string;
  point: InjectionPoint;
  blockCount: number;
  durationMs: number;
  error?: string;
  cacheStrategy?: string;
}

// ── Observer interface ────────────────────────────────────────────────────────

/**
 * 注入管线观察者接口。
 *
 * 管线在以下时机调用观察者方法：
 *   process() 入口     → onPipelineStart
 *   executeHooks 循环内 → onHookStart / onHookDone / onHookError（每个钩子）
 *   process() 出口     → onPipelineEnd（成功）或 onPipelineError（失败）
 *
 * 默认实现：NoopInjectionObserver（零开销）。
 * 生产实现：LoggingInjectionObserver（写入结构化日志）。
 */
export interface InjectionObserver {
  /** Return isolated mutable state for one request when the observer needs it. */
  forRequest?(): InjectionObserver;

  /** 管线开始处理一个请求。 */
  onPipelineStart(meta: AgentContextMetadata): void;

  /** 管线成功完成（所有钩子已执行）。 */
  onPipelineEnd(
    meta: AgentContextMetadata,
    durationMs: number,
    results: HookResult[],
  ): void;

  /** 管线级错误（如未知协议、适配器缺失），请求未能进入钩子执行阶段。 */
  onPipelineError(meta: AgentContextMetadata, error: Error): void;

  /** 单个钩子开始执行。 */
  onHookStart(hook: InjectionHook, point: InjectionPoint): void;

  /** 单个钩子执行完成（包括返回空 blocks 的情况）。 */
  onHookDone(
    hook: InjectionHook,
    point: InjectionPoint,
    blocks: ContextBlock[],
    durationMs: number,
    cacheStrategy?: string,
  ): void;

  /** 单个钩子执行异常（会由 error start→error/done 记录）。 */
  onHookError(
    hook: InjectionHook,
    point: InjectionPoint,
    error: Error,
    durationMs: number,
  ): void;
}

// ── Noop implementation ───────────────────────────────────────────────────────

/**
 * 空操作观察者 —— 默认实现，零开销。
 * 所有方法均为空函数体，JIT 内联后无性能损耗。
 */
export class NoopInjectionObserver implements InjectionObserver {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onPipelineStart(_meta: AgentContextMetadata): void { /* noop */ }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onPipelineEnd(_meta: AgentContextMetadata, _durationMs: number, _results: HookResult[]): void { /* noop */ }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onPipelineError(_meta: AgentContextMetadata, _error: Error): void { /* noop */ }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onHookStart(_hook: InjectionHook, _point: InjectionPoint): void { /* noop */ }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onHookDone(_hook: InjectionHook, _point: InjectionPoint, _blocks: ContextBlock[], _durationMs: number, _cacheStrategy?: string): void { /* noop */ }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onHookError(_hook: InjectionHook, _point: InjectionPoint, _error: Error, _durationMs: number): void { /* noop */ }
}

// ── Logging implementation ────────────────────────────────────────────────────

/**
 * 结构化日志观察者 —— 写入 `src/report/log.ts` 的结构化日志系统。
 *
 * 上报事件：
 *   injection.pipeline.start  — 管线开始
 *   injection.pipeline.done   — 管线完成（含 durationMs, hookCount, totalBlockCount）
 *   injection.pipeline.error  — 管线级错误
 *   injection.hook.start      — 单个钩子开始
 *   injection.hook.done       — 单个钩子完成（含 blocks 摘要）
 *   injection.hook.error      — 单个钩子失败
 *
 * 安全保证：所有方法内部 try/catch，绝不抛异常。
 */
export class LoggingInjectionObserver implements InjectionObserver {
  onPipelineStart(meta: AgentContextMetadata): void {
    try {
      log.info("injection.pipeline.start", {
        protocol: safeProtocol(meta.protocol),
        stream: meta.stream === true,
      });
    } catch { /* observer must never throw */ }
  }

  onPipelineEnd(
    meta: AgentContextMetadata,
    durationMs: number,
    results: HookResult[],
  ): void {
    try {
      const totalBlockCount = results.reduce((sum, r) => sum + r.blockCount, 0);
      const errorCount = results.filter((r) => r.error).length;
      log.info("injection.pipeline.done", {
        protocol: safeProtocol(meta.protocol),
        durationMs,
        hookCount: results.length,
        totalBlockCount,
        errorCount,
      });
    } catch { /* observer must never throw */ }
  }

  onPipelineError(meta: AgentContextMetadata, _error: Error): void {
    try {
      log.error("injection.pipeline.error", {
        protocol: safeProtocol(meta.protocol),
        category: "pipeline_error",
      });
    } catch { /* observer must never throw */ }
  }

  onHookStart(hook: InjectionHook, point: InjectionPoint): void {
    try {
      log.info("injection.hook.start", {
        point: safePoint(point),
        cacheStrategy: safeCacheStrategy(hook.cacheStrategy ?? "none"),
      });
    } catch { /* observer must never throw */ }
  }

  onHookDone(
    hook: InjectionHook,
    point: InjectionPoint,
    blocks: ContextBlock[],
    durationMs: number,
    cacheStrategy?: string,
  ): void {
    try {
      log.info("injection.hook.done", {
        point: safePoint(point),
        blockCount: blocks.length,
        textBlockCount: blocks.filter((block) => block.type === "text").length,
        customBlockCount: blocks.filter((block) => block.type === "custom").length,
        otherBlockCount: blocks.filter(
          (block) => block.type !== "text" && block.type !== "custom",
        ).length,
        durationMs,
        cacheStrategy: safeCacheStrategy(cacheStrategy ?? hook.cacheStrategy ?? "none"),
      });
    } catch { /* observer must never throw */ }
  }

  onHookError(
    _hook: InjectionHook,
    point: InjectionPoint,
    _error: Error,
    durationMs: number,
  ): void {
    try {
      log.warn("injection.hook.error", {
        point: safePoint(point),
        category: "hook_error",
        durationMs,
      });
    } catch { /* observer must never throw */ }
  }
}

// ── Langfuse implementation ───────────────────────────────────────────────────

/** 派生 phantom parent spanId（与 langfuse.ts 中 deriveParentSpanId 一致）。 */
function deriveParentSpanId(traceId: string): string {
  return traceId.slice(0, 16);
}

/**
 * Langfuse 注入观察者 —— 将每个钩子的执行作为 span observation 挂到当前请求 trace 下。
 *
 * 每个 hook 产生一条 span observation：
 *   - name 使用固定类别，不包含 hook/user/session 标识
 *   - metadata 只保留固定 point、数量、耗时与协议类别
 *   - traceId 复用并规范化已有 request traceId，不从 session/user/key 派生
 *
 * 安全保证：所有方法内部 try/catch，绝不抛异常；observer 不存在或降级时 fallback noop。
 */
export class LangfuseInjectionObserver implements InjectionObserver {
  /** 从 onPipelineStart 的 metadata 中捕获，后续 hook 回调使用。 */
  private meta: AgentContextMetadata | null = null;
  /** Request-scoped ID; normalized from the existing request traceId. */
  private traceId: string | null = null;

  forRequest(): InjectionObserver {
    return new LangfuseInjectionObserver();
  }

  onPipelineStart(meta: AgentContextMetadata): void {
    try {
      this.meta = meta;
      this.traceId = langfuseTurnTraceId(meta.traceId);
      // 无 span — 延迟到 hook 级别记录
    } catch { /* observer must never throw */ }
  }

  onPipelineEnd(
    _meta: AgentContextMetadata,
    _durationMs: number,
    _results: HookResult[],
  ): void {
    try {
      this.meta = null; // cleanup
      this.traceId = null;
    } catch { /* observer must never throw */ }
  }

  onPipelineError(_meta: AgentContextMetadata, _error: Error): void {
    try {
      this.meta = null;
      this.traceId = null;
    } catch { /* observer must never throw */ }
  }

  onHookStart(_hook: InjectionHook, _point: InjectionPoint): void {
    // span 在 onHookDone/onHookError 中一次性创建（含完整 duration）。
  }

  onHookDone(
    hook: InjectionHook,
    point: InjectionPoint,
    blocks: ContextBlock[],
    durationMs: number,
    cacheStrategy?: string,
  ): void {
    try {
      const lfTraceId = this.getLangfuseTraceId();
      if (!lfTraceId) return;

      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - durationMs);

      const obsMeta: Record<string, unknown> = {
        point,
        durationMs,
        blockCount: blocks.length,
        protocol: this.meta?.protocol ?? "unknown",
        stream: this.meta?.stream ?? false,
      };

      const span = startObservation(
        "injection-hook",
        {
          input: { point },
          output: { blockCount: blocks.length, blockTypes: blocks.map((block) => block.type) },
          metadata: obsMeta,
        },
        {
          asType: "span",
          startTime,
          parentSpanContext: {
            traceId: lfTraceId,
            spanId: deriveParentSpanId(lfTraceId),
            traceFlags: TraceFlags.SAMPLED,
            isRemote: true,
          },
        },
      );

      // 观察级标注
      const otelSpan = span.otelSpan;
      otelSpan.setAttribute(LangfuseOtelSpanAttributes.OBSERVATION_METADATA, JSON.stringify(obsMeta));
      // trace 级标注：叠加注入摘要（last-write-wins，所有 hook 都会写，最终保留最后一次的值）
      otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_METADATA, JSON.stringify({
        injection: { point, blockCount: blocks.length, durationMs },
      }));
      if (this.meta?.sessionKey) {
        otelSpan.setAttribute(
          LangfuseOtelSpanAttributes.TRACE_SESSION_ID,
          privacySafeSessionId(this.meta.sessionKey),
        );
      }

      span.end(endTime);
    } catch { /* observer must never throw */ }
  }

  onHookError(
    hook: InjectionHook,
    point: InjectionPoint,
    error: Error,
    durationMs: number,
  ): void {
    try {
      const lfTraceId = this.getLangfuseTraceId();
      if (!lfTraceId) return;

      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - durationMs);

      const obsMeta: Record<string, unknown> = {
        point,
        durationMs,
        protocol: this.meta?.protocol ?? "unknown",
      };

      const span = startObservation(
        "injection-hook-error",
        {
          input: { point },
          output: { error: true },
          level: "ERROR",
          statusMessage: "operation_failed",
          metadata: obsMeta,
        },
        {
          asType: "span",
          startTime,
          parentSpanContext: {
            traceId: lfTraceId,
            spanId: deriveParentSpanId(lfTraceId),
            traceFlags: TraceFlags.SAMPLED,
            isRemote: true,
          },
        },
      );

      const otelSpan = span.otelSpan;
      otelSpan.setAttribute(LangfuseOtelSpanAttributes.OBSERVATION_METADATA, JSON.stringify(obsMeta));
      otelSpan.setAttribute(LangfuseOtelSpanAttributes.OBSERVATION_LEVEL, "ERROR");

      span.end(endTime);
    } catch { /* observer must never throw */ }
  }

  /** Return this pipeline's request-scoped traceId, or null if unavailable. */
  private getLangfuseTraceId(): string | null {
    return this.traceId;
  }
}
