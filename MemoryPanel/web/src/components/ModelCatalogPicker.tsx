import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button } from 'tea-component';
import { metaPost } from '@/lib/api/base';
import { modelFailureMessage, type ModelDraft } from '@/lib/upstream-settings-form';
import {
  accountSnapshot,
  catalogChoices,
  subscriptionUsable,
  type Catalog,
  type CatalogModel,
} from '@/lib/model-catalog';
interface RefreshResult {
  source: string;
  source_label?: string;
  status: string;
  added: number;
  removed: number;
  changed: number;
  updated_at: string | null;
  error?: string;
}
export function useModelCatalog() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState('');
  const [updating, setUpdating] = useState(false);
  const [results, setResults] = useState<RefreshResult[]>([]);
  const reload = useCallback(async () => {
    setCatalog(await metaPost<Catalog>('model-catalog/list'));
  }, []);
  useEffect(() => {
    void reload().catch(() => setError('模型目录加载失败，可继续使用已保存配置。'));
  }, [reload]);
  async function refresh() {
    setUpdating(true);
    setError('');
    try {
      const result = await metaPost<{ results: RefreshResult[] }>('model-catalog/refresh');
      setResults(result.results);
      await reload();
    } catch (cause) {
      setError(modelFailureMessage(cause));
    } finally {
      setUpdating(false);
    }
  }
  return { catalog, error, updating, results, reload, refresh };
}
export function ModelCatalogStatus({ state }: { state: ReturnType<typeof useModelCatalog> }) {
  return (
    <section className="upstream-catalog" aria-label="模型目录">
      <div className="upstream-actions">
        <Button
          loading={state.updating}
          disabled={state.updating}
          onClick={() => void state.refresh()}
        >
          更新模型列表
        </Button>
        <small>
          更新候选列表，保留已保存配置和正在编辑的内容。公共目录：
          {state.catalog?.public_catalog.updated_at
            ? new Date(state.catalog.public_catalog.updated_at).toLocaleString()
            : '尚未读取'}
        </small>
      </div>
      {state.error && <Alert type="warning">{state.error}</Alert>}
      {state.catalog?.public_catalog.error && (
        <Alert type="warning">
          公共目录更新失败，正在使用上次成功快照：{state.catalog.public_catalog.error}
        </Alert>
      )}
      {state.results.length > 0 && (
        <details open>
          <summary>
            {state.results.every((r) => r.status === 'succeeded')
              ? '所有来源更新成功'
              : '部分或全部来源更新失败，失败来源保留旧列表'}
          </summary>
          <table>
            <thead>
              <tr>
                <th>来源</th>
                <th>结果</th>
                <th>新增 / 移除 / 变更</th>
                <th>最近成功时间</th>
              </tr>
            </thead>
            <tbody>
              {state.results.map((r) => (
                <tr key={r.source}>
                  <td>{r.source === 'pi' ? 'Pi 公共目录' : (r.source_label ?? r.source)}</td>
                  <td>
                    {r.status === 'succeeded'
                      ? '成功'
                      : `失败：${modelFailureMessage({ rawMessage: r.error })}`}
                  </td>
                  <td>
                    {r.added} / {r.removed} / {r.changed}
                  </td>
                  <td>{r.updated_at ? new Date(r.updated_at).toLocaleString() : '从未成功'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </section>
  );
}

export function ModelCatalogPicker({
  draft,
  change,
  state,
  disabled,
  extraction,
  protocols,
}: {
  draft: ModelDraft;
  change: (patch: Partial<ModelDraft>) => void;
  state: ReturnType<typeof useModelCatalog>;
  disabled: boolean;
  extraction: boolean;
  protocols: string[];
}) {
  const [discovered, setDiscovered] = useState<CatalogModel[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [login, setLogin] = useState<{
    state: string;
    reference: string;
    expires_at: number;
    selection: string;
    reconnecting: boolean;
  } | null>(null);
  const reload = state.reload;
  const [port, setPort] = useState(8125);
  const selection = JSON.stringify([
    draft.provider,
    draft.base_url,
    draft.credential_kind,
    draft.credential_ref,
    draft.group_id,
    draft.api_key,
  ]);
  const current = useRef(selection);
  current.current = selection;
  const subscription = draft.credential_kind === 'chatgpt_oauth';
  const snapshot = accountSnapshot(state.catalog, draft);
  const publicModels =
    state.catalog?.public_catalog.models.filter((m) => m.provider_id === draft.provider) ?? [];
  const accountModels = discovered ?? snapshot?.models;
  const models = catalogChoices(publicModels, accountModels, subscription);
  const selected = models.find((m) => m.id === draft.model_id);
  const usable = (m: CatalogModel) =>
    m.lifecycle !== 'retired' &&
    (subscription
      ? subscriptionUsable(draft.agents, protocols, extraction)
      : extraction
        ? m.protocols.includes('openai-chat')
        : protocols.every((p) => m.protocols.includes(p)));
  const connection = state.catalog?.subscriptions.find((c) => c.reference === draft.credential_ref);

  const discover = useCallback(async () => {
    const initial = selection;
    setBusy(true);
    setMessage('');
    try {
      const result = await metaPost<{ status: string; models: CatalogModel[]; error?: string }>(
        'model-catalog/discover',
        {
          provider_id: draft.provider,
          base_url: draft.base_url,
          credential_kind: draft.credential_kind,
          ...(subscription
            ? { credential_ref: draft.credential_ref }
            : draft.api_key
              ? { api_key: draft.api_key }
              : { group_id: draft.group_id }),
        },
      );
      if (current.current !== initial) return;
      setDiscovered(result.models);
      setMessage(
        result.status === 'succeeded'
          ? `已获取 ${result.models.length} 个账号模型。`
          : `获取失败：${modelFailureMessage({ rawMessage: result.error })}`,
      );
      await reload();
    } catch (cause) {
      if (current.current === initial) setMessage(modelFailureMessage(cause));
    } finally {
      setBusy(false);
    }
  }, [
    selection,
    subscription,
    draft.provider,
    draft.base_url,
    draft.credential_kind,
    draft.credential_ref,
    draft.api_key,
    draft.group_id,
    reload,
  ]);
  useEffect(() => {
    setDiscovered(null);
    setMessage('');
  }, [selection]);
  useEffect(() => {
    if (subscription && draft.credential_ref) void discover();
  }, [draft.credential_ref, subscription, discover]);
  useEffect(() => {
    if (!login) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (cancelled) return;
      try {
        const result = await metaPost<{
          pending: boolean;
          result: { code: number; message: string } | null;
        }>('model-connections/chatgpt/result', { state: login!.state });
        if (cancelled) return;
        if (result.pending && login!.expires_at > Date.now()) {
          timer = setTimeout(() => void poll(), 1500);
          return;
        }
        await reload();
        if (cancelled) return;
        if (result.result?.code !== 0) {
          // Reload also exposes a retained issued client ID after an interrupted token exchange.
          setLogin(null);
          setMessage(modelFailureMessage({ rawMessage: result.result?.message }));
          return;
        }
        if (current.current === login!.selection) {
          change({
            credential_ref: login!.reference,
            ...(!login!.reconnecting ? { model_id: '', custom_model: false } : {}),
          });
        }
        setLogin(null);
        setMessage('登录完成，账号连接已更新。');
      } catch (cause) {
        if (!cancelled) {
          setMessage(modelFailureMessage(cause));
          setLogin(null);
        }
      }
    }
    timer = setTimeout(() => void poll(), 1500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [login, reload, change]);
  async function startLogin(reference?: string) {
    const popup = window.open('about:blank', '_blank');
    if (!popup) {
      setMessage('浏览器阻止了登录窗口，请允许弹出窗口后重试。');
      return;
    }
    popup.opener = null;
    setBusy(true);
    setMessage('');
    try {
      const attempt = await metaPost<{
        authorization_url: string;
        state: string;
        reference: string;
        expires_at: number;
      }>('model-connections/chatgpt/start', { reference, callback_port: port });
      popup.location.href = attempt.authorization_url;
      setLogin({
        state: attempt.state,
        reference: attempt.reference,
        expires_at: attempt.expires_at,
        selection,
        reconnecting: !!reference,
      });
    } catch (cause) {
      popup.close();
      setMessage(modelFailureMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function disconnect() {
    setBusy(true);
    try {
      const result = await metaPost<{ remote_revocation_confirmed: boolean }>(
        'model-connections/chatgpt/disconnect',
        { reference: draft.credential_ref },
      );
      setDiscovered(null);
      await state.reload();
      setMessage(
        result.remote_revocation_confirmed
          ? '连接已退出。使用此连接的配置会要求重新登录。'
          : '本地已退出，未确认远端撤销，请在 ChatGPT 设置中断开此应用。',
      );
    } catch (cause) {
      setMessage(modelFailureMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="upstream-catalog-picker">
      {draft.provider === 'openai' && (
        <div className="upstream-field">
          <label htmlFor="model-auth-kind">认证方式</label>
          <select
            id="model-auth-kind"
            value={draft.credential_kind}
            disabled={disabled || !!login}
            onChange={(e) =>
              change({
                credential_kind: e.target.value as ModelDraft['credential_kind'],
                api_key: '',
                credential_ref: '',
                model_id: '',
                custom_model: false,
                mode: 'custom_unified',
                base_url: 'https://api.openai.com/v1',
              })
            }
          >
            <option value="api_key">OpenAI API Key（API 计费）</option>
            <option value="chatgpt_oauth">ChatGPT 订阅（Plus / Pro）</option>
          </select>
        </div>
      )}
      {subscription && (
        <div className="upstream-field">
          <label htmlFor="chatgpt-connection">ChatGPT 连接</label>
          <select
            id="chatgpt-connection"
            value={draft.credential_ref}
            disabled={disabled || busy || !!login}
            onChange={(e) =>
              change({ credential_ref: e.target.value, model_id: '', custom_model: false })
            }
          >
            <option value="">请选择连接</option>
            {state.catalog?.subscriptions.map((c) => (
              <option key={c.reference} value={c.reference}>
                {c.email ?? c.reference} · {c.status === 'connected' ? '已连接' : '需要登录'}
              </option>
            ))}
          </select>
          <div className="upstream-actions">
            <Button disabled={disabled || busy || !!login} onClick={() => void startLogin()}>
              Continue with ChatGPT
            </Button>
            {draft.credential_ref && (
              <>
                <Button
                  disabled={disabled || busy || !!login}
                  onClick={() => void startLogin(draft.credential_ref)}
                >
                  重新登录
                </Button>
                <Button disabled={disabled || busy} onClick={() => void disconnect()}>
                  退出连接
                </Button>
              </>
            )}
            <a href="https://chatgpt.com/#settings/usage" target="_blank" rel="noreferrer">
              查看 ChatGPT 用量
            </a>
          </div>
          <small>
            订阅用于本实例的 Codex、Pi、OpenCode 对话或后台提取。认证或额度失败会报错，需手动切换配置。
          </small>
          {connection && connection.status !== 'connected' && (
            <Alert type="warning">此连接需要重新登录。</Alert>
          )}
          <details>
            <summary>远程浏览器登录：SSH 隧道</summary>
            <label htmlFor="chatgpt-callback-port">浏览器本机回调端口</label>
            <input
              id="chatgpt-callback-port"
              type="number"
              min={1024}
              max={65535}
              value={port}
              disabled={!!login}
              onChange={(e) => setPort(Number(e.target.value))}
            />
            <p>在浏览器所在电脑运行以下命令，将服务器的 Panel 端口转发到本机，再开始登录：</p>
            <code>ssh -N -L {port}:127.0.0.1:8125 用户名@服务器地址</code>
            <p>
              回调地址：http://127.0.0.1:{port}/auth/callback。Panel 和浏览器同机时使用 Panel 的本机
              HTTP 端口即可。
            </p>
          </details>
          {login && <p role="status">等待浏览器完成登录…</p>}
        </div>
      )}
      <div className="upstream-field">
        <label htmlFor="upstream-model-choice">模型</label>
        <select
          id="upstream-model-choice"
          disabled={disabled}
          value={!subscription && draft.custom_model ? 'custom' : draft.model_id}
          onChange={(e) => {
            const custom = e.target.value === 'custom';
            change({ custom_model: custom, model_id: custom ? '' : e.target.value });
          }}
        >
          <option value="">请选择模型</option>
          {draft.model_id && !selected && (
            <option value={draft.model_id}>{draft.model_id}（保留当前配置）</option>
          )}
          {models.map((m) => (
            <option key={m.id} value={m.id} disabled={!usable(m)}>
              {m.name} · {m.id}
              {usable(m) ? '' : '（当前用途不支持）'}
            </option>
          ))}
          {!subscription && <option value="custom">手动填写模型 ID</option>}
        </select>
        {draft.model_id && !selected && (
          <small>
            当前模型不在列表中；配置仍保留。API 可手动填写，订阅新增选择须来自账号列表。
          </small>
        )}
        {selected && (
          <small>
            上下文：{selected.context_window?.toLocaleString() ?? '未知'}；最大输出：
            {selected.max_output_tokens?.toLocaleString() ?? '未知'}；推理：
            {selected.reasoning === undefined ? '未知' : selected.reasoning ? '支持' : '不支持'}
            。参考价格（美元 / 百万 token）：输入 {selected.reference_price?.input ??
              '未知'}，输出 {selected.reference_price?.output ?? '未知'}。
            {subscription && '订阅额度以 ChatGPT 用量页为准。'}
          </small>
        )}
        <small>
          {extraction
            ? '后台提取支持 Chat Completions；ChatGPT 订阅由 Proxy 转换为 Responses。'
            : '按当前所选客户端的协议限制可选模型。'}
        </small>
        <div className="upstream-actions">
          <Button
            disabled={
              disabled ||
              busy ||
              (subscription ? !draft.credential_ref : !draft.api_key && !draft.group_id) ||
              ['local', 'custom'].includes(draft.provider)
            }
            loading={busy}
            onClick={() => void discover()}
          >
            获取账号模型
          </Button>
          <small>
            {snapshot?.updated_at
              ? `账号列表：${new Date(snapshot.updated_at).toLocaleString()}`
              : subscription
                ? '登录后显示此账号可用的模型。'
                : 'API 支持使用尚未保存的 Key 获取列表。'}
          </small>
        </div>
        {message && <p role="status">{message}</p>}
        {snapshot?.error && (
          <Alert type="warning">
            {modelFailureMessage({ rawMessage: snapshot.error })}
            {snapshot.updated_at
              ? ' 上次成功的账号列表仍保留。'
              : ' 此连接尚无成功获取的账号列表。'}
          </Alert>
        )}
      </div>
    </div>
  );
}
