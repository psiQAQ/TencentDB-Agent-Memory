import { useEffect, useState } from 'react';
import { Alert, Button, Copy } from 'tea-component';
import { metaPost } from '@/lib/api/base';
import { getErrorMessage } from '@/lib/error-message';
import { buildPiBundleConfig, type PiBundle } from '../pi-client-bundle-config';

export function PiClientBundle({ instanceId, baseUrl, model }: { instanceId: string; baseUrl: string; model: string }) {
  const [loaded, setLoaded] = useState<{ instanceId: string; baseUrl: string; bundle: PiBundle }>();
  const bundle = loaded?.instanceId === instanceId && loaded.baseUrl === baseUrl ? loaded.bundle : undefined;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let cancelled = false;
    setError(''); setNotice('');
    void metaPost<PiBundle>('client-bundle/pi').then((value) => { if (!cancelled) setLoaded({ instanceId, baseUrl, bundle: value }); })
      .catch((err) => { if (!cancelled) { setLoaded(undefined); setError(getErrorMessage(err)); } });
    return () => { cancelled = true; };
  }, [instanceId, baseUrl]);
  async function download() {
    setBusy(true); setError(''); setNotice('');
    try {
      const value = await metaPost<PiBundle>('client-bundle/pi', { download: true });
      setLoaded({ instanceId, baseUrl, bundle: value });
      if (!value.available || !value.archiveBase64) throw new Error(value.reason || '客户端包不可用');
      buildPiBundleConfig(value, instanceId, baseUrl, model);
      const bytes = Uint8Array.from(atob(value.archiveBase64), (character) => character.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
      const link = document.createElement('a');
      link.href = url; link.download = 'pi-client-bundle.zip';
      document.body.appendChild(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setNotice('已发起下载：pi-client-bundle.zip。解压后按下方步骤安装。');
    } catch (err) { setError(getErrorMessage(err)); }
    finally { setBusy(false); }
  }
  let config = '';
  let configError = '';
  if (bundle?.available) {
    try { config = buildPiBundleConfig(bundle, instanceId, baseUrl, model); }
    catch (err) { configError = getErrorMessage(err); }
  }
  return <section aria-label="Pi 客户端包安装">
    <h4>从当前部署安装 Pi 插件</h4>
    <p>客户端包包含插件、安装与检查脚本和说明；使用自定义 CA 的部署还包含公开证书。包中不含业务 Key。</p>
    {error && <Alert type="error">{error}</Alert>}
    {!bundle && !error && <p role="status">正在检查客户端包…</p>}
    {bundle && !bundle.available && <Alert type="warning">{bundle.reason}</Alert>}
    {configError && <Alert type="warning">{configError}</Alert>}
    {bundle?.available && config && <>
      <Button disabled={busy} onClick={() => void download()}>下载 Pi 客户端包</Button>
      <p>插件源码版本：{bundle.sourceRevision?.slice(0, 12)} · 配套 Pi：{bundle.piVersion}</p>
      {notice && <p role="status">{notice}</p>}
      <ol>
        <li>解压客户端包。尚未安装 Pi 时，执行 <code>npm install -g @earendil-works/pi-coding-agent@{bundle.piVersion}</code>。</li>
        <li>将下方配置保存为包目录中的 <code>pi-client.jsonc</code>，填写 Team ID 和 Agent ID；Task ID 可选。模型已按当前分配填写。</li>
        <li>将自己的业务 User Key 单独保存到 <code>pi-user.key</code>，限制为当前用户可读；不要填写供应商 API Key 或管理员 Key。</li>
        <li>在包目录执行安装、检查、启动命令。已通过客户端包安装过插件时，不再手动复制第二份。</li>
      </ol>
      <Copy text={config}><Button>复制 Pi 客户端包配置</Button></Copy>
      <pre className="_memory-apikey-endpoint-code">{config}</pre>
      <pre className="_memory-apikey-endpoint-code">{'node ./pi-client.js install --config ./pi-client.jsonc\nnode ./pi-client.js check --config ./pi-client.jsonc\nnode ./pi-client.js run --config ./pi-client.jsonc'}</pre>
      <p>{bundle.expectedCaSha256 ? '连接使用包内公开 CA 补充默认信任。' : '连接使用运行时默认信任，无需安装包内 CA。'}业务 Key 会发送到配置中的 Panel 检查身份，并发送到 Proxy 调用服务。</p>
      <p>检查不会调用模型；启动后发送消息才会使用已分配的模型。其他电脑需能直接访问上述 HTTPS 地址。已有不同版本时安装程序会提示，追加 --replace 前先核对版本。</p>
    </>}
  </section>;
}
