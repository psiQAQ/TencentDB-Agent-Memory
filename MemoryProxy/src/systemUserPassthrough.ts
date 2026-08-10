/**
 * System-user passthrough handler.
 *
 * When an inbound apiKey matches an entry in the `systemUsers` registry the
 * proxy MUST NOT do any of its *functional* work:
 *
 *  - no auth/verify round-trip to core
 *  - no session-init / conversation binding
 *  - no injection pipeline (skill / memory / wiki context blocks)
 *  - no routing decisions
 *  - no body rewrites BEYOND model-alias resolution (see below); no thinking
 *    sanitisation, message stripping, tool rewriting, etc.
 *
 * Observability, however, IS preserved — internal service traffic must still
 * be visible in dashboards:
 *  - Opik trace + LLM span with type/count summaries only
 *  - Langfuse generation under the request-scoped random trace
 *  - ClickHouse / JSONL aggregate usage row with fixed identity redaction
 *  - MemoryPlus credit report (spaceId = memory instance from path)
 *
 * ── Body forwarding ───────────────────────────────────────────────────────
 * Two paths:
 *  1. Main handlers (`/v1/messages`, `/v1/chat/completions`) call this with
 *     an already-parsed `rewrittenBody`. The main handler owns model-alias
 *     resolution (client-facing `modelName` → real upstream `model_id`) and
 *     the `isModelInPricing` gate; both fire for internal AND external
 *     callers alike, so upstream always sees canonical `model_id`s and
 *     billing/observability keys align. In this path body forwarding is
 *     `JSON.stringify(rewrittenBody)` — a one-time round-trip through the
 *     JSON codec is the price of alignment.
 *  2. Auxiliary handlers (`count_tokens`, `embeddings`, ...) call this
 *     without `rewrittenBody`. That path stays byte-verbatim: we read the
 *     raw ArrayBuffer and forward it untouched. Aux endpoints do not go
 *     through the alias-gate today.
 *
 * The one header we rewrite in both paths is `Authorization`: the caller's
 * proxy-auth key is swapped for `config.upstream.apiKey` so TokenHub accepts
 * the request (see `buildPassthroughHeaders`). Trace payloads use whatever
 * we can JSON-parse from the raw body/response as-is, then each exporter reduces
 * it to fixed type/count summaries before data leaves the process.
 */

import type { Context } from "hono";
import { writeLog } from "./logger.js";
import { log } from "./report/log.js";
import { joinUrl } from "./guard-adapter.js";
import { extractSpaceIdFromPath, tryReportCreditFromPath } from "./credit-reporter.js";
import { extractSseUsage } from "./handler.js";
import {
  opikCreateTrace,
  opikCreateLlmSpan,
  opikUpdateTrace,
  uuidv7,
} from "./opik.js";
import {
  langfuseReportGeneration,
  langfuseReportFailure,
  langfuseTurnTraceId,
} from "./langfuse.js";
import type { ProxyConfig } from "./types.js";
import type { SystemUserMatch } from "./systemUser.js";
import {
  enforceRateLimit,
  isRateLimitExceededError,
  recordInputTokenUsage,
} from "./rate-limit/guard.js";
import {
  buildSafeUpstreamHeaders,
  MissingUpstreamCredentialError,
} from "./upstream-headers.js";

/** Response headers that would confuse the client if forwarded verbatim. */
const SKIP_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "transfer-encoding",
  "content-length",
  "connection",
]);

/**
 * Build upstream headers from the same protocol allowlist as normal requests.
 *
 * The caller's inbound key (`Authorization` / `x-api-key`) is a proxy-layer
 * auth credential — the sk-mem-xxx that `verifyUserKey` resolves against the
 * auth service. It is NOT a credential TokenHub (`config.upstream.url`) would
 * accept. It is dropped with every internal identity/session header, then the
 * configured upstream key is added in the selected protocol's auth format.
 */
function buildPassthroughHeaders(c: Context, config: ProxyConfig): Record<string, string> {
  const protocol = /\/v1\/messages(?:\/count_tokens)?$/.test(c.req.path)
    ? "anthropic"
    : "openai";
  return buildSafeUpstreamHeaders(c.req.raw.headers, {
    protocol,
    apiKey: config.upstream.apiKey,
  });
}

/** Copy upstream response headers minus length/encoding fields. */
function filterResponseHeaders(source: Headers): Headers {
  const out = new Headers();
  source.forEach((value, key) => {
    if (!SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) {
      out.set(key, value);
    }
  });
  return out;
}

/**
 * Try to JSON-parse a text blob without throwing. Returns `null` on failure;
 * callers should treat that as "record the raw string instead".
 */
function tryParseJson(text: string): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** Extract the request model id from a parsed body, tolerant of shape. */
function readModelId(bodyObj: Record<string, unknown> | null): string {
  if (!bodyObj) return "unknown";
  if (typeof bodyObj.model === "string" && bodyObj.model) return bodyObj.model;
  return "unknown";
}

/**
 * Extract usage from a non-stream response body.
 *
 * Handles the shapes we see on this proxy:
 *  - Anthropic Messages: `{ usage: { input_tokens, output_tokens, ... } }`
 *  - Anthropic count_tokens: `{ input_tokens: N }` (no wrapper)
 *  - OpenAI chat / embeddings: `{ ..., usage: { prompt_tokens, ... } }`
 */
function extractNonStreamUsage(
  respObj: Record<string, unknown> | null,
  path: string,
): Record<string, unknown> | null {
  if (!respObj) return null;
  if (path.includes("/count_tokens") && typeof respObj.input_tokens === "number") {
    return respObj;
  }
  if (respObj.usage && typeof respObj.usage === "object") {
    return respObj.usage as Record<string, unknown>;
  }
  return null;
}

/**
 * Common trace/usage recorder for both stream and non-stream paths.
 *
 * In-process attribution is identical across branches so classification and
 * credit math remain correct. Final exporters redact keyId/spaceId/sessionKey,
 * so dashboards expose totals/categories only.
 *
 * `traceInput` / `traceOutput` retain their parsed shape in-process; Opik and
 * Langfuse store only type/count summaries.
 */
async function recordTracesAndUsage(params: {
  config: ProxyConfig;
  match: SystemUserMatch;
  path: string;
  upstreamUrl: string;
  modelId: string;
  startTime: string;
  endTime: string;
  stream: boolean;
  traceId: string;
  requestPayload: unknown; // parsed body OR raw string
  responsePayload: unknown; // parsed body OR raw string
  usage: Record<string, unknown> | null;
  upstreamRequestId?: string;
  status: number;
}): Promise<void> {
  const {
    config, match, path, upstreamUrl, modelId, startTime, endTime, stream,
    traceId, requestPayload, responsePayload, usage, upstreamRequestId, status,
  } = params;

  const spaceId = extractSpaceIdFromPath(path) ?? "";
  const attributionKey = match.userId; // keyId column in ClickHouse
  const sessionKey = spaceId || match.userId;
  const usageForTrace = usage ?? {};
  const traceTags = [
    "systemUser",
    `systemUser:${match.name}`,
    stream ? "stream" : "non-stream",
  ];

  // ── ClickHouse / JSONL usage ─────────────────────────────────────────────
  if (usage && Object.keys(usage).length > 0) {
    const isAnthropicMain = /\/v1\/messages$/.test(path);
    const isOpenAiMain = /\/v1\/chat\/completions$/.test(path);
    if (isAnthropicMain || isOpenAiMain) {
      await recordInputTokenUsage({
        config,
        instanceId: spaceId || undefined,
        modelId,
        usage,
        protocol: isAnthropicMain ? "anthropic" : "openai",
      });
    }
    try {
      writeLog(config, {
        timestamp: endTime,
        event: "usage",
        modelId,
        keyId: attributionKey,
        sessionKey,
        upstreamUrl,
        stream,
        usage,
        spaceId: spaceId || undefined,
        upstreamRequestId,
      });
    } catch {
      log.warn("systemUser.usage_log_failed", {
        systemUser: true,
      });
    }
  }

  // ── Credit report (MemoryPlus billing for internal service usage) ────────
  try {
    const outcome = await tryReportCreditFromPath(
      config.creditReport,
      path,
      usage,
      config.creditPricing,
      modelId,
      upstreamUrl,
      "usage",
    );
    if (outcome.attempted && !outcome.ok) {
      log.warn("systemUser.credit_report_failed", {
        systemUser: true,
        attempted: true,
      });
    }
  } catch {
    log.warn("systemUser.credit_report_error", {
      systemUser: true,
    });
  }

  // ── Opik: create trace + LLM span (privacy-safe summaries only) ─────────
  //
  // We wrap `requestPayload` in `{ messages: ... }` when it happens to be a
  // parsed object with a `messages` array (matches the shape the main
  // handler produces for OpenAI/Anthropic requests); the exporter records
  // only fixed type/count summaries from either shape.
  const opikInput = normaliseForOpikInput(requestPayload);
  const forkTraceId = opikCreateTrace(config, {
    traceId,
    projectName: attributionKey,
    name: `${modelId} / ${match.name}`,
    startTime,
    input: opikInput,
    tags: traceTags,
    forkProjectName: "request_log",
    forkMetadata: {
      keyId: attributionKey,
      modelId,
      stream,
      upstreamUrl,
      systemUser: match.name,
    },
  });

  const opikOutput = normaliseForOpikOutput(responsePayload);
  try {
    opikUpdateTrace(config, {
      traceId,
      projectName: attributionKey,
      endTime,
      output: opikOutput,
      usage: usageForTrace,
    });
    if (forkTraceId && !config.opik.stripRequestLogContent) {
      opikUpdateTrace(config, {
        traceId: forkTraceId,
        projectName: "request_log",
        endTime,
        output: opikOutput,
        usage: usageForTrace,
      });
    }
    opikCreateLlmSpan(config, {
      traceId,
      projectName: attributionKey,
      name: modelId,
      startTime,
      endTime,
      inputMessages: opikSpanInputMessages(requestPayload),
      outputMessage: opikSpanOutputMessage(responsePayload),
      model: modelId,
      usage: usageForTrace,
      tags: traceTags,
      forkProjectName: "request_log",
      forkTraceId,
      forkMetadata: {
        keyId: attributionKey,
        modelId,
        stream,
        upstreamUrl,
        systemUser: match.name,
      },
    });
  } catch {
    log.warn("systemUser.opik_report_failed", {
      systemUser: true,
    });
  }

  // ── Langfuse: one random request trace per proxy call ────────────────────
  // Raw user/session/model fields remain available only for in-process
  // attribution; the exporter emits redacted identities and total/category
  // metrics, with no deterministic cross-request grouping.
  const lfTraceId = langfuseTurnTraceId(traceId);
  try {
    if (status >= 200 && status < 400) {
      langfuseReportGeneration({
        traceId: lfTraceId,
        name: modelId,
        model: modelId,
        startTime,
        endTime,
        input: requestPayload ?? null,
        output: responsePayload ?? null,
        usage: usage ?? undefined,
        traceName: `${modelId} / ${match.name}`,
        userId: attributionKey,
        sessionId: sessionKey,
        tags: traceTags,
        traceInput: requestPayload ?? undefined,
        traceOutput: responsePayload ?? undefined,
        traceMetadata: {
          stream,
          upstreamUrl,
          systemUser: match.name,
          spaceId: spaceId || undefined,
        },
        observationMetadata: {
          stream,
          upstreamRequestId,
          status,
        },
      });
    } else {
      langfuseReportFailure({
        lf: {
          traceId: lfTraceId,
          turnSeq: 0,
          traceName: `${modelId} / ${match.name}`,
          userId: attributionKey,
          sessionId: sessionKey,
          tags: traceTags,
          routeTags: [],
          userQuery: "",
        },
        model: modelId,
        startTime,
        endTime,
        input: requestPayload ?? null,
        status,
        statusMessage: `upstream returned ${status}`,
        observationMetadata: { stream, upstreamRequestId, systemUser: match.name },
      });
    }
  } catch {
    log.warn("systemUser.langfuse_report_failed", {
      systemUser: true,
    });
  }
}

/**
 * Best-effort shaping of the raw request body into Opik's trace `input` slot.
 * Object → `{ messages }` if the body has a `messages` array, else the whole
 * object. String / null → `{ raw: text }` so the field is always an object.
 */
function normaliseForOpikInput(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const obj = payload as Record<string, unknown>;
    if (Array.isArray(obj.messages)) {
      return { messages: obj.messages, ...(obj.system ? { system: obj.system } : {}) };
    }
    return obj;
  }
  return { raw: typeof payload === "string" ? payload : JSON.stringify(payload ?? null) };
}

/** Wrap the response for Opik trace `output`. Object stays, string becomes `{raw}`. */
function normaliseForOpikOutput(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  return { raw: typeof payload === "string" ? payload : JSON.stringify(payload ?? null) };
}

/**
 * Opik LLM span `inputMessages` expects an array of `{role, content}` objects
 * OR any array — it's ultimately stored as JSON. We return the request's
 * `messages` array untouched if present, otherwise wrap the whole body in
 * a single synthetic user message so the panel isn't empty.
 */
function opikSpanInputMessages(payload: unknown): unknown[] {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const obj = payload as Record<string, unknown>;
    if (Array.isArray(obj.messages)) return obj.messages;
  }
  return [{ role: "user", content: typeof payload === "string" ? payload : JSON.stringify(payload ?? null) }];
}

/** Opik LLM span `outputMessage` — one `{role, content}` object or null. */
function opikSpanOutputMessage(payload: unknown): Record<string, unknown> | null {
  if (payload == null) return null;
  if (typeof payload === "object" && !Array.isArray(payload)) {
    return { role: "assistant", content: JSON.stringify(payload) };
  }
  return { role: "assistant", content: typeof payload === "string" ? payload : JSON.stringify(payload) };
}

/**
 * Handle a matched system-user request. Never throws — returns a Response
 * even on upstream failure.
 *
 * @param rewrittenBody
 *   When provided, the main handler has already parsed the body and applied
 *   the model-alias resolution (`body.model = resolveModelId(...)`); we
 *   serialise it and forward that. When omitted (aux path), we read the raw
 *   request bytes and forward them verbatim.
 */
export async function handleSystemUserPassthrough(
  c: Context,
  config: ProxyConfig,
  match: SystemUserMatch,
  rewrittenBody?: Record<string, unknown>,
): Promise<Response> {
  const startTime = new Date().toISOString();
  const traceId = uuidv7();
  const path = c.req.path;
  const upstreamUrl = joinUrl(config.upstream.url, path);
  const spaceId = extractSpaceIdFromPath(path) ?? "";

  // Two body-forwarding paths (see file header). We normalise both to
  // `ArrayBuffer` so `fetch({body})` accepts them without a type-union
  // dance downstream.
  let rawBody: ArrayBuffer;
  let bodyObj: Record<string, unknown> | null;
  let bodyTextForTrace: string;
  if (rewrittenBody) {
    // Main-handler path: reuse the already-parsed + alias-resolved body so
    // upstream sees the canonical `model_id`, exactly like external callers.
    bodyTextForTrace = JSON.stringify(rewrittenBody);
    const encoded = new TextEncoder().encode(bodyTextForTrace);
    // Copy into a fresh ArrayBuffer — TextEncoder returns a Uint8Array whose
    // underlying buffer may be a SharedArrayBuffer in some runtimes.
    rawBody = encoded.buffer.slice(
      encoded.byteOffset,
      encoded.byteOffset + encoded.byteLength,
    ) as ArrayBuffer;
    bodyObj = rewrittenBody;
  } else {
    // Aux path: byte-verbatim forwarding.
    rawBody = await c.req.arrayBuffer();
    bodyTextForTrace = new TextDecoder().decode(rawBody);
    bodyObj = tryParseJson(bodyTextForTrace);
  }
  const modelId = readModelId(bodyObj);
  const requestPayload: unknown = bodyObj ?? bodyTextForTrace;

  log.info("systemUser.passthrough", {
    systemUser: true,
    memoryIdPresent: spaceId.length > 0,
    modelConfigured: modelId.length > 0,
  });

  let headers: Record<string, string>;
  try {
    headers = buildPassthroughHeaders(c, config);
  } catch (err: unknown) {
    if (err instanceof MissingUpstreamCredentialError) {
      return c.json({ error: err.message }, 503);
    }
    throw err;
  }
  const forwardTimeoutMs = config.server.forwardTimeoutMs ?? 600_000;

  let upstreamResp: Response;
  try {
    const isAnthropicMain = /\/v1\/messages$/.test(path);
    const isOpenAiMain = /\/v1\/chat\/completions$/.test(path);
    if (bodyObj && (isAnthropicMain || isOpenAiMain)) {
      await enforceRateLimit({
        config,
        instanceId: spaceId || undefined,
        modelId,
        protocol: isAnthropicMain ? "anthropic" : "openai",
      });
    }
    const fetchOpts: RequestInit = {
      method: "POST",
      headers,
      body: rawBody,
      redirect: "manual",
    };
    if (forwardTimeoutMs > 0) {
      fetchOpts.signal = AbortSignal.timeout(forwardTimeoutMs);
    }
    upstreamResp = await fetch(upstreamUrl, fetchOpts);
  } catch (err: unknown) {
    if (isRateLimitExceededError(err)) {
      return err.response;
    }
    const endTime = new Date().toISOString();
    const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
    const failureCategory = isTimeout ? "timeout" : "transport_error";
    const failureDetail = isTimeout ? "upstream_timeout" : "upstream_transport_error";
    log.error(
      "systemUser.forward_failed",
      { systemUser: true, timeout: isTimeout, category: failureCategory },
    );

    // Best-effort failure trace so aggregate dashboards see the outage.
    recordTracesAndUsage({
      config, match, path, upstreamUrl, modelId, startTime, endTime,
      stream: false, traceId,
      requestPayload,
      responsePayload: { error: failureDetail },
      usage: null,
      status: 502,
    }).catch(() => { /* best-effort */ });

    return c.json({ error: "Upstream request failed", detail: failureDetail }, 502);
  }

  if (upstreamResp.status >= 300 && upstreamResp.status < 400) {
    log.warn("systemUser.redirect_rejected", { status: upstreamResp.status });
    return c.json({ error: "Upstream redirect rejected" }, 502);
  }

  const upstreamRequestId = upstreamResp.headers.get("x-request-id") ?? undefined;
  const contentType = upstreamResp.headers.get("content-type") ?? "";
  const isStream = contentType.includes("event-stream");
  const status = upstreamResp.status;

  if (isStream && upstreamResp.body) {
    // Tee the stream: one branch to the client immediately, one consumed in
    // background for trace + usage. On tee failure fall back to a pure
    // passthrough with no observability rather than break the client.
    let clientStream: ReadableStream<Uint8Array>;
    let tapStream: ReadableStream<Uint8Array> | null = null;
    try {
      const [a, b] = upstreamResp.body.tee();
      clientStream = a;
      tapStream = b;
    } catch {
      log.warn("systemUser.stream_tee_failed", {
        systemUser: true,
      });
      clientStream = upstreamResp.body;
    }

    if (tapStream) {
      consumeStream(tapStream, path)
        .then(({ usage, rawText }) => {
          const endTime = new Date().toISOString();
          return recordTracesAndUsage({
            config, match, path, upstreamUrl, modelId,
            startTime, endTime, stream: true, traceId,
            requestPayload,
            // Exporters reduce the raw SSE text to a type/length summary.
            responsePayload: rawText,
            usage,
            upstreamRequestId,
            status,
          });
        })
        .catch(() => {
          log.warn("systemUser.stream_consume_failed", {
            systemUser: true,
          });
        });
    }

    return new Response(clientStream, {
      status,
      headers: filterResponseHeaders(upstreamResp.headers),
    });
  }

  // Non-stream: read full body, extract usage + trace, return bytes unchanged.
  const respBuf = await upstreamResp.arrayBuffer();
  const respText = new TextDecoder().decode(respBuf);
  const respObj = tryParseJson(respText);
  const responsePayload: unknown = respObj ?? respText;
  const usage = upstreamResp.ok ? extractNonStreamUsage(respObj, path) : null;
  const endTime = new Date().toISOString();

  await recordTracesAndUsage({
    config, match, path, upstreamUrl, modelId,
    startTime, endTime, stream: false, traceId,
    requestPayload, responsePayload, usage,
    upstreamRequestId, status,
  });

  return new Response(respBuf, {
    status,
    headers: filterResponseHeaders(upstreamResp.headers),
  });
}

/**
 * Consume a stream and return both the raw text (for trace payload) and
 * extracted usage (Anthropic message_start/delta OR OpenAI final usage).
 *
 * Text is capped at 512 KiB before in-process summary generation to avoid
 * unbounded memory growth. Exporters retain only type/count summaries. Usage
 * extraction always uses the full stream regardless of the cap.
 */
async function consumeStream(
  stream: ReadableStream<Uint8Array>,
  path: string,
): Promise<{ usage: Record<string, unknown> | null; rawText: string }> {
  const RAW_CAP = 512 * 1024;
  const isAnthropic = /\/v1\/messages(?:$|[/?])/.test(path);
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buf = "";
  let rawText = "";
  const anthropicUsage: Record<string, unknown> = {};

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      if (rawText.length < RAW_CAP) {
        rawText += chunk.slice(0, RAW_CAP - rawText.length);
      }

      if (isAnthropic) {
        buf += chunk;
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const part of parts) mergeAnthropicUsageFromEvent(part, anthropicUsage);
      } else {
        // For OpenAI we can afford to keep everything in buf — extractSseUsage
        // scans all `data:` lines and returns the last usage-bearing event.
        buf += chunk;
      }
    }
    if (isAnthropic && buf.trim()) {
      mergeAnthropicUsageFromEvent(buf, anthropicUsage);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }

  const usage = isAnthropic
    ? (Object.keys(anthropicUsage).length > 0 ? anthropicUsage : null)
    : extractSseUsage(buf);

  return { usage, rawText };
}

/** Merge Anthropic SSE `message_start` / `message_delta` usage into `sink`. */
function mergeAnthropicUsageFromEvent(part: string, sink: Record<string, unknown>): void {
  let dataStr = "";
  for (const line of part.split("\n")) {
    if (line.startsWith("data: ")) dataStr = line.slice(6);
    else if (line.startsWith("data:")) dataStr = line.slice(5);
  }
  if (!dataStr || dataStr === "[DONE]") return;
  try {
    const evt = JSON.parse(dataStr) as Record<string, unknown>;
    if (evt.type === "message_start") {
      const message = evt.message as Record<string, unknown> | undefined;
      if (message?.usage && typeof message.usage === "object") {
        Object.assign(sink, message.usage as Record<string, unknown>);
      }
    } else if (evt.type === "message_delta") {
      if (evt.usage && typeof evt.usage === "object") {
        Object.assign(sink, evt.usage as Record<string, unknown>);
      }
    }
  } catch {
    // ignore malformed SSE events — usage is best-effort
  }
}
