import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chatToResponses,
  guardSubscriptionStream,
  resolveSubscriptionToken,
  subscriptionEvents,
  subscriptionResponsesRequest,
  subscriptionToChat,
} from "../chatgpt-subscription.js";
import { DEFAULT_CONFIG } from "../config.js";
import { createApp } from "../server.js";
import { clearCache } from "../instance-upstream-cache.js";
import { initAuth } from "../auth.js";
import { initSystemUsers, _resetSystemUsersForTest } from "../systemUser.js";
import { __resetSessionStoreForTests } from "../session/store.js";
import {
  consumeCodexStream,
  type CodexTapContext,
} from "../pipeline/runners/codex.js";
import * as archiveStage from "../pipeline/stages/archive.js";
import { createPipeline } from "../logger.js";

type Json = Record<string, unknown>;
function sse(events: Json[], crlf = false, contentType = true): Response {
  const data = events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  const bytes = new TextEncoder().encode(
    crlf ? data.replaceAll("\n", "\r\n") : data,
  );
  // Deliberately split UTF-8 characters and SSE delimiters.
  let position = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (position === bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(
          bytes.slice(
            position,
            (position += Math.min(7, bytes.length - position)),
          ),
        );
      },
    }),
    { headers: contentType ? { "content-type": "text/event-stream" } : {} },
  );
}
const completed = {
  type: "response.completed",
  response: {
    id: "response-1",
    status: "completed",
    model: "account-model",
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: "合成数据完成" }],
      },
    ],
    usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 },
  },
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearCache();
  initAuth(DEFAULT_CONFIG.auth);
  _resetSystemUsersForTest();
  __resetSessionStoreForTests();
});
describe("ChatGPT Responses adaptation", () => {
  it("preserves history, tools and results while applying subscription request requirements", () => {
    const result = chatToResponses({
      model: "account-model",
      temperature: 1,
      max_tokens: 20,
      messages: [
        { role: "system", content: "instruction" },
        { role: "user", content: "question" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "lookup", arguments: '{"x":1}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call-1", content: "result" },
      ],
      tools: [
        {
          type: "function",
          function: { name: "lookup", parameters: { type: "object" } },
        },
      ],
      tool_choice: { type: "function", function: { name: "lookup" } },
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "answer",
          schema: { type: "object" },
          strict: true,
        },
      },
    });
    expect(result).toMatchObject({
      stream: true,
      store: false,
      model: "account-model",
      text: { format: { type: "json_schema", name: "answer" } },
    });
    expect(result).not.toHaveProperty("max_tokens");
    expect(result).not.toHaveProperty("temperature");
    expect(result.input).toEqual([
      { type: "message", role: "developer", content: "instruction" },
      { type: "message", role: "user", content: "question" },
      {
        type: "function_call",
        call_id: "call-1",
        name: "lookup",
        arguments: '{"x":1}',
        namespace: "memory_functions",
      },
      { type: "function_call_output", call_id: "call-1", output: "result" },
    ]);
    expect(result.tools).toMatchObject([
      {
        type: "namespace",
        name: "memory_functions",
        tools: [{ name: "lookup" }],
      },
    ]);
    expect(result.tool_choice).toBe("required");
    expect(result.parallel_tool_calls).toBe(false);
  });
  it("exposes only the forced namespace tool and rejects ambiguous selections", () => {
    const tools = [
      { type: "function", name: "lookup" },
      { type: "function", name: "other" },
      { type: "namespace", name: "extra", tools: [{ type: "custom", name: "lookup" }] },
    ];
    const request = { input: [], tools, tool_choice: { type: "function", name: "lookup" } };
    expect(subscriptionResponsesRequest(request)).toMatchObject({
      tools: [{ type: "namespace", name: "memory_functions", tools: [{ type: "function", name: "lookup" }] }],
      tool_choice: "required", parallel_tool_calls: false,
    });
    expect(() => subscriptionResponsesRequest({ ...request, tools: [
      ...tools, { type: "namespace", name: "ambiguous", tools: [{ type: "function", name: "lookup" }] },
    ] })).toThrow("CHATGPT_TOOL_CHOICE_NOT_AVAILABLE");
  });
  it.each([
    "image_generation",
    "mcp",
    "tool_search",
    "programmatic_tool_calling",
    "file_search",
  ])("rejects unsupported %s explicitly", (type) => {
    expect(() =>
      subscriptionResponsesRequest({ input: [], tools: [{ type }] }),
    ).toThrow("CHATGPT_UNSUPPORTED_TOOL");
  });
  it("accepts only a completed terminal event and handles UTF-8/CRLF boundaries", async () => {
    const events = [];
    for await (const event of subscriptionEvents(
      sse(
        [{ type: "response.output_text.delta", delta: "合成" }, completed],
        true,
      ).body!,
    ))
      events.push(event);
    expect(events[0].delta).toBe("合成");
    expect(events[1]).toEqual(completed);
    const chat = await subscriptionToChat(sse([completed]), false);
    expect(await chat.json()).toMatchObject({
      choices: [
        { message: { content: "合成数据完成" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
    });
  });
  it("validates completed SSE events when the upstream omits Content-Type", async () => {
    const chat = await subscriptionToChat(sse([completed], false, false), false);
    expect(await chat.json()).toMatchObject({
      choices: [{ message: { content: "合成数据完成" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
    });
  });
  it("retains completed output items when the terminal event omits its output snapshot", async () => {
    const terminal = { ...completed, response: { ...completed.response, output: [] } };
    const item = completed.response.output[0];
    const call = { type: "function_call", call_id: "call-1", name: "lookup", arguments: '{"x":1}' };
    const events = [
      { type: "response.output_item.done", output_index: 1, item: call },
      { type: "response.output_item.done", output_index: 0, item },
      terminal,
    ];
    const chat = await subscriptionToChat(sse(events, false, false), false);
    expect(await chat.json()).toMatchObject({
      choices: [{ message: { content: "合成数据完成", tool_calls: [{ id: "call-1", function: { name: "lookup", arguments: '{"x":1}' } }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
    });
    const normalized = [];
    for await (const event of subscriptionEvents(sse(events).body!)) normalized.push(event);
    expect(normalized.at(-1)).toMatchObject({ response: { output: [item, call] } });
    await expect(subscriptionToChat(sse(events.slice(0, -1)), false)).rejects.toThrow("CHATGPT_STREAM_INTERRUPTED");
  });
  it("uses the terminal output snapshot when one is present", async () => {
    const chat = await subscriptionToChat(sse([
      { type: "response.output_item.done", output_index: 0, item: { type: "message", content: [{ type: "output_text", text: "earlier snapshot" }] } },
      completed,
    ]), false);
    expect(await chat.json()).toMatchObject({ choices: [{ message: { content: "合成数据完成" } }] });
  });
  it("returns wrapped tool calls in the client's original namespace", async () => {
    const call = { type: "function_call", name: "lookup", namespace: "memory_functions", call_id: "call-1", arguments: "{}" };
    const events = [
      { type: "response.output_item.added", output_index: 0, item: call },
      { type: "response.output_item.done", output_index: 0, item: call },
      { ...completed, response: { ...completed.response, output: [] } },
    ];
    const normalized = [];
    const clientTools = [{ type: "function", name: "lookup" }];
    for await (const event of subscriptionEvents(guardSubscriptionStream(sse(events).body!, clientTools))) normalized.push(event);
    expect(normalized[0].item).not.toHaveProperty("namespace");
    expect(normalized[1].item).not.toHaveProperty("namespace");
    expect(normalized.at(-1)).toMatchObject({ response: { output: [{ type: "function_call", name: "lookup", call_id: "call-1" }] } });
    expect((normalized.at(-1)?.response as Json).output).toEqual([{ type: "function_call", name: "lookup", call_id: "call-1", arguments: "{}" }]);
    const originalNamespace = [{ type: "namespace", name: "memory_functions", tools: [{ type: "function", name: "lookup" }] }];
    const unchanged = await new Response(guardSubscriptionStream(sse(events).body!, originalNamespace)).text();
    expect(unchanged).toContain('"namespace":"memory_functions"');
  });
  it("rejects non-SSE data and incomplete events even without Content-Type", async () => {
    await expect(subscriptionToChat(
      new Response(new TextEncoder().encode(JSON.stringify(completed.response))), false,
    )).rejects.toThrow("CHATGPT_STREAM_INTERRUPTED");
    await expect(subscriptionToChat(sse([
      { type: "response.output_text.delta", delta: "partial" },
    ], false, false), false)).rejects.toThrow("CHATGPT_STREAM_INTERRUPTED");
    const wrongType = sse([completed]);
    wrongType.headers.set("content-type", "application/json");
    await expect(subscriptionToChat(wrongType, false)).rejects.toThrow("CHATGPT_SSE_REQUIRED");
  });
  it.each(["response.failed", "response.incomplete", "error"])(
    "rejects %s without fabricating completion",
    async (type) => {
      await expect(subscriptionToChat(sse([{ type }]), false)).rejects.toThrow(
        "CHATGPT_RESPONSE_FAILED",
      );
      const output = await new Response(
        guardSubscriptionStream(sse([{ type }]).body!),
      ).text();
      expect(output).toContain('"type":"error"');
      expect(output).not.toContain("response.completed");
    },
  );
  it("reports a dropped stream and subscription quota separately", async () => {
    await expect(
      subscriptionToChat(
        sse([{ type: "response.output_text.delta", delta: "partial" }]),
        false,
      ),
    ).rejects.toThrow("CHATGPT_STREAM_INTERRUPTED");
    await expect(
      subscriptionToChat(new Response(null, { status: 429 }), false),
    ).rejects.toMatchObject({ code: "CHATGPT_QUOTA_EXCEEDED", status: 429 });
    await expect(
      subscriptionToChat(new Response(null, { status: 401 }), false),
    ).rejects.toMatchObject({ code: "CHATGPT_REAUTH_REQUIRED", status: 401 });
  });
  it("streams function arguments, finish reason and usage only after completion", async () => {
    const response = await subscriptionToChat(
      sse([
        { type: "response.created", response: { id: "r", model: "m" } },
        { type: "response.in_progress", response: { id: "r" } },
        {
          type: "response.output_item.added",
          item: {
            type: "function_call",
            id: "item",
            call_id: "call-1",
            name: "lookup",
            arguments: "",
          },
        },
        {
          type: "response.function_call_arguments.delta",
          item_id: "item",
          delta: '{"x":1}',
        },
        completed,
      ]),
      true,
      true,
    );
    const output = await response.text();
    expect(output).toContain('"id":"call-1"');
    expect(output).toContain('"finish_reason":"tool_calls"');
    expect(output).toContain('"prompt_tokens":4');
    expect(output).toContain("data: [DONE]");
    const failure = await subscriptionToChat(
      sse([
        { type: "response.created", response: { id: "r" } },
        { type: "response.failed" },
      ]),
      true,
    );
    const text = await failure.text();
    expect(text).toContain("CHATGPT_RESPONSE_FAILED");
    expect(text).not.toContain("[DONE]");
  }, 2000);
});

function config() {
  const value = structuredClone(DEFAULT_CONFIG);
  value.auth = { enabled: false, url: "", timeoutMs: 1000 };
  value.coreSkill = {
    endpoint: "https://core.invalid",
    serviceToken: "synthetic-gateway",
    serviceId: "test",
    timeoutMs: 1000,
  };
  value.upstream = {
    url: "https://default.invalid",
    apiKey: "synthetic-api-billing",
    agents: {},
  };
  value.sessionInit.enabled = false;
  value.injection.enabled = false;
  value.costGuard.enabled = false;
  value.extraction = { enabled: false, extractors: [] };
  value.creditReport.url = "";
  value.log.backend = "noop";
  value.rateLimit = { tpm: 0, qpm: 0 };
  return value;
}
it.each([
  { extraction: false, contentType: true },
  { extraction: false, contentType: false },
  { extraction: true, contentType: true },
  { extraction: true, contentType: false },
])(
  "routes extraction=$extraction with upstream Content-Type=$contentType through Core credentials",
  async ({ extraction, contentType }) => {
    const value = config();
    if (extraction) {
      value.auth = {
        enabled: true,
        url: "https://auth.invalid",
        timeoutMs: 1000,
      };
      initSystemUsers([
        { name: "memory", userId: "system-test", displayName: "Synthetic" },
      ]);
    }
    initAuth(value.auth);
    const calls: Array<{ url: string; headers: Headers; body: Json }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        const target = String(url);
        const headers = new Headers(init?.headers);
        const body = JSON.parse(
          init?.body instanceof ArrayBuffer
            ? new TextDecoder().decode(init.body)
            : String(init?.body ?? "{}"),
        );
        calls.push({ url: target, headers, body });
        if (target.endsWith("auth/verify"))
          return Response.json({
            code: 0,
            data: { valid: true, user: { user_id: "system-test" } },
          });
        if (target.endsWith("instance-upstream/list"))
          return Response.json({
            code: 0,
            data: {
              items: [
                {
                  group_id: "subscription",
                  group_type: extraction ? "extraction" : "custom",
                  agents: extraction ? [] : ["codex"],
                  enabled: true,
                  mode: "custom_unified",
                  base_url: "https://api.openai.com/v1",
                  model_id: "account-model",
                  api_key: "",
                  credential_kind: "chatgpt_oauth",
                  credential_ref: "connection",
                },
              ],
            },
          });
        if (target.endsWith("chatgpt/resolve"))
          return Response.json({
            code: 0,
            data: { access_token: "synthetic-oauth" },
          });
        expect(target).toBe("https://api.openai.com/v1/responses");
        return sse([completed], false, contentType);
      }),
    );
    const result = await createApp(value).request(
      `http://proxy/${extraction ? "codebuddy" : "codex"}/test/v1/${extraction ? "chat/completions" : "responses"}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer synthetic-client",
          "x-api-key": "synthetic-client",
          "x-session-id": "synthetic-session",
        },
        body: JSON.stringify(
          extraction
            ? {
                model: "requested",
                messages: [{ role: "user", content: "synthetic" }],
                stream: false,
              }
            : {
                model: "requested",
                input: [{ role: "user", content: "synthetic" }],
              },
        ),
      },
    );
    const output = await result.text();
    expect(
      result.status,
      `${output} ${calls.map((c) => c.url).join(",")}`,
    ).toBe(200);
    expect(result.headers.get("content-type")).toContain(
      extraction ? "application/json" : "text/event-stream",
    );
    expect(output).toContain(
      extraction ? "chat.completion" : "response.completed",
    );
    const forwarded = calls.find(
      (c) => c.url === "https://api.openai.com/v1/responses",
    )!;
    expect(forwarded.headers.get("authorization")).toBe(
      "Bearer synthetic-oauth",
    );
    expect(forwarded.headers.has("x-api-key")).toBe(false);
    expect(forwarded.body).toMatchObject({
      model: "account-model",
      stream: true,
      store: false,
    });
    expect(JSON.stringify([...forwarded.headers])).not.toMatch(
      /synthetic-(gateway|client|api-billing)/,
    );
  },
);
it("does not fall back when the selected subscription cannot be resolved", async () => {
  const fetcher = vi.fn(async () =>
    Response.json(
      { code: 401, message: "CHATGPT_REAUTH_REQUIRED" },
      { status: 401 },
    ),
  );
  vi.stubGlobal("fetch", fetcher);
  await expect(
    resolveSubscriptionToken(config().coreSkill, "test", {
      group_id: "g",
      model_id: "m",
    }),
  ).rejects.toMatchObject({ code: "CHATGPT_REAUTH_REQUIRED" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("archives a subscription turn only after response.completed", async () => {
  const archive = vi
    .spyOn(archiveStage, "stageArchive")
    .mockResolvedValue(undefined);
  const value = config();
  const pipe = createPipeline(value, "synthetic-request", "account-model");
  const error = vi.spyOn(pipe, "error");
  const context: CodexTapContext = {
    requireCompleted: true,
    lf: null,
    modelId: "account-model",
    startTime: new Date().toISOString(),
    upstreamUrl: "https://api.openai.com/v1",
    inputBody: { input: [] },
    pipe,
    archiveCtx: {
      config: value,
      sessionKey: "synthetic-session",
      agentSource: "codex",
      sessionInfo: {},
      spaceId: "synthetic",
      input: [{ role: "user", content: "synthetic" }],
      tdaiClient: null,
      tdaiIdentity: null,
      tdaiUserMessage: null,
    },
  };
  consumeCodexStream(
    guardSubscriptionStream(
      sse([{ type: "response.output_text.delta", delta: "partial" }]).body!,
    ),
    context,
  );
  await vi.waitFor(() =>
    expect(error).toHaveBeenCalledWith(
      "CHATGPT_STREAM_INTERRUPTED",
      expect.any(String),
    ),
  );
  expect(archive).not.toHaveBeenCalled();
  consumeCodexStream(guardSubscriptionStream(sse([completed]).body!), context);
  await vi.waitFor(() => expect(archive).toHaveBeenCalledTimes(1));
  expect(archive.mock.calls[0][0]).toMatchObject({
    protocol: "responses",
    assistant: { text: "合成数据完成" },
  });
});
