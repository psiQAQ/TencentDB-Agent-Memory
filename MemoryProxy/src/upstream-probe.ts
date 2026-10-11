import { timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request } from "node:https";
import { isIP } from "node:net";
import type { Context } from "hono";
import type { ProxyConfig } from "./types.js";
import { refreshInstanceUpstreamConfigs, resolveInstanceTargetUrl } from "./instance-upstream-cache.js";
import { chatToResponses, resolveSubscriptionToken, subscriptionToChat, subscriptionResponsesRequest, subscriptionEvents, guardSubscriptionResponse, SubscriptionError } from "./chatgpt-subscription.js";

type Protocol = "chat" | "responses" | "anthropic";
const PROTOCOLS = new Set<Protocol>(["chat", "responses", "anthropic"]);
const MAX_RESPONSE_BYTES = 64 * 1024;
const recent = new Map<string, number>();

function sameSecret(given: string, expected: string): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function publicIpv4(address: string): boolean {
  const v = address.split(".").map(Number);
  if (v.length !== 4 || v.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, c] = v;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || (b === 168))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113));
}

function privateIpv4(address: string): boolean {
  const v = address.split(".").map(Number);
  if (v.length !== 4 || v.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = v;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

async function pinnedAddress(host: string, local: boolean): Promise<string> {
  const addresses = await lookup(host, { all: true, verbatim: true });
  const ipv4 = addresses.filter((entry) => entry.family === 4);
  const allowed = local ? privateIpv4 : publicIpv4;
  if (!ipv4.length || ipv4.some((entry) => !allowed(entry.address))) throw new Error("invalid_target");
  return ipv4[0].address;
}

async function postBounded(url: URL, key: string, body: string, protocol: Protocol, local: boolean): Promise<{ status: number; data?: Record<string, unknown> }> {
  const ip = await pinnedAddress(url.hostname, local);
  return new Promise((resolve, reject) => {
    const req = (url.protocol === "http:" ? httpRequest : request)(url, {
      method: "POST",
      timeout: 10_000,
      family: 4,
      lookup: (_host, _options, callback) => callback(null, ip, 4),
      headers: {
        "content-type": "application/json",
        ...(protocol === "anthropic"
          ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
          : { authorization: `Bearer ${key}` }),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          req.destroy(new Error("response_too_large"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        const status = response.statusCode ?? 502;
        if (status < 200 || status >= 300) return resolve({ status });
        try { resolve({ status, data: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> }); }
        catch { resolve({ status }); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(body);
  });
}

function hasText(protocol: Protocol, data: Record<string, unknown> | undefined): boolean {
  if (!data) return false;
  if (protocol === "anthropic") return Array.isArray(data.content) && data.content.some((x: unknown) =>
    typeof x === "object" && x !== null && typeof (x as { text?: unknown }).text === "string" && !!(x as { text: string }).text.trim());
  if (protocol === "chat") return Array.isArray(data.choices) && data.choices.some((x: unknown) => {
    const message = (x as { message?: { content?: unknown } })?.message;
    return typeof message?.content === "string" && !!message.content.trim();
  });
  return Array.isArray(data.output) && data.output.some((x: unknown) => {
    const content = (x as { content?: Array<{ text?: unknown }> })?.content;
    return Array.isArray(content) && content.some((item) => typeof item.text === "string" && !!item.text.trim());
  });
}

export async function handleUpstreamProbe(c: Context, config: ProxyConfig): Promise<Response> {
  const bearer = c.req.header("authorization")?.match(/^Bearer (.+)$/i)?.[1] ?? "";
  if (!sameSecret(bearer, config.coreSkill.serviceToken)) return c.json({ error: "forbidden" }, 403);
  let input: Record<string, unknown>;
  try { input = await c.req.json() as Record<string, unknown>; }
  catch { return c.json({ error: "invalid_input" }, 400); }
  const instanceId = c.req.header("x-tdai-service-id") ?? "";
  if (!instanceId || instanceId.length > 128) return c.json({ error: "invalid_instance" }, 400);
  if (input.credential_kind === "chatgpt_oauth") {
    if (input.base_url !== "https://api.openai.com/v1" || typeof input.model_id !== "string" || !input.model_id ||
      typeof input.credential_ref !== "string" || !input.credential_ref || input.api_key ||
      !Array.isArray(input.protocols) || !input.protocols.length || input.protocols.length > 2 ||
      input.protocols.some((p) => p !== "chat" && p !== "responses")) return c.json({ error: "invalid_input" }, 400);
    const rateKey = `${instanceId}:${input.type}`;
    if (Date.now() - (recent.get(rateKey) ?? 0) < 10_000) return c.json({ error: "probe_rate_limited" }, 429);
    if (recent.size > 256) recent.clear();
    recent.set(rateKey, Date.now());
    try {
      const token = await resolveSubscriptionToken(config.coreSkill, instanceId, { credential_ref: input.credential_ref, model_id: input.model_id });
      const results = [];
      for (const protocol of input.protocols) {
        try {
          const request = protocol === "chat"
            ? chatToResponses({ model: input.model_id, messages: [{ role: "user", content: "Reply OK." }] })
            : subscriptionResponsesRequest({ model: input.model_id, input: [{ role: "user", content: "Reply OK." }] });
          const response = await fetch("https://api.openai.com/v1/responses", {
            method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify(request),
          });
          let ready = false;
          if (protocol === "chat") {
            const chat = await subscriptionToChat(response, false);
            ready = hasText("chat", await chat.json() as Record<string, unknown>);
          } else {
            for await (const event of subscriptionEvents(guardSubscriptionResponse(response).body!)) {
              if (event.type === "response.completed") ready = hasText("responses", event.response as Record<string, unknown>);
            }
          }
          results.push({ protocol, status: ready ? "ready" : "invalid_response", httpStatus: 200 });
        } catch (error) {
          results.push({ protocol, status: error instanceof SubscriptionError ? error.code : "CHATGPT_UPSTREAM_UNAVAILABLE" });
        }
      }
      return c.json({ results });
    } catch (error) {
      return c.json({ results: input.protocols.map((protocol) => ({ protocol, status: error instanceof SubscriptionError ? error.code : "CHATGPT_UPSTREAM_UNAVAILABLE" })) });
    }
  }
  const baseUrl = input.base_url;
  const model = input.model_id;
  const protocols = input.protocols;
  const local = input.local === true;
  const hasDeploymentKey = false;
  const hasIndependentKey = input.credential_ref === undefined && typeof input.api_key === "string" && !!input.api_key.trim();
  if (typeof baseUrl !== "string" || baseUrl.length > 2048 || typeof model !== "string" || !model.trim() || model.length > 200 ||
      !Array.isArray(protocols) || !protocols.length || protocols.length > 3 || protocols.some((p) => !PROTOCOLS.has(p as Protocol)) ||
      (!hasDeploymentKey && !hasIndependentKey) || (local && !hasIndependentKey)) return c.json({ error: "invalid_input" }, 400);
  let base: URL;
  try { base = new URL(baseUrl); } catch { return c.json({ error: "invalid_endpoint" }, 400); }
  if ((local ? !["http:", "https:"].includes(base.protocol) ||
      (!base.port && (base.protocol !== "https:" || isIP(base.hostname) !== 0))
    : base.protocol !== "https:" || !!base.port) ||
      base.username || base.password || base.search || base.hash) {
    return c.json({ error: "invalid_endpoint" }, 400);
  }
  const cfg = { base_url: baseUrl };
  const key = input.api_key as string;
  try { await pinnedAddress(base.hostname, local); }
  catch { return c.json({ error: local ? "non_private_target" : "non_public_target" }, 400); }
  const rateKey = `${instanceId}:${input.type}`;
  const previous = recent.get(rateKey) ?? 0;
  if (Date.now() - previous < 10_000) return c.json({ error: "probe_rate_limited" }, 429);
  if (recent.size > 256) recent.clear();
  recent.set(rateKey, Date.now());
  const results = await Promise.all((protocols as Protocol[]).map(async (protocol) => {
    const suffix = protocol === "anthropic" ? "/messages" : protocol === "responses" ? "/responses" : "/chat/completions";
    const target = new URL(resolveInstanceTargetUrl(cfg, baseUrl.replace(/\/+$/, "") + suffix));
    const deepseek = base.hostname === "api.deepseek.com";
    const body = JSON.stringify(protocol === "responses"
      ? { model, input: "Reply OK.", max_output_tokens: 64, stream: false,
          ...(deepseek ? { reasoning: { effort: "none" } } : {}) }
      : { model, messages: [{ role: "user", content: "Reply OK." }], max_tokens: 64, stream: false,
          ...(deepseek && protocol === "chat" ? { thinking: { type: "disabled" } } : {}),
          ...(deepseek && protocol === "anthropic" ? { reasoning: { effort: "none" } } : {}) });
    try {
      const response = await postBounded(target, key, body, protocol, local);
      return { protocol, status: response.status >= 300 ? "http_error" : hasText(protocol, response.data) ? "ready" : "invalid_response", httpStatus: response.status };
    } catch {
      return { protocol, status: "unreachable" };
    }
  }));
  return c.json({ results });
}

export async function handleUpstreamRefresh(c: Context, config: ProxyConfig): Promise<Response> {
  const bearer = c.req.header("authorization")?.match(/^Bearer (.+)$/i)?.[1] ?? "";
  if (!sameSecret(bearer, config.coreSkill.serviceToken)) return c.json({ error: "forbidden" }, 403);
  const instanceId = c.req.header("x-tdai-service-id") ?? "";
  if (!instanceId || instanceId.length > 128) return c.json({ error: "invalid_instance" }, 400);
  let input: Record<string, unknown>;
  try { input = await c.req.json() as Record<string, unknown>; }
  catch { return c.json({ error: "invalid_input" }, 400); }
  try {
    await refreshInstanceUpstreamConfigs(config.coreSkill, instanceId);
    return c.json({ adopted: true });
  } catch { return c.json({ error: "core_unavailable" }, 502); }
}
