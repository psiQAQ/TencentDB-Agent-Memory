import type { ClientModel } from '../../lib/api/meta-instances';

export type ClientAccessConfigKind = 'file' | 'command';

export interface ClientAccessConfig {
  id: string;
  name: string;
  kind: ClientAccessConfigKind;
  target: string;
  content: string;
  instructions?: string;
  reason?: string;
  model?: string | null;
  authentication?: string;
}

export const USER_KEY_PLACEHOLDER = 'sk-mem-<你的 User Key>';

function endpoint(base: string, agent: string, instanceId: string, withV1 = false): string {
  return `${base.replace(/\/+$/, '')}/${agent}/${instanceId}${withV1 ? '/v1' : ''}`;
}

function quoted(value: string): string {
  return JSON.stringify(value);
}

function shellQuoted(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function buildClientAccessEntries(base: string, instanceId: string, clients: ClientModel[]): ClientAccessConfig[] {
  const reasons: Record<Exclude<ClientModel['status'], 'ready'>, string> = {
    unassigned: '尚未分配模型组，请在模型配置中分配客户端。',
    disabled: '所属模型组已停用，请启用模型组或重新分配。',
    default_missing: '未配置部署默认模型，请分配到已配置的自定义模型组。',
    model_missing: '所属模型组未指定模型，请补全模型配置。',
    unsupported: '当前客户端不支持 ChatGPT 订阅协议，请选择兼容的模型组。',
    client_credentials: '当前组要求客户端提供供应商凭据，不能使用仅含业务 User Key 的接入模板。',
  };
  return clients.map((client) => {
    const config = client.status === 'ready' && client.model_id
      ? buildClientAccessConfigs(base, instanceId, client.model_id).find((item) => item.id === client.agent_source) : undefined;
    return { id: client.agent_source, name: client.display_name, kind: 'file' as const, target: '', content: '', ...config,
      model: client.model_id, authentication: client.credential_kind === 'chatgpt_oauth' ? 'ChatGPT 订阅' : '部署配置 / API Key',
      reason: client.status !== 'ready' ? reasons[client.status] : !config ? '当前客户端尚无接入模板。' : undefined };
  });
}

/**
 * 与 INSTALL_CN.md 及各 agents 子目录 README 对齐的客户端接入配置。
 * Key 始终使用占位符；model 由实例公开元数据中的 Agent 模型组注入。
 */
export function buildClientAccessConfigs(
  base: string,
  instanceId: string,
  model: string | Record<string, string | null>,
): ClientAccessConfig[] {
  if (typeof model !== 'string') {
    return buildClientAccessConfigs(base, instanceId, 'model-placeholder').flatMap((config) => {
      const modelId = model[config.id];
      return modelId ? buildClientAccessConfigs(base, instanceId, modelId).filter((entry) => entry.id === config.id) : [];
    });
  }
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
      id: 'pi',
      name: 'Pi',
      kind: 'command',
      target: '终端（Bash / Zsh）',
      instructions: '先将源码仓库的 MemoryCore/pi-plugin/index.ts 保存为 ~/.pi/agent/extensions/tdai-memory.ts（或使用已有 Pi 客户端包中的同一插件）。填写业务 User Key、Team ID 和 Agent ID；Task ID 可选。插件自动为每个真实会话生成 pi-<session id>，不要手填固定会话 ID。',
      content: `# 接口：${endpoint(base, 'pi', instanceId, true)}
export TDAI_PROXY_URL=${shellQuoted(base.replace(/\/+$/, ''))}
export TDAI_SPACE_ID=${shellQuoted(instanceId)}
export TDAI_AGENT_SOURCE='pi'
export TDAI_MODEL=${shellQuoted(model)}
export TDAI_USER_KEY=${shellQuoted(USER_KEY_PLACEHOLDER)}
export TDAI_TEAM_ID='<team-id>'
export TDAI_AGENT_ID='<agent-id>'
# 如需按 Task 隔离，填写对应 Task ID；空值表示不限制 Task。
export TDAI_TASK_ID=''
pi -e "$HOME/.pi/agent/extensions/tdai-memory.ts" --provider tdai --model "$TDAI_MODEL"`,
    },
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
supports_websockets = false
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
          model: `proxy-memory/${model}`,
          small_model: `proxy-memory/${model}`,
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
