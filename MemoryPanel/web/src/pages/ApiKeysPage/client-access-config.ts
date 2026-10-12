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
  compatibility?: string;
  setupCommands?: string;
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
  const codeBuddyEndpoint = `${endpoint(base, 'codebuddy', instanceId, true)}/chat/completions`;
  const workBuddyEndpoint = endpoint(base, 'workbuddy', instanceId);
  const codexEndpoint = endpoint(base, 'codex', instanceId);
  const dshEndpoint = endpoint(base, 'dsh', instanceId);
  const openCodeEndpoint = endpoint(base, 'opencode', instanceId, true);
  const openClawEndpoint = endpoint(base, 'openclaw', instanceId, true);
  const hermesEndpoint = endpoint(base, 'hermes', instanceId, true);

  return [
    {
      id: 'pi',
      name: 'Pi',
      compatibility: 'Pi 1.1.0；需要腾讯记忆扩展',
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
      compatibility: '模板基线：Claude Code 2.1.296',
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
      compatibility: '模板基线：CodeBuddy CLI 2.164.0',
      instructions: '保存模型文件并填写业务 User Key。url 必须包含完整的 /v1/chat/completions 路径。以下启动命令通过官方 --header 参数绑定 Team/Agent 身份；每次新会话生成新的会话 ID，续聊保留原值。',
      kind: 'file',
      target: '~/.codebuddy/models.json',
      setupCommands: `export TDAI_TEAM_ID='<team-id>'
export TDAI_AGENT_ID='<agent-id>'
export TDAI_CONVERSATION_ID="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
codebuddy --header "x-team-id: $TDAI_TEAM_ID" "x-agent-id: $TDAI_AGENT_ID" "x-conversation-id: $TDAI_CONVERSATION_ID" --model ${shellQuoted(model)}`,
      content: JSON.stringify(
        {
          models: [
            {
              id: model,
              name: 'proxy-memory-agent',
              vendor: 'Custom',
              apiKey: USER_KEY_PLACEHOLDER,
              maxInputTokens: 200000,
              url: codeBuddyEndpoint,
              supportsToolCall: true,
              supportsImages: false,
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
      compatibility: '按仓库接入规范核对；本机无对应镜像，未验证客户端版本',
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
      compatibility: '模板基线：Codex CLI 0.162.1',
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
      compatibility: '模板基线：DSH 0.2.0-rc.2 / Linux',
      kind: 'file',
      target: '~/.dsh/cordis.patch.yml',
      instructions: '填写 Team/Agent 身份；Task 可留空。供应商使用随 DSH 提供的 llm-pi-ai。每次新会话重新生成 TDAI_CONVERSATION_ID，续聊保持原值。0.2.0-rc.2 使用自定义 tdai 供应商。容器中的 /tmp 需要允许执行原生模块。下方 YAML 和启动命令分别保存、执行。',
      content: `# ~/.dsh/cordis.patch.yml
- id: agent-default-model
  config:
    provider: tdai
    model: ${quoted(model)}
- id: llm-pi-ai
  config:
    providers:
      tdai:
        displayName: TencentDB Agent Memory
        apiKeyEnv: TDAI_USER_KEY
        api: openai-completions
        baseURL: ${quoted(dshEndpoint)}
        headers:
          x-team-id: "<team-id>"
          x-agent-id: "<agent-id>"
          x-task-id: ""
          x-conversation-id: !!js process.env.TDAI_CONVERSATION_ID
        compat:
          thinkingFormat: deepseek
          supportsDeveloperRole: false
          maxTokensField: max_tokens
        models:
          - id: ${quoted(model)}
            name: ${quoted(model)}`,
      setupCommands: `# 以下在 Bash 终端执行，不写入 YAML
# 将业务 Key 保存为仅当前用户可读的 ~/.dsh/tdai-user.key
# Key 文件内只有一行；chmod 600 ~/.dsh/tdai-user.key
# 业务 Key 格式：${USER_KEY_PLACEHOLDER}
export TDAI_USER_KEY="$(cat "$HOME/.dsh/tdai-user.key")"
export TDAI_CONVERSATION_ID="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
node --expose-internals "$(readlink -f "$(command -v dsh)")" web`,
    },
    {
      id: 'opencode',
      name: 'OpenCode',
      compatibility: '模板基线：OpenCode 1.19.0；主模型与辅助模型一致',
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
      compatibility: '模板基线：OpenClaw 2026.10.1；Node 24.16.0+（24.x）或 26.1.0+',
      instructions: '填写身份请求头；每次新对话更换 x-conversation-id，续聊保持原值。将此配置合并到已有文件，保留其他 Agent 设置。',
      kind: 'file',
      target: '~/.openclaw/openclaw.json',
      content: JSON.stringify(
        {
          agents: { defaults: { model: { primary: `memory-proxy/${model}` } } },
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
                  'x-task-id': '',
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
      compatibility: '模板基线：Hermes 0.21.6；Python 3.14',
      instructions: '填写 Team/Agent 身份。session_affinity_header 让客户端自动发送真实会话 ID；旧版本若不支持此字段，不能直接使用该模板。',
      kind: 'file',
      target: '~/.hermes/config.yaml',
      content: `model:
  default: ${quoted(model)}
  provider: tdai
  api_mode: chat_completions
providers:
  tdai:
    api: ${quoted(hermesEndpoint)}
    api_key: ${quoted(USER_KEY_PLACEHOLDER)}
    discover_models: false
    models:
      - ${quoted(model)}
    session_affinity_header: x-conversation-id
    extra_headers:
      x-team-id: "<team-id>"
      x-agent-id: "<agent-id>"
      x-task-id: ""`,
    },
  ];
}
