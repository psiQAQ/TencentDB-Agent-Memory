import { describe, expect, it } from "vitest";
import { injectCodexAssets } from "../pipeline/runners/codex.js";
import { subscriptionResponsesRequest } from "../chatgpt-subscription.js";

describe("Codex asset injection", () => {
  it("retains memory instructions after leading native additional_tools items and subscription adaptation", () => {
    const body = {
      model: "account-model",
      input: [
        { type: "additional_tools", role: "developer", tools: [] },
        { type: "message", role: "developer", content: [{ type: "input_text", text: "client instructions" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "recall project decisions" }] },
      ],
    };
    const before = structuredClone(body);
    const result = injectCodexAssets(body, { raw: "<tdai_memory_tools>memory lookup</tdai_memory_tools>" });
    expect(result.input).toEqual([
      body.input[0],
      { ...body.input[1], content: [
        { type: "input_text", text: "client instructions" },
        { type: "input_text", text: expect.stringContaining("<tdai_memory_tools>memory lookup</tdai_memory_tools>") },
      ] },
      body.input[2],
    ]);
    expect(JSON.stringify(subscriptionResponsesRequest(result))).toContain("memory lookup");
    expect(body).toEqual(before);
  });

  it.each(["developer", "system"])("supports %s messages with optional type and string content", (role) => {
    const result = injectCodexAssets({ input: [{ role, content: "client instructions" }] }, { raw: "Agent instructions" });
    expect(result.input).toEqual([{ role, content: [
      { type: "input_text", text: "client instructions" },
      { type: "input_text", text: expect.stringContaining("Agent instructions") },
    ] }]);
  });

  it("adds a developer message without modifying user or tool result content", () => {
    const input = [
      { type: "additional_tools", role: "developer", tools: [] },
      { role: "user", content: "question" },
      { type: "function_call_output", call_id: "c1", output: "tool result" },
    ];
    const result = injectCodexAssets({ input }, { raw: "Agent instructions" });
    expect(result.input).toEqual([
      input[0],
      { type: "message", role: "developer", content: [{ type: "input_text", text: expect.stringContaining("Agent instructions") }] },
      ...input.slice(1),
    ]);
  });

  it("accepts string input without elevating the user's role", () => {
    const result = injectCodexAssets({ input: "question" }, { raw: "Agent instructions" });
    expect(result.input).toEqual([
      { type: "message", role: "developer", content: [{ type: "input_text", text: expect.stringContaining("Agent instructions") }] },
      { type: "message", role: "user", content: "question" },
    ]);
  });
});
