/** 当前账号的 ownership 依赖与 owner-only 永久清理。 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Checkbox, H3, Justify, Tag, Text } from 'tea-component';
import { useTranslation } from 'react-i18next';
import {
  ownedResourcesApi,
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

  useEffect(() => { void refresh(); }, [refresh]);

  const groups = useMemo(() => {
    const map = new Map<string, { teamName: string; membership: string; items: OwnedResourceDependency[] }>();
    for (const item of dependencies?.items ?? []) {
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
  }, [dependencies]);

  function toggle(key: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function selectable(items: OwnedResourceDependency[]): OwnedResourceDependency[] {
    return items.filter((item) => item.resource_type !== 'team' && item.membership_status === 'active');
  }

  function selectTeam(items: OwnedResourceDependency[]) {
    const choices = selectable(items);
    setSelected((current) => {
      const next = new Set(current);
      const allSelected = choices.every((item) => next.has(resourceKey(item)));
      for (const item of choices) {
        const key = resourceKey(item);
        if (allSelected) next.delete(key); else next.add(key);
      }
      return next;
    });
  }

  async function purge(teamId: string, items: OwnedResourceDependency[]) {
    const resources: OwnedResourceRef[] = selectable(items)
      .filter((item) => selected.has(resourceKey(item)))
      .map((item) => ({ resource_type: item.resource_type as OwnedResourceRef['resource_type'], resource_id: item.resource_id }));
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
        tea.notify.warning(t('resources.purge.partial', { deleted: result.deleted.length, failed: result.failed.length }));
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

  return (
    <div>
      <Justify
        left={<div><H3>{t('resources.title')}</H3><Text theme="weak" parent="div" style={{ marginTop: 4 }}>{t('resources.desc')}</Text></div>}
        right={<Button loading={loading} onClick={() => void refresh()}>{t('common.refresh')}</Button>}
      />
      {dependencies && (
        <Alert type={dependencies.counts.total > 0 ? 'info' : 'success'} style={{ marginTop: 16 }}>
          {t('resources.counts', dependencies.counts)}
        </Alert>
      )}
      <div style={{ display: 'grid', gap: 16, marginTop: 16 }}>
        {groups.map(([teamId, group]) => {
          const choices = selectable(group.items);
          const teamSelected = choices.filter((item) => selected.has(resourceKey(item))).length;
          const absent = group.membership !== 'active';
          return (
            <Card key={teamId}>
              <Card.Body>
                <Justify
                  left={<div><H3>{group.teamName}</H3><code>{teamId}</code>{' '}<Tag theme={absent ? 'error' : 'success'}>{group.membership}</Tag></div>}
                  right={choices.length > 0 ? <Button type="link" onClick={() => selectTeam(group.items)}>{t('resources.selectAll')}</Button> : null}
                />
                {absent && <Alert type="warning" style={{ marginTop: 12 }}>{t('resources.absent')}</Alert>}
                {group.items.some((item) => item.resource_type === 'team') && (
                  <Alert type="info" style={{ marginTop: 12 }}>{t('resources.teamOwned')}</Alert>
                )}
                <div style={{ marginTop: 8 }}>
                  {group.items.map((item) => {
                    const canSelect = item.resource_type !== 'team' && item.membership_status === 'active';
                    return (
                      <div key={resourceKey(item)} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '9px 0', borderBottom: '1px solid var(--tea-color-border-secondary)' }}>
                        <Checkbox
                          value={canSelect && selected.has(resourceKey(item))}
                          disabled={!canSelect}
                          onChange={() => canSelect && toggle(resourceKey(item))}
                        />
                        <div>
                          <div><Tag size="sm">{item.resource_type}</Tag> <strong>{item.name || item.resource_id}</strong></div>
                          <div style={{ marginTop: 3, color: 'var(--tea-color-text-secondary)' }}>
                            <code>{item.resource_id}</code> · {item.status}{item.asset_type ? ` · ${item.asset_type}` : ''}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                {choices.length > 0 && (
                  <div style={{ marginTop: 12 }}>
                    <Button
                      type="primary"
                      disabled={teamSelected === 0 || purgingTeam !== null}
                      loading={purgingTeam === teamId}
                      onClick={() => void purge(teamId, group.items)}
                    >
                      {t('resources.purge.action')} ({teamSelected})
                    </Button>
                  </div>
                )}
              </Card.Body>
            </Card>
          );
        })}
        {!loading && groups.length === 0 && <Alert type="success">{t('resources.empty')}</Alert>}
      </div>
    </div>
  );
}
