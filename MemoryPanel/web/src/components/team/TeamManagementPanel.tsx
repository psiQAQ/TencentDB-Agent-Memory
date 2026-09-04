/**
 * TeamManagementPanel — 团队管理。
 *
 * 承担「Team + 成员 + Agent」管理：
 *   - 顶部是当前 team 概览与 Team 设置入口；永久解散位于 owner-only Danger Zone。
 *   - 中部是当前 team 的成员管理：按 user_id 添加 / 删除成员
 *   - 下部是当前 team 的 Agent 卡片网格：新建 / 编辑 / 删除
 *
 * 数据存储（后端持久化）：
 *   - team/members/agent 均走 @/lib/teamApi；
 *   - 写操作成功后统一调用 invalidateBackendCache()，驱动 useTeams/useAgents 重新拉取；
 *   - 后端 schema 还没有的展示字段，序列化进 agent.metadata_json 的 "ui" namespace。
 *
 * Ownership 转交与永久清理由“我的资源依赖”统一编排；TeamSwitcher 只负责切换和创建。
 *
 * 文件拆分（本文件仅保留组合/编排逻辑，具体实现见同目录下）：
 *   - types.ts / useAgentAssets.ts / shared.tsx / AgentGrid.tsx / MemberSection.tsx /
 *     CreateTeamDialog.tsx / CreateAgentDialog.tsx / AgentEditDialog.tsx
 *   - Team 设置/Danger Zone 只使用安全 delete-preview + revision 流程。
 */

import { useState, useMemo } from 'react';
import { Alert, Button, Input } from 'tea-component';
import { useTranslation } from 'react-i18next';
import { UsergroupIcon, AddIcon } from 'tea-icons-react';
import {
  useTeams,
  useAgents,
  isTeamAdmin,
  canManageAsset,
  invalidateBackendCache,
  writeAgentUiMeta,
  writeActiveTeamId,
  type Agent as StoreAgent,
} from '@/services';
import { teamsApi, agentsApi, skillApi } from '@/lib/teamApi';
import { knowledgeApi } from '@/lib/api/knowledge-api';
import { useDisplayNameResolver } from '@/services/user-profile-store';
import { tea } from '@/lib/tea-bridge';
import { getErrorMessage } from '@/lib/error-message';
import './team-management-panel.css';

import { MAX_IMPORTED_CHAT_MEMORIES, importedChatMemoryIds, type AgentCard } from './types';
import { useAgentMountedCounts, syncChatMemoryBindings } from './useAgentAssets';
import AgentGrid from './AgentGrid';
import { TeamHeaderCard } from './TeamHeaderCard';
import { MemberSection, AddMemberDialog } from './MemberSection';
import CreateTeamDialog from './CreateTeamDialog';
import CreateAgentDialog from './CreateAgentDialog';
import AgentEditDialog from './AgentEditDialog';
import DefaultAgentTemplateSection from './DefaultAgentTemplateSection';
import EditTeamDialog from './EditTeamDialog';

function errMsg(e: unknown): string {
  return getErrorMessage(e);
}

// =================== Component ===================

export default function TeamManagementPanel({
  currentUser,
  section = 'all',
}: {
  currentUser: string;
  /**
   * 控制本面板渲染哪一块内容（拆 tab 用，功能完全不变）：
   *   - 'members'：仅成员管理
   *   - 'agents' ：仅 Agent 管理
   *   - 'all'    ：两者都渲染（向后兼容旧的单页用法）
   */
  section?: 'members' | 'agents' | 'all';
}) {
  const showMembers = section === 'members' || section === 'all';
  const showAgents = section === 'agents' || section === 'all';
  const { activeTeamId, activeTeam, loading: teamsLoading } = useTeams();
  // 只取当前 team 的 agent — agent 严格归属 team，不会跨 team 显示
  const { agents: allAgents, loading: agentsLoading } = useAgents(activeTeamId, true);
  const { t } = useTranslation();
  // Agent 可见性：
  //   - 当前 team 的 admin(owner)：可见 team 内全部 agent
  //   - 普通成员：只能看到自己 owner（创建）的 agent
  const canSeeAllAgents = !!activeTeam && isTeamAdmin(activeTeam, currentUser);
  const agents = useMemo(() => {
    if (!activeTeam || canSeeAllAgents) return allAgents;
    return allAgents.filter((a) => a.owner_user_id === currentUser);
  }, [allAgents, activeTeam, canSeeAllAgents, currentUser]);
  const { counts: mountedCounts, countsLoading } = useAgentMountedCounts(activeTeamId, agents);
  // 通知文案里展示 display_name 而非 user_id（复用全局缓存，幂等无额外请求）
  const resolveUserName = useDisplayNameResolver();

  const [showCreateAgent, setShowCreateAgent] = useState(false);
  const [showCreateTeam, setShowCreateTeam] = useState(false);
  const [showAddMember, setShowAddMember] = useState(false);
  const [editingAgent, setEditingAgent] = useState<StoreAgent | null>(null);
  const [busy, setBusy] = useState(false);
  const [showTeamSettings, setShowTeamSettings] = useState(false);
  const [editingTeamSettings, setEditingTeamSettings] = useState(false);
  const [deleteName, setDeleteName] = useState('');
  const [deletePreview, setDeletePreview] = useState<Awaited<
    ReturnType<typeof teamsApi.deletePreview>
  > | null>(null);

  async function handleCreateAgent(card: Omit<AgentCard, 'id' | 'icon' | 'accent'>) {
    if (!activeTeamId || !activeTeam) return;
    if (
      importedChatMemoryIds(activeTeamId, '__new_agent__', card.chatMemories).length >
      MAX_IMPORTED_CHAT_MEMORIES
    ) {
      tea.notify.error('IMPORT_LIMIT_EXCEEDED');
      return;
    }
    const accents: AgentCard['accent'][] = ['blue', 'purple', 'orange', 'emerald', 'rose', 'slate'];
    const icons = ['🤖', '✨', '⚡', '🎯', '🚀', '🧩'];
    const accent = accents[agents.length % accents.length];
    const icon = icons[agents.length % icons.length];
    setBusy(true);
    try {
      const created = await agentsApi.create(activeTeamId, {
        name: card.name,
        description: card.description,
        prompt: [card.rolePrompt, card.rulesPrompt].filter(Boolean).join('\n\n'),
        visibility: 'team',
      });
      const metadataJson = writeAgentUiMeta(created.metadata_json, {
        role_prompt: card.rolePrompt,
        rules_prompt: card.rulesPrompt,
        icon,
        accent,
      });
      await agentsApi.update(created.agent_id, { metadata_json: metadataJson });

      // 资产绑定统一走真实挂载接口（不写 metadata_json.ui）。串行执行，任一失败即抛错，
      // 由外层 catch 统一提示 —— 避免 allSettled 静默导致「显示绑了但实际没绑」。
      //   - skill → forkToAgent（复制 owner=新 agent 的独立副本）
      //   - code_graph / wiki → allocate（引用绑定）
      //   - chat_memory → syncChatMemoryBindings
      await syncChatMemoryBindings(activeTeamId, created.agent_id, card.chatMemories);
      for (const skillId of card.skills) {
        await skillApi.forkToAgent(activeTeamId, skillId, created.agent_id);
      }
      for (const id of card.codeGraphs) {
        await knowledgeApi.code.allocate(activeTeamId, id, created.agent_id);
      }
      for (const id of card.llmWikis) {
        await knowledgeApi.wiki.allocate(activeTeamId, id, created.agent_id);
      }

      invalidateBackendCache();
    } catch (err) {
      tea.notify.error(errMsg(err));
      setBusy(false);
      return;
    }
    setBusy(false);
    setShowCreateAgent(false);
  }

  async function handleArchiveAgent(agent: StoreAgent) {
    if (!activeTeamId || !activeTeam) return;
    if (
      !canManageAsset(
        { owner_user_id: agent.owner_user_id, team_id: agent.team_id },
        activeTeam,
        currentUser,
        false,
      )
    ) {
      tea.notify.error(
        t('team.deleteAgent.noPermission', {
          name: agent.name,
          id: agent.agent_id,
          teamName: activeTeam.name,
          owner: agent.owner_user_id
            ? resolveUserName(agent.owner_user_id)
            : t('team.deleteAgent.ownerUnset'),
        }),
      );
      return;
    }
    const ok = await tea.confirm({
      message: t('team.deleteAgent.confirm', { name: agent.name }),
      description: t('team.deleteAgent.desc', { id: agent.agent_id }),
      okText: t('team.deleteAgent.action'),
    });
    if (!ok) return;
    try {
      await agentsApi.archive(agent.agent_id);
      invalidateBackendCache();
      tea.notify.success(t('team.deleteAgent.success', { name: agent.name }));
    } catch (err) {
      tea.notify.error(errMsg(err));
    }
  }

  async function handleRestoreAgent(agent: StoreAgent) {
    try {
      await agentsApi.restore(agent.agent_id);
      invalidateBackendCache();
      tea.notify.success(t('team.restoreAgent.success', { name: agent.name }));
    } catch (err) {
      tea.notify.error(errMsg(err));
    }
  }

  async function handleCreateDefaultAgent() {
    if (!activeTeamId) return;
    let description = t('agentGrid.defaultCreate.descFallback');
    try {
      const template = await agentsApi.getDefaultTemplate(activeTeamId);
      if (template?.name) {
        description = t('agentGrid.defaultCreate.descTemplate', {
          name: template.name,
          skills: template.asset_ids?.skills?.length ?? 0,
          codeGraphs: template.asset_ids?.code_graphs?.length ?? 0,
          wikis: template.asset_ids?.wikis?.length ?? 0,
        });
      }
    } catch (err) {
      tea.notify.error(errMsg(err));
      return;
    }
    const ok = await tea.confirm({
      message: t('agentGrid.defaultCreate.confirm'),
      description,
      okText: t('agentGrid.defaultCreate.action'),
    });
    if (!ok) return;
    setBusy(true);
    try {
      const result = await agentsApi.createDefault(activeTeamId);
      invalidateBackendCache();
      if (result.failed_assets.length > 0) {
        tea.notify.warning(
          t('agentGrid.defaultCreate.partial', { count: result.failed_assets.length }),
        );
      } else {
        tea.notify.success(t('agentGrid.defaultCreate.success', { name: result.agent_name }));
      }
    } catch (err) {
      tea.notify.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateTeam(input: { name: string; description: string }) {
    setBusy(true);
    try {
      await teamsApi.create(input);
      invalidateBackendCache();
    } catch (err) {
      tea.notify.error(errMsg(err));
      setBusy(false);
      return;
    }
    setBusy(false);
    setShowCreateTeam(false);
  }

  async function refreshDeletePreview() {
    if (!activeTeamId) return;
    try {
      setDeletePreview(await teamsApi.deletePreview(activeTeamId));
    } catch (err) {
      tea.notify.error(errMsg(err));
    }
  }

  async function handleUpdateTeam(input: { name: string; description: string }) {
    if (!activeTeamId) return;
    await teamsApi.update(activeTeamId, input);
    invalidateBackendCache();
    setEditingTeamSettings(false);
  }

  async function handleDeleteTeam() {
    if (!activeTeam || !deletePreview || deleteName !== activeTeam.name) return;
    try {
      await teamsApi.delete(activeTeam.team_id, activeTeam.name, deletePreview.revision);
      writeActiveTeamId(null);
      invalidateBackendCache();
      setShowTeamSettings(false);
    } catch (err) {
      tea.notify.error(errMsg(err));
      await refreshDeletePreview();
    }
  }

  return (
    <div className="_memory-team-mgmt">
      {/* === Header: 当前 team 概览 + ops ===
        切 team 的入口只在左上角全局 TeamSwitcher（App.tsx），这里不再提供
        平铺 chips 的切换入口，避免跟全局切换器形成两个语义重叠的控件。
        本卡片只承担三件事：
          1. 告诉用户「我现在操作的是哪个 team」（name + team_id + 成员数 + 描述）
          2. 提供 team 级的操作（+ 新建 Team / + 新建 Agent）
          3. 当尚未选 team 时，给出引导 */}
      {teamsLoading ? (
        <div className="_memory-panel-card">
          <div className="_memory-team-header-row">
            <div className="_memory-team-header-info">
              <div className="_memory-team-header-avatar" style={{ opacity: 0.3 }}>
                …
              </div>
              <div className="_memory-team-header-meta">
                <div className="_memory-team-header-meta-row">
                  <span
                    className="_memory-team-header-name"
                    style={{ color: 'var(--muted-foreground)' }}
                  >
                    {t('team.loading')}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : activeTeam ? (
        <TeamHeaderCard
          team={activeTeam}
          ops={
            <>
              <Button onClick={() => setShowCreateTeam(true)} title={t('team.createTeam')}>
                <AddIcon size={14} /> {t('team.createTeam')}
              </Button>
              {showMembers && isTeamAdmin(activeTeam, currentUser) && (
                <Button
                  onClick={() => {
                    setShowTeamSettings((value) => !value);
                    void refreshDeletePreview();
                  }}
                >
                  {t('team.settings')}
                </Button>
              )}
            </>
          }
        />
      ) : (
        <div className="_memory-panel-card">
          <div className="_memory-team-header-row">
            <div className="_memory-team-header-empty-hint">{t('team.empty.hint')}</div>
          </div>
        </div>
      )}

      {teamsLoading ? (
        <div
          className="_memory-panel-card"
          style={{ padding: '2rem', textAlign: 'center', color: 'var(--muted-foreground)' }}
        >
          {t('team.loading')}
        </div>
      ) : !activeTeam ? (
        <EmptyTeamState onCreateTeam={() => setShowCreateTeam(true)} />
      ) : (
        <>
          {/* === Members === */}
          {showMembers && (
            <MemberSection
              team={activeTeam}
              currentUser={currentUser}
              onAdd={() => setShowAddMember(true)}
            />
          )}

          {showMembers && showTeamSettings && isTeamAdmin(activeTeam, currentUser) && (
            <div className="_memory-panel-card" style={{ borderColor: 'var(--tea-color-error)' }}>
              <h3>{t('team.danger.title')}</h3>
              <Button onClick={() => setEditingTeamSettings(true)}>{t('team.danger.edit')}</Button>
              <Alert type="warning" style={{ marginTop: 12 }}>
                {deletePreview
                  ? t('team.danger.preview', {
                      members: deletePreview.active_members,
                      agents: deletePreview.counts.agents,
                      tasks: deletePreview.counts.tasks,
                      assets: deletePreview.counts.assets,
                      associations: deletePreview.active_associations,
                    })
                  : t('team.danger.loading')}
              </Alert>
              {activeTeam.owner_user_id === currentUser ? (
                <>
                  <p>{t('team.danger.typeName', { name: activeTeam.name })}</p>
                  <Input
                    value={deleteName}
                    onChange={setDeleteName}
                    placeholder={activeTeam.name}
                  />{' '}
                  <Button
                    type="primary"
                    disabled={!deletePreview?.ready || deleteName !== activeTeam.name}
                    onClick={() => void handleDeleteTeam()}
                  >
                    {t('team.danger.delete')}
                  </Button>
                </>
              ) : (
                <Alert type="info" style={{ marginTop: 12 }}>
                  {t('team.danger.ownerOnly')}
                </Alert>
              )}
            </div>
          )}

          {/* === 默认 Agent 模板（仅当前 Team owner/admin 可见）=== */}
          {showAgents && isTeamAdmin(activeTeam, currentUser) && (
            <DefaultAgentTemplateSection teamId={activeTeam.team_id} teamName={activeTeam.name} />
          )}

          {/* === Agent grid === */}
          {showAgents && (
            <AgentGrid
              activeTeam={activeTeam}
              agents={agents}
              agentsLoading={agentsLoading}
              countsLoading={countsLoading}
              mountedCounts={mountedCounts}
              currentUser={currentUser}
              canSeeAllAgents={canSeeAllAgents}
              onCreateAgent={() => setShowCreateAgent(true)}
              onCreateDefaultAgent={
                !allAgents.some((agent) => agent.owner_user_id === currentUser)
                  ? handleCreateDefaultAgent
                  : undefined
              }
              onEditAgent={setEditingAgent}
              onArchiveAgent={handleArchiveAgent}
              onRestoreAgent={handleRestoreAgent}
            />
          )}
        </>
      )}

      {/* Modals */}
      {showCreateTeam && (
        <CreateTeamDialog
          onClose={() => setShowCreateTeam(false)}
          onCreate={handleCreateTeam}
          busy={busy}
        />
      )}
      {showCreateAgent && activeTeam && (
        <CreateAgentDialog
          team={{ team_id: activeTeam.team_id, name: activeTeam.name }}
          currentUser={currentUser}
          onClose={() => setShowCreateAgent(false)}
          onCreated={handleCreateAgent}
          busy={busy}
        />
      )}
      {showAddMember && activeTeam && (
        <AddMemberDialog
          team={activeTeam}
          onClose={() => setShowAddMember(false)}
          currentUser={currentUser}
        />
      )}
      {editingAgent && activeTeam && (
        <AgentEditDialog agent={editingAgent} onClose={() => setEditingAgent(null)} />
      )}
      {editingTeamSettings && activeTeam && (
        <EditTeamDialog
          team={activeTeam}
          onClose={() => setEditingTeamSettings(false)}
          onSave={handleUpdateTeam}
          busy={busy}
        />
      )}
    </div>
  );
}

// =================== Empty state ===================

/**
 * 空态引导。
 *
 * 任意已认证用户都可创建 Team，并自动成为 owner/admin。
 */
function EmptyTeamState({ onCreateTeam }: { onCreateTeam?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="_memory-empty-team">
      <UsergroupIcon size={32} className="_memory-empty-team-icon" />
      <div className="_memory-empty-team-title">{t('team.emptyTeam.title')}</div>
      <div className="_memory-empty-team-desc">
        {onCreateTeam ? t('team.emptyTeam.desc') : t('team.emptyTeam.contactAdmin')}
      </div>
      {onCreateTeam && (
        <Button type="primary" onClick={onCreateTeam} className="_memory-empty-team-cta">
          <AddIcon size={14} /> {t('team.emptyTeam.cta')}
        </Button>
      )}
    </div>
  );
}
