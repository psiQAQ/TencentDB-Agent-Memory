const REDACTED = "[redacted]";
const SAFE_TAGS = new Set([
  "error",
  "internal",
  "non-stream",
  "request_log",
  "retry",
  "stream",
]);
const SAFE_USAGE_KEYS = new Set([
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
  "cache_read_tokens",
  "completion_tokens",
  "credit",
  "input_tokens",
  "output_tokens",
  "prompt_cache_hit_tokens",
  "prompt_cache_miss_tokens",
  "prompt_cache_write_tokens",
  "prompt_tokens",
  "total_tokens",
]);

export function privacySafeSessionId(value: string | undefined): string {
  return value ? REDACTED : "";
}

export function privacySafeText(value: string | undefined): string {
  return value ? REDACTED : "";
}

export function summarizeTelemetryValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string") return { type: "text", length: value.length };
  if (Array.isArray(value)) return { type: "array", itemCount: value.length };
  if (typeof value === "object") {
    return { type: "object", fieldCount: Object.keys(value).length };
  }
  return { type: typeof value };
}

export function privacySafeMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const values = Object.values(metadata);
  return {
    field_count: values.length,
    numeric_count: values.filter((value) => typeof value === "number" && Number.isFinite(value)).length,
    boolean_count: values.filter((value) => typeof value === "boolean").length,
    string_count: values.filter((value) => typeof value === "string").length,
    collection_count: values.filter((value) => Array.isArray(value)).length,
    object_count: values.filter(
      (value) => value !== null && typeof value === "object" && !Array.isArray(value),
    ).length,
  };
}

export function privacySafeTags(tags: string[] | undefined): string[] | undefined {
  if (!tags) return undefined;
  return tags.map((tag) => {
    if (SAFE_TAGS.has(tag)) return tag;
    if (/^protocol:(anthropic|openai)$/.test(tag)) return tag;
    return REDACTED;
  });
}

/** Retain only known numeric token/credit counters; drop arbitrary keys and values. */
export function privacySafeUsage(
  usage: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!usage) return {};
  const safe: Record<string, unknown> = {};
  for (const key of SAFE_USAGE_KEYS) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) safe[key] = value;
  }

  const promptDetails = usage.prompt_tokens_details;
  if (promptDetails && typeof promptDetails === "object" && !Array.isArray(promptDetails)) {
    const cached = (promptDetails as Record<string, unknown>).cached_tokens;
    if (typeof cached === "number" && Number.isFinite(cached)) {
      safe.prompt_tokens_details = { cached_tokens: cached };
    }
  }

  const cacheCreation = usage.cache_creation;
  if (cacheCreation && typeof cacheCreation === "object" && !Array.isArray(cacheCreation)) {
    const source = cacheCreation as Record<string, unknown>;
    const nested: Record<string, number> = {};
    for (const key of [
      "ephemeral_5m_input_tokens",
      "ephemeral_1h_input_tokens",
    ]) {
      const value = source[key];
      if (typeof value === "number" && Number.isFinite(value)) nested[key] = value;
    }
    if (Object.keys(nested).length > 0) safe.cache_creation = nested;
  }
  return safe;
}
