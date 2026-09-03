/** system_admin-only integrity findings. Core performs authorization and stale revalidation. */
import { createHmac } from 'node:crypto';
import type { Hono } from 'hono';
import type { PanelDeps } from '../../panel-deps.js';
import { toKernelCredentials, type MetaCallContext } from '../../kernel/types.js';
import type { MetaEnvelope } from '../../kernel/envelope.js';
import { validatePanelMetaHeaders } from '../middleware/validate-panel-headers.js';
import { respondControlError, respondEnvelope } from '../envelope.js';
import { buildCtx, okEnvelope, readJson, str } from './knowledge/common.js';

interface Finding {
  finding_id: string;
  fingerprint: string;
  category: string;
  source_service: string;
  resource_type: string;
  resource_id: string;
  team_id: string | null;
  owner_user_id: string | null;
  reason: string;
  allowed_actions: string[];
  first_seen_at: string;
  last_seen_at: string;
  name?: string;
  status?: string;
  item_count?: number;
  size_bytes?: number;
}

interface ScanResult {
  scan_revision: string;
  findings: Finding[];
  counts: Record<string, number>;
}

function signFinding(ctx: MetaCallContext, value: unknown): string {
  return createHmac('sha256', ctx.gatewayApiKey).update(JSON.stringify(value)).digest('hex');
}

async function scan(deps: PanelDeps, ctx: MetaCallContext): Promise<MetaEnvelope<ScanResult>> {
  const coreEnv = await deps.metaKernel.invoke('integrity/scan', {}, ctx);
  if (coreEnv.code !== 0) return coreEnv as MetaEnvelope<ScanResult>;
  const core = coreEnv.data as ScanResult;
  const findings = [...core.findings];
  const inventory = await deps.knowledgeClientFactory(ctx.instanceId).listIntegrityInventory();
  for (const item of inventory.items) {
    const metaEnv = await deps.kernelHttp.postEnvelope<Record<string, unknown>>(
      '/v3/internal/meta/asset/get',
      { asset_id: item.resource_id },
      toKernelCredentials(ctx, { timeoutMs: deps.config.metadataRemoteTimeoutMs }, { omitUserKey: true }),
    );
    let reason = '';
    let category = 'inconsistent';
    let allowedActions = ['inspect'];
    if (metaEnv.code === 404) {
      reason = 'backing_exists_without_core_metadata';
      category = 'operational_orphan';
      allowedActions = ['inspect', 'purge'];
    } else if (metaEnv.code !== 0) {
      return metaEnv as unknown as MetaEnvelope<ScanResult>;
    } else {
      const meta = metaEnv.data ?? {};
      if (meta.asset_type === item.resource_type && meta.team_id === item.team_id
        && meta.owner_user_id === item.owner_user_id) continue;
      reason = 'backing_and_core_metadata_mismatch';
    }
    const identity = {
      source_service: 'MemoryKnowledge',
      resource_type: item.resource_type,
      resource_id: item.resource_id,
      team_id: item.team_id,
      owner_user_id: item.owner_user_id,
      reason,
      updated_at: item.updated_at,
    };
    findings.push({
      finding_id: `knowledge:${item.resource_type}:${item.resource_id}`,
      fingerprint: signFinding(ctx, identity),
      category,
      source_service: 'MemoryKnowledge',
      resource_type: item.resource_type,
      resource_id: item.resource_id,
      team_id: item.team_id,
      owner_user_id: item.owner_user_id,
      reason,
      allowed_actions: allowedActions,
      first_seen_at: item.created_at,
      last_seen_at: item.updated_at,
      name: item.name,
      status: item.status,
    });
  }
  const counts: Record<string, number> = {};
  for (const finding of findings) counts[finding.category] = (counts[finding.category] ?? 0) + 1;
  return {
    code: 0,
    message: 'ok',
    request_id: coreEnv.request_id,
    data: {
      scan_revision: signFinding(ctx, findings.map((item) => `${item.finding_id}:${item.fingerprint}`).sort()),
      findings,
      counts,
    },
  };
}

export function registerAdminOrphanRoutes(api: Hono, deps: PanelDeps): void {
  const mw = validatePanelMetaHeaders(deps);
  api.post('/admin/orphans/scan/start', mw, async (c) => respondEnvelope(c, await scan(deps, buildCtx(c))));
  api.post('/admin/orphans/scan/get', mw, async (c) => respondEnvelope(c, await scan(deps, buildCtx(c))));
  api.post('/admin/orphans/list', mw, async (c) => {
    const body = await readJson(c);
    const env = await scan(deps, buildCtx(c));
    if (env.code !== 0) return respondEnvelope(c, env);
    const data = env.data as ScanResult;
    const category = str(body, 'category');
    const status = str(body, 'status');
    const findings = data.findings.filter((item) => (!category || item.category === category)
      && (!status || (status === 'history' ? item.category === 'retained_history' : item.category !== 'retained_history')));
    return respondEnvelope(c, okEnvelope(c, { ...data, findings }));
  });
  api.post('/admin/orphans/get', mw, async (c) => {
    const body = await readJson(c);
    const findingId = str(body, 'finding_id');
    if (!findingId) return respondControlError(c, 400, 'MISSING_FINDING_ID');
    const env = await scan(deps, buildCtx(c));
    if (env.code !== 0) return respondEnvelope(c, env);
    const data = env.data as ScanResult;
    const finding = data.findings.find((item) => item.finding_id === findingId);
    if (!finding) return respondControlError(c, 404, 'FINDING_NOT_FOUND');
    return respondEnvelope(c, okEnvelope(c, finding));
  });
  api.post('/admin/orphans/purge', mw, async (c) => {
    const body = await readJson(c);
    if (str(body, 'confirmation') !== 'PURGE_ZOMBIES') {
      return respondControlError(c, 400, 'CONFIRMATION_REQUIRED');
    }
    if (!Array.isArray(body.findings) || body.findings.length === 0 || body.findings.length > 100) {
      return respondControlError(c, 400, 'INVALID_FINDINGS');
    }
    const governanceReason = str(body, 'reason');
    if (!governanceReason || governanceReason.length < 3) return respondControlError(c, 400, 'GOVERNANCE_REASON_REQUIRED');
    const ctx = buildCtx(c);
    const freshEnv = await scan(deps, ctx);
    if (freshEnv.code !== 0) return respondEnvelope(c, freshEnv);
    const fresh = freshEnv.data as ScanResult;
    const requested = body.findings as Array<{ finding_id?: unknown; fingerprint?: unknown }>;
    const knowledgeItems: Finding[] = [];
    const coreItems: Array<{ finding_id: string; fingerprint: string }> = [];
    for (const raw of requested) {
      if (typeof raw.finding_id !== 'string' || typeof raw.fingerprint !== 'string') {
        return respondControlError(c, 400, 'INVALID_FINDINGS');
      }
      const current = fresh.findings.find((item) => item.finding_id === raw.finding_id);
      if (!current || current.fingerprint !== raw.fingerprint) {
        return respondControlError(c, 409, 'stale_integrity_scan');
      }
      if (current.source_service === 'MemoryKnowledge') {
        if (!current.allowed_actions.includes('purge')) return respondControlError(c, 403, 'FINDING_NOT_PURGABLE');
        knowledgeItems.push(current);
      } else {
        coreItems.push({ finding_id: current.finding_id, fingerprint: current.fingerprint });
      }
    }

    const deleted: string[] = [];
    const failed: Array<{ finding_id: string; reason: string }> = [];
    const kc = deps.knowledgeClientFactory(ctx.instanceId);
    for (const item of knowledgeItems) {
      try {
        const result = item.resource_type === 'llm_wiki'
          ? await kc.wikiDelete([item.resource_id])
          : await kc.codeGraphDelete([item.resource_id]);
        assertDeleteResult(result, item.resource_id);
        deleted.push(item.finding_id);
      } catch (err) {
        failed.push({ finding_id: item.finding_id, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    if (coreItems.length) {
      const coreEnv = await deps.metaKernel.invoke('integrity/purge', { findings: coreItems }, ctx);
      if (coreEnv.code !== 0) return respondEnvelope(c, coreEnv);
      const coreResult = coreEnv.data as { deleted?: string[]; failed?: Array<{ finding_id: string; reason: string }> } | null;
      deleted.push(...(coreResult?.deleted ?? []));
      failed.push(...(coreResult?.failed ?? []));
    }
    deps.logger.info('orphan governance purge completed', {
      actor_scope: 'system_admin',
      governance_reason: governanceReason,
      requested: requested.length,
      deleted: deleted.length,
      failed: failed.length,
    });
    return respondEnvelope(c, okEnvelope(c, { deleted, failed }));
  });
  api.post('/admin/orphans/operation/get', mw, async (c) => {
    const env = await scan(deps, buildCtx(c));
    if (env.code !== 0) return respondEnvelope(c, env);
    return respondEnvelope(c, okEnvelope(c, { status: 'completed', ...(env.data as ScanResult) }));
  });
}

function assertDeleteResult(result: { failed?: Array<{ id: string; reason: string }> }, resourceId: string): void {
  const failure = result.failed?.find((item) => item.id === resourceId);
  if (failure && !/not[_ -]?found/i.test(failure.reason)) throw new Error(failure.reason);
}
