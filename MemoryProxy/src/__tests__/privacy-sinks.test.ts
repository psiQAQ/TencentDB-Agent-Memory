import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  clickhouseCommand,
  clickhouseCreateClient,
  clickhouseInsert,
  startObservation,
} = vi.hoisted(() => {
  const clickhouseCommand = vi.fn(async () => undefined);
  const clickhouseInsert = vi.fn(async (_input: unknown) => undefined);
  const clickhouseClient = {
    command: clickhouseCommand,
    insert: clickhouseInsert,
    close: vi.fn(async () => undefined),
  };
  return {
    clickhouseCommand,
    clickhouseCreateClient: vi.fn(() => clickhouseClient),
    clickhouseInsert,
    startObservation: vi.fn((
      _name: string,
      _input?: unknown,
      _options?: { parentSpanContext?: { traceId?: string } },
    ) => ({
      otelSpan: { setAttribute: vi.fn() },
      end: vi.fn(),
    })),
  };
});

vi.mock("@langfuse/tracing", () => ({
  startObservation,
  LangfuseOtelSpanAttributes: {
    TRACE_NAME: "trace.name",
    TRACE_USER_ID: "trace.user_id",
    TRACE_SESSION_ID: "trace.session_id",
    TRACE_TAGS: "trace.tags",
    TRACE_INPUT: "trace.input",
    TRACE_OUTPUT: "trace.output",
    TRACE_METADATA: "trace.metadata",
  },
}));
vi.mock("@langfuse/otel", () => ({ LangfuseSpanProcessor: class {} }));
vi.mock("@clickhouse/client", () => ({ createClient: clickhouseCreateClient }));
vi.mock("@opentelemetry/sdk-node", () => ({
  NodeSDK: class {
    start(): void {}
    async shutdown(): Promise<void> {}
  },
}));

import {
  buildClickHouseRow,
  buildFailedReportRawRow,
  buildRawUsageRow,
  flush,
  flushRaw,
  initClickHouse,
  shutdownClickHouse,
} from "../clickhouse.js";
import { buildRequestDebugMetadata } from "../common/langfuse-debug.js";
import { DEFAULT_CONFIG } from "../config.js";
import { normalizeExtensionLogEvent } from "../guard-adapter.js";
import { getRecentInspections, inspectAndRecord } from "../identity.js";
import {
  initLangfuse,
  langfuseTurnTraceId,
  langfuseReportGeneration,
  shutdownLangfuse,
} from "../langfuse.js";
import { LangfuseInjectionObserver } from "../injection/observer.js";
import { writeLog } from "../logger.js";
import { opikCreateLlmSpan, opikCreateTrace, opikUpdateTrace } from "../opik.js";
import { log } from "../report/log.js";

const PRIVATE_VALUE = "private-observability-value";

function containsPrivateValue(value: unknown): boolean {
  return JSON.stringify(value).includes(PRIVATE_VALUE);
}

async function readWhenCreated(path: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error("usage log was not created");
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  startObservation.mockClear();
  await shutdownLangfuse();
});

describe("privacy-safe observability sinks", () => {
  it("keeps only presence metadata in recent identity inspections", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    inspectAndRecord(
      "POST",
      `/claude-code/${PRIVATE_VALUE}/v1/messages`,
      {
        authorization: `Bearer ${PRIVATE_VALUE}`,
        "x-session-id": PRIVATE_VALUE,
        "x-team-id": PRIVATE_VALUE,
        "x-custom-value": PRIVATE_VALUE,
        [`x-${PRIVATE_VALUE}`]: PRIVATE_VALUE,
      },
      {
        model: PRIVATE_VALUE,
        stream: false,
        messages: [{ role: "user", content: "hello" }],
        system: `${PRIVATE_VALUE}${"x".repeat(6000)}${PRIVATE_VALUE}`,
      },
      "claude-code",
    );

    const inspection = getRecentInspections().at(-1);
    expect(containsPrivateValue(inspection)).toBe(false);
    expect(inspection?.bodyMeta.systemPromptPreview).toBeUndefined();
    expect(inspection?.bodyMeta.systemPromptTail).toBeUndefined();
  });

  it("stores no raw session or user input in JSONL", async () => {
    const dir = await mkdtemp(join(tmpdir(), "proxy-privacy-"));
    try {
      const config = structuredClone(DEFAULT_CONFIG);
      config.log.file = dir;
      config.clickhouse.enabled = false;
      writeLog(config, {
        timestamp: new Date().toISOString(),
        event: "usage",
        modelId: PRIVATE_VALUE,
        keyId: PRIVATE_VALUE,
        sessionKey: PRIVATE_VALUE,
        userInput: PRIVATE_VALUE,
        upstreamUrl: `https://upstream.invalid/${PRIVATE_VALUE}`,
        stream: false,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          [PRIVATE_VALUE]: { nested: PRIVATE_VALUE },
        },
        routedFrom: PRIVATE_VALUE,
        spaceId: PRIVATE_VALUE,
        upstreamRequestId: PRIVATE_VALUE,
      });

      const path = join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
      const stored = await readWhenCreated(path);
      expect(stored.includes(PRIVATE_VALUE)).toBe(false);
      const parsed = JSON.parse(stored.trim()) as Record<string, unknown>;
      expect([
        parsed.modelId,
        parsed.keyId,
        parsed.sessionKey,
        parsed.upstreamUrl,
        parsed.routedFrom,
        parsed.spaceId,
        parsed.upstreamRequestId,
      ].every((value) => value === "[redacted]")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps typed usage for ClickHouse classification and cost before final row redaction", async () => {
    clickhouseCommand.mockClear();
    clickhouseCreateClient.mockClear();
    clickhouseInsert.mockClear();
    const config = structuredClone(DEFAULT_CONFIG);
    config.log.file = "";
    config.clickhouse = {
      enabled: true,
      url: "https://clickhouse.invalid",
      database: "privacy_test",
      table: "usage_logs",
      rawTable: "usage_raw",
      user: "default",
      password: "",
      flushIntervalMs: 60_000,
      flushThreshold: 100,
      ttlDays: 0,
    };
    config.creditPricing.models = [{
      name: "priced-model",
      modelName: PRIVATE_VALUE,
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
    }];

    initClickHouse(config.clickhouse);
    await vi.waitFor(() => expect(clickhouseCreateClient).toHaveBeenCalledTimes(2));
    writeLog(config, {
      timestamp: "2026-08-10T12:34:56.789Z",
      event: "usage",
      modelId: "priced-model",
      keyId: PRIVATE_VALUE,
      sessionKey: PRIVATE_VALUE,
      turnSeq: 3,
      userInput: PRIVATE_VALUE,
      upstreamUrl: "https://tokenhub.invalid/v1/messages",
      stream: false,
      usage: { input_tokens: 1_000, output_tokens: 500 },
      routedFrom: PRIVATE_VALUE,
      spaceId: PRIVATE_VALUE,
      upstreamRequestId: PRIVATE_VALUE,
    });
    await flush();
    await flushRaw();

    const inserts = clickhouseInsert.mock.calls.map(([input]) => input as {
      table: string;
      values: Array<Record<string, unknown>>;
    });
    const usageInsert = inserts.find((input) => input.table === "usage_logs");
    const rawInsert = inserts.find((input) => input.table === "usage_raw");
    const row = usageInsert?.values[0];
    expect(row?.credit).toBe(2);
    expect(row?.prompt_tokens).toBe(1_000);
    expect(row?.completion_tokens).toBe(500);
    expect(rawInsert).toBeUndefined();
    expect(containsPrivateValue(row)).toBe(false);
    expect(row?.model_id === "[redacted]").toBe(true);
    await shutdownClickHouse();
  });

  it("stores no raw session or user input in ClickHouse rows", () => {
    const entry = {
      timestamp: new Date().toISOString(),
      event: "usage",
      modelId: PRIVATE_VALUE,
      keyId: PRIVATE_VALUE,
      sessionKey: PRIVATE_VALUE,
      userInput: PRIVATE_VALUE,
      upstreamUrl: `https://upstream.invalid/${PRIVATE_VALUE}`,
      stream: false,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        [PRIVATE_VALUE]: { nested: PRIVATE_VALUE },
      },
      routedFrom: PRIVATE_VALUE,
      spaceId: PRIVATE_VALUE,
      upstreamRequestId: PRIVATE_VALUE,
    };
    const rows = [
      buildClickHouseRow(entry),
      buildRawUsageRow(entry, PRIVATE_VALUE),
      buildFailedReportRawRow(entry, PRIVATE_VALUE),
    ];

    expect(containsPrivateValue(rows)).toBe(false);
    expect(rows.every((row) => row !== null && [
      row.model_id,
      row.model_name,
      "key_id" in row ? row.key_id : undefined,
      row.user_id,
      row.session_key,
      row.upstream_url,
      row.routed_from,
      row.space_id,
      row.upstream_request_id,
    ].filter((value) => value !== undefined).every((value) => value === "[redacted]"))).toBe(true);
  });

  it("sends only fixed categories, counts, and numeric usage to Opik", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return Response.json({});
    }));
    for (const stripRequestLogContent of [false, true]) {
      const config = structuredClone(DEFAULT_CONFIG);
      config.opik.enabled = true;
      config.opik.url = "https://opik.invalid";
      config.opik.stripRequestLogContent = stripRequestLogContent;
      const traceId = stripRequestLogContent ? "trace-strip" : "trace-summary";
      const forkTraceId = opikCreateTrace(config, {
        traceId,
        projectName: PRIVATE_VALUE,
        name: PRIVATE_VALUE,
        startTime: new Date().toISOString(),
        input: { [PRIVATE_VALUE]: [{ role: "user", content: PRIVATE_VALUE }] },
        tags: [PRIVATE_VALUE, `session:${PRIVATE_VALUE}`],
        forkProjectName: "request_log",
        forkMetadata: { [PRIVATE_VALUE]: PRIVATE_VALUE, keyId: PRIVATE_VALUE, modelId: PRIVATE_VALUE },
      });
      opikCreateLlmSpan(config, {
        traceId,
        projectName: PRIVATE_VALUE,
        name: PRIVATE_VALUE,
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString(),
        inputMessages: [{ role: "user", content: PRIVATE_VALUE }],
        outputMessage: { role: "assistant", content: PRIVATE_VALUE },
        model: PRIVATE_VALUE,
        usage: { input_tokens: 1, output_tokens: 1, [PRIVATE_VALUE]: 7 },
        tags: [PRIVATE_VALUE, `session:${PRIVATE_VALUE}`],
        forkProjectName: "request_log",
        forkTraceId,
        forkMetadata: { [PRIVATE_VALUE]: PRIVATE_VALUE, keyId: PRIVATE_VALUE, modelId: PRIVATE_VALUE },
      });
      opikUpdateTrace(config, {
        traceId,
        projectName: PRIVATE_VALUE,
        endTime: new Date().toISOString(),
        output: [{ role: "assistant", content: PRIVATE_VALUE }],
        usage: { input_tokens: 1, output_tokens: 1, [PRIVATE_VALUE]: 7 },
      });
    }

    expect(bodies.length).toBe(10);
    expect(containsPrivateValue(bodies)).toBe(false);
    expect(bodies.every((body) => {
      const record = body as Record<string, unknown>;
      return [record.project_name, record.name, record.model]
        .filter((value) => value !== undefined && value !== "request_log")
        .every((value) => value === "[redacted]");
    })).toBe(true);
    const summaryForkTrace = bodies[1] as Record<string, unknown>;
    const summaryForkSpan = bodies[3] as Record<string, unknown>;
    const strippedForkTrace = bodies[6] as Record<string, unknown>;
    const strippedForkSpan = bodies[8] as Record<string, unknown>;
    expect("input" in summaryForkTrace).toBe(true);
    expect("input" in summaryForkSpan).toBe(true);
    expect("output" in summaryForkSpan).toBe(true);
    expect("input" in strippedForkTrace).toBe(false);
    expect("input" in strippedForkSpan).toBe(false);
    expect("output" in strippedForkSpan).toBe(false);
  });

  it("uses request-scoped Langfuse trace ids and privacy-safe injection observations", () => {
    const requestTraceId = "019fed2a-0000-7000-8000-000000000001";
    const firstTraceId = langfuseTurnTraceId(requestTraceId);
    const secondTraceId = langfuseTurnTraceId(requestTraceId);
    const otherTraceId = langfuseTurnTraceId("019fed2a-0000-7000-8000-000000000002");
    expect(firstTraceId === secondTraceId).toBe(true);
    expect(firstTraceId === otherTraceId).toBe(false);
    expect(/^[0-9a-f]{32}$/.test(firstTraceId)).toBe(true);

    const observer = new LangfuseInjectionObserver();
    observer.onPipelineStart({
      protocol: "anthropic",
      traceId: requestTraceId,
      keyId: PRIVATE_VALUE,
      modelId: PRIVATE_VALUE,
      stream: false,
      agentSource: PRIVATE_VALUE,
      userId: PRIVATE_VALUE,
      spaceId: PRIVATE_VALUE,
      sessionKey: PRIVATE_VALUE,
      turnSeq: 7,
      requestPath: `/${PRIVATE_VALUE}`,
    });
    observer.onHookDone({
      id: PRIVATE_VALUE,
      point: "system.prefix",
      priority: 1,
      description: PRIVATE_VALUE,
      execute: () => [],
    }, "system.prefix", [{
      type: "text",
      content: PRIVATE_VALUE,
      metadata: { [PRIVATE_VALUE]: PRIVATE_VALUE, source: PRIVATE_VALUE },
    }], 5, PRIVATE_VALUE);

    const observation = startObservation.mock.results.at(-1)?.value;
    const observationOptions = startObservation.mock.calls.at(-1)?.[2];
    expect(observationOptions?.parentSpanContext?.traceId === firstTraceId).toBe(true);
    expect(containsPrivateValue(startObservation.mock.calls.at(-1))).toBe(false);
    expect(containsPrivateValue(observation?.otelSpan.setAttribute.mock.calls)).toBe(false);
  });

  it("runtime-validates opaque extension log control fields", () => {
    const rejected = normalizeExtensionLogEvent({
      event: PRIVATE_VALUE,
      timestamp: PRIVATE_VALUE,
      stream: PRIVATE_VALUE,
    });
    const normalized = normalizeExtensionLogEvent({
      event: "analyzer_usage",
      timestamp: PRIVATE_VALUE,
      modelId: PRIVATE_VALUE,
      keyId: PRIVATE_VALUE,
      sessionKey: PRIVATE_VALUE,
      upstreamUrl: `https://upstream.invalid/${PRIVATE_VALUE}`,
      stream: PRIVATE_VALUE,
      usage: { input_tokens: 1, [PRIVATE_VALUE]: PRIVATE_VALUE },
      [PRIVATE_VALUE]: PRIVATE_VALUE,
    });
    const normalizedTimestamp = normalizeExtensionLogEvent({
      event: "analyzer_usage",
      timestamp: "2026-08-10T12:34:56+08:00",
      modelId: "model",
      keyId: "key",
      upstreamUrl: "https://upstream.invalid",
      stream: true,
      usage: {},
    });

    expect(rejected).toBeNull();
    expect(normalized?.event === "analyzer_usage").toBe(true);
    expect(Number.isNaN(Date.parse(normalized?.timestamp ?? ""))).toBe(false);
    expect(normalized?.timestamp.includes(PRIVATE_VALUE)).toBe(false);
    expect(normalized?.stream).toBe(false);
    expect(Object.keys(normalized ?? {}).includes(PRIVATE_VALUE)).toBe(false);
    expect(normalizedTimestamp?.timestamp === "2026-08-10T04:34:56.000Z").toBe(true);
    expect(normalizedTimestamp?.stream).toBe(true);
  });

  it("does not log raw Opik response bodies or errors", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response(PRIVATE_VALUE, { status: 500 })));
    const config = structuredClone(DEFAULT_CONFIG);
    config.opik.enabled = true;
    config.opik.url = "https://opik.invalid";

    opikCreateTrace(config, {
      traceId: "trace-error",
      projectName: "project",
      name: "trace",
      startTime: new Date().toISOString(),
      input: {},
    });
    for (let attempt = 0; attempt < 100 && warn.mock.calls.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(warn).toHaveBeenCalled();
    expect(containsPrivateValue(warn.mock.calls)).toBe(false);
  });

  it("passes no raw prompt, session, or debug value to Langfuse", async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.langfuse = {
      ...config.langfuse,
      enabled: true,
      host: "https://langfuse.invalid",
      publicKey: "public-test-key",
      secretKey: "secret-test-key",
    };
    expect(await initLangfuse(config)).toBe(true);

    langfuseReportGeneration({
      traceId: "a".repeat(32),
      name: PRIVATE_VALUE,
      model: PRIVATE_VALUE,
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
      input: [{ role: "user", content: PRIVATE_VALUE }],
      output: { role: "assistant", content: PRIVATE_VALUE },
      usage: { input_tokens: 1, output_tokens: 1 },
      traceName: PRIVATE_VALUE,
      userId: PRIVATE_VALUE,
      sessionId: PRIVATE_VALUE,
      tags: [PRIVATE_VALUE, `session:${PRIVATE_VALUE}`],
      traceInput: PRIVATE_VALUE,
      traceOutput: PRIVATE_VALUE,
      traceMetadata: { [PRIVATE_VALUE]: PRIVATE_VALUE },
      observationMetadata: { [PRIVATE_VALUE]: PRIVATE_VALUE },
    });

    expect(startObservation).toHaveBeenCalledOnce();
    const observation = startObservation.mock.results[0]?.value;
    expect(containsPrivateValue(observation?.otelSpan.setAttribute.mock.calls)).toBe(false);
    expect(containsPrivateValue(startObservation.mock.calls)).toBe(false);
    expect(startObservation.mock.calls[0]?.[0] === "[redacted]").toBe(true);
  });

  it("keeps debug metadata to counts, names, and safe categories", () => {
    const metadata = buildRequestDebugMetadata({
      debug: true,
      body: {
        model: PRIVATE_VALUE,
        messages: [{ role: "user", content: PRIVATE_VALUE }],
        system: PRIVATE_VALUE,
        tools: [{ name: PRIVATE_VALUE, description: PRIVATE_VALUE }],
        thinking: { type: PRIVATE_VALUE },
        metadata: { [PRIVATE_VALUE]: PRIVATE_VALUE },
        [PRIVATE_VALUE]: PRIVATE_VALUE,
      },
      headers: { [`x-${PRIVATE_VALUE}`]: PRIVATE_VALUE },
      agentSource: PRIVATE_VALUE as never,
      requestKind: "main",
      spaceId: PRIVATE_VALUE,
      requestPath: `/claude-code/${PRIVATE_VALUE}/v1/messages`,
      protocol: "anthropic",
    });

    expect(containsPrivateValue(metadata)).toBe(false);
  });
});
