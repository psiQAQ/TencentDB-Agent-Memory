import type { Hono } from 'hono';
import { z } from 'zod';
import type { PanelDeps } from '../../panel-deps.js';
import { validatePanelMetaHeaders } from '../middleware/validate-panel-headers.js';
import { buildCtx, isCallerSystemAdmin, okEnvelope } from './knowledge/common.js';
import { respondControlError } from '../envelope.js';

const input = z.object({
  agent_source: z.literal('default'),
  type: z.enum(['conversation', 'extraction']),
  base_url: z.string().max(2048),
  model_id: z.string().trim().min(1).max(200),
  credential_ref: z.literal('deployment_default'),
});
const refreshInput = input.extend({
  model_id: z.string().max(200),
  credential_ref: z.enum(['deployment_default', 'none']),
}).refine((value) => value.credential_ref === 'none' || value.model_id.trim().length > 0);

interface ProbeResult { protocol: string; status: string; httpStatus?: number }

export function registerUpstreamTestRoute(api: Hono, deps: PanelDeps): void {
  api.post('/meta/instance-upstream/test', validatePanelMetaHeaders(deps), async (c) => {
    const ctx = buildCtx(c);
    if (!(await isCallerSystemAdmin(deps, ctx))) return respondControlError(c, 403, 'permission_denied');
    const parsed = input.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return respondControlError(c, 400, 'INVALID_PARAM');
    const proxyBase = process.env.MODEL_PROBE_PROXY_URL;
    if (!proxyBase) return respondControlError(c, 503, 'PROXY_PROBE_NOT_CONFIGURED');
    const protocols = parsed.data.type === 'extraction' ? ['chat'] : ['chat', 'responses', 'anthropic'];
    try {
      const response = await fetch(`${proxyBase.replace(/\/+$/, '')}/internal/upstream/test`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: {
          authorization: `Bearer ${ctx.gatewayApiKey}`,
          'x-tdai-service-id': ctx.instanceId,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ ...parsed.data, protocols }),
      });
      if (!response.ok) return respondControlError(c, response.status === 429 ? 429 : 502, 'PROXY_PROBE_FAILED');
      const body = await response.json() as { results?: ProbeResult[] };
      if (!Array.isArray(body.results)) return respondControlError(c, 502, 'PROXY_PROBE_INVALID');
      return c.json(okEnvelope(c, { results: body.results }));
    } catch {
      return respondControlError(c, 502, 'PROXY_PROBE_UNAVAILABLE');
    }
  });
  api.post('/meta/instance-upstream/refresh', validatePanelMetaHeaders(deps), async (c) => {
    const ctx = buildCtx(c);
    if (!(await isCallerSystemAdmin(deps, ctx))) return respondControlError(c, 403, 'permission_denied');
    const parsed = refreshInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return respondControlError(c, 400, 'INVALID_PARAM');
    const proxyBase = process.env.MODEL_PROBE_PROXY_URL;
    if (!proxyBase) return respondControlError(c, 503, 'PROXY_PROBE_NOT_CONFIGURED');
    try {
      const response = await fetch(`${proxyBase.replace(/\/+$/, '')}/internal/upstream/refresh`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: {
          authorization: `Bearer ${ctx.gatewayApiKey}`,
          'x-tdai-service-id': ctx.instanceId,
          'content-type': 'application/json',
        },
        body: JSON.stringify(parsed.data),
      });
      if (!response.ok) return respondControlError(c, 502, 'PROXY_REFRESH_FAILED');
      const body = await response.json() as { adopted?: unknown };
      if (typeof body.adopted !== 'boolean') return respondControlError(c, 502, 'PROXY_REFRESH_INVALID');
      return c.json(okEnvelope(c, { adopted: body.adopted }));
    } catch { return respondControlError(c, 502, 'PROXY_REFRESH_UNAVAILABLE'); }
  });
}
