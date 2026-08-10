const SAFE_REQUEST_HEADERS = {
  anthropic: new Set(["accept", "anthropic-beta", "anthropic-version"]),
  openai: new Set(["accept"]),
};

export interface UpstreamHeaderOptions {
  protocol: "anthropic" | "openai";
  apiKey?: string;
  authHeaders?: Record<string, string> | null;
}

export class MissingUpstreamCredentialError extends Error {
  constructor() {
    super("Server upstream credentials are not configured");
    this.name = "MissingUpstreamCredentialError";
  }
}

function safeProtocolValue(name: string, value: string): boolean {
  if (name === "accept") {
    return value === "application/json" || value === "text/event-stream";
  }
  if (name === "anthropic-version") return /^\d{4}-\d{2}-\d{2}$/.test(value);
  return value.length <= 512 && /^[A-Za-z0-9._=, -]+$/.test(value);
}

/** Compare only canonical URL origins; malformed URLs never share credentials. */
export function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

/** Build a fail-closed upstream header set from an explicit protocol allowlist. */
export function buildSafeUpstreamHeaders(
  inbound: Headers,
  options: UpstreamHeaderOptions,
): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  for (const [rawName, value] of inbound.entries()) {
    const name = rawName.toLowerCase();
    if (SAFE_REQUEST_HEADERS[options.protocol].has(name) && safeProtocolValue(name, value)) {
      headers[name] = value;
    }
  }

  let explicitApiKey = "";
  let explicitAuthorization = "";
  for (const [rawName, rawValue] of Object.entries(options.authHeaders ?? {})) {
    const name = rawName.toLowerCase();
    const value = typeof rawValue === "string" ? rawValue.trim() : "";
    if (name === "x-api-key" && value) explicitApiKey = value;
    if (name === "authorization" && /^Bearer\s+\S+$/i.test(value)) {
      explicitAuthorization = value;
    }
  }
  if (explicitApiKey) {
    headers["x-api-key"] = explicitApiKey;
  } else if (explicitAuthorization) {
    headers.authorization = explicitAuthorization;
  } else if (options.apiKey?.trim()) {
    if (options.protocol === "anthropic") {
      headers["x-api-key"] = options.apiKey.trim();
    } else {
      headers.authorization = `Bearer ${options.apiKey.trim()}`;
    }
  } else {
    throw new MissingUpstreamCredentialError();
  }
  return headers;
}
