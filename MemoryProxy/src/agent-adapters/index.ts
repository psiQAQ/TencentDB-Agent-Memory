/**
 * Agent Adapter 工厂。
 *
 * 根据 URL 前缀映射来的 `agentSource` 返回对应的适配器；未识别的客户端返回
 * default adapter（等价现状的保守行为）。
 *
 * 各点详见：
 *   - types.ts —— AgentAdapter 接口 + 三个适配点的说明
 *   - claude-code.ts —— CC 特化实现（当前唯一有源码/抓包依据的客户端）
 *   - codebuddy.ts —— CB stub（沿用 default 行为，等抓包再补 CB 特化）
 *   - default.ts —— unknown 兜底
 */

import type { AgentAdapter } from "./types.js";
import { claudeCodeAdapter } from "./claude-code.js";
import { codebuddyAdapter } from "./codebuddy.js";
import { defaultAdapter, opencodeAdapter, piAdapter } from "./default.js";
import {
  ANTHROPIC_MESSAGE_SOURCES,
  extractAgentSourceFromPath,
} from "./anthropic-platform.js";

export type { AgentAdapter, AgentKind, RequestKind } from "./types.js";

/** Public agent-prefixed OpenAI compatibility routes. */
export const OPENAI_PLATFORM_SOURCES = ["codebuddy", "hermes", "openclaw"] as const;
export type OpenAIPlatformSource = (typeof OPENAI_PLATFORM_SOURCES)[number];

/**
 * All OpenAI identities used internally by handlers and bridge tools. `openai`
 * is reserved for source-less `/v1/*` and `/proxy/<space>/v1/*` compatibility;
 * it is not accepted as an arbitrary caller-selected path prefix.
 */
export const OPENAI_CHAT_SOURCES = [...OPENAI_PLATFORM_SOURCES, "openai"] as const;
export type OpenAIChatSource = (typeof OPENAI_CHAT_SOURCES)[number];

/** Product platforms with an explicit adapter and protocol route binding. */
export const REGISTERED_AGENT_SOURCES = [
  ...ANTHROPIC_MESSAGE_SOURCES,
  ...OPENAI_CHAT_SOURCES,
] as const;

export function isRegisteredAgentSource(value: string): boolean {
  return (REGISTERED_AGENT_SOURCES as readonly string[]).includes(value);
}

export function isOpenAIChatSource(value: string): value is OpenAIChatSource {
  return (OPENAI_CHAT_SOURCES as readonly string[]).includes(value);
}

export function isOpenAIPlatformSource(value: string): value is OpenAIPlatformSource {
  return (OPENAI_PLATFORM_SOURCES as readonly string[]).includes(value);
}

export function getOpenAISourceBindingError(
  path: string,
  boundSource?: OpenAIChatSource,
): "unbound" | "conflict" | null {
  if (!boundSource) return "unbound";
  const pathSource = extractAgentSourceFromPath(path);
  return pathSource && pathSource !== boundSource ? "conflict" : null;
}

export function resolveAgentAdapter(agentSource: string): AgentAdapter {
  switch (agentSource) {
    case "claude-code":
      return claudeCodeAdapter;
    case "opencode":
      return opencodeAdapter;
    case "pi":
      return piAdapter;
    case "codebuddy":
      return codebuddyAdapter;
    default:
      return defaultAdapter;
  }
}
