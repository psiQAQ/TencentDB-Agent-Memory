import { describe, expect, it } from 'vitest';
import { InstanceRegistry } from '../src/panel/config/instance-registry.js';
import {
  buildClientAccessConfigs,
  buildClientAccessEntries,
  USER_KEY_PLACEHOLDER,
} from '../web/src/pages/ApiKeysPage/client-access-config.js';

describe('API Key client access configuration', () => {
  it('uses each Agent model group and omits disabled or unassigned Agents', () => {
    const configs = buildClientAccessConfigs('http://proxy:8096', 'instance-a', {
      codex: 'responses-model', 'claude-code': 'claude-model', pi: 'pi-model', dsh: null,
    });
    expect(configs.map((config) => config.id)).toEqual(['pi', 'claude-code', 'codex']);
    expect(configs.find((config) => config.id === 'codex')!.content).toContain('responses-model');
    expect(configs.find((config) => config.id === 'claude-code')!.content).toContain('claude-model');
    expect(configs.find((config) => config.id === 'codex')!.content).not.toContain('claude-model');
  });
  it('builds all nine client configurations with the runtime model', () => {
    const configs = buildClientAccessConfigs(
      'http://127.0.0.1:8096/',
      'default',
      'runtime-model-v2',
    );

    expect(configs.map((config) => config.id)).toEqual([
      'pi',
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
      expect(config.content + (config.setupCommands ?? '')).toContain(USER_KEY_PLACEHOLDER);
      expect(config.content).not.toContain('PROXY_UPSTREAM_MODEL 里配的模型');
    }
    expect(configs[1]).toMatchObject({
      kind: 'file',
      target: '~/.claude/settings.json',
    });
    expect(JSON.parse(configs[1]!.content)).toEqual({
      env: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:8096/claude-code/default',
        ANTHROPIC_AUTH_TOKEN: USER_KEY_PLACEHOLDER,
        ANTHROPIC_MODEL: 'runtime-model-v2',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'runtime-model-v2',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'runtime-model-v2',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'runtime-model-v2',
        CLAUDE_CODE_SUBAGENT_MODEL: 'runtime-model-v2',
      },
    });
  });

  it('uses the Pi extension for real session IDs and quotes model and instance shell values', () => {
    const pi = buildClientAccessConfigs('https://memory.example/proxy/', "space'1", "model'$(echo bad)").find((entry) => entry.id === 'pi')!;
    expect(pi.content).toContain("export TDAI_PROXY_URL='https://memory.example/proxy'");
    expect(pi.content).toContain("export TDAI_SPACE_ID='space'\"'\"'1'");
    expect(pi.content).toContain("export TDAI_MODEL='model'\"'\"'$(echo bad)'");
    expect(pi.content).toContain('tdai-memory.ts');
    expect(pi.content).not.toContain('export TDAI_CONVERSATION_ID');
    expect(pi.instructions).toContain('pi-<session id>');
  });

  it('uses a complete Chat endpoint for CodeBuddy CLI custom models', () => {
    const config = buildClientAccessConfigs('https://memory.example/proxy', 'a', 'deepseek-flash').find((entry) => entry.id === 'codebuddy')!;
    const model = JSON.parse(config.content).models[0];
    expect(model.url).toBe('https://memory.example/proxy/codebuddy/a/v1/chat/completions');
    expect(model.vendor).toBe('Custom');
    expect(model.supportsImages).toBe(false);
    expect(config.setupCommands).toContain('--header');
  });

  it('shows explicit unavailable reasons without generating a copyable configuration', () => {
    const statuses = ['unassigned', 'disabled', 'default_missing', 'model_missing', 'unsupported', 'client_credentials'] as const;
    const entries = buildClientAccessEntries('https://memory.example/proxy', 'instance-a', statuses.map((status) => ({
      agent_source: 'pi', display_name: 'Pi', protocol: 'openai-chat', model_id: 'model-a', credential_kind: 'api_key', status,
    })));
    expect(entries).toHaveLength(statuses.length);
    for (const entry of entries) { expect(entry.reason).toBeTruthy(); expect(entry.content).toBe(''); }
    const unknown = buildClientAccessEntries('https://memory.example/proxy', 'instance-a', [{
      agent_source: 'new-client', display_name: 'New client', protocol: 'new', model_id: 'model-a', credential_kind: 'api_key', status: 'ready',
    }]);
    expect(unknown[0]?.reason).toBe('当前客户端尚无接入模板。');
  });

  it('matches the tested DSH Cordis adapter, credential reference and per-session headers', () => {
    const dsh = buildClientAccessConfigs('https://memory.example/proxy', 'a', 'deepseek-flash').find((item) => item.id === 'dsh')!;
    expect(dsh.target).toBe('~/.dsh/cordis.patch.yml');
    expect(dsh.compatibility).toContain('0.2.0-rc.2');
    expect(dsh.content).toContain('- id: llm-pi-ai');
    expect(dsh.content).toContain('apiKeyEnv: TDAI_USER_KEY');
    expect(dsh.content).toContain('x-conversation-id: !!js process.env.TDAI_CONVERSATION_ID');
    expect(dsh.setupCommands).toContain('--expose-internals');
    expect(dsh.content).not.toContain('export TDAI_USER_KEY');
    expect(dsh.content).not.toContain('.credentials.yaml');
  });

  it('selects the OpenClaw model and configures Hermes provider-level headers and session affinity', () => {
    const configs = buildClientAccessConfigs('https://memory.example/proxy', 'a', 'selected');
    const claw = JSON.parse(configs.find((item) => item.id === 'openclaw')!.content);
    expect(claw.agents.defaults.model.primary).toBe('memory-proxy/selected');
    expect(claw.models.providers['memory-proxy'].baseUrl).toBe('https://memory.example/proxy/openclaw/a/v1');
    const hermes = configs.find((item) => item.id === 'hermes')!.content;
    expect(hermes).toContain('providers:\n  tdai:');
    expect(hermes).toContain('api: "https://memory.example/proxy/hermes/a/v1"');
    expect(hermes).toContain('session_affinity_header: x-conversation-id');
    expect(hermes).not.toContain('<conv-id>');
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
    expect(JSON.parse(configs.get('opencode')!)).toMatchObject({
      model: 'proxy-memory/model-a', small_model: 'proxy-memory/model-a',
    });
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
