const SAFE_REQUEST_HEADERS = new Set([
  "accept",
  "anthropic-beta",
  "anthropic-version",
]);

export interface UpstreamHeaderOptions {
  protocol: "anthropic" | "openai";
  apiKey?: string;
  authHeaders?: Record<string, string> | null;
}

function safeProtocolValue(name: string, value: string): boolean {
  if (name === "accept") {
    return value === "application/json" || value === "text/event-stream";
  }
  if (name === "anthropic-version") return /^\d{4}-\d{2}-\d{2}$/.test(value);
  return value.length <= 512 && /^[A-Za-z0-9._=, -]+$/.test(value);
}

/** Build a fail-closed upstream header set from an explicit protocol allowlist. */
export function buildSafeUpstreamHeaders(
  inbound: Headers,
  options: UpstreamHeaderOptions,
): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  for (const [rawName, value] of inbound.entries()) {
    const name = rawName.toLowerCase();
    if (SAFE_REQUEST_HEADERS.has(name) && safeProtocolValue(name, value)) {
      headers[name] = value;
    }
  }

  const explicit = new Headers(options.authHeaders ?? undefined);
  const explicitApiKey = explicit.get("x-api-key");
  const explicitAuthorization = explicit.get("authorization");
  if (explicitApiKey) {
    headers["x-api-key"] = explicitApiKey;
  } else if (explicitAuthorization) {
    headers.authorization = explicitAuthorization;
  } else if (options.apiKey) {
    if (options.protocol === "anthropic") {
      headers["x-api-key"] = options.apiKey;
    } else {
      headers.authorization = `Bearer ${options.apiKey}`;
    }
  }
  return headers;
}
