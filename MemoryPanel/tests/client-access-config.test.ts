import { describe, expect, it } from 'vitest';
import { InstanceRegistry } from '../src/panel/config/instance-registry.js';
import {
  buildClientAccessConfigs,
  USER_KEY_PLACEHOLDER,
} from '../web/src/pages/ApiKeysPage/client-access-config.js';

describe('API Key client access configuration', () => {
  it('builds all eight documented client configurations with the runtime model', () => {
    const configs = buildClientAccessConfigs(
      'http://127.0.0.1:8096/',
      'default',
      'runtime-model-v2',
    );

    expect(configs.map((config) => config.id)).toEqual([
      'claude-code',
      'codebuddy',
      'workbuddy',
      'codex',
      'dsh',
      'opencode',
      'openclaw',
      'hermes',
    ]);
    for (const config of configs) {
      expect(config.content).toContain('runtime-model-v2');
      expect(config.content).toContain(USER_KEY_PLACEHOLDER);
      expect(config.content).not.toContain('PROXY_UPSTREAM_MODEL 里配的模型');
    }
    expect(configs[0]?.content).toContain(
      "export ANTHROPIC_BASE_URL='http://127.0.0.1:8096/claude-code/default'",
    );
    expect(configs[0]?.content).toContain("claude --model 'runtime-model-v2'");
  });

  it('uses the protocol-specific endpoint form from each agent document', () => {
    const configs = new Map(
      buildClientAccessConfigs('http://proxy:8096', 'instance-a', 'model-a').map((config) => [
        config.id,
        config.content,
      ]),
    );

    expect(configs.get('claude-code')).toContain('/claude-code/instance-a');
    expect(configs.get('codex')).toContain('/codex/instance-a');
    expect(configs.get('dsh')).toContain('/dsh/instance-a');
    expect(configs.get('opencode')).toContain('/opencode/instance-a/v1');
    expect(configs.get('openclaw')).toContain('/openclaw/instance-a');
    expect(configs.get('hermes')).toContain('/hermes/instance-a');
  });

  it('publishes the configured upstream model without exposing the instance api key', () => {
    const registry = new InstanceRegistry([
      {
        instance_id: 'default',
        name: 'Default',
        gateway_endpoint: 'http://memory-core:8420',
        proxy_endpoint: 'http://127.0.0.1:8096',
        upstream_model: 'runtime-model-v2',
        api_key: 'gateway-secret',
      },
    ]);

    expect(registry.listPublic()).toEqual([
      {
        instance_id: 'default',
        name: 'Default',
        gateway_endpoint: 'http://memory-core:8420',
        proxy_endpoint: 'http://127.0.0.1:8096',
        upstream_model: 'runtime-model-v2',
      },
    ]);
    expect(registry.listPublic()[0]).not.toHaveProperty('api_key');
  });
});
