/** Trusted routing facts for answering which backend model a client is using. */
export interface ModelIdentity {
  client: string;
  provider?: string;
  upstreamUrl: string;
}

const CLIENT_NAMES: Record<string, string> = {
  codex: "Codex", "claude-code": "Claude Code", pi: "Pi", opencode: "OpenCode",
  dsh: "DeepSeek Harness", hermes: "Hermes", openclaw: "OpenClaw", codebuddy: "CodeBuddy",
};

function providerName(identity: ModelIdentity): string {
  if (identity.provider && /^[a-zA-Z0-9._-]{1,80}$/.test(identity.provider)) return identity.provider;
  try {
    const host = new URL(identity.upstreamUrl).hostname;
    if (host === "api.deepseek.com") return "deepseek";
    if (host === "api.openai.com") return "openai";
    if (host === "api.anthropic.com") return "anthropic";
    if (host === "generativelanguage.googleapis.com") return "google";
  } catch { /* A missing provider is reported as unknown, never inferred from the client name. */ }
  return "unknown";
}

export function modelIdentityText(body: Record<string, unknown>, identity: ModelIdentity): string | null {
  const client = CLIENT_NAMES[identity.client];
  const model = body.model;
  if (!client || typeof model !== "string" || !/^[a-zA-Z0-9._:/@+-]{1,200}$/.test(model)) return null;
  return `<tdai_model_identity>\n${JSON.stringify({ client, provider: providerName(identity), requested_model: model })}\n`
    + "These are routing facts supplied by the server for this request. When asked which model you are using, "
    + "report requested_model exactly and distinguish the client application from the backend model. "
    + "This identifies the model requested from the provider, not an independently verified model architecture. "
    + "Do not infer the model from the client's name or contradict these routing facts using a default client persona.\n</tdai_model_identity>";
}

/** Append at the final forwarding boundary; leave client history and tool results intact. */
export function withModelIdentity(
  body: Record<string, unknown>, protocol: "chat" | "anthropic" | "responses", identity: ModelIdentity,
): Record<string, unknown> {
  const text = modelIdentityText(body, identity);
  if (!text) return body;
  if (protocol === "responses") {
    return { ...body, instructions: [typeof body.instructions === "string" ? body.instructions : "", text].filter(Boolean).join("\n\n") };
  }
  if (protocol === "anthropic") {
    // Preserve the shape the caller produced. The anthropic runner builds
    // body.system as a plain string, and protocol-shape tests assert on that
    // string; converting it to text blocks would silently change the upstream
    // request. Append as a block only when the caller already uses blocks.
    if (Array.isArray(body.system)) {
      return { ...body, system: [...body.system, { type: "text", text }] };
    }
    const existing = typeof body.system === "string" && body.system ? `${body.system}\n\n` : "";
    return { ...body, system: `${existing}${text}` };
  }
  return { ...body, messages: [{ role: "system", content: text }, ...(Array.isArray(body.messages) ? body.messages : [])] };
}
