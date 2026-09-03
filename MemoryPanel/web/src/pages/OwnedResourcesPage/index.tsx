/** 当前账号的 ownership 依赖与 owner-only 永久清理。 */
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

function resourceKey(item: Pick<OwnedResourceDependency, 'resource_type' | 'resource_id'>): string {
  return `${item.resource_type}:${item.resource_id}`;
}

export function OwnedResourcesPage() {
  const { t } = useTranslation();
  const userId = useAuthStore((state) => state.auth?.user_id);
  const [dependencies, setDependencies] = useState<UserDependencies | null>(null);
  const [loading, setLoading] = useState(true);
  const [purgingTeam, setPurgingTeam] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [teamFilter, setTeamFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [transfer, setTransfer] = useState<{
    teamId: string;
    items: OwnedResourceDependency[];
    target: string;
    members: Array<{ user_id: string; username?: string; role: string }>;
  } | null>(null);

  const refresh = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    try {
      setDependencies(await usersApi.dependenciesAll(userId));
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
    const map = new Map<
      string,
      { teamName: string; membership: string; items: OwnedResourceDependency[] }
    >();
    for (const item of dependencies?.items ?? []) {
      const itemType =
        item.resource_type === 'asset' ? (item.asset_type ?? 'other') : item.resource_type;
      if (teamFilter !== 'all' && item.team_id !== teamFilter) continue;
      if (typeFilter !== 'all' && itemType !== typeFilter) continue;
      if (statusFilter !== 'all' && item.status !== statusFilter) continue;
      const group = map.get(item.team_id) ?? {
        teamName: item.team_name || item.team_id,
        membership: item.membership_status,
        items: [],
      };
      group.items.push(item);
      if (item.membership_status === 'active') group.membership = 'active';
      map.set(item.team_id, group);
    }
    return [...map.entries()];
  }, [dependencies, teamFilter, typeFilter, statusFilter]);

  const filterOptions = useMemo(() => {
    const items = dependencies?.items ?? [];
    const teams = [
      ...new Map(items.map((item) => [item.team_id, item.team_name || item.team_id])).entries(),
    ];
    const statuses = [...new Set(items.map((item) => item.status))].sort();
    return { teams, statuses };
  }, [dependencies]);

  function toggle(key: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function purgeable(items: OwnedResourceDependency[]): OwnedResourceDependency[] {
    return items.filter(
      (item) => item.resource_type !== 'team' && item.membership_status === 'active',
    );
  }

  function selectable(items: OwnedResourceDependency[]): OwnedResourceDependency[] {
    return items.filter((item) => item.membership_status === 'active');
  }

  function transferable(items: OwnedResourceDependency[]): OwnedResourceDependency[] {
    return items.filter(
      (item) =>
        item.membership_status === 'active' &&
        !(
          item.resource_type === 'asset' &&
          (item.asset_type === 'skill' || item.asset_type === 'chat_memory')
        ),
    );
  }

  function selectTeam(items: OwnedResourceDependency[]) {
    const choices = selectable(items);
    setSelected((current) => {
      const next = new Set(current);
      const allSelected = choices.every((item) => next.has(resourceKey(item)));
      for (const item of choices) {
        const key = resourceKey(item);
        if (allSelected) next.delete(key);
        else next.add(key);
      }
      return next;
    });
  }

  async function purge(teamId: string, items: OwnedResourceDependency[]) {
    const resources: OwnedResourceRef[] = purgeable(items)
      .filter((item) => selected.has(resourceKey(item)))
      .map((item) => ({
        resource_type: item.resource_type as OwnedResourceRef['resource_type'],
        resource_id: item.resource_id,
      }));
    if (resources.length === 0) return;
    const ok = await tea.confirm({
      message: t('resources.purge.confirm', { count: resources.length }),
      description: t('resources.purge.desc'),
      okText: t('resources.purge.action'),
    });
    if (!ok) return;
    setPurgingTeam(teamId);
    try {
      const result = await ownedResourcesApi.purge(teamId, resources);
      if (result.failed.length > 0) {
        tea.notify.warning(
          t('resources.purge.partial', {
            deleted: result.deleted.length,
            failed: result.failed.length,
          }),
        );
      } else {
        tea.notify.success(t('resources.purge.success', { count: result.deleted.length }));
      }
      await refresh();
    } catch (err) {
      tea.notify.error(getErrorMessage(err));
    } finally {
      setPurgingTeam(null);
    }
  }

  async function openTransfer(teamId: string, items: OwnedResourceDependency[]) {
    const chosen = transferable(items).filter((item) => selected.has(resourceKey(item)));
    if (!chosen.length) return;
    try {
      const members = await membersApi.list(teamId);
      setTransfer({ teamId, items: chosen, target: '', members });
    } catch (err) {
      tea.notify.error(getErrorMessage(err));
    }
  }

  async function submitTransfer() {
    if (!transfer?.target) return;
    const ok = await tea.confirm({
      message: t('resources.transfer.confirm', {
        count: transfer.items.length,
        target: transfer.target,
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
        <Alert type={dependencies.counts.total > 0 ? 'info' : 'success'} style={{ marginTop: 16 }}>
          Team {dependencies.counts.teams} · Agent {dependencies.counts.agents} · Task{' '}
          {dependencies.counts.tasks}
          {' · '}Skill {dependencies.asset_counts.skill} · Wiki {dependencies.asset_counts.llm_wiki}
          {' · '}Code Graph {dependencies.asset_counts.code_graph} · Chat Memory{' '}
          {dependencies.asset_counts.chat_memory}
          {' · '}Other Asset {dependencies.asset_counts.other} · Total {dependencies.counts.total}
        </Alert>
      )}
      {dependencies && dependencies.items.length > 0 && (
        <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
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
      <div style={{ display: 'grid', gap: 16, marginTop: 16 }}>
        {groups.map(([teamId, group]) => {
          const choices = selectable(group.items);
          const purgeSelected = purgeable(group.items).filter((item) =>
            selected.has(resourceKey(item)),
          ).length;
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
                    choices.length > 0 ? (
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
                <div style={{ marginTop: 8 }}>
                  {group.items.map((item) => {
                    const canSelect = item.membership_status === 'active';
                    return (
                      <div
                        key={resourceKey(item)}
                        style={{
                          display: 'flex',
                          gap: 10,
                          alignItems: 'flex-start',
                          padding: '9px 0',
                          borderBottom: '1px solid var(--tea-color-border-secondary)',
                        }}
                      >
                        <Checkbox
                          value={canSelect && selected.has(resourceKey(item))}
                          disabled={!canSelect}
                          onChange={() => canSelect && toggle(resourceKey(item))}
                        />
                        <div>
                          <div>
                            <Tag size="sm">{typeLabel(item)}</Tag>{' '}
                            <strong>{item.name || item.resource_id}</strong>
                          </div>
                          <div style={{ marginTop: 3, color: 'var(--tea-color-text-secondary)' }}>
                            <code>{item.resource_id}</code> · {item.status}
                            {item.asset_type ? ` · ${item.asset_type}` : ''}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                {choices.length > 0 && (
                  <div style={{ marginTop: 12 }}>
                    <Button
                      disabled={
                        transferable(group.items).filter((item) => selected.has(resourceKey(item)))
                          .length === 0 || purgingTeam !== null
                      }
                      onClick={() => void openTransfer(teamId, group.items)}
                    >
                      {t('resources.transfer.action')}
                    </Button>{' '}
                    <Button
                      type="primary"
                      disabled={purgeSelected === 0 || purgingTeam !== null}
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
            <div style={{ marginTop: 12 }}>
              <Select
                size="full"
                value={transfer.target}
                onChange={(value) => setTransfer({ ...transfer, target: String(value) })}
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
          </Modal.Body>
          <Modal.Footer>
            <Button
              type="primary"
              disabled={!transfer.target}
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
