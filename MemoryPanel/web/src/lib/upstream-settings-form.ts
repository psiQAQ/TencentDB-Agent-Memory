import {
  PROVIDERS, providerForUrl, sameUpstreamOrigin, validLocalEndpoint, type ProviderId,
} from './upstream-provider-catalog';

export type CredentialMode = 'custom_unified' | 'custom_passthrough';
export interface ModelAuthFields { provider_id?: ProviderId; credential_kind?: 'api_key' | 'chatgpt_oauth'; credential_ref?: string }
export interface ModelGroup extends ModelAuthFields {
  group_id: string;
  group_type: 'default' | 'custom';
  name: string;
  agents: string[];
  enabled: boolean;
  mode: 'official' | CredentialMode;
  base_url: string;
  api_key_masked: string;
  model_id: string;
  version: number;
}
export interface ExtractionModel extends ModelAuthFields {
  group_id?: string;
  configured: boolean;
  enabled: boolean;
  base_url?: string;
  api_key_masked?: string;
  model_id?: string;
  version?: number;
}
export interface ModelDraft {
  credential_kind: 'api_key' | 'chatgpt_oauth';
  credential_ref: string;
  group_id?: string;
  version?: number;
  name: string;
  agents: string[];
  provider: ProviderId;
  base_url: string;
  model_id: string;
  api_key: string;
  mode: CredentialMode;
  custom_model: boolean;
}
export type DraftField = 'name' | 'base_url' | 'model_id' | 'api_key';
export type DraftErrors = Partial<Record<DraftField, string>>;

export function emptyModelDraft(): ModelDraft {
  return {
    name: '', agents: [], provider: 'deepseek', base_url: PROVIDERS[0].baseUrls[0], credential_kind: 'api_key', credential_ref: '',
    model_id: PROVIDERS[0].models[0], api_key: '', mode: 'custom_unified', custom_model: false,
  };
}

export function draftFromGroup(group: ModelGroup): ModelDraft {
  const provider = group.provider_id ?? providerForUrl(group.base_url);
  return {
    ...emptyModelDraft(), group_id: group.group_id, version: group.version, name: group.name,
    agents: [...group.agents], provider, base_url: group.base_url, model_id: group.model_id,
    mode: group.mode === 'custom_passthrough' ? 'custom_passthrough' : 'custom_unified',
    credential_kind: group.credential_kind ?? 'api_key', credential_ref: group.credential_ref ?? '',
    custom_model: !PROVIDERS.find((entry) => entry.id === provider)?.models.includes(group.model_id),
  };
}

export function draftFromExtraction(extraction: ExtractionModel): ModelDraft {
  if (!extraction.configured) return emptyModelDraft();
  const provider = extraction.provider_id ?? providerForUrl(extraction.base_url ?? '');
  return {
    ...emptyModelDraft(), version: extraction.version, provider, group_id: extraction.group_id,
    credential_kind: extraction.credential_kind ?? 'api_key', credential_ref: extraction.credential_ref ?? '',
    base_url: extraction.base_url ?? '', model_id: extraction.model_id ?? '',
    custom_model: !PROVIDERS.find((entry) => entry.id === provider)?.models.includes(extraction.model_id ?? ''),
  };
}

export function canReuseModelKey(draft: ModelDraft, saved?: ModelGroup | ExtractionModel): boolean {
  return draft.credential_kind !== 'chatgpt_oauth' && saved?.credential_kind !== 'chatgpt_oauth' &&
    !!saved?.api_key_masked && (saved.provider_id ?? providerForUrl(saved.base_url ?? '')) === draft.provider && sameUpstreamOrigin(saved.base_url ?? '', draft.base_url);
}

export function validateModelDraft(
  draft: ModelDraft, saved?: ModelGroup | ExtractionModel, extraction = false,
): DraftErrors {
  const errors: DraftErrors = {};
  if (!extraction) {
    const name = draft.name.trim();
    if (!name) errors.name = '请给模型组起一个名称，例如“DeepSeek 开发组”。';
    else if (name.length > 64 || /[\n\r"'<>/\\]/.test(name)) {
      errors.name = '组名最多 64 个字符，不能包含换行、引号、尖括号或斜杠。';
    }
  }
  let validUrl = false;
  if (draft.provider === 'local') validUrl = validLocalEndpoint(draft.base_url);
  else {
    try {
      const url = new URL(draft.base_url);
      validUrl = url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
    } catch { /* The field below explains the required URL format. */ }
  }
  if (!validUrl) errors.base_url = draft.provider === 'local'
    ? '请填写容器可访问的模型地址，例如 http://host.docker.internal:11434/v1；不要使用 localhost。'
    : '请填写 HTTPS API 基础地址，不要在地址中放用户名、Key、查询参数或片段。';
  if (!draft.model_id.trim()) errors.model_id = '请选择一个模型，或填写供应商提供的模型 ID。';
  if (draft.credential_kind === 'chatgpt_oauth') {
    if (!draft.credential_ref) errors.api_key = '请先登录并选择 ChatGPT 连接。';
    if (draft.provider !== 'openai' || draft.mode !== 'custom_unified') errors.api_key = 'ChatGPT 订阅仅用于 OpenAI 服务器认证。';
    if (!extraction && draft.agents.some((agent) => agent !== 'codex')) errors.model_id = '当前订阅对话只支持 Codex 客户端。';
  } else if (extraction || draft.mode === 'custom_unified') {
    const key = draft.api_key.trim();
    if (key.startsWith('sk-mem-')) errors.api_key = '这里需要模型供应商的 API Key；sk-mem- 开头的 User Key 用于登录和客户端接入。';
    else if (!key && !canReuseModelKey(draft, saved)) {
      errors.api_key = '请填写模型供应商后台生成的 API Key。新建组或更换供应商地址时需要独立填写。';
    }
  }
  return errors;
}

export function modelWriteRequest(draft: ModelDraft, extraction?: ExtractionModel) {
  const fields = {
    provider_id: draft.provider, credential_kind: draft.credential_kind, credential_ref: draft.credential_kind === 'chatgpt_oauth' ? draft.credential_ref : '',
    base_url: draft.base_url.trim(), model_id: draft.model_id.trim(),
    ...(draft.credential_kind !== 'chatgpt_oauth' && (extraction || draft.mode === 'custom_unified') && draft.api_key.trim()
      ? { api_key: draft.api_key.trim() } : {}),
  };
  if (extraction) return {
    action: `instance-upstream/extraction/${extraction.configured ? 'update' : 'create'}`,
    body: { ...fields, ...(extraction.configured ? { expected_version: draft.version } : {}) },
  };
  return {
    action: `instance-upstream/groups/${draft.group_id ? 'update' : 'create'}`,
    body: {
      ...fields, group_type: 'custom', name: draft.name.trim(), agents: draft.agents, mode: draft.mode,
      ...(draft.group_id ? { group_id: draft.group_id, expected_version: draft.version } : {}),
    },
  };
}

/** A successful write stays successful when refreshing the page data fails. */
export async function writeModelAndReload(write: () => Promise<unknown>, reload: () => Promise<void>) {
  await write();
  try { await reload(); return { refreshFailed: false }; }
  catch { return { refreshFailed: true }; }
}

export function modelFailureMessage(cause: unknown): string {
  const error = cause && typeof cause === 'object' ? cause : {};
  const code = 'code' in error ? String(error.code) : '';
  // Core uses numeric envelope codes and prefixes the message with a named code.
  const raw = 'rawMessage' in error && typeof error.rawMessage === 'string' ? error.rawMessage : '';
  const namedCode = raw.match(/^([A-Z_]+|permission_denied)(?=:|$)/)?.[1] ?? '';
  const messages: Record<string, string> = {
    CHATGPT_REAUTH_REQUIRED: 'ChatGPT 连接已失效，请重新登录。',
    CHATGPT_MODEL_NOT_AVAILABLE: '该模型不在当前订阅账号的列表中，请获取模型后重新选择。',
    CHATGPT_PLAN_PERMISSION_REQUIRED: '此连接未获得 ChatGPT 计划用量权限，请重新登录并完成授权。',
    CHATGPT_QUOTA_EXCEEDED: 'ChatGPT 可用额度不足，请查看用量或手动切换模型配置。',
    CHATGPT_PERMISSION_DENIED: 'ChatGPT 账号未获得此次调用权限，请检查授权与所选模型。',
    CHATGPT_STREAM_INTERRUPTED: 'ChatGPT 响应中途断开，此次调用未完成。',
    CHATGPT_RESPONSE_FAILED: 'ChatGPT 未完成此次响应，请检查账号状态后重试。',
    CHATGPT_UPSTREAM_UNAVAILABLE: 'ChatGPT 服务暂不可用，请稍后重试。',
    CHATGPT_CONNECTION_UNAVAILABLE: '暂时无法读取 ChatGPT 连接，请检查 Core 服务。',
    MODEL_AUTH_REQUIRED: '供应商凭据无效，请检查 Key 或重新登录。',
    MODEL_PERMISSION_DENIED: '供应商凭据缺少读取模型列表的权限。',
    MODEL_QUOTA_EXCEEDED: '供应商请求受到额度或频率限制，请稍后重试。',
    MODEL_DISCOVERY_REQUIRES_OFFICIAL_ENDPOINT: '此地址不支持自动发现，可手动填写模型 ID。',
    MODEL_CONNECTION_BUSY: '该连接正在更新，请稍后重试。',
    CHATGPT_ACCOUNT_MISMATCH: '登录账号与所选连接不一致，请使用原账号或新增连接。',
    CHATGPT_AUTHORIZATION_DENIED: '本次 ChatGPT 授权已取消。',
    CHATGPT_LOGIN_EXPIRED: '登录请求已过期或 Panel 已重启，请重新登录。',
    CHATGPT_CODEX_ONLY: '订阅对话当前只支持 Codex；总结模型可单独配置。',
    MODEL_SOURCE_UNAVAILABLE: '模型来源暂不可用，已保留上次成功列表。',
    DUPLICATE_GROUP_NAME: '模型组名称已存在，请换一个名称。',
    MISSING_GROUP_NAME: '请检查组名：最多 64 个字符，不含引号或斜杠。',
    AGENTS_OVERLAP: '客户端已经分配给其他组。请先在原组移出并保存，再分配到目标组。',
    INVALID_AGENTS: '客户端列表已变化，请取消编辑并刷新配置后重新选择。',
    WRITE_CONFLICT: '配置已被其他操作更新。请取消编辑并刷新配置，核对最新内容后再保存。',
    GROUP_NOT_FOUND: '此模型组已被删除，请取消编辑并刷新配置。',
    MISSING_API_KEY: '请填写目标模型供应商的 API Key。更换供应商地址后不能沿用旧 Key。',
    INVALID_BASE_URL: '模型服务地址无效，请检查 API 基础地址。',
    permission_denied: '只有 system admin 可以管理当前实例的模型配置。',
    PERMISSION_DENIED: '只有 system admin 可以管理当前实例的模型配置。',
    EXTRACTION_ALREADY_CONFIGURED: '总结模型已存在，请取消编辑并刷新配置后修改。',
    EXTRACTION_NOT_CONFIGURED: '总结模型配置已被删除，请取消编辑并刷新配置。',
    PROXY_PROBE_UNAVAILABLE: '测试服务暂时不可用，请检查 Proxy 服务后重试。',
    PROXY_PROBE_FAILED: '连接测试未通过，请检查供应商地址、模型和 Key 后重试。',
    PROXY_PROBE_NOT_CONFIGURED: '连接测试尚未配置，请联系部署管理员检查 Proxy 设置。',
  };
  return messages[code] ?? messages[namedCode] ?? '操作失败，请检查服务状态后重试。';
}
