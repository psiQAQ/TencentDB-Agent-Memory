import { vi } from "vitest";
import { getInstanceUpstreamConfigs, type InstanceUpstreamConfigEntry } from "../../instance-upstream-cache.js";
import { createApp } from "../../server.js";
import type { ProxyConfig } from "../../types.js";

/** Explicit active Panel profiles for tests of routes, identity, and diagnostics. */
export function configureActiveProfiles(config: ProxyConfig): void {
  const upstreams = { default: config.upstream, ...config.upstream.agents };
  const rows: InstanceUpstreamConfigEntry[] = Object.entries(upstreams).flatMap(([source, upstream]) =>
    (["conversation", "extraction"] as const).map((type) => ({
      agent_source: source,
      type,
      mode: "custom_unified",
      base_url: upstream.url,
      api_key: upstream.apiKey ?? config.upstream.apiKey ?? "profile-test-key",
      model_id: "test-model",
      ready_protocols: ["chat", "anthropic", "responses"],
    })),
  );
  vi.mocked(getInstanceUpstreamConfigs).mockImplementation(async (_config, instanceId) => instanceId ? rows : []);
}

export function createConfiguredApp(config: ProxyConfig): ReturnType<typeof createApp> {
  configureActiveProfiles(config);
  return createApp(config);
}
