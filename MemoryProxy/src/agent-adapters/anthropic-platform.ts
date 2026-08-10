/** Anthropic Messages platforms with explicit proxy route bindings. */
export const ANTHROPIC_MESSAGE_SOURCES = ["claude-code", "opencode", "pi"] as const;

export type AnthropicMessageSource = (typeof ANTHROPIC_MESSAGE_SOURCES)[number];

export function isAnthropicMessageSource(value: string): value is AnthropicMessageSource {
  return (ANTHROPIC_MESSAGE_SOURCES as readonly string[]).includes(value);
}

/** Return the platform-looking first path segment, if the path has one. */
export function extractAgentSourceFromPath(path: string): string | null {
  const first = path.split("?", 1)[0]?.split("/").filter(Boolean)[0] ?? "";
  return first && !["v1", "proxy", "skill-bridge", "memory-bridge"].includes(first)
    ? first
    : null;
}

/** Session IDs are opaque ASCII tokens, never storage paths or log text. */
export function isValidSessionId(value: string): boolean {
  return value.length <= 256 && !value.includes("..") && /^[A-Za-z0-9._:-]+$/.test(value);
}
