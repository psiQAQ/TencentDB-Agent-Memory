import type { CoreSkillConfig } from "./types.js";

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  !!value && typeof value === "object" && !Array.isArray(value);
export class SubscriptionError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 401 | 403 | 409 | 429 | 502 | 503 = 502,
  ) {
    super(code);
  }
}
export async function resolveSubscriptionToken(
  config: Pick<CoreSkillConfig, "endpoint" | "serviceToken" | "timeoutMs">,
  instanceId: string,
  input: { group_id?: string; credential_ref?: string; model_id: string },
): Promise<string> {
  try {
    const response = await fetch(
      `${config.endpoint.replace(/\/$/, "")}/v3/internal/meta/model-connections/chatgpt/resolve`,
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(45_000),
        headers: {
          authorization: `Bearer ${config.serviceToken}`,
          "x-tdai-service-id": instanceId,
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
      },
    );
    const body = (await response.json()) as Json;
    if (!response.ok || body.code !== 0) {
      const allowed = [
        "CHATGPT_REAUTH_REQUIRED",
        "CHATGPT_MODEL_NOT_AVAILABLE",
        "MODEL_CONNECTION_BUSY",
        "MODEL_CREDENTIALS_CHANGED",
        "CHATGPT_PLAN_PERMISSION_REQUIRED",
      ];
      const code =
        typeof body.message === "string" && allowed.includes(body.message)
          ? body.message
          : "CHATGPT_CONNECTION_UNAVAILABLE";
      throw new SubscriptionError(
        code,
        response.status === 401 ? 401 : response.status === 403 ? 403 : 503,
      );
    }
    if (
      !isObject(body.data) ||
      typeof body.data.access_token !== "string" ||
      !body.data.access_token
    )
      throw new SubscriptionError("CHATGPT_CONNECTION_UNAVAILABLE", 503);
    return body.data.access_token;
  } catch (error) {
    if (error instanceof SubscriptionError) throw error;
    throw new SubscriptionError("CHATGPT_CONNECTION_UNAVAILABLE", 503);
  }
}

const OMIT = new Set([
  "background",
  "conversation",
  "max_output_tokens",
  "max_tool_calls",
  "metadata",
  "moderation",
  "multi_agent",
  "prompt",
  "prompt_cache_retention",
  "safety_identifier",
  "temperature",
  "top_logprobs",
  "top_p",
  "truncation",
  "user",
  "previous_response_id",
]);
const UNSUPPORTED_TOOLS = new Set([
  "image_generation",
  "file_search",
  "code_interpreter",
  "computer",
  "computer_use_preview",
  "mcp",
  "tool_search",
  "programmatic_tool_calling",
]);
export function subscriptionResponsesRequest(body: Json): Json {
  const result = Object.fromEntries(
    Object.entries(body).filter(([key]) => !OMIT.has(key)),
  );
  result.stream = true;
  result.store = false;
  const input =
    typeof body.input === "string"
      ? [{ role: "user", content: body.input }]
      : body.input;
  if (!Array.isArray(input))
    throw new SubscriptionError("CHATGPT_INPUT_ARRAY_REQUIRED", 400);
  result.input = input.map((item) => {
    if (!isObject(item))
      throw new SubscriptionError("CHATGPT_INVALID_INPUT", 400);
    if (item.role === "system") return { ...item, role: "developer" };
    return item;
  });
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools))
      throw new SubscriptionError("CHATGPT_INVALID_TOOLS", 400);
    const flat: Json[] = [];
    const kept: Json[] = [];
    for (const tool of body.tools) {
      if (
        !isObject(tool) ||
        typeof tool.type !== "string" ||
        UNSUPPORTED_TOOLS.has(tool.type)
      )
        throw new SubscriptionError("CHATGPT_UNSUPPORTED_TOOL", 400);
      if (tool.type === "function" || tool.type === "custom") flat.push(tool);
      else if (tool.type === "namespace") {
        if (
          !Array.isArray(tool.tools) ||
          tool.tools.some(
            (child) =>
              !isObject(child) ||
              !["function", "custom"].includes(String(child.type)),
          )
        )
          throw new SubscriptionError("CHATGPT_UNSUPPORTED_TOOL", 400);
        kept.push(tool);
      } else if (["web_search", "web_search_preview"].includes(tool.type))
        kept.push(tool);
      else throw new SubscriptionError("CHATGPT_UNSUPPORTED_TOOL", 400);
    }
    if (flat.length) {
      const namespace = "memory_functions";
      if (kept.some((tool) => tool.name === namespace))
        throw new SubscriptionError("CHATGPT_TOOL_NAMESPACE_CONFLICT", 400);
      kept.push({
        type: "namespace",
        name: namespace,
        description: "Client-executed tools",
        tools: flat,
      });
      result.input = (result.input as Json[]).map((item) =>
        ["function_call", "custom_tool_call"].includes(String(item.type)) &&
        !item.namespace &&
        flat.some((tool) => tool.name === item.name)
          ? { ...item, namespace }
          : item,
      );
    }
    result.tools = kept;
    const choice = body.tool_choice;
    if (isObject(choice) && ["function", "custom"].includes(String(choice.type))) {
      const selected = kept.flatMap((tool) => {
        if (tool.type !== "namespace" || !Array.isArray(tool.tools)) return [];
        const tools = tool.tools.filter((child) => isObject(child) &&
          child.type === choice.type && child.name === choice.name);
        return tools.length ? [{ ...tool, tools }] : [];
      });
      if (selected.reduce((count, tool) => count + tool.tools.length, 0) !== 1)
        throw new SubscriptionError("CHATGPT_TOOL_CHOICE_NOT_AVAILABLE", 400);
      // The public route cannot select a namespace child by name. Expose only the
      // requested tool and require one call, preserving forced-choice semantics.
      result.tools = selected;
      result.tool_choice = "required";
      result.parallel_tool_calls = false;
    }
  }
  return result;
}

export function chatToResponses(body: Json): Json {
  if (!Array.isArray(body.messages) || (body.n !== undefined && body.n !== 1))
    throw new SubscriptionError("CHATGPT_UNSUPPORTED_CHAT_REQUEST", 400);
  const input: Json[] = [];
  for (const message of body.messages) {
    if (!isObject(message))
      throw new SubscriptionError("CHATGPT_INVALID_MESSAGE", 400);
    const role = message.role === "system" ? "developer" : message.role;
    if (role === "tool") {
      if (typeof message.tool_call_id !== "string")
        throw new SubscriptionError("CHATGPT_INVALID_TOOL_RESULT", 400);
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id,
        output:
          typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content),
      });
      continue;
    }
    if (!["user", "assistant", "developer"].includes(String(role)))
      throw new SubscriptionError("CHATGPT_UNSUPPORTED_MESSAGE_ROLE", 400);
    if (message.content !== null && message.content !== undefined) {
      const content =
        typeof message.content === "string"
          ? message.content
          : Array.isArray(message.content)
            ? message.content.map((part) => {
                if (!isObject(part))
                  throw new SubscriptionError(
                    "CHATGPT_UNSUPPORTED_CONTENT",
                    400,
                  );
                if (part.type === "text")
                  return { type: role === "assistant" ? "output_text" : "input_text", text: part.text };
                if (part.type === "image_url" && isObject(part.image_url))
                  return {
                    type: "input_image",
                    image_url: part.image_url.url,
                    detail: part.image_url.detail ?? "auto",
                  };
                throw new SubscriptionError("CHATGPT_UNSUPPORTED_CONTENT", 400);
              })
            : null;
      if (content === null)
        throw new SubscriptionError("CHATGPT_UNSUPPORTED_CONTENT", 400);
      input.push({ type: "message", role, content });
    }
    if (Array.isArray(message.tool_calls))
      for (const call of message.tool_calls) {
        if (
          !isObject(call) ||
          call.type !== "function" ||
          !isObject(call.function)
        )
          throw new SubscriptionError("CHATGPT_UNSUPPORTED_TOOL", 400);
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        });
      }
  }
  const result: Json = { model: body.model, input };
  if (Array.isArray(body.tools))
    result.tools = body.tools.map((tool) => {
      if (
        !isObject(tool) ||
        tool.type !== "function" ||
        !isObject(tool.function)
      )
        throw new SubscriptionError("CHATGPT_UNSUPPORTED_TOOL", 400);
      return { type: "function", ...tool.function };
    });
  if (body.tool_choice !== undefined)
    result.tool_choice =
      isObject(body.tool_choice) && isObject(body.tool_choice.function)
        ? { type: "function", name: body.tool_choice.function.name }
        : body.tool_choice;
  if (body.parallel_tool_calls !== undefined)
    result.parallel_tool_calls = body.parallel_tool_calls;
  if (typeof body.reasoning_effort === "string")
    result.reasoning = { effort: body.reasoning_effort };
  if (isObject(body.response_format)) {
    result.text = {
      format:
        body.response_format.type === "json_schema" &&
        isObject(body.response_format.json_schema)
          ? { type: "json_schema", ...body.response_format.json_schema }
          : body.response_format,
    };
  }
  return subscriptionResponsesRequest(result);
}

/** Decode SSE frames across arbitrary UTF-8/chunk/CRLF boundaries, with a bounded event size. */
export async function* subscriptionEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Json> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  const outputItems = new Map<number, { item: Json; size: number }>();
  let outputSize = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        if (frame.length > 2 * 1024 * 1024)
          throw new SubscriptionError("CHATGPT_EVENT_TOO_LARGE");
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data || data === "[DONE]") continue;
        let event: unknown;
        try {
          event = JSON.parse(data);
        } catch {
          throw new SubscriptionError("CHATGPT_INVALID_EVENT");
        }
        if (!isObject(event))
          throw new SubscriptionError("CHATGPT_INVALID_EVENT");
        if (
          ["response.failed", "response.incomplete", "error"].includes(
            String(event.type),
          )
        ) {
          const error = isObject(event.error)
            ? event.error
            : isObject(event.response) && isObject(event.response.error)
              ? event.response.error
              : {};
          const code = String(error.code ?? event.code ?? "");
          throw new SubscriptionError(
            /quota|rate_limit|usage_limit/.test(code)
              ? "CHATGPT_QUOTA_EXCEEDED"
              : /auth|token/.test(code)
                ? "CHATGPT_REAUTH_REQUIRED"
                : "CHATGPT_RESPONSE_FAILED",
            /quota|rate_limit|usage_limit/.test(code) ? 429 : 502,
          );
        }
        if (event.type === "response.output_item.done") {
          const index = event.output_index;
          if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || !isObject(event.item))
            throw new SubscriptionError("CHATGPT_INVALID_EVENT");
          const size = JSON.stringify(event.item).length;
          outputSize += size - (outputItems.get(index)?.size ?? 0);
          if (outputSize > 2 * 1024 * 1024)
            throw new SubscriptionError("CHATGPT_EVENT_TOO_LARGE");
          outputItems.set(index, { item: event.item, size });
        }
        if (event.type === "response.completed") {
          if (
            !isObject(event.response) ||
            event.response.status !== "completed"
          )
            throw new SubscriptionError("CHATGPT_RESPONSE_FAILED");
          // Some subscription streams carry complete items only in output_item.done.
          if (outputItems.size && (event.response.output === undefined ||
              (Array.isArray(event.response.output) && event.response.output.length === 0))) {
            event.response.output = [...outputItems.entries()]
              .sort(([left], [right]) => left - right)
              .map(([, value]) => value.item);
          }
          completed = true;
        }
        yield event;
        if (completed) return;
      }
      if (buffer.length > 2 * 1024 * 1024)
        throw new SubscriptionError("CHATGPT_EVENT_TOO_LARGE");
      if (done) break;
    }
    throw new SubscriptionError("CHATGPT_STREAM_INTERRUPTED");
  } catch (error) {
    if (error instanceof SubscriptionError) throw error;
    throw new SubscriptionError("CHATGPT_STREAM_INTERRUPTED");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

const encode = (value: unknown, event?: string) =>
  new TextEncoder().encode(
    `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(value)}\n\n`,
  );
export function guardSubscriptionStream(
  body: ReadableStream<Uint8Array>,
  clientTools?: unknown,
): ReadableStream<Uint8Array> {
  const events = subscriptionEvents(body);
  const wrappedNames = new Set(Array.isArray(clientTools) ? clientTools
    .filter((tool) => isObject(tool) && ["function", "custom"].includes(String(tool.type)))
    .map((tool) => tool.name) : []);
  const restoreTool = (item: unknown): unknown => {
    if (!isObject(item) || item.namespace !== "memory_functions" ||
        !["function_call", "custom_tool_call"].includes(String(item.type)) || !wrappedNames.has(item.name)) return item;
    const { namespace: _namespace, ...original } = item;
    return original;
  };
  return new ReadableStream({
    async pull(controller) {
      try {
        const next = await events.next();
        if (next.done) controller.close();
        else {
          let event = next.value;
          if (event.item) event = { ...event, item: restoreTool(event.item) };
          if (isObject(event.response) && Array.isArray(event.response.output)) {
            event = { ...event, response: { ...event.response, output: event.response.output.map(restoreTool) } };
          }
          controller.enqueue(encode(event, String(event.type)));
        }
      } catch (error) {
        const code =
          error instanceof SubscriptionError
            ? error.code
            : "CHATGPT_STREAM_INTERRUPTED";
        controller.enqueue(
          encode({ type: "error", code, message: code }, "error"),
        );
        controller.close();
      }
    },
    async cancel() {
      await events.return(undefined);
    },
  });
}
function chatUsage(usage: unknown) {
  const value = isObject(usage) ? usage : {};
  return {
    prompt_tokens: value.input_tokens ?? 0,
    completion_tokens: value.output_tokens ?? 0,
    total_tokens: value.total_tokens ?? 0,
    prompt_tokens_details: value.input_tokens_details,
    completion_tokens_details: value.output_tokens_details,
  };
}
export function responseToChat(response: Json): Json {
  const output = Array.isArray(response.output)
    ? response.output.filter(isObject)
    : [];
  const text = output
    .filter((item) => item.type === "message")
    .flatMap((item) =>
      Array.isArray(item.content) ? item.content.filter(isObject) : [],
    )
    .filter((part) => part.type === "output_text")
    .map((part) => part.text ?? "")
    .join("");
  const calls = output
    .filter((item) => item.type === "function_call")
    .map((item) => ({
      id: item.call_id,
      type: "function",
      function: { name: item.name, arguments: item.arguments },
    }));
  return {
    id: response.id,
    object: "chat.completion",
    created: response.created_at ?? Math.floor(Date.now() / 1000),
    model: response.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text || null,
          ...(calls.length ? { tool_calls: calls } : {}),
        },
        finish_reason: calls.length ? "tool_calls" : "stop",
      },
    ],
    usage: chatUsage(response.usage),
  };
}
/** Kept in-process so an SSE error/EOF cannot be mistaken for successful archival. */
export interface SubscriptionStreamState {
  completed: boolean;
  error?: string;
}
export async function subscriptionToChat(
  response: Response,
  stream: boolean,
  includeUsage = false,
  state?: SubscriptionStreamState,
): Promise<Response> {
  assertSubscriptionResponse(response);
  const events = subscriptionEvents(response.body!);
  const headers = {
    "content-type": stream ? "text/event-stream" : "application/json",
    "cache-control": "no-store",
    ...(response.headers.has("x-request-id") ? { "x-request-id": response.headers.get("x-request-id")! } : {}),
  };
  if (!stream) {
    for await (const event of events)
      if (event.type === "response.completed") {
        if (state) state.completed = true;
        return Response.json(responseToChat(event.response as Json), {
          headers,
        });
      }
    throw new SubscriptionError("CHATGPT_STREAM_INTERRUPTED");
  }
  let id = "";
  let model = "";
  let toolCount = 0;
  let text = "";
  const tools = new Map<string, { index: number; arguments: string }>();
  const itemCalls = new Map<string, string>();
  const chunk = (delta: Json, finish: string | null = null) => ({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        let emitted = false;
        const emit = (value: Uint8Array) => {
          emitted = true;
          controller.enqueue(value);
        };
        const toolItem = (item: Json) => {
          const callId = String(item.call_id ?? "");
          if (!callId || typeof item.name !== "string") throw new SubscriptionError("CHATGPT_INVALID_TOOL_EVENT");
          if (typeof item.id === "string") itemCalls.set(item.id, callId);
          let tool = tools.get(callId);
          if (!tool) {
            tool = { index: toolCount++, arguments: "" };
            tools.set(callId, tool);
            emit(encode(chunk({ tool_calls: [{ index: tool.index, id: callId, type: "function",
              function: { name: item.name, arguments: "" } }] })));
          }
          if (typeof item.arguments === "string" && item.arguments) {
            if (!item.arguments.startsWith(tool.arguments)) throw new SubscriptionError("CHATGPT_INVALID_TOOL_EVENT");
            const delta = item.arguments.slice(tool.arguments.length);
            tool.arguments = item.arguments;
            if (delta) emit(encode(chunk({ tool_calls: [{ index: tool.index, function: { arguments: delta } }] })));
          }
        };
        while (!emitted) {
          const next = await events.next();
          if (next.done) {
            controller.close();
            return;
          }
          const event = next.value;
          if (event.type === "response.created" && isObject(event.response)) {
            id = String(event.response.id ?? "");
            model = String(event.response.model ?? "");
            emit(encode(chunk({ role: "assistant", content: "" })));
          }
          if (event.type === "response.output_text.delta") {
            if (typeof event.delta !== "string") throw new SubscriptionError("CHATGPT_INVALID_EVENT");
            text += event.delta;
            emit(encode(chunk({ content: event.delta })));
          }
          if (
            ["response.output_item.added", "response.output_item.done"].includes(String(event.type)) &&
            isObject(event.item) &&
            event.item.type === "function_call"
          ) {
            toolItem(event.item);
          }
          if (event.type === "response.function_call_arguments.delta") {
            const tool = tools.get(itemCalls.get(String(event.item_id)) ?? "");
            if (!tool || typeof event.delta !== "string")
              throw new SubscriptionError("CHATGPT_INVALID_TOOL_EVENT");
            tool.arguments += event.delta;
            emit(
              encode(
                chunk({
                  tool_calls: [{ index: tool.index, function: { arguments: event.delta } }],
                }),
              ),
            );
          }
          if (event.type === "response.completed") {
            const terminal = event.response as Json;
            id ||= String(terminal.id ?? "");
            model ||= String(terminal.model ?? "");
            // Some streams contain the final text/tool arguments only in done items.
            const final = responseToChat(terminal);
            const message = ((final.choices as Json[])[0].message as Json);
            if (typeof message.content === "string") {
              if (!message.content.startsWith(text)) throw new SubscriptionError("CHATGPT_INVALID_EVENT");
              const delta = message.content.slice(text.length);
              if (delta) emit(encode(chunk({ content: delta })));
            }
            for (const item of Array.isArray(terminal.output) ? terminal.output : []) {
              if (isObject(item) && item.type === "function_call") toolItem(item);
            }
            if (state) state.completed = true;
            controller.enqueue(
              encode(chunk({}, toolCount ? "tool_calls" : "stop")),
            );
            if (includeUsage && isObject(event.response))
              controller.enqueue(
                encode({
                  ...chunk({}),
                  choices: [],
                  usage: chatUsage(event.response.usage),
                }),
              );
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            await events.return(undefined);
            controller.close();
            return;
          }
        }
      } catch (error) {
        const code =
          error instanceof SubscriptionError
            ? error.code
            : "CHATGPT_STREAM_INTERRUPTED";
        if (state) state.error = code;
        controller.enqueue(
          encode({
            error: { type: "subscription_error", code, message: code },
          }),
        );
        controller.close();
      }
    },
    async cancel() {
      await events.return(undefined);
    },
  });
  return new Response(body, { headers });
}
export function assertSubscriptionResponse(response: Response): void {
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new SubscriptionError(
      response.status === 401
        ? "CHATGPT_REAUTH_REQUIRED"
        : response.status === 403
          ? "CHATGPT_PERMISSION_DENIED"
          : response.status === 429
            ? "CHATGPT_QUOTA_EXCEEDED"
            : "CHATGPT_UPSTREAM_UNAVAILABLE",
      response.status === 401
        ? 401
        : response.status === 403
          ? 403
          : response.status === 429
            ? 429
            : 502,
    );
  }
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  // Missing media metadata is validated by subscriptionEvents; a declared different format is rejected.
  if (!response.body || (mediaType && mediaType !== "text/event-stream")) {
    void response.body?.cancel().catch(() => {});
    throw new SubscriptionError("CHATGPT_SSE_REQUIRED");
  }
}

/** Validate events and present a consistent SSE response to clients and archive taps. */
export function guardSubscriptionResponse(response: Response, clientTools?: unknown): Response {
  assertSubscriptionResponse(response);
  const headers = new Headers(response.headers);
  headers.set("content-type", "text/event-stream");
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(guardSubscriptionStream(response.body!, clientTools), {
    status: response.status,
    headers,
  });
}
