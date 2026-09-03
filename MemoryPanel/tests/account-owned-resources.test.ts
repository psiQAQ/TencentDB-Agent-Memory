import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { registerAccountOwnedResourceRoutes } from '../src/panel/http/routes/account-owned-resources.js';

function buildApp(options: {
  membership?: 'active' | 'removed';
  owner?: string;
  resourceCode?: number;
  clearCode?: number;
} = {}) {
  const invoke = vi.fn(async (action: string, body: Record<string, unknown>) => {
    if (action === 'auth/verify') {
      return { code: 0, message: 'ok', data: { valid: true, user: { user_id: 'caller' } } };
    }
    if (action === 'team-member/get') {
      return { code: 0, message: 'ok', data: { user_id: 'caller', role: 'member', status: options.membership ?? 'active' } };
    }
    if (action === 'task/get') {
      if (options.resourceCode === 404) return { code: 404, message: 'not found', data: null };
      return { code: 0, message: 'ok', data: { task_id: body.task_id, team_id: 'team-1', creator_user_id: options.owner ?? 'caller' } };
    }
    if (action === 'asset/get') {
      return { code: 0, message: 'ok', data: { asset_id: body.asset_id, team_id: 'team-1', owner_user_id: options.owner ?? 'caller', asset_type: 'chat_memory' } };
    }
    if (action === 'task/delete' || action === 'asset/delete') {
      const ids = (body.task_ids ?? body.asset_ids) as string[];
      return { code: 0, message: 'ok', data: { deleted_ids: ids, failed: [] } };
    }
    if (action === 'user/dependencies') {
      return { code: 0, message: 'ok', data: { counts: { teams: 0, agents: 0, tasks: 0, assets: 0, total: 0 } } };
    }
    throw new Error(`unexpected meta action: ${action}`);
  });
  const kernelPost = vi.fn(async () => ({
    code: options.clearCode ?? 0,
    message: options.clearCode ? 'clear failed' : 'ok',
    data: { all_cleared: !options.clearCode },
  }));
  const deps = {
    instanceRegistry: { resolve: () => ({ instance_id: 'local', gateway_endpoint: 'http://core', api_key: 'gateway' }) },
    metaKernel: { invoke },
    kernelHttp: { postEnvelope: kernelPost },
    config: { metadataRemoteTimeoutMs: 10_000 },
  } as never;
  const app = new Hono();
  registerAccountOwnedResourceRoutes(app, deps);
  return { app, invoke, kernelPost };
}

function purge(app: Hono, resources: Array<{ resource_type: string; resource_id: string }>) {
  return app.request('/account/owned-resources/purge', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Tdai-Service-Id': 'local',
      'X-Tdai-User-Key': 'key',
    },
    body: JSON.stringify({ team_id: 'team-1', resources, confirmation: 'PERMANENT_DELETE' }),
  });
}

describe('owner-only owned resource purge', () => {
  it('physically deletes a caller-owned Task and treats a missing retry as success', async () => {
    const normal = buildApp();
    const response = await purge(normal.app, [{ resource_type: 'task', resource_id: 'task-1' }]);
    expect(response.status).toBe(200);
    expect(normal.invoke).toHaveBeenCalledWith('task/delete', { task_ids: ['task-1'] }, expect.anything());

    const missing = buildApp({ resourceCode: 404 });
    const retry = await purge(missing.app, [{ resource_type: 'task', resource_id: 'task-gone' }]);
    await expect(retry.json()).resolves.toMatchObject({ data: { deleted: [{ resource_id: 'task-gone' }], failed: [] } });
  });

  it('prevalidates the full batch and never lets a Team admin purge another owner resource', async () => {
    const { app, invoke } = buildApp({ owner: 'other-user' });
    const response = await purge(app, [{ resource_type: 'task', resource_id: 'task-other' }]);
    expect(response.status).toBe(403);
    expect(invoke.mock.calls.some(([action]) => action === 'task/delete')).toBe(false);
  });

  it('requires active membership and preserves metadata when backing cleanup fails', async () => {
    const removed = buildApp({ membership: 'removed' });
    expect((await purge(removed.app, [{ resource_type: 'task', resource_id: 'task-1' }])).status).toBe(403);

    const failed = buildApp({ clearCode: 502 });
    const response = await purge(failed.app, [{ resource_type: 'asset', resource_id: 'memory-1' }]);
    const body = await response.json() as { data: { failed: unknown[] } };
    expect(body.data.failed).toHaveLength(1);
    expect(failed.invoke.mock.calls.some(([action]) => action === 'asset/delete')).toBe(false);
  });
});
