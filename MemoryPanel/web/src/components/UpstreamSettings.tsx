import { useEffect, useState } from 'react';
import { Alert, Button, Card } from 'tea-component';
import { ResourcePage } from '@/pages/ResourcePage';
import { useAuthStore } from '@/stores/auth';
import { ApiError, metaPost } from '@/lib/api/base';
import { PROVIDERS, providerForUrl, sameUpstreamOrigin, validLocalEndpoint, type ProviderId } from '@/lib/upstream-provider-catalog';
import './UpstreamSettings.css';

type Group = { group_id: string; group_type: 'default' | 'custom'; name: string; agents: string[];
  enabled: boolean; mode: 'official' | 'custom_unified' | 'custom_passthrough'; base_url: string;
  api_key_masked: string; model_id: string; version: number };
type Extraction = { configured: boolean; enabled: boolean; base_url?: string; api_key_masked?: string; model_id?: string; version?: number };
type Agent = { agent_source: string; display_name: string; protocol: string };
type Draft = { group_id?: string; version?: number; name: string; agents: string[]; provider: ProviderId;
  base_url: string; model_id: string; api_key: string; mode: 'custom_unified' | 'custom_passthrough'; local: boolean };
const emptyDraft = (): Draft => ({ name: '', agents: [], provider: 'deepseek', base_url: PROVIDERS[0].baseUrls[0],
  model_id: PROVIDERS[0].models[0], api_key: '', mode: 'custom_unified', local: false });

export function UpstreamPage() {
  const { auth } = useAuthStore();
  if (!auth?.isAdmin) return <Alert type="warning">仅 system admin 可管理模型配置。</Alert>;
  return <ResourcePage><Card bordered><Card.Body title="模型配置"><GroupSettings key={auth.instance_id} /></Card.Body></Card></ResourcePage>;
}

function GroupSettings() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [extraction, setExtraction] = useState<Extraction>({ configured: false, enabled: false });
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editingExtraction, setEditingExtraction] = useState(false);
  const [defaultAgents, setDefaultAgents] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const def = groups.find((g) => g.group_type === 'default');
  const preset = PROVIDERS.find((p) => p.id === draft.provider);
  async function reload() {
    const [list, supported, summary] = await Promise.all([
      metaPost<{ items: Group[] }>('instance-upstream/groups/list', {}),
      metaPost<{ items: Agent[] }>('upstream/supported-agents', {}),
      metaPost<Extraction>('instance-upstream/extraction/get', {}),
    ]);
    setGroups(list.items); setAgents(supported.items); setExtraction(summary);
    setDefaultAgents(list.items.find((g) => g.group_type === 'default')?.agents ?? []);
  }
  useEffect(() => { void reload().catch(() => setError('加载模型组失败')); }, []);
  async function run(action: () => Promise<unknown>) {
    setBusy(true); setError('');
    try { await action(); await reload(); return true; }
    catch (cause) { setError(cause instanceof ApiError && cause.code ? `操作失败：${cause.code}` : '操作失败，请刷新后重试'); return false; }
    finally { setBusy(false); }
  }
  function occupied(agent: string, own?: string) { return groups.find((g) => g.group_id !== own && g.agents.includes(agent)); }
  function choose(items: string[], agent: string) { return items.includes(agent) ? items.filter((a) => a !== agent) : [...items, agent]; }
  function edit(group?: Group) {
    setEditingExtraction(false);
    setDraft(group ? { group_id: group.group_id, version: group.version, name: group.name, agents: group.agents,
      provider: providerForUrl(group.base_url), base_url: group.base_url, model_id: group.model_id, api_key: '',
      mode: group.mode === 'custom_passthrough' ? 'custom_passthrough' : 'custom_unified', local: validLocalEndpoint(group.base_url) } : emptyDraft());
  }
  async function save() {
    const old = editingExtraction ? extraction : groups.find((g) => g.group_id === draft.group_id);
    let valid = draft.local ? validLocalEndpoint(draft.base_url) : false;
    if (!draft.local) { try { const url = new URL(draft.base_url); valid = url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash; } catch { valid = false; } }
    if (!valid || !draft.model_id.trim() || (!editingExtraction && (!draft.name.trim() || !draft.agents.length))) {
      setError('请填写有效地址、模型 ID、组名并分配至少一个客户端'); return;
    }
    if ((editingExtraction || draft.mode === 'custom_unified') && !draft.api_key.trim() &&
      (!old?.api_key_masked || !sameUpstreamOrigin(old.base_url ?? '', draft.base_url))) {
      setError('请填写此供应商地址的独立 API Key'); return;
    }
    const fields = { base_url: draft.base_url.trim(), model_id: draft.model_id.trim(),
      ...(draft.api_key.trim() ? { api_key: draft.api_key.trim() } : {}) };
    const action = editingExtraction ? `instance-upstream/extraction/${extraction.configured ? 'update' : 'create'}`
      : `instance-upstream/groups/${draft.group_id ? 'update' : 'create'}`;
    const ok = await run(() => metaPost(action, editingExtraction
      ? { ...fields, expected_version: extraction.version }
      : { ...fields, group_type: 'custom', name: draft.name.trim(), agents: draft.agents, mode: draft.mode,
        ...(draft.group_id ? { group_id: draft.group_id, expected_version: draft.version } : {}) }));
    if (ok) { setDraft(emptyDraft()); setEditingExtraction(false); }
  }
  return <div className="upstream-settings">
    <section className="upstream-card" aria-label="对话模型组"><h2>对话模型组</h2>
      {error && <Alert type="error">{error}</Alert>}
      <p className="upstream-help">每个客户端只能分配给一个组。停用组会阻止该组客户端调用；移组时先在原组取消分配，再加入目标组。配置最多约 30 秒后生效。</p>
      {def && <article className="upstream-profile"><h3>{def.name}</h3>
        <label><input type="checkbox" checked={def.enabled} disabled={busy} onChange={() => void run(() => metaPost('instance-upstream/groups/toggle', { group_id: def.group_id, enabled: !def.enabled, expected_version: def.version }))} />启用默认组</label>
        <div>{agents.map((a) => <label key={a.agent_source} style={{ display: 'inline-block', margin: 8 }}>
          <input type="checkbox" checked={defaultAgents.includes(a.agent_source)} disabled={busy || !!occupied(a.agent_source, def.group_id)}
            onChange={() => setDefaultAgents(choose(defaultAgents, a.agent_source))} />{a.display_name}</label>)}</div>
        <Button disabled={busy} onClick={() => void run(() => metaPost('instance-upstream/groups/update', { group_id: def.group_id, group_type: 'default', agents: defaultAgents, expected_version: def.version }))}>保存默认组分配</Button>
      </article>}
      {groups.filter((g) => g.group_type === 'custom').map((g) => <article key={g.group_id} className="upstream-profile">
        <h3>{g.name}</h3><p>{g.model_id} · {g.agents.join('、')}</p><p>API Key：{g.api_key_masked || '未保存'}</p>
        <div className="upstream-actions"><Button disabled={busy} onClick={() => edit(g)}>编辑</Button>
          <Button disabled={busy} onClick={() => void run(() => metaPost('instance-upstream/groups/toggle', { group_id: g.group_id, enabled: !g.enabled, expected_version: g.version }))}>{g.enabled ? '停用' : '启用'}</Button>
          <Button disabled={busy} onClick={() => { if (window.confirm(`删除模型组“${g.name}”？该组客户端将失去分配。`)) void run(() => metaPost('instance-upstream/groups/delete', { group_id: g.group_id })); }}>删除</Button></div>
      </article>)}
      <Button disabled={busy} onClick={() => edit()}>新建自定义组</Button>
      <h2>总结模型 / Core 与 Knowledge</h2>
      <p>{extraction.configured ? `${extraction.model_id} · ${extraction.enabled ? '已启用' : '已停用'} · ${extraction.api_key_masked}` : '未配置，使用部署默认总结模型'}</p>
      <p className="upstream-help">停用或删除总结模型会回退到部署默认配置。</p>
      <div className="upstream-actions"><Button disabled={busy} onClick={() => {
        setEditingExtraction(true); setDraft({ ...emptyDraft(), base_url: extraction.base_url ?? emptyDraft().base_url,
          model_id: extraction.model_id ?? emptyDraft().model_id, provider: providerForUrl(extraction.base_url ?? ''), local: validLocalEndpoint(extraction.base_url ?? '') });
      }}>{extraction.configured ? '编辑总结模型' : '配置总结模型'}</Button>
      {extraction.configured && <><Button disabled={busy} onClick={() => void run(() => metaPost('instance-upstream/extraction/toggle', { enabled: !extraction.enabled, expected_version: extraction.version }))}>{extraction.enabled ? '停用' : '启用'}</Button>
        <Button disabled={busy} onClick={() => { if (window.confirm('删除总结模型配置？')) void run(() => metaPost('instance-upstream/extraction/delete', {})); }}>删除</Button></>}</div>
    </section>
    <section className="upstream-card" aria-label="模型组编辑"><h2>{editingExtraction ? '编辑总结模型' : draft.group_id ? '编辑自定义组' : '新建自定义组'}</h2>
      <div className="upstream-form">
        {!editingExtraction && <><label>组名<input value={draft.name} disabled={busy} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
          <fieldset><legend>客户端分配</legend>{agents.map((a) => <label key={a.agent_source}>
            <input type="checkbox" checked={draft.agents.includes(a.agent_source)} disabled={busy || !!occupied(a.agent_source, draft.group_id)} onChange={() => setDraft({ ...draft, agents: choose(draft.agents, a.agent_source) })} />{a.display_name}{occupied(a.agent_source, draft.group_id) ? `（已分配：${occupied(a.agent_source, draft.group_id)?.name}）` : ''}</label>)}</fieldset>
          <label>凭据方式<select value={draft.mode} disabled={busy} onChange={(e) => setDraft({ ...draft, mode: e.target.value as Draft['mode'] })}>
            <option value="custom_unified">使用独立供应商 Key</option><option value="custom_passthrough">透传客户端凭据</option></select></label></>}
        <label>供应商<select value={draft.provider} disabled={busy} onChange={(e) => { const provider = e.target.value as ProviderId; const next = PROVIDERS.find((p) => p.id === provider);
          setDraft({ ...draft, provider, base_url: next?.baseUrls[0] ?? '', model_id: next?.models[0] ?? '', api_key: '', local: provider === 'local' });
        }}>{PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}<option value="local">本地模型</option><option value="custom">自定义供应商</option></select></label>
        <label>URL<input list="group-model-urls" disabled={busy} value={draft.base_url} onChange={(e) => setDraft({ ...draft, base_url: e.target.value })} /></label>
        <datalist id="group-model-urls">{preset?.baseUrls.map((url) => <option key={url} value={url} />)}</datalist>
        <label>模型 ID<input list="group-model-ids" disabled={busy} value={draft.model_id} onChange={(e) => setDraft({ ...draft, model_id: e.target.value })} /></label>
        <datalist id="group-model-ids">{preset?.models.map((model) => <option key={model} value={model} />)}</datalist>
        {(editingExtraction || draft.mode === 'custom_unified') && <label>独立 API Key<input type="password" autoComplete="new-password" disabled={busy} value={draft.api_key} placeholder="同一供应商地址可留空沿用已保存 Key" onChange={(e) => setDraft({ ...draft, api_key: e.target.value })} /></label>}
        <Button disabled={busy} onClick={() => void save()}>保存</Button>
      </div>
    </section>
  </div>;
}
