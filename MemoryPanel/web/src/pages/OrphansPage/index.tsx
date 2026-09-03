import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Checkbox, H3, Input, Justify, Tag } from 'tea-component';
import { useTranslation } from 'react-i18next';
import { orphansApi, type OrphanFinding, type OrphanScan } from '@/lib/teamApi';
import { tea } from '@/lib/tea-bridge';
import { getErrorMessage } from '@/lib/error-message';

export function OrphansPage() {
  const { t } = useTranslation();
  const [scan, setScan] = useState<OrphanScan | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState('');
  const pending = useMemo(
    () => scan?.findings.filter((item) => item.category !== 'retained_history') ?? [],
    [scan],
  );
  const history = useMemo(
    () => scan?.findings.filter((item) => item.category === 'retained_history') ?? [],
    [scan],
  );
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setScan(await orphansApi.scan());
      setSelected(new Set());
    } catch (err) {
      tea.notify.error(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function purge() {
    const findings = pending.filter((item) => selected.has(item.finding_id));
    if (!findings.length || reason.trim().length < 3) return;
    const ok = await tea.confirm({
      message: t('orphans.purge.confirm', { count: findings.length }),
      description: t('orphans.purge.desc'),
      okText: t('orphans.purge.action'),
    });
    if (!ok) return;
    try {
      const result = await orphansApi.purge(
        findings.map(({ finding_id, fingerprint }) => ({ finding_id, fingerprint })),
        reason.trim(),
      );
      if (result.failed.length)
        tea.notify.warning(t('orphans.purge.partial', { failed: result.failed.length }));
      else tea.notify.success(t('orphans.purge.success', { count: result.deleted.length }));
      await refresh();
    } catch (err) {
      tea.notify.error(getErrorMessage(err));
    }
  }

  const renderFinding = (item: OrphanFinding, selectable: boolean) => (
    <div
      key={item.finding_id}
      style={{
        display: 'flex',
        gap: 10,
        padding: '10px 0',
        borderBottom: '1px solid var(--tea-color-border-secondary)',
      }}
    >
      <Checkbox
        value={selectable && selected.has(item.finding_id)}
        disabled={!selectable}
        onChange={() =>
          setSelected((current) => {
            const next = new Set(current);
            if (next.has(item.finding_id)) next.delete(item.finding_id);
            else next.add(item.finding_id);
            return next;
          })
        }
      />
      <div>
        <div>
          <Tag>{item.category}</Tag> <strong>{item.name || item.resource_type}</strong>{' '}
          <code>{item.resource_id}</code>
        </div>
        <div style={{ marginTop: 4 }}>
          {item.reason} · {item.source_service}
        </div>
        <div style={{ marginTop: 3, color: 'var(--tea-color-text-secondary)' }}>
          Team: {item.team_id ?? 'missing'} · owner: {item.owner_user_id ?? 'missing'}
          {item.status ? ` · status: ${item.status}` : ''}
          {typeof item.item_count === 'number' ? ` · items: ${item.item_count}` : ''}
          {typeof item.size_bytes === 'number'
            ? ` · size: ${(item.size_bytes / 1024 / 1024).toFixed(2)} MiB`
            : ''}
        </div>
      </div>
    </div>
  );

  return (
    <div>
      <Justify
        left={
          <div>
            <H3>{t('orphans.title')}</H3>
            <p>{t('orphans.desc')}</p>
          </div>
        }
        right={
          <Button loading={loading} onClick={() => void refresh()}>
            {t('orphans.scan')}
          </Button>
        }
      />
      <Alert type="info">{t('orphans.boundary')}</Alert>
      <Card style={{ marginTop: 16 }}>
        <Card.Body>
          <H3>
            {t('orphans.pending')} ({pending.length})
          </H3>
          {pending.map((item) => renderFinding(item, item.allowed_actions.includes('purge')))}
          {!loading && !pending.length && <Alert type="success">{t('orphans.empty')}</Alert>}
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <Input value={reason} onChange={setReason} placeholder={t('orphans.reason')} />
            <Button
              type="primary"
              disabled={!selected.size || reason.trim().length < 3}
              onClick={() => void purge()}
            >
              {t('orphans.purge.action')} ({selected.size})
            </Button>
          </div>
        </Card.Body>
      </Card>
      <Card style={{ marginTop: 16 }}>
        <Card.Body>
          <H3>
            {t('orphans.history')} ({history.length})
          </H3>
          {history.map((item) => renderFinding(item, false))}
        </Card.Body>
      </Card>
    </div>
  );
}
