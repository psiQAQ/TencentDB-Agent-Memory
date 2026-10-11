export interface PiBundle {
  available: boolean;
  reason?: string;
  sourceRevision?: string;
  piVersion?: string;
  expectedCaSha256?: string;
  proxyUrl?: string;
  panelUrl?: string;
  archiveBase64?: string;
}

function httpsBase(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || /[\s\\?#]/.test(value)) {
    throw new Error('Pi 客户端包需要 HTTPS 接入地址，请联系管理员配置后重新导出。');
  }
  return url.toString().replace(/\/+$/, '');
}

export function buildPiBundleConfig(bundle: PiBundle, instanceId: string, baseUrl: string, model: string): string {
  if (!bundle.available) throw new Error(bundle.reason || '客户端包不可用');
  const proxyUrl = httpsBase(baseUrl);
  if (bundle.proxyUrl && httpsBase(bundle.proxyUrl) !== proxyUrl) {
    throw new Error('Pi 客户端包地址与当前实例接入地址不一致，请联系管理员重新导出。');
  }
  const panelUrl = httpsBase(bundle.panelUrl ?? new URL(proxyUrl).origin);
  return JSON.stringify({
    proxyUrl, panelUrl, spaceId: instanceId,
    teamId: 'replace-with-team-id', agentId: 'replace-with-agent-id', taskId: '', model,
    userKeyFile: './pi-user.key',
    ...(bundle.expectedCaSha256 ? { caFile: './root.crt', expectedCaSha256: bundle.expectedCaSha256 } : {}),
    pluginFile: './tdai-memory.ts', piCommand: 'pi',
  }, null, 2);
}
