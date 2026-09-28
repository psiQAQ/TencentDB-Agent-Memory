import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Form, Input, Select, Text, Card } from 'tea-component';
import { ResourcePage } from '@/pages/ResourcePage';
import { useAuthStore } from '@/stores/auth';
import { metaPost } from '@/lib/api/base';
import {
  LOCAL_ENDPOINT_DESCRIPTION, PROVIDERS, providerForUrl, sameUpstreamOrigin, validLocalEndpoint,
  type ProviderId, type UpstreamProtocol,
} from '@/lib/upstream-provider-catalog';

import './UpstreamSettings.css';

type ConfigType = 'conversation' | 'extraction';
type KeyMode = 'deployment' | 'independent';
interface Config {
  agent_source: string;
  type: ConfigType;
  mode: string;
  base_url: string;
  model_id: string;
  credential_status: string;
  description: string;
  endpoint: { protocol: string; host: string; port: string };
}
interface Probe { protocol: string; status: string; httpStatus?: number }
const CUSTOM = '__custom__';
const DEEPSEEK_URL = 'https://api.deepseek.com';
const DEEPSEEK_MODEL = 'deepseek-flash';

export function UpstreamPage() {
  const { auth } = useAuthStore();
  const { t } = useTranslation();
  if (!auth?.isAdmin) return <Alert type="warning">{t('upstream.adminOnly')}</Alert>;
  return <ResourcePage><Card bordered><Card.Body title={t('upstream.title')}>
    <div className="upstream-settings">
      <UpstreamSettings key={`${auth.instance_id}:conversation`} type="conversation" />
      <UpstreamSettings key={`${auth.instance_id}:extraction`} type="extraction" />
    </div>
  </Card.Body></Card></ResourcePage>;
}

function UpstreamSettings({ type }: { type: ConfigType }) {
  const { t } = useTranslation();
  const [saved, setSaved] = useState<Config | null>(null);
  const [providerId, setProviderId] = useState<ProviderId>('deepseek');
  const [endpointChoice, setEndpointChoice] = useState(DEEPSEEK_URL);
  const [baseUrl, setBaseUrl] = useState(DEEPSEEK_URL);
  const [modelChoice, setModelChoice] = useState(DEEPSEEK_MODEL);
  const [modelId, setModelId] = useState(DEEPSEEK_MODEL);
  const [keyMode, setKeyMode] = useState<KeyMode>('deployment');
  const [apiKey, setApiKey] = useState('');
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [results, setResults] = useState<Probe[]>([]);
  const [adopted, setAdopted] = useState<boolean | null>(null);

  const preset = PROVIDERS.find((entry) => entry.id === providerId);
  const protocols: readonly UpstreamProtocol[] = type === 'extraction' ? ['chat'] : (preset?.protocols ?? ['chat']);
  const ready = results.length === protocols.length && results.every((result) => result.status === 'ready');
  const reuseKey = keyMode === 'independent' && !apiKey.trim() &&
    saved?.credential_status === 'configured' && sameUpstreamOrigin(saved.base_url, baseUrl);
  const validEndpoint = providerId === 'local'
    ? validLocalEndpoint(baseUrl)
    : (() => {
      try {
        const url = new URL(baseUrl);
        return url.protocol === 'https:' && !url.port && !url.username && !url.password && !url.search && !url.hash;
      } catch { return false; }
    })();
  const hasKey = keyMode === 'deployment'
    ? sameUpstreamOrigin(baseUrl, DEEPSEEK_URL)
    : !!apiKey.trim() || reuseKey;
  const canSave = validEndpoint && !!modelId.trim() && hasKey && (ready || reuseKey);
  const payload = {
    agent_source: 'default' as const,
    type,
    base_url: baseUrl.trim(),
    model_id: modelId.trim(),
  };

  async function load(): Promise<Config> {
    const config = await metaPost<Config>('instance-upstream/get-for-edit', { agent_source: 'default', type });
    setSaved(config);
    return config;
  }

  useEffect(() => {
    let cancelled = false;
    metaPost<Config>('instance-upstream/get-for-edit', { agent_source: 'default', type })
      .then((config) => { if (!cancelled) setSaved(config); })
      .catch(() => { if (!cancelled) setError(t('upstream.loadError')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [type, t]);

  function clearProbe() {
    setResults([]);
    setAdopted(null);
    setNotice('');
  }

  function selectProvider(next: ProviderId) {
    const nextPreset = PROVIDERS.find((entry) => entry.id === next);
    const nextUrl = nextPreset?.baseUrls[0] ?? '';
    const nextModel = nextPreset?.models[0] ?? '';
    setProviderId(next);
    setEndpointChoice(nextUrl || CUSTOM);
    setBaseUrl(nextUrl);
    setModelChoice(nextModel || CUSTOM);
    setModelId(nextModel);
    setKeyMode(next === 'deepseek' ? 'deployment' : 'independent');
    setApiKey('');
    clearProbe();
  }

  async function openEditor() {
    setBusy(true); setError(''); clearProbe();
    try {
      const config = await load();
      const nextUrl = config.mode === 'official' ? DEEPSEEK_URL : config.base_url;
      const nextProvider = config.description === LOCAL_ENDPOINT_DESCRIPTION ? 'local' : providerForUrl(nextUrl);
      const nextPreset = PROVIDERS.find((entry) => entry.id === nextProvider);
      const nextModel = config.model_id || nextPreset?.models[0] || DEEPSEEK_MODEL;
      setProviderId(nextProvider);
      setBaseUrl(nextUrl);
      setEndpointChoice(nextPreset?.baseUrls.includes(nextUrl) ? nextUrl : CUSTOM);
      setModelId(nextModel);
      setModelChoice(nextPreset?.models.includes(nextModel) ? nextModel : CUSTOM);
      setKeyMode(nextProvider === 'deepseek' && config.credential_status !== 'configured' ? 'deployment' : 'independent');
      setApiKey('');
      setEditing(true);
    } catch { setError(t('upstream.loadError')); }
    finally { setBusy(false); }
  }

  async function test() {
    if (!apiKey.trim() && keyMode === 'independent') return;
    setBusy(true); setError(''); clearProbe();
    try {
      const auth = keyMode === 'deployment'
        ? { credential_ref: 'deployment_default' as const }
        : { api_key: apiKey.trim() };
      const response = await metaPost<{ results: Probe[] }>('instance-upstream/test', {
        ...payload, ...auth, local: providerId === 'local', protocols,
      });
      setResults(response.results);
    } catch { setError(t('upstream.testError')); }
    finally { setBusy(false); }
  }

  async function save() {
    if (!canSave) return;
    setBusy(true); setError('');
    try {
      const auth = keyMode === 'deployment'
        ? { credential_ref: 'deployment_default' as const }
        : apiKey.trim() ? { api_key: apiKey.trim() } : {};
      await metaPost('instance-upstream/set', {
        ...payload, ...auth, mode: 'custom_unified',
        description: providerId === 'local' ? LOCAL_ENDPOINT_DESCRIPTION : '',
      });
      await load();
      try {
        const refreshed = await metaPost<{ adopted: boolean }>('instance-upstream/refresh', {
          ...payload, credential_ref: keyMode === 'deployment' ? 'deployment_default' : 'stored',
        });
        setAdopted(refreshed.adopted);
      } catch { setAdopted(null); }
      setApiKey('');
      setEditing(false);
      setNotice(t('upstream.saved'));
    } catch { setError(t('upstream.saveError')); }
    finally { setBusy(false); }
  }

  async function reset() {
    if (!window.confirm(t('upstream.resetConfirm'))) return;
    setBusy(true); setError('');
    try {
      await metaPost('instance-upstream/reset', { agent_source: 'default', type });
      await load();
      try {
        const refreshed = await metaPost<{ adopted: boolean }>('instance-upstream/refresh', {
          ...payload, base_url: '', model_id: '', credential_ref: 'none',
        });
        setAdopted(refreshed.adopted);
      } catch { setAdopted(null); }
      setApiKey('');
      setEditing(false); setResults([]);
      setNotice(t('upstream.saved'));
    } catch { setError(t('upstream.saveError')); }
    finally { setBusy(false); }
  }

  return <section className="upstream-card" aria-label={t(`upstream.${type}`)}>
    <h2>{t(`upstream.${type}`)}</h2>
    {error && <Alert type="error">{error}</Alert>}
    <Form layout="vertical">
      <Form.Item label={t('upstream.current')}>
        {loading ? <Text reset>{t('upstream.loading')}</Text> : saved && saved.mode !== 'official' ? <dl className="upstream-current">
          <dt>{t('upstream.provider')}</dt><dd>{saved.description === LOCAL_ENDPOINT_DESCRIPTION
            ? t('upstream.local') : PROVIDERS.find((item) => item.id === providerForUrl(saved.base_url))?.name ?? t('upstream.localOrCustom')}</dd>
          <dt>{t('upstream.endpoint')}</dt><dd>{saved.endpoint.protocol}://{saved.endpoint.host}{saved.endpoint.port ? `:${saved.endpoint.port}` : ''}</dd>
          <dt>{t('upstream.model')}</dt><dd>{saved.model_id || t('upstream.clientModel')}</dd>
          <dt>{t('upstream.credential')}</dt><dd>{t(saved.credential_status === 'deployment_default' ? 'upstream.deploymentKey' : 'upstream.independentKeySaved')}</dd>
          <dt>{t('upstream.runtime')}</dt><dd>{adopted === true ? t('upstream.runtimeAdopted') : adopted === false ? t('upstream.runtimePending') : t('upstream.runtimeUnverified')}</dd>
        </dl> : <Text reset>{t('upstream.deployment')}</Text>}
      </Form.Item>
      {!editing && <Button disabled={busy || loading} onClick={() => void openEditor()}>{t('upstream.edit')}</Button>}
      {editing && <>
        <Form.Item label={t('upstream.provider')}>
          <Select appearance="button" size="full" value={providerId} disabled={busy}
            onChange={(value) => selectProvider(value as ProviderId)}
            options={[
              ...PROVIDERS.filter((entry) => type === 'conversation' || entry.protocols.includes('chat'))
                .map((entry) => ({ value: entry.id, text: entry.name })),
              { value: 'local', text: t('upstream.local') },
              { value: 'custom', text: t('upstream.custom') },
            ]} />
        </Form.Item>
        {preset && <Form.Item label={t('upstream.endpoint')}>
          <Select appearance="button" size="full" value={endpointChoice} disabled={busy}
            onChange={(value) => { setEndpointChoice(value); if (value !== CUSTOM) setBaseUrl(value); clearProbe(); }}
            options={[
              ...preset.baseUrls.map((value) => ({ value, text: value })),
              { value: CUSTOM, text: t('upstream.customAddress') },
            ]} />
        </Form.Item>}
        {(!preset || endpointChoice === CUSTOM) && <Form.Item label={t('upstream.endpoint')}>
          <Input size="full" value={baseUrl} disabled={busy}
            onChange={(value) => { setBaseUrl(value); clearProbe(); }}
            placeholder={providerId === 'local' ? 'http://host.docker.internal:11434/v1' : 'https://provider.example/v1'} />
        </Form.Item>}
        {preset && <Form.Item label={t('upstream.model')}>
          <Select appearance="button" size="full" value={modelChoice} disabled={busy}
            onChange={(value) => { setModelChoice(value); if (value !== CUSTOM) setModelId(value); clearProbe(); }}
            options={[
              ...preset.models.map((value) => ({ value, text: value })),
              { value: CUSTOM, text: t('upstream.customModel') },
            ]} />
        </Form.Item>}
        {(!preset || modelChoice === CUSTOM) && <Form.Item label={t('upstream.model')}>
          <Input size="full" value={modelId} disabled={busy}
            onChange={(value) => { setModelId(value); clearProbe(); }}
            placeholder={t('upstream.modelPlaceholder')} />
        </Form.Item>}
        {providerId === 'deepseek' && <Form.Item label={t('upstream.credential')}>
          <Select appearance="button" size="full" value={keyMode} disabled={busy}
            onChange={(value) => { setKeyMode(value as KeyMode); setApiKey(''); clearProbe(); }}
            options={[
              { value: 'deployment', text: t('upstream.deploymentKey') },
              { value: 'independent', text: t('upstream.independentKey') },
            ]} />
        </Form.Item>}
        {keyMode === 'independent' ? <Form.Item label={t('upstream.independentKey')}>
          <input className="upstream-secret-input" type="password" autoComplete="new-password"
            value={apiKey} disabled={busy} onChange={(event) => { setApiKey(event.target.value); clearProbe(); }}
            placeholder={reuseKey ? t('upstream.keepSavedKey') : t('upstream.enterKey')} />
        </Form.Item> : <Text reset>{t('upstream.deploymentKey')}</Text>}
        <p className="upstream-help">{t('upstream.protocols', { protocols: protocols.join(', ') })}</p>
        {providerId === 'local' && <p className="upstream-help">{t('upstream.localHelp')}</p>}
        {reuseKey && <p className="upstream-help">{t('upstream.reuseKeyHelp')}</p>}
      </>}
    </Form>
    {results.map((result) => <Alert key={result.protocol} type={result.status === 'ready' ? 'success' : 'warning'}>
      {result.protocol}: {t(`upstream.result.${result.status}`)}{result.httpStatus && result.status !== 'ready' ? ` (HTTP ${result.httpStatus})` : ''}
    </Alert>)}
    {notice && <Alert type="success">{notice}</Alert>}
    <div className="upstream-actions">
      {editing && <Button disabled={busy || !validEndpoint || !modelId.trim() || !hasKey || (keyMode === 'independent' && !apiKey.trim())} onClick={() => void test()}>{t('upstream.test')}</Button>}
      {editing && <Button type="primary" disabled={busy || !canSave} onClick={() => void save()}>{t('upstream.save')}</Button>}
      <Button disabled={busy || loading || !saved || saved.mode === 'official'} onClick={() => void reset()}>{t('upstream.reset')}</Button>
    </div>
  </section>;
}
