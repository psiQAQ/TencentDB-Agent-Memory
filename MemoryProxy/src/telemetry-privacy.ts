import { createHash } from "node:crypto";

const REDACTED = "[redacted]";
const PRIVATE_SESSION_PATTERN = /^session:[0-9a-f]{16}$/;

export function privacySafeSessionId(value: string | undefined): string {
  if (!value) return "";
  if (PRIVATE_SESSION_PATTERN.test(value)) return value;
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 16);
  return `session:${digest}`;
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
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === "number" || typeof value === "boolean" || value === null) {
      safe[key] = value;
    } else if (typeof value === "string") {
      safe[key] = REDACTED;
    } else if (Array.isArray(value)) {
      safe[`${key}_count`] = value.length;
    } else if (value && typeof value === "object") {
      safe[`${key}_field_count`] = Object.keys(value).length;
    }
  }
  return safe;
}

export function privacySafeTags(tags: string[] | undefined): string[] | undefined {
  if (!tags) return undefined;
  return tags.map((tag) => {
    if (tag.startsWith("session:")) {
      return privacySafeSessionId(tag.slice("session:".length));
    }
    return tag.length <= 128 && /^[A-Za-z0-9_.:-]+$/.test(tag) ? tag : REDACTED;
  });
}
