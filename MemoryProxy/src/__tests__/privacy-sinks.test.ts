import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { startObservation } = vi.hoisted(() => ({
  startObservation: vi.fn(() => ({
    otelSpan: { setAttribute: vi.fn() },
    end: vi.fn(),
  })),
}));

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
} from "../clickhouse.js";
import { buildRequestDebugMetadata } from "../common/langfuse-debug.js";
import { DEFAULT_CONFIG } from "../config.js";
import { getRecentInspections, inspectAndRecord } from "../identity.js";
import {
  initLangfuse,
  langfuseReportGeneration,
  shutdownLangfuse,
} from "../langfuse.js";
import { writeLog } from "../logger.js";
import { opikCreateLlmSpan, opikCreateTrace, opikUpdateTrace } from "../opik.js";

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
      "/claude-code/space/v1/messages",
      {
        authorization: `Bearer ${PRIVATE_VALUE}`,
        "x-session-id": PRIVATE_VALUE,
        "x-team-id": PRIVATE_VALUE,
        "x-custom-value": PRIVATE_VALUE,
      },
      {
        model: "test-model",
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
        modelId: "test-model",
        keyId: "user-1",
        sessionKey: PRIVATE_VALUE,
        userInput: PRIVATE_VALUE,
        upstreamUrl: "https://upstream.invalid",
        stream: false,
        usage: { input_tokens: 1, output_tokens: 1 },
      });

      const path = join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
      const stored = await readWhenCreated(path);
      expect(stored.includes(PRIVATE_VALUE)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stores no raw session or user input in ClickHouse rows", () => {
    const entry = {
      timestamp: new Date().toISOString(),
      event: "usage",
      modelId: "test-model",
      keyId: "user-1",
      sessionKey: PRIVATE_VALUE,
      userInput: PRIVATE_VALUE,
      upstreamUrl: "https://upstream.invalid",
      stream: false,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const rows = [
      buildClickHouseRow(entry),
      buildRawUsageRow(entry, "non_tokenhub"),
      buildFailedReportRawRow(entry, "fixed-error-category"),
    ];

    expect(containsPrivateValue(rows)).toBe(false);
  });

  it("sends no raw prompt or session value to Opik", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return Response.json({});
    }));
    const config = structuredClone(DEFAULT_CONFIG);
    config.opik.enabled = true;
    config.opik.url = "https://opik.invalid";

    opikCreateTrace(config, {
      traceId: "trace-1",
      projectName: "project",
      name: "trace",
      startTime: new Date().toISOString(),
      input: { messages: [{ role: "user", content: PRIVATE_VALUE }] },
      tags: [`session:${PRIVATE_VALUE}`],
    });
    opikCreateLlmSpan(config, {
      traceId: "trace-1",
      projectName: "project",
      name: "span",
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
      inputMessages: [{ role: "user", content: PRIVATE_VALUE }],
      outputMessage: { role: "assistant", content: PRIVATE_VALUE },
      model: "test-model",
      usage: { input_tokens: 1, output_tokens: 1 },
      tags: [`session:${PRIVATE_VALUE}`],
    });
    opikUpdateTrace(config, {
      traceId: "trace-1",
      projectName: "project",
      endTime: new Date().toISOString(),
      output: [{ role: "assistant", content: PRIVATE_VALUE }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    for (let attempt = 0; attempt < 100 && bodies.length < 3; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(bodies.length).toBe(3);
    expect(containsPrivateValue(bodies)).toBe(false);
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
      name: "test-model",
      model: "test-model",
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
      input: [{ role: "user", content: PRIVATE_VALUE }],
      output: { role: "assistant", content: PRIVATE_VALUE },
      usage: { input_tokens: 1, output_tokens: 1 },
      traceName: "test-trace",
      userId: "user-1",
      sessionId: PRIVATE_VALUE,
      tags: [`session:${PRIVATE_VALUE}`],
      traceInput: PRIVATE_VALUE,
      traceOutput: PRIVATE_VALUE,
      traceMetadata: { debug: PRIVATE_VALUE },
      observationMetadata: { debug: PRIVATE_VALUE },
    });

    expect(startObservation).toHaveBeenCalledOnce();
    const observation = startObservation.mock.results[0]?.value;
    expect(containsPrivateValue(observation?.otelSpan.setAttribute.mock.calls)).toBe(false);
    expect(containsPrivateValue(startObservation.mock.calls)).toBe(false);
  });

  it("keeps debug metadata to counts, names, and safe categories", () => {
    const metadata = buildRequestDebugMetadata({
      debug: true,
      body: {
        model: "test-model",
        messages: [{ role: "user", content: PRIVATE_VALUE }],
        system: PRIVATE_VALUE,
        tools: [{ name: PRIVATE_VALUE, description: PRIVATE_VALUE }],
        metadata: { private: PRIVATE_VALUE },
      },
      headers: { "x-private-value": PRIVATE_VALUE },
      agentSource: "claude-code",
      requestKind: "main",
      spaceId: PRIVATE_VALUE,
      requestPath: `/claude-code/${PRIVATE_VALUE}/v1/messages`,
      protocol: "anthropic",
    });

    expect(containsPrivateValue(metadata)).toBe(false);
  });
});
