import type { ProxyConfig } from "./types.js";
import { getInstanceUpstreamConfigs, resolveForAgent, resolveInstanceTargetUrl } from "./instance-upstream-cache.js";

/** Task drafts follow the dialogue group's supplier and credentials. */
export async function resolveTaskDraftUpstream(config: ProxyConfig, spaceId: string, agent: string,
  protocol: "openai" | "anthropic" | "responses") {
  const resolution = resolveForAgent(await getInstanceUpstreamConfigs(config.coreSkill, spaceId, config.instanceUpstream), agent);
  if (resolution.kind === "blocked" || resolution.kind === "unmanaged") return null;
  const deployed = config.upstream.agents?.[agent];
  const row = resolution.kind === "override" ? resolution.row : null;
  const base = row?.base_url ?? deployed?.url ?? config.upstream.url;
  const suffix = protocol === "anthropic" ? "/messages" : protocol === "responses" ? "/responses" : "/chat/completions";
  return { model: row?.model_id || config.memCommand?.taskDraft?.model || "",
    upstreamUrl: resolveInstanceTargetUrl({ base_url: base }, `${base.replace(/\/+$/, "")}${suffix}`),
    apiKey: row ? row.mode === "custom_unified" ? row.api_key : "" : deployed ? deployed.apiKey ?? "" : config.upstream.apiKey,
    protocol };
}
