/**
 * TeamSwitcher — 全局顶栏内嵌的 Team 切换器
 *
 * 从侧边栏迁移到顶栏后的行内 pill 样式版本：使用 Tea `Dropdown` 承载弹出面板
 * （自带定位、遮罩点击关闭、滚动关闭等能力），面板内部用 `List`/`Input`/`Button` 组装。
 *
 * 这里只负责切换和创建。编辑与永久解散位于 Team 设置 Danger Zone。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dropdown, Input, Button } from 'tea-component';
import { ChevronDownIcon, AddIcon } from 'tea-icons-react';
import { useTeams, writeActiveTeamId, invalidateBackendCache } from '@/services';
import { useBackendStore } from '@/stores/backend';
import { teamsApi } from '@/lib/teamApi';
import { teamColor } from '@/utils/color';
import { tea } from '@/lib/tea-bridge';
import { getErrorMessage } from '@/lib/error-message';
import './team-switcher.css';

export function TeamSwitcher() {
  const { t } = useTranslation();
  const { teams, activeTeamId } = useTeams();
  const refreshTeams = useBackendStore((s) => s.refreshTeams);
  const [showCreateTeam, setShowCreateTeam] = useState(false);
  const [newTeamName, setNewTeamName] = useState('');
  const [newTeamDesc, setNewTeamDesc] = useState('');
  const [creating, setCreating] = useState(false);

  const myTeams = teams;
  const active = myTeams.find((tm) => tm.team_id === activeTeamId) ?? null;

  function resetCreateForm() {
    setShowCreateTeam(false);
    setNewTeamName('');
    setNewTeamDesc('');
  }

  function pick(team_id: string, close: () => void) {
    // 只切换 activeTeamId，不 invalidateTeamCache：
    //  - useAgents/useTasks 按 teamId 分桶缓存，切到目标 team 时若已有缓存（之前看过）
    //    会直接秒开，无需重新 loading；无缓存才走 fetch —— 这才是"自动刷新"而不是
    //    "整页重刷"。
    //  - invalidateTeamCache 会删目标 team 缓存 + 广播 BACKEND_REFRESH_EVENT，
    //    导致切 team 后所有页面（含 counts/participation 等无关数据）连带重新拉取，
    //    表现为"切换一次 = 全部重新刷新一次"。写操作后的 invalidateBackendCache
    //    已经保证数据新鲜度，切换本身不需要再强刷。
    writeActiveTeamId(team_id);
    close();
  }

  async function handleCreate() {
    const name = newTeamName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const created = await teamsApi.create({ name, description: newTeamDesc.trim() });
      invalidateBackendCache();
      writeActiveTeamId(created.team_id);
      resetCreateForm();
    } catch (err) {
      tea.notify.error(getErrorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
      <Dropdown
        appearance="pure"
        clickClose={false}
        matchButtonWidth={false}
        className="_memory-team-switcher-dropdown"
        boxClassName="_memory-team-switcher-box"
        // 静默刷新：仅让下拉框里的 team 列表保新鲜，不翻转 teamsLoading，
        // 否则 TeamManagementPanel 等消费方会整体进入 loading 占位（表现为
        // "点开选择 team 的选项框，成员/Agents 管理页面就刷新一下"）。
        onOpen={() => {
          void refreshTeams({ silent: true });
        }}
        onClose={resetCreateForm}
        button={
          <button
            type="button"
            className="_memory-team-switcher-trigger"
            title={active?.name ?? t('teamSwitcher.selectTeam')}
          >
            <span
              className={`_memory-team-switcher-avatar ${active ? teamColor(active.team_id) : 'bg-primary'}`}
            >
              {(active?.name ?? '?').slice(0, 1).toUpperCase()}
            </span>
            <span className="_memory-team-switcher-meta">
              <span className="_memory-team-switcher-name">
                {active?.name ?? t('teamSwitcher.selectTeam')}
              </span>
              <span className="_memory-team-switcher-id">
                {active?.team_id ?? t('teamSwitcher.noTeam')}
              </span>
            </span>
            <ChevronDownIcon size={12} className="_memory-team-switcher-chevron" />
          </button>
        }
      >
        {(close) => (
          <div className="_memory-team-switcher-panel">
            <div className="_memory-team-switcher-panel-header">
              <div className="_memory-team-switcher-panel-title">{t('teamSwitcher.title')}</div>
              <div className="_memory-team-switcher-panel-desc">{t('teamSwitcher.desc')}</div>
            </div>

            <div className="_memory-team-switcher-panel-label">
              {t('teamSwitcher.teamCount', { count: myTeams.length })}
            </div>

            <div className="_memory-team-switcher-list-wrap">
              {myTeams.length === 0 ? (
                <div className="_memory-team-switcher-empty">{t('teamSwitcher.empty.member')}</div>
              ) : (
                // 用原生 ul/li 而非 Tea List：Tea 的 List.Item selected 会自动渲染 ✓
                // 并改变内边距，split="divide" 又会注入 padding/border-top，与自定义
                // 卡片式行样式（圆角 + 描边 + 间距）反复冲突（表现为选中行左侧被裁切、
                // 行分割线被上一行压住）。这里自己掌控全部样式，行为更可控。
                <ul className="_memory-team-switcher-list">
                  {myTeams.map((tm) => {
                    const isActive = tm.team_id === activeTeamId;
                    return (
                      <li key={tm.team_id} className="_memory-team-switcher-row">
                        <button
                          type="button"
                          className={`_memory-team-switcher-item${isActive ? ' is-active' : ''}`}
                          aria-current={isActive || undefined}
                          onClick={() => pick(tm.team_id, close)}
                        >
                          <span
                            className={`_memory-team-switcher-item-avatar ${teamColor(tm.team_id)}`}
                          >
                            {tm.name.slice(0, 1).toUpperCase()}
                          </span>
                          <span className="_memory-team-switcher-item-meta">
                            <span className="_memory-team-switcher-item-name">{tm.name}</span>
                            <span className="_memory-team-switcher-item-count">
                              {t('teamSwitcher.memberCount', { count: tm.members.length })}
                            </span>
                          </span>
                          {/* 选中态由背景色 + 描边传达，不再额外显示 ✓ —— 避免与右侧
                              操作按钮挤在一起。操作按钮为绝对定位浮层，不占行内布局宽度。 */}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="_memory-team-switcher-footer">
              {showCreateTeam ? (
                <div className="_memory-team-switcher-create-form">
                  <Input
                    autoFocus
                    size="full"
                    value={newTeamName}
                    onChange={setNewTeamName}
                    placeholder={t('teamSwitcher.teamNamePlaceholder')}
                  />
                  <Input
                    size="full"
                    value={newTeamDesc}
                    onChange={setNewTeamDesc}
                    placeholder={t('teamSwitcher.teamDescPlaceholder')}
                  />
                  <div className="_memory-team-switcher-create-actions">
                    <Button onClick={resetCreateForm}>{t('teamSwitcher.cancel')}</Button>
                    <Button
                      type="primary"
                      loading={creating}
                      disabled={!newTeamName.trim() || creating}
                      onClick={handleCreate}
                    >
                      {t('teamSwitcher.create')}
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  type="text"
                  className="_memory-team-switcher-create-trigger"
                  onClick={() => setShowCreateTeam(true)}
                >
                  <AddIcon size={14} />
                  {t('teamSwitcher.newTeam')}
                </Button>
              )}
            </div>
          </div>
        )}
      </Dropdown>
    </>
  );
}
