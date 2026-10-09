import { vi } from "vitest";
import { getInstanceUpstreamConfigs, type InstanceUpstreamRow } from "../../instance-upstream-cache.js";
import { REGISTERED_AGENT_SOURCES } from "../../agent-adapters/index.js";
import { createApp } from "../../server.js";
import type { ProxyConfig } from "../../types.js";

/** Explicit model groups for tests of routes, identity, and diagnostics. */
export function configureActiveProfiles(config: ProxyConfig): void {
  const entries = Object.entries(config.upstream.agents ?? {});
  const rows: InstanceUpstreamRow[] = entries.map(([agent, upstream]) => ({
    group_id: `group-${agent}`, group_type: "custom", name: agent, agents: [agent], enabled: true,
    mode: "custom_unified", base_url: upstream.url, api_key: upstream.apiKey ?? config.upstream.apiKey,
    model_id: "test-model",
  }));
  rows.push({ group_id: "group-main", group_type: "custom", name: "Main", enabled: true,
    agents: REGISTERED_AGENT_SOURCES.filter((agent) => !entries.some(([source]) => source === agent)),
    mode: "custom_unified", base_url: config.upstream.url, api_key: config.upstream.apiKey, model_id: "test-model" });
  rows.push({ group_id: "extraction", group_type: "extraction", name: "Summary", agents: [], enabled: true,
    mode: "custom_unified", base_url: config.upstream.url, api_key: config.upstream.apiKey, model_id: "test-model" });
  vi.mocked(getInstanceUpstreamConfigs).mockImplementation(async (_config, instanceId) => instanceId ? rows : []);
}
export function createConfiguredApp(config: ProxyConfig): ReturnType<typeof createApp> {
  configureActiveProfiles(config); return createApp(config);
}
