/** 当前账号的 ownership 依赖、Agent 绑定关系与 owner-only 生命周期操作。 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  H3,
  Justify,
  Modal,
  Select,
  Tag,
  Text,
} from 'tea-component';
import { useTranslation } from 'react-i18next';
import {
  agentsApi,
  ownedResourcesApi,
  membersApi,
  usersApi,
  type OwnedResourceDependency,
  type OwnedResourceRef,
  type UserDependencies,
} from '@/lib/teamApi';
import { useAuthStore } from '@/stores/auth';
import { tea } from '@/lib/tea-bridge';
import { getErrorMessage } from '@/lib/error-message';
import './owned-resources.css';

type BoundAsset = Awaited<ReturnType<typeof agentsApi.getAssets>>[number];
type Member = { user_id: string; username?: string; role: string };
type DisplayItem = OwnedResourceDependency & {
  owner_user_id: string;
  parent_agent_id?: string;
  borrowed?: boolean;
  display_key: string;
};

function resourceKey(item: Pick<OwnedResourceDependency, 'resource_type' | 'resource_id'>): string {
  return `${item.resource_type}:${item.resource_id}`;
}

export function OwnedResourcesPage() {
  const { t } = useTranslation();
  const userId = useAuthStore((state) => state.auth?.user_id);
  const [dependencies, setDependencies] = useState<UserDependencies | null>(null);
  const [boundByAgent, setBoundByAgent] = useState<Map<string, BoundAsset[]>>(new Map());
  const [membersByTeam, setMembersByTeam] = useState<Map<string, Member[]>>(new Map());
  const [loading, setLoading] = useState(true);
  const [purgingTeam, setPurgingTeam] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [teamFilter, setTeamFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [transfer, setTransfer] = useState<{
    teamId: string;
    items: DisplayItem[];
    target: string;
    targetAgent: string;
    targetAgents: Array<{ agent_id: string; name: string }>;
    members: Member[];
  } | null>(null);

  const refresh = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    try {
      const deps = await usersApi.dependenciesAll(userId);
      const activeTeams = [
        ...new Set(
          deps.items
            .filter((item) => item.membership_status === 'active')
            .map((item) => item.team_id),
        ),
      ];
      const agents = deps.items.filter(
        (item) => item.resource_type === 'agent' && item.membership_status === 'active',
      );
      const [bindingResults, memberResults] = await Promise.all([
        Promise.all(
          agents.map(
            async (agent) =>
              [agent.resource_id, await agentsApi.getAssets(agent.resource_id, true)] as const,
          ),
        ),
        Promise.all(
          activeTeams.map(async (teamId) => [teamId, await membersApi.list(teamId)] as const),
        ),
      ]);
      setDependencies(deps);
      setBoundByAgent(new Map(bindingResults));
      setMembersByTeam(new Map(memberResults));
      setSelected(new Set());
    } catch (err) {
      tea.notify.error(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const groups = useMemo(() => {
    const source = dependencies?.items ?? [];
    const map = new Map<string, { teamName: string; membership: string; items: DisplayItem[] }>();
    for (const teamId of [...new Set(source.map((item) => item.team_id))]) {
      if (teamFilter !== 'all' && teamId !== teamFilter) continue;
      const owned = source.filter((item) => item.team_id === teamId);
      const ownedByKey = new Map(owned.map((item) => [resourceKey(item), item]));
      const consumedAssets = new Set<string>();
      const rows: DisplayItem[] = [];
      const addOwned = (item: OwnedResourceDependency, suffix = '') =>
        rows.push({
          ...item,
          owner_user_id: userId ?? '',
          display_key: `${resourceKey(item)}${suffix}`,
        });
      owned.filter((item) => item.resource_type === 'team').forEach((item) => addOwned(item));
      for (const agent of owned.filter((item) => item.resource_type === 'agent')) {
        addOwned(agent);
        for (const asset of boundByAgent.get(agent.resource_id) ?? []) {
          const key = `asset:${asset.asset_id}`;
          const own = ownedByKey.get(key);
          if (own) consumedAssets.add(key);
          rows.push({
            ...(own ?? {
              resource_type: 'asset' as const,
              resource_id: asset.asset_id,
              team_id: teamId,
              team_name: agent.team_name,
              name: asset.name,
              status: asset.status,
              asset_type: asset.asset_type,
              created_at: asset.created_at,
              membership_role: agent.membership_role,
              membership_status: agent.membership_status,
              team_status: agent.team_status,
            }),
            owner_user_id: asset.owner_user_id,
            parent_agent_id: agent.resource_id,
            borrowed: asset.owner_user_id !== userId,
            display_key: `${key}@${agent.resource_id}`,
          });
        }
      }
      owned.filter((item) => item.resource_type === 'task').forEach((item) => addOwned(item));
      owned
        .filter((item) => item.resource_type === 'asset' && !consumedAssets.has(resourceKey(item)))
        .forEach((item) => addOwned(item));
      const filtered = rows.filter((item) => {
        const itemType =
          item.resource_type === 'asset' ? (item.asset_type ?? 'other') : item.resource_type;
        return (
          (typeFilter === 'all' || typeFilter === itemType) &&
          (statusFilter === 'all' || statusFilter === item.status)
        );
      });
      if (!filtered.length) continue;
      map.set(teamId, {
        teamName: owned[0]?.team_name || teamId,
        membership: owned.some((item) => item.membership_status === 'active')
          ? 'active'
          : (owned[0]?.membership_status ?? 'absent'),
        items: filtered,
      });
    }
    return [...map.entries()];
  }, [dependencies, boundByAgent, statusFilter, teamFilter, typeFilter, userId]);

  const filterOptions = useMemo(() => {
    const items = dependencies?.items ?? [];
    return {
      teams: [
        ...new Map(items.map((item) => [item.team_id, item.team_name || item.team_id])).entries(),
      ],
      statuses: [...new Set(items.map((item) => item.status))].sort(),
    };
  }, [dependencies]);

  const childKeysByAgent = useMemo(() => {
    const result = new Map<string, Set<string>>();
    for (const [, group] of groups)
      for (const item of group.items) {
        if (!item.parent_agent_id || item.borrowed) continue;
        const set = result.get(item.parent_agent_id) ?? new Set<string>();
        set.add(resourceKey(item));
        result.set(item.parent_agent_id, set);
      }
    return result;
  }, [groups]);
  const effectiveSelected = useMemo(() => {
    const next = new Set(selected);
    for (const [agentId, children] of childKeysByAgent)
      if (selected.has(`agent:${agentId}`)) for (const key of children) next.add(key);
    return next;
  }, [childKeysByAgent, selected]);
  const lockedChildren = useMemo(() => {
    const next = new Set<string>();
    for (const [agentId, children] of childKeysByAgent)
      if (selected.has(`agent:${agentId}`)) for (const key of children) next.add(key);
    return next;
  }, [childKeysByAgent, selected]);

  function canSelect(item: DisplayItem) {
    return item.membership_status === 'active' && !item.borrowed;
  }
  function toggle(key: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  function uniqueOwned(items: DisplayItem[]): DisplayItem[] {
    return [
      ...new Map(
        items.filter((item) => !item.borrowed).map((item) => [resourceKey(item), item]),
      ).values(),
    ];
  }
  function operationItems(items: DisplayItem[], purge: boolean): DisplayItem[] {
    const owned = uniqueOwned(items).filter(
      (item) => item.membership_status === 'active' && (!purge || item.resource_type !== 'team'),
    );
    const selectedAgents = new Set(
      owned
        .filter((item) => item.resource_type === 'agent' && selected.has(resourceKey(item)))
        .map((item) => item.resource_id),
    );
    return owned.filter((item) => {
      if (!effectiveSelected.has(resourceKey(item))) return false;
      if (item.resource_type === 'asset') {
        const followsSelectedAgent = items.some(
          (row) =>
            resourceKey(row) === resourceKey(item) &&
            !!row.parent_agent_id &&
            selectedAgents.has(row.parent_agent_id),
        );
        if (followsSelectedAgent) return false;
      }
      return true;
    });
  }
  function selectTeam(items: DisplayItem[]) {
    const choices = uniqueOwned(items).filter((item) => item.membership_status === 'active');
    setSelected((current) => {
      const next = new Set(current);
      const allSelected = choices.every((item) => effectiveSelected.has(resourceKey(item)));
      for (const item of choices) {
        const key = resourceKey(item);
        if (allSelected) next.delete(key);
        else next.add(key);
      }
      return next;
    });
  }

  async function purge(teamId: string, items: DisplayItem[]) {
    const resources = operationItems(items, true).map((item) => ({
      resource_type: item.resource_type as OwnedResourceRef['resource_type'],
      resource_id: item.resource_id,
    }));
    if (!resources.length) return;
    const ok = await tea.confirm({
      message: t('resources.purge.confirm', { count: resources.length }),
      description: t('resources.purge.desc'),
      okText: t('resources.purge.action'),
    });
    if (!ok) return;
    setPurgingTeam(teamId);
    try {
      const result = await ownedResourcesApi.purge(teamId, resources);
      if (result.failed.length)
        tea.notify.warning(
          t('resources.purge.partial', {
            deleted: result.deleted.length,
            failed: result.failed.length,
          }),
        );
      else tea.notify.success(t('resources.purge.success', { count: result.deleted.length }));
      await refresh();
    } catch (err) {
      tea.notify.error(getErrorMessage(err));
    } finally {
      setPurgingTeam(null);
    }
  }
  async function openTransfer(teamId: string, items: DisplayItem[]) {
    const chosen = operationItems(items, false);
    if (!chosen.length) return;
    try {
      setTransfer({
        teamId,
        items: chosen,
        target: '',
        targetAgent: '',
        targetAgents: [],
        members: membersByTeam.get(teamId) ?? (await membersApi.list(teamId)),
      });
    } catch (err) {
      tea.notify.error(getErrorMessage(err));
    }
  }
  async function chooseTarget(value: string) {
    if (!transfer) return;
    const needsAgent = transfer.items.some((item) => item.resource_type === 'asset');
    const targetAgents = needsAgent
      ? await agentsApi.list(transfer.teamId, { owner_user_id: value })
      : [];
    setTransfer({ ...transfer, target: value, targetAgent: '', targetAgents });
  }
  async function submitTransfer() {
    if (!transfer?.target) return;
    const needsAgent = transfer.items.some((item) => item.resource_type === 'asset');
    if (needsAgent && transfer.targetAgents.length > 0 && !transfer.targetAgent) return;
    const targetName =
      transfer.members.find((member) => member.user_id === transfer.target)?.username ??
      transfer.target;
    const ok = await tea.confirm({
      message: t('resources.transfer.confirm', {
        count: transfer.items.length,
        target: targetName,
      }),
      description: t('resources.transfer.desc'),
      okText: t('resources.transfer.action'),
    });
    if (!ok) return;
    try {
      const result = await ownedResourcesApi.transfer(
        transfer.teamId,
        transfer.items.map((item) => ({
          resource_type: item.resource_type,
          resource_id: item.resource_id,
          to_user_id: transfer.target,
          ...(item.resource_type === 'asset'
            ? {
                ...(item.parent_agent_id ? { from_agent_id: item.parent_agent_id } : {}),
                ...(transfer.targetAgent ? { to_agent_id: transfer.targetAgent } : {}),
              }
            : {}),
        })),
      );
      const failed = result.items.filter((item) => !item.transferred);
      if (failed.length)
        tea.notify.warning(t('resources.transfer.partial', { failed: failed.length }));
      else tea.notify.success(t('resources.transfer.success', { count: result.items.length }));
      setTransfer(null);
      await refresh();
    } catch (err) {
      tea.notify.error(getErrorMessage(err));
    }
  }

  const typeLabel = (item: OwnedResourceDependency) =>
    item.resource_type === 'asset'
      ? t(`resources.type.${item.asset_type ?? 'other'}`)
      : t(`resources.type.${item.resource_type}`);
  const ownerName = (item: DisplayItem) =>
    membersByTeam.get(item.team_id)?.find((member) => member.user_id === item.owner_user_id)
      ?.username ?? item.owner_user_id;
  const primaryMetrics = dependencies
    ? ([
        ['team', dependencies.counts.teams],
        ['agent', dependencies.counts.agents],
        ['task', dependencies.counts.tasks],
      ] as const)
    : [];
  const assetMetrics = dependencies
    ? ([
        ['skill', dependencies.asset_counts.skill],
        ['llm_wiki', dependencies.asset_counts.llm_wiki],
        ['code_graph', dependencies.asset_counts.code_graph],
        ['chat_memory', dependencies.asset_counts.chat_memory],
        ...(dependencies.asset_counts.other > 0
          ? ([['other', dependencies.asset_counts.other]] as const)
          : []),
      ] as const)
    : [];

  return (
    <div>
      <Justify
        left={
          <div>
            <H3>{t('resources.title')}</H3>
            <Text theme="weak" parent="div" style={{ marginTop: 4 }}>
              {t('resources.desc')}
            </Text>
          </div>
        }
        right={
          <Button loading={loading} onClick={() => void refresh()}>
            {t('common.refresh')}
          </Button>
        }
      />
      {dependencies && (
        <div className="owned-resources-summary" aria-label={t('resources.summary')}>
          {[primaryMetrics, assetMetrics].map((metrics, row) => (
            <div className="owned-resources-summary__row" key={row}>
              {metrics.map(([kind, value]) => (
                <div className="owned-resources-summary__metric" key={kind}>
                  <strong>{value}</strong>
                  <span>{t(`resources.type.${kind}`)}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      {dependencies && dependencies.items.length > 0 && (
        <div className="owned-resources-filters">
          <Select
            value={teamFilter}
            onChange={(value) => setTeamFilter(String(value))}
            options={[
              { value: 'all', text: t('resources.filter.allTeams') },
              ...filterOptions.teams.map(([value, text]) => ({ value, text })),
            ]}
          />
          <Select
            value={typeFilter}
            onChange={(value) => setTypeFilter(String(value))}
            options={[
              'all',
              'team',
              'agent',
              'task',
              'skill',
              'llm_wiki',
              'code_graph',
              'chat_memory',
              'other',
            ].map((value) => ({
              value,
              text: value === 'all' ? t('resources.filter.allTypes') : t(`resources.type.${value}`),
            }))}
          />
          <Select
            value={statusFilter}
            onChange={(value) => setStatusFilter(String(value))}
            options={[
              { value: 'all', text: t('resources.filter.allStatuses') },
              ...filterOptions.statuses.map((value) => ({ value, text: value })),
            ]}
          />
        </div>
      )}
      <div className="owned-resources-groups">
        {groups.map(([teamId, group]) => {
          const ownedChoices = uniqueOwned(group.items).filter(
            (item) => item.membership_status === 'active',
          );
          const purgeSelected = operationItems(group.items, true).length;
          const transferSelected = operationItems(group.items, false).length;
          const absent = group.membership !== 'active';
          return (
            <Card key={teamId}>
              <Card.Body>
                <Justify
                  left={
                    <div>
                      <H3>{group.teamName}</H3>
                      <code>{teamId}</code>{' '}
                      <Tag theme={absent ? 'error' : 'success'}>{group.membership}</Tag>
                    </div>
                  }
                  right={
                    ownedChoices.length ? (
                      <Button type="link" onClick={() => selectTeam(group.items)}>
                        {t('resources.selectAll')}
                      </Button>
                    ) : null
                  }
                />
                {absent && (
                  <Alert type="warning" style={{ marginTop: 12 }}>
                    {t('resources.absent')}
                  </Alert>
                )}
                {group.items.some((item) => item.resource_type === 'team') && (
                  <Alert type="info" style={{ marginTop: 12 }}>
                    {t('resources.teamOwned')}
                  </Alert>
                )}
                <div className="owned-resources-list">
                  {group.items.map((item) => {
                    const key = resourceKey(item);
                    const locked = !!item.parent_agent_id && lockedChildren.has(key);
                    const selectable = canSelect(item);
                    return (
                      <div
                        key={item.display_key}
                        className={`owned-resource-row${item.parent_agent_id ? ' owned-resource-row--child' : ''}`}
                      >
                        <Checkbox
                          value={selectable && effectiveSelected.has(key)}
                          disabled={!selectable || locked}
                          onChange={() => selectable && !locked && toggle(key)}
                        />
                        <div>
                          <div>
                            <Tag size="sm">{typeLabel(item)}</Tag>{' '}
                            <strong>{item.name || item.resource_id}</strong>
                            {item.borrowed && (
                              <Tag
                                size="sm"
                                theme="warning"
                                className="owned-resource-row__borrowed"
                              >
                                {t('resources.borrowed')}
                              </Tag>
                            )}
                          </div>
                          <div className="owned-resource-row__meta">
                            <code>{item.resource_id}</code> · {item.status}
                            {item.borrowed
                              ? ` · ${t('resources.owner', { owner: ownerName(item) })}`
                              : ''}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                {ownedChoices.length > 0 && (
                  <div style={{ marginTop: 12 }}>
                    <Button
                      disabled={!transferSelected || purgingTeam !== null}
                      onClick={() => void openTransfer(teamId, group.items)}
                    >
                      {t('resources.transfer.action')}
                    </Button>{' '}
                    <Button
                      type="primary"
                      disabled={!purgeSelected || purgingTeam !== null}
                      loading={purgingTeam === teamId}
                      onClick={() => void purge(teamId, group.items)}
                    >
                      {t('resources.purge.action')} ({purgeSelected})
                    </Button>
                  </div>
                )}
              </Card.Body>
            </Card>
          );
        })}
        {!loading && groups.length === 0 && <Alert type="success">{t('resources.empty')}</Alert>}
      </div>
      {transfer && (
        <Modal visible caption={t('resources.transfer.title')} onClose={() => setTransfer(null)}>
          <Modal.Body>
            <Alert type="warning">{t('resources.transfer.desc')}</Alert>
            <div className="owned-resources-transfer-field">
              <Text parent="div">{t('resources.transfer.targetUser')}</Text>
              <Select
                size="full"
                value={transfer.target}
                onChange={(value) => void chooseTarget(String(value))}
                options={transfer.members
                  .filter((member) => member.user_id !== userId)
                  .filter(
                    (member) =>
                      !transfer.items.some((item) => item.resource_type === 'team') ||
                      member.role === 'admin',
                  )
                  .map((member) => ({
                    value: member.user_id,
                    text: `${member.username ?? member.user_id} (${member.role})`,
                  }))}
              />
            </div>
            {transfer.items.some((item) => item.resource_type === 'asset') && (
              <div className="owned-resources-transfer-field">
                <Text parent="div">{t('resources.transfer.targetAgent')}</Text>
                <Select
                  size="full"
                  value={transfer.targetAgent}
                  onChange={(value) => setTransfer({ ...transfer, targetAgent: String(value) })}
                  options={transfer.targetAgents.map((agent) => ({
                    value: agent.agent_id,
                    text: `${agent.name} (${agent.agent_id})`,
                  }))}
                />
                <Text theme="weak" parent="div">
                  {transfer.target && transfer.targetAgents.length === 0
                    ? t('resources.transfer.noTargetAgent')
                    : t('resources.transfer.targetAgentHint')}
                </Text>
              </div>
            )}
          </Modal.Body>
          <Modal.Footer>
            <Button
              type="primary"
              disabled={
                !transfer.target ||
                (transfer.items.some((item) => item.resource_type === 'asset') &&
                  transfer.targetAgents.length > 0 &&
                  !transfer.targetAgent)
              }
              onClick={() => void submitTransfer()}
            >
              {t('resources.transfer.action')}
            </Button>
            <Button onClick={() => setTransfer(null)}>{t('common.cancel')}</Button>
          </Modal.Footer>
        </Modal>
      )}
    </div>
  );
}
