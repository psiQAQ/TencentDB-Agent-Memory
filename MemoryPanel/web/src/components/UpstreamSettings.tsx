import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Form, Input, Select, Text, Card } from 'tea-component';
import { ResourcePage } from '@/pages/ResourcePage';
import { useAuthStore } from '@/stores/auth';
import { metaPost } from '@/lib/api/base';

import './UpstreamSettings.css';

type ConfigType = 'conversation' | 'extraction';
interface Config {
  agent_source: string;
  type: ConfigType;
  mode: string;
  base_url: string;
  model_id: string;
  credential_status: string;
  endpoint: { protocol: string; host: string; port: string };
}
interface Probe { protocol: string; status: string; httpStatus?: number }
const DEEPSEEK_URL = 'https://api.deepseek.com';
const DEEPSEEK_MODEL = 'deepseek-v4-flash';

export function UpstreamPage() {
  const { auth } = useAuthStore();
  const { t } = useTranslation();
  if (!auth?.isAdmin) return <Alert type="warning">{t('upstream.adminOnly')}</Alert>;
  return <ResourcePage><Card bordered><Card.Body title={t('upstream.title')}>
    <div className="upstream-settings"><UpstreamSettings key={auth.instance_id} /></div>
  </Card.Body></Card></ResourcePage>;
}

function UpstreamSettings() {
  const { t } = useTranslation();
  const [type, setType] = useState<ConfigType>('conversation');
  const [items, setItems] = useState<Config[]>([]);
  const [baseUrl, setBaseUrl] = useState(DEEPSEEK_URL);
  const [modelId, setModelId] = useState(DEEPSEEK_MODEL);
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [results, setResults] = useState<Probe[]>([]);
  const [adopted, setAdopted] = useState<boolean | null>(null);
  const saved = items.find((item) => item.agent_source === 'default' && item.type === type);
  const required = type === 'extraction' ? 1 : 3;
  const ready = results.length === required && results.every((result) => result.status === 'ready');
  const payload = {
    agent_source: 'default' as const,
    type,
    base_url: baseUrl.trim(),
    model_id: modelId.trim(),
    credential_ref: 'deployment_default' as const,
  };

  async function reload() {
    const response = await metaPost<{ items: Config[] }>('instance-upstream/list', {});
    setItems(response.items);
  }

  useEffect(() => {
    let cancelled = false;
    metaPost<{ items: Config[] }>('instance-upstream/list', {})
      .then((response) => { if (!cancelled) setItems(response.items); })
      .catch(() => { if (!cancelled) setError(t('upstream.loadError')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [t]);

  async function openEditor() {
    setBusy(true); setError(''); setNotice(''); setResults([]);
    try {
      const config = await metaPost<Config>('instance-upstream/get-for-edit', { agent_source: 'default', type });
      setBaseUrl(config.base_url || DEEPSEEK_URL);
      setModelId(config.model_id || DEEPSEEK_MODEL);
      setEditing(true);
    } catch { setError(t('upstream.loadError')); }
    finally { setBusy(false); }
  }

  async function test() {
    setBusy(true); setError(''); setNotice(''); setResults([]);
    try {
      const response = await metaPost<{ results: Probe[] }>('instance-upstream/test', payload);
      setResults(response.results);
    } catch { setError(t('upstream.testError')); }
    finally { setBusy(false); }
  }

  async function save() {
    setBusy(true); setError('');
    try {
      await metaPost('instance-upstream/set', { ...payload, mode: 'custom_unified' });
      await reload();
      try {
        const refreshed = await metaPost<{ adopted: boolean }>('instance-upstream/refresh', payload);
        setAdopted(refreshed.adopted);
      } catch { setAdopted(null); }
      setEditing(false); setResults([]);
      setNotice(t('upstream.saved'));
    } catch { setError(t('upstream.saveError')); }
    finally { setBusy(false); }
  }

  async function reset() {
    if (!window.confirm(t('upstream.resetConfirm'))) return;
    setBusy(true); setError('');
    try {
      await metaPost('instance-upstream/reset', { agent_source: 'default', type });
      await reload();
      try {
        const refreshed = await metaPost<{ adopted: boolean }>('instance-upstream/refresh', { ...payload, base_url: '', model_id: '', credential_ref: 'none' });
        setAdopted(refreshed.adopted);
      } catch { setAdopted(null); }
      setEditing(false); setResults([]);
      setNotice(t('upstream.saved'));
    } catch { setError(t('upstream.saveError')); }
    finally { setBusy(false); }
  }

  return <div>
    {error && <Alert type="error">{error}</Alert>}
    <Form layout="vertical">
      <Form.Item label={t('upstream.type')}>
        <Select appearance="button" size="full" value={type} disabled={busy || loading}
          onChange={(value) => { setType(value as ConfigType); setEditing(false); setResults([]); setAdopted(null); setNotice(''); setError(''); }}
          options={[{ value: 'conversation', text: t('upstream.conversation') }, { value: 'extraction', text: t('upstream.extraction') }]} />
      </Form.Item>
      <Form.Item label={t('upstream.current')}>
        {loading ? <Text reset>{t('upstream.loading')}</Text> : saved && saved.mode !== 'official' ? <dl className="upstream-current">
          <dt>{t('upstream.provider')}</dt><dd>{saved.endpoint.host === 'api.deepseek.com' ? 'DeepSeek' : saved.endpoint.host}</dd>
          <dt>{t('upstream.endpoint')}</dt><dd>{saved.endpoint.protocol}://{saved.endpoint.host}{saved.endpoint.port ? `:${saved.endpoint.port}` : ''}</dd>
          <dt>{t('upstream.model')}</dt><dd>{saved.model_id || t('upstream.clientModel')}</dd>
          <dt>{t('upstream.credential')}</dt><dd>{t(saved.credential_status === 'deployment_default' ? 'upstream.deploymentKey' : 'upstream.legacyKey')}</dd>
          <dt>{t('upstream.runtime')}</dt><dd>{adopted === true ? t('upstream.runtimeAdopted') : adopted === false ? t('upstream.runtimePending') : t('upstream.runtimeUnverified')}</dd>
        </dl> : <Text reset>{t('upstream.deployment')}</Text>}
      </Form.Item>
      {!editing && <Button disabled={busy || loading} onClick={() => void openEditor()}>{t('upstream.edit')}</Button>}
      {editing && <>
        <Form.Item label={t('upstream.endpoint')}>
          <Input size="full" value={baseUrl} disabled={busy} onChange={(value) => { setBaseUrl(value); setResults([]); }} placeholder={DEEPSEEK_URL} />
        </Form.Item>
        <Form.Item label={t('upstream.model')}>
          <Input size="full" value={modelId} disabled={busy} onChange={(value) => { setModelId(value); setResults([]); }} placeholder={DEEPSEEK_MODEL} />
        </Form.Item>
        <Text reset>{t('upstream.deploymentKey')}</Text>
      </>}
    </Form>
    {results.map((result) => <Alert key={result.protocol} type={result.status === 'ready' ? 'success' : 'warning'}>
      {result.protocol}: {t(`upstream.result.${result.status}`)}{result.httpStatus && result.status !== 'ready' ? ` (HTTP ${result.httpStatus})` : ''}
    </Alert>)}
    {notice && <Alert type="success">{notice}</Alert>}
    <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
      {editing && <Button disabled={busy || !baseUrl.trim() || !modelId.trim()} onClick={() => void test()}>{t('upstream.test')}</Button>}
      {editing && <Button type="primary" disabled={busy || !ready} onClick={() => void save()}>{t('upstream.save')}</Button>}
      <Button disabled={busy || loading || !saved || saved.mode === 'official'} onClick={() => void reset()}>{t('upstream.reset')}</Button>
    </div>
  </div>;
}
