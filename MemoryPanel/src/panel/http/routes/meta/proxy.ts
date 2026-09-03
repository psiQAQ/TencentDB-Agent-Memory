import type { Hono } from 'hono';
import type { MetaAction } from '../../../api/meta-actions.js';
import {
  ALLOWED_PANEL_ACTIONS,
  isNotInScopeAction,
} from '../../../api/meta-actions.js';
import type { PanelDeps } from '../../../panel-deps.js';
import { validatePanelMetaHeaders } from '../../middleware/validate-panel-headers.js';
import { respondControlError, respondEnvelope } from '../../envelope.js';
import type { MetaCallContext } from '../../../kernel/types.js';
import { KNOWLEDGE_SERVICE_USERNAME } from '../../../startup/ensure-knowledge-llm-binding.js';
import { DEFAULT_SKILLS } from './default-skills.js';
import { extractListItems, isCallerSystemAdmin, resolveCallerUserId } from '../knowledge/common.js';
import {
  getAgentTemplate as readTemplateFile,
  saveAgentTemplate as writeTemplateFile,
  type AgentTemplateConfig,
} from '../../../state/agent-template-store.js';

/**
 * Hide the internal per-instance `knowledge-service` billing user from panel user
 * listings (design 009 §4.2). Mutates the envelope's paginated `items`/`total` in place.
 */
function hideKnowledgeServiceUser(data: unknown): void {
  if (!data || typeof data !== 'object') return;
  const d = data as { items?: Array<{ username?: string }>; total?: number };
  if (!Array.isArray(d.items)) return;
  const before = d.items.length;
  d.items = d.items.filter((u) => u.username !== KNOWLEDGE_SERVICE_USERNAME);
  const removed = before - d.items.length;
  if (removed > 0 && typeof d.total === 'number') {
    d.total = Math.max(0, d.total - removed);
  }
}

function readAction(path: string): string {
  const marker = '/meta/';
  const idx = path.indexOf(marker);
  if (idx < 0) return '';
  return path.slice(idx + marker.length);
}

/** 默认 Agent 模板只按真实 Team membership 授权，不继承 system_admin 全局身份。 */
async function getCallerActiveTeamRole(
  deps: PanelDeps,
  ctx: MetaCallContext,
  teamId: string,
): Promise<'admin' | 'member' | 'reviewer' | null> {
  const userId = await resolveCallerUserId(deps, ctx);
  if (!userId || !teamId) return null;
  try {
    const envelope = await deps.metaKernel.invoke(
      'team-member/get',
      { team_id: teamId, user_id: userId },
      ctx,
    );
    if (envelope.code !== 0 || !envelope.data) return null;
    const member = envelope.data as { user_id?: string; role?: string; status?: string };
    if (member.user_id !== userId || member.status === 'removed') return null;
    return member.role === 'admin' || member.role === 'member' || member.role === 'reviewer'
      ? member.role
      : null;
  } catch {
    return null;
  }
}

// ── 创建时重复名称检查 ──

interface DupCheckConfig {
  /** 用来查重的 list action。 */
  listAction: string;
  /** 从 create body 构造 list 请求体（限定可见范围）。 */
  listBody: (body: Record<string, unknown>) => Record<string, unknown>;
  /** 内核新增的精确过滤参数名。 */
  filterParam: string;
  /** 从 create body 提取待匹配的值。 */
  matchValue: (body: Record<string, unknown>) => string | undefined;
  /** 中文实体名，用于错误消息。 */
  entityLabel: string;
}

const DUP_CHECK_MAP: Record<string, DupCheckConfig> = {
  'user/create': {
    listAction: 'user/list',
    listBody: () => ({}),
    filterParam: 'username',
    matchValue: (b) => (typeof b.username === 'string' ? b.username : undefined),
    entityLabel: '用户',
  },
  // user/create 的姊妹接口：查重口径与 user/create 完全一致（先按 username 精确 list）。
  // user_key 的重复由内核 duplicate_user_key(409) 兜底，Panel 直接透传。
  'user/create-with-key': {
    listAction: 'user/list',
    listBody: () => ({}),
    filterParam: 'username',
    matchValue: (b) => (typeof b.username === 'string' ? b.username : undefined),
    entityLabel: '用户',
  },
  'team/create': {
    listAction: 'team/list',
    listBody: (b) => ({ user_id: b.owner_user_id }),
    filterParam: 'name',
    matchValue: (b) => (typeof b.name === 'string' ? b.name : undefined),
    entityLabel: '团队',
  },
  'agent/create': {
    listAction: 'agent/list',
    // 面板「删除」走 agent/archive（status→inactive），列表只展示 active；
    // 查重须同样过滤，否则归档后同名重建会被误拦 409。
    listBody: (b) => ({ team_id: b.team_id, owner_user_id: b.owner_user_id, status: 'active' }),
    filterParam: 'name',
    matchValue: (b) => (typeof b.name === 'string' ? b.name : undefined),
    entityLabel: 'Agent',
  },
  'task/create': {
    listAction: 'task/list',
    // 面板删 Task 走物理 task/delete；completed 仍在工作台可见，故查重含全部状态。
    listBody: (b) => ({ team_id: b.team_id, creator_user_id: b.creator_user_id }),
    filterParam: 'title',
    matchValue: (b) => (typeof b.title === 'string' ? b.title : undefined),
    entityLabel: 'Task',
  },
};

/**
 * 对 create 类 action 做"先查后写"重复检查。
 * 返回 null 表示不重复；否则返回中文错误消息。
 */
async function checkDuplicate(
  action: string,
  body: Record<string, unknown>,
  ctx: MetaCallContext,
  deps: PanelDeps,
): Promise<string | null> {
  const config = DUP_CHECK_MAP[action];
  if (!config) return null;

  const targetValue = config.matchValue(body);
  if (!targetValue) return null;

  const listBody = {
    ...config.listBody(body),
    [config.filterParam]: targetValue,
    limit: 1,
  };

  try {
    const envelope = await deps.metaKernel.invoke(config.listAction, listBody, ctx);
    if (envelope.code === 0) {
      // 以返回 items 中的精确同名为准；部分内核版本可能暂不支持 name 过滤，
      // 不能因为 items 非空就误判重复。
      const data = envelope.data as { items?: unknown[] } | undefined;
      if (Array.isArray(data?.items)) {
        const duplicated = data.items.some((item) => {
          if (!item || typeof item !== 'object') return false;
          const value = (item as Record<string, unknown>)[config.filterParam];
          return typeof value === 'string' && value === targetValue;
        });
        if (duplicated) {
          return `已存在同名${config.entityLabel}「${targetValue}」，请更换名称后重试。`;
        }
      }
    }
  } catch {
    // 查重失败时放行，宁可允许重复也不错杀正常创建
  }
  return null;
}

// ── 路由注册 ──

export function registerMetaProxyRoutes(api: Hono, deps: PanelDeps): void {
  api.post('/meta/*', validatePanelMetaHeaders(deps), async (c) => {
    const action = readAction(c.req.path);
    if (!action) {
      return respondControlError(c, 404, 'UNKNOWN_META_ACTION');
    }

    if (isNotInScopeAction(action)) {
      return respondControlError(c, 501, 'NOT_IN_SCOPE');
    }

    if (!ALLOWED_PANEL_ACTIONS.has(action as MetaAction)) {
      return respondControlError(c, 404, 'UNKNOWN_META_ACTION');
    }

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    } catch {
      body = {};
    }

    const panelMeta = c.get('panelMeta');
    const ctx: MetaCallContext = {
      instanceId: panelMeta.instanceId,
      gatewayEndpoint: panelMeta.gatewayEndpoint,
      gatewayApiKey: panelMeta.gatewayApiKey,
      userKey: panelMeta.userKey,
      reqId: c.get('reqId'),
    };

    // user/create 只有 system_admin 有权调用。普通用户直接交由内核返回 403，
    // 不先发一个缺少 team_id、注定失败的 user/list 查重请求。
    const isUserCreate = action === 'user/create' || action === 'user/create-with-key';
    const canCheckDuplicate = !isUserCreate || await isCallerSystemAdmin(deps, ctx);
    // create 类 action：先查重
    const duplicateMsg = canCheckDuplicate ? await checkDuplicate(action, body, ctx, deps) : null;
    if (duplicateMsg) {
      return respondControlError(c, 409, duplicateMsg);
    }

    // ── 默认 Agent 模板读写：Panel 直接读写本地文件（不转发内核）──
    if (action === 'agent/set-default-template') {
      const teamId = typeof body.team_id === 'string' ? body.team_id : '';
      const template = body.template;
      if (!teamId || !template || typeof template !== 'object') {
        return respondControlError(c, 400, 'INVALID_PARAM');
      }
      if ((await getCallerActiveTeamRole(deps, ctx, teamId)) !== 'admin') {
        return respondControlError(c, 403, 'permission_denied');
      }
      writeTemplateFile(deps.config.agentTemplateDir, ctx.instanceId, teamId, template as AgentTemplateConfig);
      return respondEnvelope(c, { code: 0, message: 'ok', request_id: ctx.reqId ?? '', data: { ok: true } });
    }
    if (action === 'agent/get-default-template') {
      const teamId = typeof body.team_id === 'string' ? body.team_id : '';
      if (!teamId) return respondControlError(c, 400, 'INVALID_PARAM');
      if (!(await getCallerActiveTeamRole(deps, ctx, teamId))) {
        return respondControlError(c, 403, 'permission_denied');
      }
      const template = teamId ? readTemplateFile(deps.config.agentTemplateDir, ctx.instanceId, teamId) : null;
      return respondEnvelope(c, { code: 0, message: 'ok', request_id: ctx.reqId ?? '', data: template ?? {} });
    }

    const envelope = await deps.metaKernel.invoke(action, body, ctx);

    if (action === 'user/list' && envelope.code === 0) {
      hideKnowledgeServiceUser(envelope.data);
    }
    // 切私密后：不再由 backend 主动 prune 其它 agent 的绑定。
    // 内核权限模型下 caller 只能 set 自己 owner 的 agent，跨 owner 会 403。
    // 保留脏 binding 也无害：injection / memory-bridge / 面板详情页在读侧调
    // apply_visibility_filter=true 过滤掉 canBindAsset=false 的项。
    return respondEnvelope(c, envelope);
  });
}

// ── 用户显式确认后创建默认 Agent 与模板资产 ──

// 默认 Agent 预置字段（对齐内核 DEFAULT_AGENT_*，无模板时建 default-agent 用）
const DEFAULT_AGENT_NAME = 'default-agent';
const DEFAULT_AGENT_DESCRIPTION = '默认助手，可处理通用开发任务与日常协作。';
const DEFAULT_AGENT_PROMPT = '';
const DEFAULT_AGENT_METADATA = { ui: { role_prompt: '', rules_prompt: '' } };

export interface DefaultAgentProvisionResult {
  agent_id: string;
  agent_name: string;
  agent_created: boolean;
  failed_assets: string[];
}

function provisioningMetadata(raw: string | undefined, teamId: string, userId: string): string {
  let parsed: Record<string, unknown> = {};
  try {
    const value = JSON.parse(raw ?? '{}') as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  return JSON.stringify({
    ...parsed,
    panel_provisioning: {
      source: 'default_template',
      schema_version: 1,
      team_id: teamId,
      created_for_user_id: userId,
    },
  });
}

/**
 * 有模板 → 建同名 Agent（owner=新用户）→ 复制模板资产（skill fork / code_graph·wiki allocate）；
 * 无模板 → 建 default-agent-{username} → 导入预置 Skill。
 */
export async function provisionDefaultAgentForCaller(
  userId: string,
  teamId: string,
  ctx: MetaCallContext,
  deps: PanelDeps,
): Promise<DefaultAgentProvisionResult> {

  // 1. 读本地模板文件
  const template = readTemplateFile(deps.config.agentTemplateDir, ctx.instanceId, teamId);
  const hasTemplate = !!template?.name;

  // 2. 拿 username（拼 default-agent 名）
  const userEnv = await deps.metaKernel.invoke('user/get', { user_id: userId }, ctx);
  if (userEnv.code !== 0) throw new Error(userEnv.message || 'USER_LOOKUP_FAILED');
  const user = userEnv.code === 0 ? (userEnv.data as { username?: string } | null) : null;
  const defaultAgentName = `${DEFAULT_AGENT_NAME}-${user?.username ?? userId}`;

  // 3. 决定目标 Agent：有模板同名 / 无模板 default-agent
  const agentName = hasTemplate ? template!.name : defaultAgentName;

  // 4. 幂等查重：已存在同名 active agent 则跳过建本体
  const agentsEnv = await deps.metaKernel.invoke('agent/list', {
    team_id: teamId,
    owner_user_id: userId,
    status: 'active',
    limit: 50,
    offset: 0,
  }, ctx);
  if (agentsEnv.code !== 0) throw new Error(agentsEnv.message || 'AGENT_LIST_FAILED');
  const agents = agentsEnv.code === 0
    ? ((agentsEnv.data as { items?: Array<{ agent_id: string; name: string; metadata_json?: string }> })?.items ?? [])
    : [];
  const markedAgent = agents.find((candidate) => {
    try {
      const metadata = JSON.parse(candidate.metadata_json ?? '{}') as {
        panel_provisioning?: { source?: string; team_id?: string; created_for_user_id?: string };
      };
      return metadata.panel_provisioning?.source === 'default_template'
        && metadata.panel_provisioning.team_id === teamId
        && metadata.panel_provisioning.created_for_user_id === userId;
    } catch {
      return false;
    }
  });
  let defaultAgent = markedAgent ?? agents.find((a) => a.name === agentName);
  let agentCreated = false;

  if (!defaultAgent) {
    // 建本体（owner=新用户；有模板用模板字段，无模板用 default-agent 预置字段）
    const createEnv = await deps.metaKernel.invoke('agent/create', {
      team_id: teamId,
      owner_user_id: userId,
      name: agentName,
      description: hasTemplate ? template!.description ?? null : DEFAULT_AGENT_DESCRIPTION,
      prompt: hasTemplate ? template!.prompt ?? '' : DEFAULT_AGENT_PROMPT,
      visibility: hasTemplate ? template!.visibility ?? 'team' : 'team',
      metadata_json: provisioningMetadata(
        hasTemplate ? template!.metadata_json : JSON.stringify(DEFAULT_AGENT_METADATA),
        teamId,
        userId,
      ),
      status: 'active',
    }, ctx);
    if (createEnv.code !== 0) {
      deps.logger.warn('create default agent failed', {
        instanceId: ctx.instanceId, userId, teamId, agentName,
        code: createEnv.code, message: createEnv.message,
      });
      throw new Error(createEnv.message || 'DEFAULT_AGENT_CREATE_FAILED');
    }
    agentCreated = true;
    defaultAgent = {
      agent_id: (createEnv.data as { agent_id: string }).agent_id,
      name: agentName,
    };
  }

  // 5. 有模板 → 复制资产；无模板 → 导入预置 skill
  const failedAssets = hasTemplate
    ? await cloneTemplateAssets(deps, ctx, userId, teamId, template!, defaultAgent.agent_id)
    : await importDefaultSkillsForAgent(userId, teamId, defaultAgent.agent_id, ctx, deps);
  return {
    agent_id: defaultAgent.agent_id,
    agent_name: defaultAgent.name,
    agent_created: agentCreated,
    failed_assets: failedAssets,
  };
}

/** 复制模板资产：skill fork 副本 + code_graph/wiki allocate 引用。 */
async function cloneTemplateAssets(
  deps: PanelDeps,
  ctx: MetaCallContext,
  userId: string,
  teamId: string,
  template: AgentTemplateConfig,
  agentId: string,
): Promise<string[]> {
  const failed: string[] = [];
  // skills：fork 独立副本
  for (const skillId of template.asset_ids?.skills ?? []) {
    try {
      await forkSkillToAgent(deps, ctx, userId, teamId, skillId, agentId);
    } catch (err) {
      failed.push(skillId);
      deps.logger.warn('fork template skill failed', {
        instanceId: ctx.instanceId, skillId, agentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // code_graph / wiki：allocate 引用
  const knowledgeIds: Array<{ assetId: string; assetType: string }> = [
    ...(template.asset_ids?.code_graphs ?? []).map((assetId) => ({ assetId, assetType: 'code_graph' })),
    ...(template.asset_ids?.wikis ?? []).map((assetId) => ({ assetId, assetType: 'llm_wiki' })),
  ];
  for (const k of knowledgeIds) {
    try {
      await allocateKnowledgeToAgent(deps, ctx, agentId, k.assetId, k.assetType);
    } catch (err) {
      failed.push(k.assetId);
      deps.logger.warn('allocate template knowledge failed', {
        instanceId: ctx.instanceId, assetId: k.assetId, agentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return failed;
}

/** fork skill 到目标 agent（get → files/read → create），复用前端 forkToAgent 的语义。 */
async function forkSkillToAgent(
  deps: PanelDeps,
  ctx: MetaCallContext,
  userId: string,
  teamId: string,
  sourceSkillId: string,
  targetAgentId: string,
): Promise<void> {
  const getEnv = await deps.skillKernel.invoke('get', {
    user_id: userId,
    team_id: teamId,
    skill_id: sourceSkillId,
    include_content: true,
    include_manifest: true,
  }, ctx);
  if (getEnv.code !== 0) throw new Error(`skill get failed: ${getEnv.code}`);
  const detail = getEnv.data as {
    name: string;
    content: string;
    manifest?: Array<{ path: string; is_executable?: boolean }>;
  };

  const resources: Array<{
    path: string;
    content: string;
    encoding: string;
    mime_type?: string;
    is_executable?: boolean;
  }> = [];
  for (const entry of detail.manifest ?? []) {
    try {
      const fEnv = await deps.skillKernel.invoke('files/read', {
        user_id: userId,
        team_id: teamId,
        skill_id: sourceSkillId,
        path: entry.path,
      }, ctx);
      if (fEnv.code === 0) {
        const f = fEnv.data as { path: string; content: string; encoding: string; mime_type?: string };
        resources.push({
          path: f.path,
          content: f.content,
          encoding: f.encoding,
          mime_type: f.mime_type,
          is_executable: entry.is_executable,
        });
      }
    } catch {
      /* 单个资源读取失败则跳过 */
    }
  }

  const createEnv = await deps.skillKernel.invoke('create', {
    user_id: userId,
    team_id: teamId,
    agent_id: targetAgentId,
    name: detail.name,
    content: detail.content,
    resources: resources.length ? resources : undefined,
    metadata: { forked_from: { skill_id: sourceSkillId, name: detail.name } },
  }, ctx);
  if (createEnv.code !== 0 && createEnv.code !== 42201) {
    throw new Error(`skill create failed: ${createEnv.code}`);
  }
}

/** 把 knowledge 资产（code_graph / wiki）引用绑定到 agent（list → append → set）。 */
async function allocateKnowledgeToAgent(
  deps: PanelDeps,
  ctx: MetaCallContext,
  agentId: string,
  assetId: string,
  assetType: string,
): Promise<void> {
  const caller = await resolveCallerUserId(deps, ctx);
  const listEnv = await deps.metaKernel.invoke('agent-fixed-asset/list', { agent_id: agentId }, ctx);
  if (listEnv.code !== 0) return;
  const bindings = extractListItems<{
    asset_id: string;
    asset_type: string;
    injection_mode?: string;
    priority?: number;
    created_by?: string;
  }>(listEnv);
  if (bindings.some((b) => b.asset_id === assetId)) return; // 已绑定，幂等跳过

  const newBindings = [
    ...bindings.map((b) => ({
      asset_id: b.asset_id,
      asset_type: b.asset_type,
      injection_mode: b.injection_mode ?? 'summary',
      priority: b.priority ?? 50,
      created_by: b.created_by,
    })),
    { asset_id: assetId, asset_type: assetType, injection_mode: 'tool', priority: 50, created_by: caller },
  ];
  const setEnv = await deps.metaKernel.invoke('agent-fixed-asset/set', { agent_id: agentId, bindings: newBindings }, ctx);
  if (setEnv.code !== 0) {
    throw new Error(`agent-fixed-asset/set failed: ${setEnv.code}`);
  }
}

// ── 用户确认后：为 default-agent 导入预置 Skill ──

async function importDefaultSkillsForAgent(
  userId: string,
  teamId: string,
  agentId: string,
  ctx: MetaCallContext,
  deps: PanelDeps,
): Promise<string[]> {
  const failed: string[] = [];
  for (const skill of DEFAULT_SKILLS) {
    try {
      const createEnv = await deps.skillKernel.invoke('create', {
        user_id: userId,
        team_id: teamId,
        agent_id: agentId,
        name: skill.name,
        content: skill.content,
      }, ctx);
      if (createEnv.code === 0) {
        deps.logger.info(`default skill "${skill.name}" created`, {
          instanceId: ctx.instanceId,
          agentId,
        });
      } else if (createEnv.code !== 42201) {
        failed.push(skill.name);
        deps.logger.warn(`default skill "${skill.name}" create failed`, {
          instanceId: ctx.instanceId,
          code: createEnv.code,
          message: createEnv.message,
        });
      }
    } catch (err) {
      failed.push(skill.name);
      deps.logger.warn(`default skill "${skill.name}" create error`, {
        instanceId: ctx.instanceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return failed;
}
