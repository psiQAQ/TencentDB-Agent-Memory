import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { PanelDeps } from '../../panel-deps.js';
import { validatePanelMetaHeaders } from '../middleware/validate-panel-headers.js';
import { buildCtx, okEnvelope } from './knowledge/common.js';
import { respondControlError } from '../envelope.js';

const httpsBase = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !/[\s\\?#]/.test(value);
});
const metadataSchema = z.object({
  instanceId: z.string(),
  sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
  pluginSha256: z.string().regex(/^[a-f0-9]{64}$/),
  archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
  piVersion: z.string().min(1),
  expectedCaSha256: z.string().regex(/^[A-Fa-f0-9]{64}$/).optional(),
  proxyUrl: httpsBase.optional(),
  panelUrl: httpsBase.optional(),
}).refine((value) => Boolean(value.proxyUrl) === Boolean(value.panelUrl));

function normalizedBase(value: string): string {
  try { return new URL(value).toString().replace(/\/+$/, ''); } catch { return ''; }
}

/** Only the deployment's fixed, credential-free archive can be downloaded. */
export function registerClientBundleRoutes(api: Hono, deps: PanelDeps): void {
  api.post('/meta/client-bundle/pi', validatePanelMetaHeaders(deps), async (c) => {
    c.header('Cache-Control', 'no-store');
    const ctx = buildCtx(c);
    const verified = await deps.metaKernel.invoke('auth/verify', { user_key: ctx.userKey }, ctx);
    if (verified.code !== 0 || !(verified.data as { valid?: boolean } | null)?.valid)
      return respondControlError(c, 401, 'UNAUTHORIZED');
    const body = z.object({ download: z.boolean().optional() }).strict().safeParse(await c.req.json().catch(() => null));
    if (!body.success) return respondControlError(c, 400, 'INVALID_PARAM');
    const unavailable = (reason: string) => c.json(okEnvelope(c, { available: false, reason }));
    if (!deps.config.clientBundleDir) return unavailable('当前部署尚未提供 Pi 客户端包，请联系管理员导出。');
    try {
      const metadata = metadataSchema.parse(JSON.parse(await readFile(join(deps.config.clientBundleDir, 'download.json'), 'utf8')));
      if (metadata.instanceId !== ctx.instanceId) return unavailable('当前实例尚未提供 Pi 客户端包。');
      const instance = deps.instanceRegistry.resolve(ctx.instanceId);
      if (metadata.proxyUrl && normalizedBase(metadata.proxyUrl) !== normalizedBase(instance.proxy_endpoint || instance.gateway_endpoint))
        return unavailable('Pi 客户端包地址与当前实例接入地址不一致，请联系管理员重新导出。');
      const archive = await readFile(join(deps.config.clientBundleDir, 'pi-client-bundle.zip'));
      if (archive.length > 2 * 1024 * 1024 || createHash('sha256').update(archive).digest('hex') !== metadata.archiveSha256)
        return unavailable('Pi 客户端包校验失败，请联系管理员重新导出。');
      return c.json(okEnvelope(c, { available: true, ...metadata,
        ...(body.data.download ? { archiveBase64: archive.toString('base64') } : {}) }));
    } catch (error) {
      // Do not expose host paths, archive contents or credentials in an error response.
      if (error instanceof z.ZodError || error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT')
        return unavailable('Pi 客户端包缺失或格式无效，请联系管理员重新导出。');
      throw error;
    }
  });
}
