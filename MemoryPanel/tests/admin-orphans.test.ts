import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { registerAdminOrphanRoutes } from '../src/panel/http/routes/admin-orphans.js';

describe('system_admin orphan governance', () => {
  it('forwards the governance reason and confirmation when purging Core findings', async () => {
    const finding = {
      finding_id: 'finding-1',
      fingerprint: 'fingerprint-1',
      category: 'operational_orphan',
      source_service: 'MemoryCore',
      resource_type: 'fixed_asset_relation',
      resource_id: 'binding-1',
      team_id: null,
      owner_user_id: null,
      reason: 'dangling_agent_or_asset',
      allowed_actions: ['inspect', 'purge'],
      first_seen_at: '2026-09-03T00:00:00.000Z',
      last_seen_at: '2026-09-03T00:00:00.000Z',
    };
    const invoke = vi.fn(async (action: string) => {
      if (action === 'integrity/scan') {
        return {
          code: 0,
          message: 'ok',
          request_id: 'req-1',
          data: { scan_revision: 'scan-1', findings: [finding], counts: { operational_orphan: 1 } },
        };
      }
      if (action === 'integrity/purge') {
        return {
          code: 0,
          message: 'ok',
          request_id: 'req-1',
          data: { deleted: ['finding-1'], failed: [] },
        };
      }
      throw new Error(`unexpected meta action: ${action}`);
    });
    const deps = {
      instanceRegistry: {
        resolve: () => ({
          instance_id: 'local',
          gateway_endpoint: 'http://core',
          api_key: 'gateway',
        }),
      },
      metaKernel: { invoke },
      kernelHttp: { postEnvelope: vi.fn() },
      knowledgeClientFactory: () => ({ listIntegrityInventory: vi.fn(async () => ({ items: [] })) }),
      config: { metadataRemoteTimeoutMs: 10_000 },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as never;
    const app = new Hono();
    registerAdminOrphanRoutes(app, deps);

    const response = await app.request('/admin/orphans/purge', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Tdai-Service-Id': 'local',
        'X-Tdai-User-Key': 'key',
      },
      body: JSON.stringify({
        findings: [{ finding_id: finding.finding_id, fingerprint: finding.fingerprint }],
        reason: 'remove verified dangling relation',
        confirmation: 'PURGE_ZOMBIES',
      }),
    });

    expect(response.status).toBe(200);
    expect(invoke).toHaveBeenCalledWith(
      'integrity/purge',
      {
        findings: [{ finding_id: finding.finding_id, fingerprint: finding.fingerprint }],
        reason: 'remove verified dangling relation',
        confirmation: 'PURGE_ZOMBIES',
      },
      expect.anything(),
    );
  });
});
