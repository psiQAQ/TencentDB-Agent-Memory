import { afterEach, expect, it } from "vitest";
import { resolveTaskDraftConfig } from "../routes/session-task.js";
import { taskDraftUrl } from "../mem-command/task-draft-generator.js";

afterEach(() => {
  delete process.env.MEMORY_LLM_API_KEY;
  delete process.env.MEMORY_LLM_BASE_URL;
  delete process.env.MEMORY_LLM_MODEL;
});

it("uses the selected Panel conversation model for Task drafts", () => {
  process.env.MEMORY_LLM_API_KEY = "obsolete-file-key";
  process.env.MEMORY_LLM_BASE_URL = "https://obsolete.example";
  process.env.MEMORY_LLM_MODEL = "obsolete-model";
  const result = resolveTaskDraftConfig({ model: "panel-model", upstreamUrl: "https://panel.example/v1",
    apiKey: "panel-key", protocol: "openai" });
  expect(result).toEqual({ cfg: expect.objectContaining({ model: "panel-model",
    url: "https://panel.example/v1", apiKey: "panel-key" }) });
});

it("fails when no Panel conversation model is selected", () => {
  expect(resolveTaskDraftConfig({})).toHaveProperty("error");
});

it("uses DeepSeek's protocol-specific endpoints for Task drafts", () => {
  expect(taskDraftUrl("https://api.deepseek.com/v1", "openai")).toBe("https://api.deepseek.com/chat/completions");
  expect(taskDraftUrl("https://api.deepseek.com/v1", "responses")).toBe("https://api.deepseek.com/responses");
  expect(taskDraftUrl("https://api.deepseek.com/v1", "anthropic")).toBe("https://api.deepseek.com/anthropic/v1/messages");
});
