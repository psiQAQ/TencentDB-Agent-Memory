/**
 * api/agents.ts — Agent 管理（meta/agent/* + meta/agent-fixed-asset/*）。
 */
import { getPanelSession } from '../panelSession';
import { metaPost, metaListAll, getCurrentUser, request, ApiError } from './base';
import type { MetaEnvelope, Agent, AssetType, AssetStatus, FixedAssetBinding } from './types';

// ========================= 默认 Agent 模板 =========================

export interface AgentTemplateAssetIds {
  /** 团队 skill ID（skl-xxx） */
  skills?: string[];
  /** 团队 code graph ID（code-xxx） */
  code_graphs?: string[];
  /** 团队 wiki ID（wiki-xxx） */
  wikis?: string[];
}

/**
 * Team 默认 Agent 模板。模板集合由 Team 全体 active member 共同维护。
 * 注意：
 *   - asset_ids 为团队资产 ID 快照，只允许选 visibility=team 的公共资产；
 *   - 覆盖式写入：set 时需一次回传完整 template；
 *   - metadata_json 为 JSON 字符串，ui.role_prompt / ui.rules_prompt 存拆分 prompt。
 */
export interface AgentTemplateConfig {
  template_id: string;
  name: string;
  description?: string | null;
  prompt?: string | null;
  /** 'private' | 'team'(默认) | 'restricted' */
  visibility?: string;
  metadata_json?: string;
  asset_ids?: AgentTemplateAssetIds;
  created_by?: string | null;
  updated_by?: string | null;
  created_at: string;
  updated_at: string;
}

export type AgentTemplateInput = Omit<
  AgentTemplateConfig,
  'template_id' | 'created_by' | 'updated_by' | 'created_at' | 'updated_at'
>;

export const agentsApi = {
  /** 当前登录用户显式确认后，为自己创建 Team 默认 Agent。 */
  createDefault: async (teamId: string, templateId?: string) => {
    const session = getPanelSession();
    if (!session) throw new ApiError(401, 'Unauthorized', 'no active panel session');
    const envelope = await request<
      MetaEnvelope<{
        agent_id: string;
        agent_name: string;
        agent_created: boolean;
        failed_assets: string[];
      }>
    >(
      'POST',
      '/api/v1/agent/create-default',
      {
        team_id: teamId,
        template_id: templateId,
      },
      {
        'X-Tdai-Service-Id': session.instanceId,
        'X-Tdai-User-Key': session.userKey,
      },
    );
    const result = envelope.data;
    if (envelope.code !== 0 || !result) {
      throw new ApiError(envelope.code, envelope.message, '', {
        code: envelope.code,
        requestId: envelope.request_id,
        rawMessage: envelope.message,
      });
    }
    return result;
  },

  /**
   * 列出 team 下的 agents。
   *
   * @param teamId team ID
   * @param params.owner_user_id 可选：只返该 user owner 的 agent（"agent 私有可见性"场景，
   *   如 Skill 面板固定资产 tab）；不传则返 team 全量。`agent/list` 支持
   *   `team_id + owner_user_id` 组合过滤。
   */
  list: (teamId: string, params?: { owner_user_id?: string }) =>
    metaListAll<Agent>('agent/list', {
      team_id: teamId,
      status: 'active',
      owner_user_id: params?.owner_user_id,
    }),

  /** Agents 管理专用：同时列出 active 与 inactive，其他业务选择器仍只使用 list()。 */
  listIncludingInactive: async (teamId: string) => {
    const [active, inactive] = await Promise.all([
      metaListAll<Agent>('agent/list', { team_id: teamId, status: 'active' }),
      metaListAll<Agent>('agent/list', { team_id: teamId, status: 'inactive' }),
    ]);
    return [...new Map([...active, ...inactive].map((agent) => [agent.agent_id, agent])).values()];
  },

  /** agent 详情 */
  get: (agentId: string) => metaPost<Agent>('agent/get', { agent_id: agentId }),

  /** 创建 agent */
  create: async (
    teamId: string,
    data: { name: string; description?: string; prompt?: string; visibility?: string },
  ) => {
    const me = await getCurrentUser();
    return metaPost<Agent>('agent/create', {
      team_id: teamId,
      owner_user_id: me.user_id,
      name: data.name,
      description: data.description,
      prompt: data.prompt,
      visibility: data.visibility ?? 'team',
    });
  },

  /**
   * 更新 agent。
   *
   * `metadata_json` 是给前端自定义关系的兜底通道：后端 schema 未落地的展示字段
   * （如 icon / accent / 关联 user 等 UI-only 字段）可以序列化进这里的自定义 namespace。
   */
  update: (
    agentId: string,
    data: {
      name?: string;
      description?: string;
      prompt?: string;
      visibility?: string;
      status?: string;
      metadata_json?: string;
    },
  ) => metaPost<Agent>('agent/update', { agent_id: agentId, ...data }),

  /** 可恢复归档：仅把 Agent 设为 inactive，保留关联资产、backing data 和 bindings。 */
  archive: async (agentId: string) => {
    const session = getPanelSession();
    if (!session) {
      throw new ApiError(401, 'Unauthorized', 'no active panel session');
    }
    const envelope = await request<
      MetaEnvelope<{
        archived: boolean;
        agent_id: string;
        assets_preserved: boolean;
      }>
    >(
      'POST',
      '/api/v1/agent/archive',
      { agent_id: agentId },
      {
        'X-Tdai-Service-Id': session.instanceId,
        'X-Tdai-User-Key': session.userKey,
      },
    );
    if (envelope.code !== 0) {
      throw new ApiError(200, envelope.message, '', {
        code: envelope.code,
        requestId: envelope.request_id,
        rawMessage: envelope.message,
      });
    }
  },

  /** 恢复归档 Agent；关联资产从未删除，因此无需重新创建或重新绑定。 */
  restore: (agentId: string) =>
    metaPost<Agent>('agent/update', {
      agent_id: agentId,
      status: 'active',
    }),

  /** 获取 agent 的资产聚合视图（binding + asset 详情）。
   *  用 metaListAll 翻页拉全量（list-with-detail 默认 limit 20，绑定资产一多会被截断）。
   *
   *  applyVisibilityFilter：默认 true（屏蔽已私密的绑定，用于普通展示）。
   *  owner 视角管理自己的资产时应传 false —— 否则自己 owner 的 private skill
   *  会被接口过滤掉，导致 fixed tab 拿不到它的 visibility、共享/私密切换按钮消失。 */
  getAssets: async (agentId: string, applyVisibilityFilter = true) => {
    const items = await metaListAll<{
      asset_id: string;
      owner_user_id: string;
      asset_type: AssetType;
      name: string;
      description?: string;
      status: AssetStatus;
      visibility: string;
      injection_mode: FixedAssetBinding['injection_mode'];
      priority: number;
      created_at: string;
    }>('agent-fixed-asset/list-with-detail', {
      agent_id: agentId,
      apply_visibility_filter: applyVisibilityFilter,
      touch_usage: false,
    });
    return items.map((item) => ({
      asset_id: item.asset_id,
      owner_user_id: item.owner_user_id,
      asset_type: item.asset_type,
      name: item.name,
      description: item.description,
      status: item.status,
      visibility: item.visibility,
      injection_mode: item.injection_mode ?? 'direct',
      priority: item.priority,
      created_at: item.created_at,
    }));
  },

  /** 获取 agent 固定资产 binding（仅 binding 字段） */
  getFixedAssets: async (agentId: string) => {
    const rows = await metaListAll<{
      asset_id: string;
      asset_type: AssetType;
      injection_mode?: FixedAssetBinding['injection_mode'];
      priority: number;
    }>('agent-fixed-asset/list', { agent_id: agentId });
    return rows.map((r) => ({
      asset_id: r.asset_id,
      asset_type: r.asset_type,
      injection_mode: r.injection_mode,
      priority: r.priority,
    }));
  },

  /** 全量设置 agent 固定资产 */
  setFixedAssets: async (agentId: string, bindings: FixedAssetBinding[]) => {
    const me = await getCurrentUser();
    await metaPost<{ ok: boolean }>('agent-fixed-asset/set', {
      agent_id: agentId,
      bindings: bindings.map((b) => ({
        asset_id: b.asset_id,
        asset_type: b.asset_type,
        injection_mode: b.injection_mode ?? 'direct',
        priority: b.priority ?? 0,
        created_by: me.user_id,
      })),
    });
  },

  listDefaultTemplates: async (teamId: string) => {
    const result = await metaPost<{ items: AgentTemplateConfig[]; total: number }>(
      'agent/list-default-templates',
      { team_id: teamId },
    );
    return result.items;
  },

  createDefaultTemplate: (teamId: string, template: AgentTemplateInput) =>
    metaPost<AgentTemplateConfig>('agent/create-default-template', { team_id: teamId, template }),

  updateDefaultTemplate: (teamId: string, templateId: string, template: AgentTemplateInput) =>
    metaPost<AgentTemplateConfig>('agent/update-default-template', {
      team_id: teamId,
      template_id: templateId,
      template,
    }),

  deleteDefaultTemplate: (teamId: string, templateId: string) =>
    metaPost<{ deleted: boolean }>('agent/delete-default-template', {
      team_id: teamId,
      template_id: templateId,
    }),
};
