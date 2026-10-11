import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Modal } from 'tea-component';
import { ResourcePage } from '@/pages/ResourcePage';
import { useAuthStore } from '@/stores/auth';
import { metaPost } from '@/lib/api/base';
import { PROVIDERS, type ProviderId } from '@/lib/upstream-provider-catalog';
import {
  canReuseModelKey, draftFromExtraction, draftFromGroup, emptyModelDraft, modelFailureMessage,
  modelWriteRequest, validateModelDraft, writeModelAndReload, supportsSubscriptionAgent, subscriptionProbeProtocols,
  type DraftErrors, type ExtractionModel, type ModelDraft, type ModelGroup,
} from '@/lib/upstream-settings-form';
import './UpstreamSettings.css';
import { ModelCatalogPicker, ModelCatalogStatus, useModelCatalog } from './ModelCatalogPicker';

type Agent = { agent_source: string; display_name: string; protocol: string };
type Editor = 'group' | 'extraction' | 'assignment' | null;
type ProbeResult = { results: Array<{ protocol: string; status: string }> };

export function UpstreamPage() {
  const { auth } = useAuthStore();
  if (!auth?.isAdmin) return <Alert type="warning">仅 system admin 可管理模型配置。</Alert>;
  return <ResourcePage><Card bordered><Card.Body title="模型配置"><GroupSettings key={auth.instance_id} /></Card.Body></Card></ResourcePage>;
}

function GroupSettings() {
  const catalog = useModelCatalog();
  const [groups, setGroups] = useState<ModelGroup[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [extraction, setExtraction] = useState<ExtractionModel>({ configured: false, enabled: false });
  const [draft, setDraft] = useState<ModelDraft>(emptyModelDraft);
  const [editor, setEditor] = useState<Editor>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [errors, setErrors] = useState<DraftErrors>({});
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const working = busy || testing || loading;
  const currentGroup = groups.find((group) => group.group_id === draft.group_id);
  const saved = editor === 'extraction' ? extraction : currentGroup;
  const preset = PROVIDERS.find((provider) => provider.id === draft.provider);
  const occupied = (agent: string) => groups.find((group) => group.agents.includes(agent));
  const agentName = (source: string) => agents.find((agent) => agent.agent_source === source)?.display_name ?? source;
  const freeAgents = agents.filter((agent) => !occupied(agent.agent_source));
  const availableAgents = agents.filter((agent) => {
    const owner = occupied(agent.agent_source);
    return !owner || owner.group_id === draft.group_id;
  });

  const reload = useCallback(async () => {
    const [list, supported, summary] = await Promise.all([
      metaPost<{ items: ModelGroup[] }>('instance-upstream/groups/list', {}),
      metaPost<{ items: Agent[] }>('upstream/supported-agents', {}),
      metaPost<ExtractionModel>('instance-upstream/extraction/get', {}),
    ]);
    setGroups(list.items); setAgents(supported.items); setExtraction(summary);
  }, []);
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { await reload(); }
    catch { setError('加载模型配置失败，请确认 Core 服务正常后重新加载。'); }
    finally { setLoading(false); }
  }, [reload]);
  useEffect(() => { void load(); }, [load]);

  async function run(action: () => Promise<unknown>, message: string) {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await writeModelAndReload(action, reload);
      setNotice(message);
      if (result.refreshFailed) setError('配置已保存，但列表刷新失败。请重新加载配置，不要重复创建模型组。');
      return true;
    } catch (cause) { setError(modelFailureMessage(cause)); return false; }
    finally { setBusy(false); }
  }

  function closeEditor() {
    setEditor(null); setDraft(emptyModelDraft()); setErrors({}); setProbe(null);
  }
  function openEditor(kind: Exclude<Editor, null>, group?: ModelGroup) {
    setEditor(kind); setError(''); setNotice(''); setErrors({}); setProbe(null);
    const next = kind === 'extraction' ? draftFromExtraction(extraction) : group ? draftFromGroup(group) : emptyModelDraft();
    if (catalog.catalog?.public_catalog.models.some((model) => model.provider_id === next.provider && model.id === next.model_id)
      || catalog.catalog?.connections.some((connection) => connection.provider_id === next.provider
        && connection.snapshot?.models.some((model) => model.id === next.model_id))) next.custom_model = false;
    setDraft(next);
  }
  const change = useCallback((patch: Partial<ModelDraft>) => {
    setDraft((previous) => ({ ...previous, ...patch })); setErrors({}); setProbe(null); setError('');
  }, []);
  function selectAgent(source: string) {
    change({ agents: draft.agents.includes(source) ? draft.agents.filter((agent) => agent !== source) : [...draft.agents, source] });
  }

  async function save() {
    if (editor === 'assignment' && currentGroup) {
      const ok = await run(() => metaPost('instance-upstream/groups/update', {
        group_id: currentGroup.group_id, group_type: currentGroup.group_type,
        agents: draft.agents, expected_version: draft.version,
      }), '客户端分配已保存，最多约 30 秒后生效。');
      if (ok) closeEditor();
      return;
    }
    const nextErrors = validateModelDraft(draft, saved, editor === 'extraction');
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;
    const request = modelWriteRequest(draft, editor === 'extraction' ? extraction : undefined);
    const message = editor === 'extraction' ? '总结模型已保存，供 Core 和 Knowledge 使用。'
      : draft.agents.length ? '模型组已保存，客户端配置最多约 30 秒后生效。'
        : '模型组已保存，尚未分配客户端。点击该组的“分配客户端”继续配置。';
    if (await run(() => metaPost(request.action, request.body), message)) closeEditor();
  }

  async function testConnection() {
    const nextErrors = validateModelDraft({ ...draft, mode: 'custom_unified' }, undefined, true);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;
    setTesting(true); setError(''); setProbe(null);
    try {
      const result = await metaPost<ProbeResult>('instance-upstream/test', {
        credential_kind: draft.credential_kind,
        ...(draft.credential_kind === 'chatgpt_oauth' ? { credential_ref: draft.credential_ref } : {}),
        agent_source: 'default', type: editor === 'extraction' ? 'extraction' : 'conversation',
        base_url: draft.base_url.trim(), model_id: draft.model_id.trim(), api_key: draft.api_key.trim(),
        local: draft.provider === 'local', protocols: draft.credential_kind === 'chatgpt_oauth'
          ? subscriptionProbeProtocols(draft.agents, editor === 'extraction')
          : editor === 'extraction' ? ['chat'] : preset?.protocols ?? ['chat'],
      });
      setProbe(result);
    } catch (cause) { setError(modelFailureMessage(cause)); }
    finally { setTesting(false); }
  }

  function toggleGroup(group: ModelGroup) {
    if (group.enabled && !window.confirm(`停用“${group.name}”？已分配的客户端将无法调用模型。`)) return;
    void run(() => metaPost('instance-upstream/groups/toggle', {
      group_id: group.group_id, enabled: !group.enabled, expected_version: group.version,
    }), group.enabled ? '模型组已停用。' : '模型组已启用。');
  }

  const caption = editor === 'assignment' ? `分配客户端 · ${draft.name}` : editor === 'extraction'
    ? (extraction.configured ? '编辑总结模型' : '配置总结模型') : draft.group_id ? '编辑自定义组' : '新建自定义组';
  const reusingKey = canReuseModelKey(draft, saved);

  return <div className="upstream-settings">
    <ModelCatalogStatus state={catalog} />
    <div className="upstream-intro">
      <div><h2>为客户端选择模型</h2><p>自定义组将供应商、模型和凭据保存在一起，再分配给 Claude Code、Codex、Pi 等客户端。配置对当前记忆实例生效。</p></div>
      <div className="upstream-actions">
        <Button type="primary" disabled={working} onClick={() => openEditor('group')}>新建自定义组</Button>
        <Button disabled={working || editor !== null} onClick={() => void load()}>重新加载</Button>
      </div>
    </div>
    {error && !editor && <Alert type="error">{error}</Alert>}
    {notice && <Alert type="success">{notice}</Alert>}
    <details className="upstream-guide"><summary>如何填写模型配置</summary>
      <ol><li>新建自定义组并起一个便于识别的名称，例如“DeepSeek 开发组”。</li>
        <li>选择供应商。预设会填写 API 基础地址和模型 ID；供应商 API Key 从该供应商后台获取，与 Panel 登录的 User Key 不同。</li>
        <li>保存模型组，再点击“分配客户端”。客户端已有归属时，先在原组移出并保存，再加入目标组。</li></ol>
      <p>对话模型组用于客户端的模型调用；总结模型单独供 Core 和 Knowledge 使用。配置保存后最多约 30 秒生效。</p>
    </details>
    {loading ? <p role="status">正在加载模型配置…</p> : <>
      {freeAgents.length > 0 && <Alert type="warning">{freeAgents.map((agent) => agent.display_name).join('、')} 尚未分配模型组，请在目标组点击“分配客户端”。</Alert>}
      <div className="upstream-columns">
        <section className="upstream-card" aria-label="对话模型组"><h2>对话模型组</h2>
          <p className="upstream-help">每个客户端最多属于一个组。默认组使用部署默认模型；自定义组使用你保存的供应商配置。</p>
          <div className="upstream-profile-list">{groups.map((group) => <article key={group.group_id} className="upstream-profile">
            <div className="upstream-profile-head"><h3>{group.name}</h3><span className={group.enabled ? 'upstream-status-good' : 'upstream-status-bad'}>{group.enabled ? '已启用' : '已停用'}</span></div>
            {group.group_type === 'default' ? <p>使用部署默认模型</p> : <dl className="upstream-current">
              <dt>模型</dt><dd>{group.model_id || '未指定'}</dd>
              <dt>API 地址</dt><dd>{group.base_url}</dd>
              <dt>认证方式</dt><dd>{group.credential_kind === 'chatgpt_oauth' ? `ChatGPT 订阅 · ${catalog.catalog?.subscriptions.find((c) => c.reference === group.credential_ref)?.email ?? group.credential_ref}` : group.mode === 'custom_passthrough' ? '由客户端提供供应商凭据' : group.api_key_masked || '未保存'}</dd>
            </dl>}
            <div className="upstream-client-tags">{group.agents.length
              ? group.agents.map((source) => <span key={source}>{agentName(source)}</span>)
              : <span className="upstream-pending">待分配客户端</span>}</div>
            <div className="upstream-actions">
              {group.group_type === 'custom' && <Button disabled={working} onClick={() => openEditor('group', group)}>编辑模型</Button>}
              <Button disabled={working} onClick={() => openEditor('assignment', group)}>分配客户端</Button>
              <Button disabled={working} onClick={() => toggleGroup(group)}>{group.enabled ? '停用组' : '启用组'}</Button>
              {group.group_type === 'custom' && <Button disabled={working} onClick={() => {
                if (window.confirm(`删除模型组“${group.name}”？已分配的客户端将失去模型配置。`)) {
                  void run(() => metaPost('instance-upstream/groups/delete', { group_id: group.group_id }), '模型组已删除，请检查客户端分配。');
                }
              }}>删除组</Button>}
            </div>
          </article>)}</div>
          {!groups.some((group) => group.group_type === 'custom') && <p className="upstream-help">还没有自定义组。可以先保存模型配置，稍后再分配客户端。</p>}
        </section>
        <section className="upstream-card" aria-label="总结模型"><h2>总结模型</h2>
          <p className="upstream-help">供 Core 记忆总结和 Knowledge 知识抽取使用，不改变客户端的对话模型。</p>
          {extraction.configured ? <dl className="upstream-current">
            <dt>模型</dt><dd>{extraction.model_id}</dd>
            <dt>API 地址</dt><dd>{extraction.base_url}</dd>
            <dt>认证方式</dt><dd>{extraction.credential_kind === 'chatgpt_oauth' ? 'ChatGPT 订阅' : extraction.api_key_masked}</dd>
            <dt>状态</dt><dd>{extraction.enabled ? '已启用' : '已停用，使用部署默认总结配置'}</dd>
          </dl> : <p>未配置，使用部署默认总结模型。</p>}
          <div className="upstream-actions"><Button disabled={working} onClick={() => openEditor('extraction')}>{extraction.configured ? '编辑总结模型' : '配置总结模型'}</Button>
            {extraction.configured && <><Button disabled={working} onClick={() => void run(() => metaPost('instance-upstream/extraction/toggle', {
              enabled: !extraction.enabled, expected_version: extraction.version,
            }), extraction.enabled ? '总结模型已停用，使用部署默认总结配置。' : '总结模型已启用。')}>{extraction.enabled ? '停用' : '启用'}</Button>
              <Button disabled={working} onClick={() => {
                if (window.confirm('删除总结模型配置？Core 和 Knowledge 将使用部署默认总结配置。')) {
                  void run(() => metaPost('instance-upstream/extraction/delete', {}), '总结模型配置已删除。');
                }
              }}>删除</Button></>}
          </div>
        </section>
      </div>
    </>}

    {editor && <Modal visible className="upstream-editor-modal" caption={caption} size="l" onClose={() => { if (!working) closeEditor(); }} disableEscape={working}>
      <Modal.Body>
        {error && <Alert type="error">{error}</Alert>}
        {editor === 'assignment' ? <div className="upstream-assignment">
          <p>勾选此组要使用的客户端，再保存分配。移出客户端不会删除模型组或它保存的模型配置。</p>
          {!currentGroup?.enabled && <Alert type="warning">此组已停用。分配到此组的客户端要等组启用后才能调用。</Alert>}
          <div className="upstream-client-options">{agents.map((agent) => {
            const owner = occupied(agent.agent_source);
            const other = owner && owner.group_id !== draft.group_id;
            return <div className="upstream-client-option" key={agent.agent_source}>
              <label><input type="checkbox" disabled={working || !!other || (draft.credential_kind === 'chatgpt_oauth' && !supportsSubscriptionAgent(agent.agent_source))} checked={draft.agents.includes(agent.agent_source)}
                onChange={() => selectAgent(agent.agent_source)} />
                <span>{agent.display_name}<small>{owner ? `当前组：${owner.name}` : '尚未分配'}</small></span></label>
              {other && <Button type="text" disabled={working} onClick={() => openEditor('assignment', owner)}>调整原组</Button>}
            </div>;
          })}</div>
          <p className="upstream-help">已有归属的客户端需先在原组移出并保存，再加入目标组。未分配期间该客户端无法调用模型。</p>
        </div> : <form id="upstream-model-form" className="upstream-editor-form" noValidate onSubmit={(event) => { event.preventDefault(); void save(); }}>
          {editor === 'group' && !draft.group_id && <Alert type="info">先填写并保存模型配置，再分配客户端。暂不分配客户端也可以创建组。</Alert>}
          {editor === 'extraction' && <p>此配置供 Core 和 Knowledge 使用，选择供应商 API Key 或已登录的 ChatGPT 订阅。</p>}
          {editor === 'group' && <div className="upstream-field">
            <label htmlFor="upstream-group-name">组名 <span aria-hidden="true">*</span></label>
            <input id="upstream-group-name" value={draft.name} maxLength={64} required aria-invalid={!!errors.name} aria-describedby="upstream-name-help"
              disabled={working} placeholder="例如：DeepSeek 开发组" onChange={(event) => change({ name: event.target.value })} />
            <small id="upstream-name-help">仅用于区分模型组，最多 64 个字符。</small>{errors.name && <p role="alert" className="upstream-field-error">{errors.name}</p>}
          </div>}
          <div className="upstream-field-pair">
            <div className="upstream-field"><label htmlFor="upstream-provider">模型供应商</label>
              <select id="upstream-provider" disabled={working} value={draft.provider} onChange={(event) => {
                const provider = event.target.value as ProviderId;
                const next = PROVIDERS.find((entry) => entry.id === provider);
                change({ provider, base_url: next?.baseUrls[0] ?? '', model_id: '', api_key: '', custom_model: !next, credential_kind: 'api_key', credential_ref: '' });
              }}>
                {PROVIDERS.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
                <option value="local">本地模型</option><option value="custom">自定义供应商</option>
              </select><small>选择供应商会填写 API 地址，模型来自公共目录及账号发现。</small>
            </div>

          </div>
          <ModelCatalogPicker draft={draft} change={change} state={catalog} disabled={working} extraction={editor === 'extraction'}
            protocols={agents.filter((agent) => draft.agents.includes(agent.agent_source)).map((agent) => agent.protocol)} />
          {draft.credential_kind === 'chatgpt_oauth' && errors.api_key && <p role="alert" className="upstream-field-error">{errors.api_key}</p>}
          {errors.model_id && <p role="alert" className="upstream-field-error">{errors.model_id}</p>}
          {draft.custom_model && draft.credential_kind !== 'chatgpt_oauth' && <div className="upstream-field"><label htmlFor="upstream-model-id">模型 ID <span aria-hidden="true">*</span></label>
            <input id="upstream-model-id" value={draft.model_id} required aria-invalid={!!errors.model_id} disabled={working}
              placeholder="填写供应商提供的完整模型 ID" onChange={(event) => change({ model_id: event.target.value })} />
            {errors.model_id && <p role="alert" className="upstream-field-error">{errors.model_id}</p>}
          </div>}
          <div className="upstream-field"><label htmlFor="upstream-base-url">API 基础地址 <span aria-hidden="true">*</span></label>
            <input id="upstream-base-url" type="url" value={draft.base_url} required aria-invalid={!!errors.base_url} aria-describedby="upstream-url-help" disabled={working || draft.credential_kind === 'chatgpt_oauth'}
              placeholder={draft.provider === 'local' ? 'http://host.docker.internal:11434/v1' : 'https://api.deepseek.com'}
              onChange={(event) => change({ base_url: event.target.value })} />
            <small id="upstream-url-help">{draft.provider === 'local' ? '填写 Docker 容器可以访问的地址；localhost 指向容器自身。' : '填写供应商文档中的 API 基础地址，无需追加 /chat/completions。'}</small>
            {errors.base_url && <p role="alert" className="upstream-field-error">{errors.base_url}</p>}
          </div>
          {draft.credential_kind !== 'chatgpt_oauth' && (editor === 'extraction' || draft.mode === 'custom_unified') && <div className="upstream-field">
            <label htmlFor="upstream-api-key">供应商 API Key {reusingKey ? '（已保存，可留空）' : <span aria-hidden="true">*</span>}</label>
            <input id="upstream-api-key" type="password" autoComplete="new-password" value={draft.api_key} aria-invalid={!!errors.api_key} aria-describedby="upstream-key-help"
              disabled={working} placeholder={reusingKey ? '留空沿用此供应商已保存的 Key' : '粘贴模型供应商后台生成的 API Key'}
              onChange={(event) => change({ api_key: event.target.value })} />
            <small id="upstream-key-help">供应商 Key 用于调用模型，与登录 Panel 的 User Key 不同。保存后加密存储，页面只显示掩码。{reusingKey ? '更换供应商地址后需要重新填写 Key。' : ''}</small>
            {errors.api_key && <p role="alert" className="upstream-field-error">{errors.api_key}</p>}
          </div>}
          {editor === 'group' && draft.credential_kind !== 'chatgpt_oauth' && <details className="upstream-advanced" open={draft.mode === 'custom_passthrough' ? true : undefined}><summary>高级设置：客户端透传凭据</summary>
            <div className="upstream-field"><label htmlFor="upstream-credential-mode">模型调用凭据</label>
              <select id="upstream-credential-mode" disabled={working} value={draft.mode} onChange={(event) => change({ mode: event.target.value as ModelDraft['mode'], api_key: '' })}>
                <option value="custom_unified">服务器使用已保存的供应商 Key（推荐）</option><option value="custom_passthrough">由客户端透传供应商凭据</option>
              </select><small>透传模式要求客户端另外携带目标供应商接受的凭据；Panel 登录 User Key 不能代替供应商凭据。切换为透传会清除该组保存的供应商 Key。</small>
            </div>
          </details>}
          {editor === 'group' && <fieldset className="upstream-client-fieldset"><legend>客户端分配（可选）</legend>
            {availableAgents.length ? <div className="upstream-available-clients">{availableAgents.map((agent) => <label key={agent.agent_source}>
              <input type="checkbox" disabled={working || (draft.credential_kind === 'chatgpt_oauth' && !supportsSubscriptionAgent(agent.agent_source))} checked={draft.agents.includes(agent.agent_source)} onChange={() => selectAgent(agent.agent_source)} />{agent.display_name}
            </label>)}</div> : <p>所有客户端目前已有模型组，可以先保存此组，再通过“分配客户端”调整归属。</p>}
            <p className="upstream-help">此处只列出未分配或已属于本组的客户端。留空保存后，组会显示“待分配客户端”。</p>
          </fieldset>}
          <div className="upstream-probe"><Button disabled={working || draft.mode === 'custom_passthrough' || (draft.credential_kind === 'chatgpt_oauth' ? !draft.credential_ref : !draft.api_key.trim())} loading={testing} onClick={() => void testConnection()}>测试连接</Button>
            <small>{draft.mode === 'custom_passthrough' ? '透传模式请从客户端发起模型调用验证。' : reusingKey && !draft.api_key.trim()
              ? '留空可沿用已保存 Key；重新输入供应商 Key 后可测试连接。' : '测试会向所填供应商发送最小模型请求；测试后仍需保存配置。'}</small>
          </div>
          {probe && <Alert type={probe.results.every((result) => result.status === 'ready') ? 'success' : 'warning'}>
            {probe.results.map((result) => `${result.protocol}：${result.status === 'ready' ? '可用' : result.status.startsWith('CHATGPT_') ? modelFailureMessage({ code: result.status }) : '未通过'}`).join('；')}。测试不会保存配置。
          </Alert>}
        </form>}
      </Modal.Body>
      <Modal.Footer><Button disabled={working} onClick={closeEditor}>取消</Button>
        <Button type="primary" disabled={working} loading={busy} onClick={() => void save()}>{editor === 'assignment' ? '保存客户端分配' : editor === 'extraction' ? '保存总结模型' : draft.group_id ? '保存修改' : '创建模型组'}</Button>
      </Modal.Footer>
    </Modal>}
  </div>;
}
