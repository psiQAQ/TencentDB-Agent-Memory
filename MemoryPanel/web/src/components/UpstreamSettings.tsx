import { useEffect, useState } from 'react';
import { Alert, Button, Card } from 'tea-component';
import { ResourcePage } from '@/pages/ResourcePage';
import { useAuthStore } from '@/stores/auth';
import { ApiError, metaPost } from '@/lib/api/base';
import { PROVIDERS, providerForUrl, sameUpstreamOrigin, validLocalEndpoint, type ProviderId } from '@/lib/upstream-provider-catalog';
import './UpstreamSettings.css';

type Kind = 'conversation' | 'extraction';
interface Profile { id: string; name: string; type: Kind; base_url: string; model_id: string;
  local: boolean; has_api_key: boolean; ready_protocols: string[]; checked_at: string | null;
  probe_failed: boolean; probe_results: Array<{ protocol: string; status: string; httpStatus?: number }> }
interface Library { profiles: Profile[]; active_id: string | null }
interface Draft { id?: string; name: string; provider: ProviderId; base_url: string; model_id: string; api_key: string; local: boolean }
const emptyDraft = (): Draft => ({ name: '', provider: 'deepseek', base_url: PROVIDERS[0].baseUrls[0],
  model_id: PROVIDERS[0].models[0], api_key: '', local: false });

export function UpstreamPage() {
  const { auth } = useAuthStore();
  if (!auth?.isAdmin) return <Alert type="warning">仅 system admin 可管理模型配置。</Alert>;
  return <ResourcePage><Card bordered><Card.Body title="模型配置"><div className="upstream-settings">
    <ProfileColumn key={`${auth.instance_id}:conversation`} type="conversation" />
    <ProfileColumn key={`${auth.instance_id}:extraction`} type="extraction" />
  </div></Card.Body></Card></ResourcePage>;
}

function ProfileColumn({ type }: { type: Kind }) {
  const [library, setLibrary] = useState<Library>({ profiles: [], active_id: null });
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [failed, setFailed] = useState<string | null>(null);
  const preset = PROVIDERS.find((item) => item.id === draft.provider);
  const title = type === 'conversation' ? '对话模型 / Proxy' : '总结模型 / Core 与 Knowledge';

  async function reload() { setLibrary(await metaPost<Library>('upstream-profile/list', { type })); }
  useEffect(() => { void reload().catch(() => setError('加载配置库失败')); }, [type]);

  async function save() {
    setError('');
    const urlValid = draft.local ? validLocalEndpoint(draft.base_url) : (() => {
      try { const url = new URL(draft.base_url); return url.protocol === 'https:' && !url.port &&
        !url.username && !url.password && !url.search && !url.hash; } catch { return false; }
    })();
    if (!draft.name.trim() || !draft.model_id.trim() || !urlValid) { setError('请填写备注名、有效地址和模型 ID'); return; }
    const old = library.profiles.find((item) => item.id === draft.id);
    if (!draft.api_key.trim() && (!old?.has_api_key || !sameUpstreamOrigin(old.base_url, draft.base_url))) {
      setError('请填写此地址的独立 API Key'); return;
    }
    setBusy(true);
    try {
      setLibrary(await metaPost<Library>('upstream-profile/save', { type, ...(draft.id ? { id: draft.id } : {}),
        name: draft.name.trim(), base_url: draft.base_url.trim(), model_id: draft.model_id.trim(),
        ...(draft.api_key.trim() ? { api_key: draft.api_key.trim() } : {}), local: draft.local }));
      setDraft(emptyDraft()); setFailed(null);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 429) setError('探测请求过快，请间隔 10 秒后重试；原配置继续生效');
      else { setError('保存或生效前验证失败；原配置继续生效'); if (draft.id) setFailed(draft.id); }
    }
    finally { setBusy(false); }
  }

  async function activate(id: string) {
    if (busy || library.active_id === id) return;
    setBusy(true); setError(''); setFailed(null);
    try { setLibrary(await metaPost<Library>('upstream-profile/activate', { type, id })); }
    catch (cause) {
      if (cause instanceof ApiError && cause.status === 429) setError('探测请求过快，请间隔 10 秒后重试；原配置继续生效');
      else { setFailed(id); setError('模型验证失败；原配置继续生效'); }
    }
    finally { setBusy(false); }
  }

  async function remove(id: string) {
    if (!window.confirm('删除此配置条？')) return;
    setBusy(true); setError('');
    try { setLibrary(await metaPost<Library>('upstream-profile/delete', { type, id }));
      if (draft.id === id) setDraft(emptyDraft()); }
    catch { setError('删除失败'); }
    finally { setBusy(false); }
  }

  return <section className="upstream-card" aria-label={title}>
    <h2>{title}</h2>{error && <Alert type="error">{error}</Alert>}
    <p className="upstream-help">每侧仅启用一条；选择前会实际调用模型验证。供应商 Key 不会回显。</p>
    <div className="upstream-form">
      <label>备注名<input value={draft.name} disabled={busy} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
      <label>供应商<select value={draft.provider} disabled={busy} onChange={(e) => {
        const provider = e.target.value as ProviderId;
        const next = PROVIDERS.find((item) => item.id === provider);
        setDraft({ ...draft, provider, base_url: next?.baseUrls[0] ?? '', model_id: next?.models[0] ?? '',
          api_key: '', local: provider === 'local' });
      }}>{PROVIDERS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        <option value="local">本地模型</option><option value="custom">自定义供应商</option></select></label>
      <label>URL<input list={`${type}-urls`} value={draft.base_url} disabled={busy}
        onChange={(e) => setDraft({ ...draft, base_url: e.target.value })} /></label>
      <datalist id={`${type}-urls`}>{preset?.baseUrls.map((url) => <option key={url} value={url} />)}</datalist>
      <label>模型 ID<input list={`${type}-models`} value={draft.model_id} disabled={busy}
        onChange={(e) => setDraft({ ...draft, model_id: e.target.value })} /></label>
      <datalist id={`${type}-models`}>{preset?.models.map((model) => <option key={model} value={model} />)}</datalist>
      <label>独立 API Key<input type="password" value={draft.api_key} autoComplete="new-password" disabled={busy}
        placeholder={draft.id ? '留空以沿用同一地址的 Key' : '填写 API Key'}
        onChange={(e) => setDraft({ ...draft, api_key: e.target.value })} /></label>
      <div className="upstream-actions"><Button onClick={() => void save()} disabled={busy}>保存配置条</Button>
        {draft.id && <Button onClick={() => setDraft(emptyDraft())} disabled={busy}>取消编辑</Button>}</div>
    </div>
    <div className="upstream-profile-list">
      {library.profiles.length === 0 && <p>尚无配置条；保存后选择并验证一条配置。</p>}
      {library.profiles.map((profile) => <article key={profile.id} className="upstream-profile">
        <div className="upstream-profile-head">
          <input type="checkbox" aria-label={`启用 ${profile.name}`} checked={library.active_id === profile.id}
            disabled={busy || library.active_id === profile.id || !profile.has_api_key}
            onChange={() => void activate(profile.id)} />
          <button type="button" className="upstream-profile-name" onClick={() => setExpanded(expanded === profile.id ? null : profile.id)}>{profile.name}</button>
          <span className={failed === profile.id || profile.probe_failed ? 'upstream-status-bad' : profile.checked_at ? 'upstream-status-good' : ''}>
            {failed === profile.id || profile.probe_failed ? '验证失败' : profile.checked_at ? '验证通过' : '未验证'}</span>
        </div>
        {expanded === profile.id && <div className="upstream-profile-detail">
          <div>URL：{profile.base_url}</div><div>模型 ID：{profile.model_id}</div>
          <div>API Key：{profile.has_api_key ? '已保存' : '未填写'}</div>
          <div>通过协议：{profile.ready_protocols.join('、') || '尚无'}</div>
          {profile.probe_results.map((result) => <div key={result.protocol}>
            {result.protocol}：{result.status}{result.httpStatus ? ` (HTTP ${result.httpStatus})` : ''}</div>)}
          <div className="upstream-actions"><Button disabled={busy} onClick={() => {
            setDraft({ id: profile.id, name: profile.name, provider: providerForUrl(profile.base_url),
              base_url: profile.base_url, model_id: profile.model_id, api_key: '', local: profile.local }); setError('');
          }}>编辑</Button>
            <Button disabled={busy} onClick={() => setDraft({ name: `${profile.name} 副本`,
              provider: providerForUrl(profile.base_url), base_url: profile.base_url,
              model_id: profile.model_id, api_key: '', local: profile.local })}>克隆</Button>
            <Button disabled={busy} onClick={() => void remove(profile.id)}>删除</Button></div>
        </div>}
      </article>)}
    </div>
  </section>;
}
