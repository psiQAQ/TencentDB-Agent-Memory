export type ClientAccessConfigKind = 'file';

export interface ClientAccessConfig {
  id: string;
  name: string;
  kind: ClientAccessConfigKind;
  target: string;
  content: string;
}

export const USER_KEY_PLACEHOLDER = 'sk-mem-<你的 User Key>';

function endpoint(base: string, agent: string, instanceId: string, withV1 = false): string {
  return `${base.replace(/\/+$/, '')}/${agent}/${instanceId}${withV1 ? '/v1' : ''}`;
}

function quoted(value: string): string {
  return JSON.stringify(value);
}

/**
 * 与 INSTALL_CN.md 及各 agents 子目录 README 对齐的客户端接入配置。
 * Key 始终使用占位符；model 由实例公开元数据中的实际 PROXY_UPSTREAM_MODEL 注入。
 */
export function buildClientAccessConfigs(
  base: string,
  instanceId: string,
  model: string,
): ClientAccessConfig[] {
  const claudeEndpoint = endpoint(base, 'claude-code', instanceId);
  const codeBuddyEndpoint = endpoint(base, 'codebuddy', instanceId);
  const workBuddyEndpoint = endpoint(base, 'workbuddy', instanceId);
  const codexEndpoint = endpoint(base, 'codex', instanceId);
  const dshEndpoint = endpoint(base, 'dsh', instanceId);
  const openCodeEndpoint = endpoint(base, 'opencode', instanceId, true);
  const openClawEndpoint = endpoint(base, 'openclaw', instanceId);
  const hermesEndpoint = endpoint(base, 'hermes', instanceId);

  return [
    {
      id: 'claude-code',
      name: 'Claude Code',
      kind: 'file',
      target: '~/.claude/settings.json',
      content: JSON.stringify(
        {
          env: {
            ANTHROPIC_BASE_URL: claudeEndpoint,
            ANTHROPIC_AUTH_TOKEN: USER_KEY_PLACEHOLDER,
            ANTHROPIC_MODEL: model,
            ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
            ANTHROPIC_DEFAULT_SONNET_MODEL: model,
            ANTHROPIC_DEFAULT_OPUS_MODEL: model,
            CLAUDE_CODE_SUBAGENT_MODEL: model,
          },
        },
        null,
        2,
      ),
    },
    {
      id: 'codebuddy',
      name: 'CodeBuddy',
      kind: 'file',
      target: '~/.codebuddy/models.json',
      content: JSON.stringify(
        {
          models: [
            {
              id: model,
              name: 'proxy-memory-agent',
              vendor: 'claude',
              apiKey: USER_KEY_PLACEHOLDER,
              maxInputTokens: 200000,
              url: codeBuddyEndpoint,
              supportsToolCall: true,
              supportsImages: true,
            },
          ],
        },
        null,
        2,
      ),
    },
    {
      id: 'workbuddy',
      name: 'WorkBuddy',
      kind: 'file',
      target: '~/.workbuddy/models.json',
      content: JSON.stringify(
        [
          {
            id: model,
            name: model,
            vendor: 'Custom',
            url: workBuddyEndpoint,
            apiKey: USER_KEY_PLACEHOLDER,
            supportsToolCall: true,
            supportsImages: false,
            supportsReasoning: false,
            useCustomProtocol: false,
          },
        ],
        null,
        2,
      ),
    },
    {
      id: 'codex',
      name: 'Codex CLI',
      kind: 'file',
      target: '~/.codex/config.toml',
      content: `model_provider = "team-proxy"
model = ${quoted(model)}
model_reasoning_effort = "high"
disable_response_storage = true

[model_providers.team-proxy]
name       = "TDAI team-proxy"
wire_api   = "responses"
base_url   = ${quoted(codexEndpoint)}
experimental_bearer_token = ${quoted(USER_KEY_PLACEHOLDER)}

request_max_retries    = 2
stream_max_retries     = 3
stream_idle_timeout_ms = 120000`,
    },
    {
      id: 'dsh',
      name: 'DeepSeek Harness (dsh)',
      kind: 'file',
      target: '~/.dsh/settings.yaml + ~/.dsh/.credentials.yaml',
      content: `# ~/.dsh/settings.yaml
llm-deepseek:
  apiKeyEnv: PROXY_USER_KEY
  baseURL: ${quoted(dshEndpoint)}
  model: ${quoted(model)}
  reasoningEffort: high

# ~/.dsh/.credentials.yaml
PROXY_USER_KEY: ${quoted(USER_KEY_PLACEHOLDER)}

# 启动
dsh`,
    },
    {
      id: 'opencode',
      name: 'OpenCode',
      kind: 'file',
      target: '~/.config/opencode/opencode.json',
      content: JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          provider: {
            'proxy-memory': {
              npm: '@ai-sdk/openai-compatible',
              name: 'Proxy Memory (OpenCode)',
              options: {
                baseURL: openCodeEndpoint,
                apiKey: USER_KEY_PLACEHOLDER,
              },
              models: {
                [model]: { name: model },
              },
            },
          },
        },
        null,
        2,
      ),
    },
    {
      id: 'openclaw',
      name: 'OpenClaw',
      kind: 'file',
      target: '~/.openclaw/openclaw.json',
      content: JSON.stringify(
        {
          models: {
            mode: 'merge',
            providers: {
              'memory-proxy': {
                baseUrl: openClawEndpoint,
                apiKey: USER_KEY_PLACEHOLDER,
                api: 'openai-completions',
                headers: {
                  'x-team-id': '<team-id>',
                  'x-agent-id': '<agent-id>',
                  'x-task-id': 'no-task',
                  'x-conversation-id': '<conv-id>',
                },
                request: { allowPrivateNetwork: true },
                models: [
                  {
                    id: model,
                    name: model,
                    reasoning: false,
                    input: ['text'],
                    contextWindow: 128000,
                    maxTokens: 32000,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  },
                ],
              },
            },
          },
        },
        null,
        2,
      ),
    },
    {
      id: 'hermes',
      name: 'Hermes',
      kind: 'file',
      target: '~/.hermes/config.yaml',
      content: `model:
  default: ${quoted(model)}
  provider: custom
  base_url: ${quoted(hermesEndpoint)}
  api_key: ${quoted(USER_KEY_PLACEHOLDER)}
  extra_headers:
    x-team-id: "<team-id>"
    x-agent-id: "<agent-id>"
    x-task-id: "no-task"
    x-conversation-id: "<conv-id>"`,
    },
  ];
}
