import { afterEach, describe, expect, it, vi } from "vitest";

import { initAuth } from "../auth.js";
import { DEFAULT_CONFIG } from "../config.js";
import { createApp } from "../server.js";

const PRIVATE_VALUE = "private-active-handler-value";

function containsPrivateValue(value: unknown): boolean {
  return JSON.stringify(value).includes(PRIVATE_VALUE);
}

afterEach(() => {
  initAuth(DEFAULT_CONFIG.auth);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("active handler diagnostics privacy", () => {
  it("keeps OpenAI request-tail diagnostics and outbound summaries private", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("PROXY_DEBUG_DUMP_OUTBOUND_MD5", "1");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      id: "chatcmpl-safe",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })));
    const config = structuredClone(DEFAULT_CONFIG);
    config.upstream.url = "https://upstream.invalid/v1";
    config.upstream.apiKey = "server-key";
    config.sessionInit.enabled = true;
    config.injection.enabled = false;
    config.rateLimit = { tpm: 0, qpm: 0 };
    config.extraction = { enabled: false, extractors: [] };
    config.creditReport.url = "";
    config.log.backend = "noop";
    initAuth(config.auth);
    const app = createApp(config);

    const response = await app.request("http://proxy/codebuddy/space-1/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer memory-user-key" },
      body: JSON.stringify({
        model: "test-model",
        messages: [
          { role: "system", content: PRIVATE_VALUE },
          { role: "assistant", content: "ok" },
          { role: "user", content: PRIVATE_VALUE, tool_call_id: PRIVATE_VALUE },
        ],
      }),
    });
    const calls = [...consoleLog.mock.calls, ...consoleWarn.mock.calls, ...consoleError.mock.calls];

    expect(response.status).toBe(200);
    expect.soft(containsPrivateValue(calls)).toBe(false);
    expect(JSON.stringify(calls).includes("Md5=")).toBe(false);
  });

  it("keeps Anthropic source/config diagnostics and outbound summaries private", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("PROXY_DEBUG_DUMP_OUTBOUND_MD5", "1");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      id: "msg-safe",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      model: "test-model",
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    })));
    const config = structuredClone(DEFAULT_CONFIG);
    config.upstream.url = "https://upstream.invalid/anthropic/v1";
    config.upstream.apiKey = "server-key";
    config.upstream.agents.opencode = {
      url: "https://upstream.invalid/anthropic/v1",
      apiKey: "server-key",
    };
    config.sessionInit.enabled = false;
    config.injection.enabled = false;
    config.injection.injectors = [PRIVATE_VALUE as never];
    config.rateLimit = { tpm: 0, qpm: 0 };
    config.extraction = { enabled: false, extractors: [] };
    config.creditReport.url = "";
    config.log.backend = "noop";
    initAuth(config.auth);
    const app = createApp(config);

    const response = await app.request(`http://proxy/opencode/${PRIVATE_VALUE}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "memory-user-key",
        "x-session-id": "ses_safe",
      },
      body: JSON.stringify({
        model: "test-model",
        max_tokens: 16,
        system: PRIVATE_VALUE,
        messages: [{ role: "user", content: PRIVATE_VALUE }],
      }),
    });
    const calls = [...consoleLog.mock.calls, ...consoleWarn.mock.calls, ...consoleError.mock.calls];

    expect(response.status).toBe(200);
    expect.soft(containsPrivateValue(calls)).toBe(false);
    expect(JSON.stringify(calls).includes("Md5=")).toBe(false);
  });
});
