import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PRIVATE_VALUE = "private-auxiliary-diagnostics-value";

const { tryReportCreditFromPath } = vi.hoisted(() => ({
  tryReportCreditFromPath: vi.fn(),
}));

vi.mock("../credit-reporter.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../credit-reporter.js")>();
  return { ...original, tryReportCreditFromPath };
});

import { initAuth } from "../auth.js";
import { DEFAULT_CONFIG } from "../config.js";
import { log } from "../report/log.js";
import { createApp } from "../server.js";

function containsPrivateValue(value: unknown): boolean {
  const seen = new Set<object>();
  const visit = (item: unknown): boolean => {
    if (typeof item === "string") return item.includes(PRIVATE_VALUE);
    if (item instanceof AggregateError) {
      return visit(item.message) || visit(item.stack) || visit(item.cause) || visit(item.errors);
    }
    if (item instanceof Error) return visit(item.message) || visit(item.stack) || visit(item.cause);
    if (!item || typeof item !== "object" || seen.has(item)) return false;
    seen.add(item);
    return Object.entries(item).some(([key, nested]) => visit(key) || visit(nested));
  };
  return visit(value);
}

function config() {
  const value = structuredClone(DEFAULT_CONFIG);
  value.auth = { enabled: false, url: "", timeoutMs: 1_000 };
  value.upstream.url = "https://configured.invalid/anthropic/v1";
  value.upstream.apiKey = "server-key";
  value.upstream.agents["claude-code"] = {
    url: `https://upstream.invalid/${PRIVATE_VALUE}`,
    apiKey: "server-key",
  };
  value.log.backend = "noop";
  value.log.file = "";
  value.clickhouse.enabled = false;
  return value;
}

function request() {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "memory-user-key",
    },
    body: JSON.stringify({
      model: PRIVATE_VALUE,
      messages: [{ role: "user", content: PRIVATE_VALUE }],
    }),
  } satisfies RequestInit;
}

beforeEach(() => {
  tryReportCreditFromPath.mockResolvedValue({ attempted: false, ok: false });
});

afterEach(() => {
  initAuth(DEFAULT_CONFIG.auth);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("auxiliary diagnostic privacy", () => {
  it("returns and logs a fixed transport error category", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const error = vi.spyOn(log, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error(PRIVATE_VALUE, { cause: PRIVATE_VALUE });
    }));
    const value = config();
    initAuth(value.auth);

    const response = await createApp(value).request(
      `http://proxy/claude-code/${PRIVATE_VALUE}/v1/messages/count_tokens`,
      request(),
    );
    const body = await response.json();

    expect(containsPrivateValue(body)).toBe(false);
    expect(containsPrivateValue([...stderr.mock.calls, ...error.mock.calls])).toBe(false);
    expect(response.status).toBe(502);
    expect(body).toEqual({
      error: "Upstream request failed",
      detail: "upstream_transport_error",
    });
    expect(error).toHaveBeenCalledWith("pipeline.error", expect.objectContaining({
      stage: "AUX_FORWARD",
    }));
  });

  it("logs only a fixed category when credit reporting rejects", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const error = vi.spyOn(log, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ input_tokens: 7 })));
    tryReportCreditFromPath.mockRejectedValueOnce(
      new Error(PRIVATE_VALUE, { cause: PRIVATE_VALUE }),
    );
    const value = config();
    initAuth(value.auth);

    const response = await createApp(value).request(
      `http://proxy/claude-code/${PRIVATE_VALUE}/v1/messages/count_tokens`,
      request(),
    );

    expect(containsPrivateValue([...stderr.mock.calls, ...error.mock.calls])).toBe(false);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ input_tokens: 7 });
    expect(error).toHaveBeenCalledWith("aux.credit_report_failed", {
      category: "report_error",
      protocol: "anthropic",
    });
  });

  it("keeps request path and upstream URL out of stream diagnostics", async () => {
    const debug = vi.spyOn(log, "debug").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response("safe stream", {
      headers: { "content-type": "text/event-stream" },
    })));
    const value = config();
    initAuth(value.auth);

    const response = await createApp(value).request(
      `http://proxy/claude-code/${PRIVATE_VALUE}/v1/messages/count_tokens`,
      request(),
    );
    await response.text();

    expect(containsPrivateValue(debug.mock.calls)).toBe(false);
    expect(response.status).toBe(200);
    expect(debug).toHaveBeenCalledWith("aux.stream.passthrough", {
      protocol: "anthropic",
      upstreamConfigured: true,
    });
  });
});
