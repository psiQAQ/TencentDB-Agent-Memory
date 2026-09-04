import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { registerAccountOwnedResourceRoutes } from '../src/panel/http/routes/account-owned-resources.js';

function buildApp(options: {
  membership?: 'active' | 'removed';
  owner?: string;
  resourceCode?: number;
  clearCode?: number;
  assetType?: 'skill' | 'chat_memory' | 'llm_wiki' | 'code_graph';
  targetHasAgent?: boolean;
  sourceAgentStatus?: 'active' | 'inactive';
  inactiveOwnedAgent?: boolean;
  boundAssets?: Array<{ asset_id: string; asset_type: 'skill' | 'chat_memory' | 'llm_wiki' | 'code_graph'; owner_user_id?: string }>;
} = {}) {
  const invoke = vi.fn(async (action: string, body: Record<string, unknown>) => {
    if (action === 'auth/verify') {
      return { code: 0, message: 'ok', data: { valid: true, user: { user_id: 'caller' } } };
    }
    if (action === 'team-member/get') {
      return { code: 0, message: 'ok', data: { user_id: 'caller', role: 'member', status: options.membership ?? 'active' } };
    }
    if (action === 'user/get') {
      return { code: 0, message: 'ok', data: { user_id: body.user_id, username: 'target' } };
    }
    if (action === 'agent-fixed-asset/list') {
      return {
        code: 0,
        message: 'ok',
        data: {
          items: (options.boundAssets ?? []).map(({ asset_id, asset_type }) => ({ asset_id, asset_type })),
          total: options.boundAssets?.length ?? 0,
        },
      };
    }
    if (action === 'agent/list') {
      if (body.status === 'inactive') {
        const items = options.inactiveOwnedAgent
          ? [{ agent_id: 'inactive-agent', name: 'inactive', owner_user_id: 'caller', status: 'inactive' }]
          : [];
        return { code: 0, message: 'ok', data: { items, total: items.length } };
      }
      const items = options.targetHasAgent === false ? [] : [{ agent_id: 'target-agent', name: 'target' }];
      return { code: 0, message: 'ok', data: { items, total: items.length } };
    }
    if (action === 'task/get') {
      if (options.resourceCode === 404) return { code: 404, message: 'not found', data: null };
      return { code: 0, message: 'ok', data: { task_id: body.task_id, team_id: 'team-1', owner_user_id: options.owner ?? 'caller', creator_user_id: 'original-creator' } };
    }
    if (action === 'agent/get') {
      const target = body.agent_id === 'target-agent' || body.agent_id === 'handoff-agent';
      return {
        code: 0,
        message: 'ok',
        data: {
          agent_id: body.agent_id,
          team_id: 'team-1',
          owner_user_id: target ? 'target' : 'caller',
          status: target ? 'active' : (options.sourceAgentStatus ?? 'active'),
        },
      };
    }
    if (action === 'asset/get') {
      const bound = options.boundAssets?.find((item) => item.asset_id === body.asset_id);
      return { code: 0, message: 'ok', data: { asset_id: body.asset_id, team_id: 'team-1', owner_user_id: bound?.owner_user_id ?? options.owner ?? 'caller', asset_type: bound?.asset_type ?? options.assetType ?? 'chat_memory' } };
    }
    if (action === 'ownership/transfer') {
      const transfers = body.transfers as Array<Record<string, unknown>>;
      return { code: 0, message: 'ok', data: { items: transfers.map((item) => ({ ...item, transferred: true })) } };
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
  const kernelPost = vi.fn(async (path: string) => {
    if (path.endsWith('/agent/create-for-handoff')) {
      return { code: 0, message: 'ok', data: { agent_id: 'handoff-agent', name: 'default-agent-target' } };
    }
    if (path.endsWith('/prepare-transfer')) return { code: 0, message: 'ok', data: { operation_id: 'op-1', status: 'pending' } };
    if (path.endsWith('/finalize-transfer') || path.endsWith('/finalize-bound-transfer')) {
      return { code: 0, message: 'ok', data: { resource_type: 'asset', resource_id: 'wiki-1', transferred: true } };
    }
    if (path.endsWith('/finalize-delete')) return { code: 0, message: 'ok', data: { deleted_ids: ['memory-1'], failed: [] } };
    return {
      code: options.clearCode ?? 0,
      message: options.clearCode ? 'clear failed' : 'ok',
      data: { all_cleared: !options.clearCode },
    };
  });
  const transferOwnership = vi.fn(async () => ({ resource_id: 'wiki-1', owner_user_id: 'target', status: 'ready' }));
  const deps = {
    instanceRegistry: { resolve: () => ({ instance_id: 'local', gateway_endpoint: 'http://core', api_key: 'gateway' }) },
    metaKernel: { invoke },
    skillKernel: { invoke: vi.fn(async () => ({ code: 0, message: 'ok', data: { items: [{ skill_id: 'skill-1', version: 3, owner_agent_id: 'source-agent' }], total: 1 } })) },
    kernelHttp: { postEnvelope: kernelPost },
    knowledgeClientFactory: () => ({ transferOwnership }),
    config: { metadataRemoteTimeoutMs: 10_000, agentTemplateDir: '/tmp/memory-panel-missing-template' },
  } as never;
  const app = new Hono();
  registerAccountOwnedResourceRoutes(app, deps);
  return { app, invoke, kernelPost, transferOwnership };
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

  it('requires an inactive Agent child to be purged through its Agent aggregate', async () => {
    const fixture = buildApp({
      inactiveOwnedAgent: true,
      boundAssets: [{ asset_id: 'memory-1', asset_type: 'chat_memory' }],
    });
    const response = await purge(fixture.app, [{ resource_type: 'asset', resource_id: 'memory-1' }]);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ message: 'INACTIVE_AGENT_CHILD_REQUIRES_AGENT_PURGE' });
    expect(fixture.kernelPost.mock.calls.some(([path]) => path === '/v3/chat-memory/clear')).toBe(false);
  });
});

describe('ownership transfer lifecycle', () => {
  it('folds selected Agent children into one aggregate transfer and forwards confirmation', async () => {
    const fixture = buildApp({
      boundAssets: [
        { asset_id: 'memory-1', asset_type: 'chat_memory' },
        { asset_id: 'skill-1', asset_type: 'skill' },
      ],
    });
    const response = await fixture.app.request('/account/ownership/transfer', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Tdai-Service-Id': 'local',
        'X-Tdai-User-Key': 'key',
      },
      body: JSON.stringify({
        team_id: 'team-1',
        transfers: [
          { resource_type: 'agent', resource_id: 'agent-1', to_user_id: 'target' },
          {
            resource_type: 'asset', resource_id: 'memory-1', to_user_id: 'target',
            from_agent_id: 'agent-1', to_agent_id: 'target-agent',
          },
        ],
        idempotency_key: '22222222-2222-4222-8222-222222222222',
        confirmation: 'TRANSFER_OWNERSHIP',
      }),
    });
    expect(response.status).toBe(200);
    const call = fixture.invoke.mock.calls.find(([action]) => action === 'ownership/transfer');
    expect(call?.[1]).toMatchObject({
      confirmation: 'TRANSFER_OWNERSHIP',
      transfers: [{ resource_type: 'agent', resource_id: 'agent-1', to_user_id: 'target' }],
    });
  });

  it('journals bound Knowledge backing before committing the Agent aggregate', async () => {
    const fixture = buildApp({
      boundAssets: [{ asset_id: 'wiki-1', asset_type: 'llm_wiki' }],
    });
    const response = await fixture.app.request('/account/ownership/transfer', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Tdai-Service-Id': 'local',
        'X-Tdai-User-Key': 'key',
      },
      body: JSON.stringify({
        team_id: 'team-1',
        transfers: [{ resource_type: 'agent', resource_id: 'agent-1', to_user_id: 'target' }],
        idempotency_key: '44444444-4444-4444-8444-444444444444',
        confirmation: 'TRANSFER_OWNERSHIP',
      }),
    });
    expect(response.status).toBe(200);
    expect(fixture.kernelPost.mock.calls.map(([path]) => path)).toEqual([
      '/v3/internal/meta/asset/prepare-transfer',
      '/v3/internal/meta/asset/finalize-transfer',
    ]);
    expect(fixture.transferOwnership).toHaveBeenCalledWith(expect.objectContaining({
      resource_type: 'llm_wiki',
      resource_id: 'wiki-1',
      from_owner_user_id: 'caller',
      to_owner_user_id: 'target',
    }));
    const coreCall = fixture.invoke.mock.calls.find(([action]) => action === 'ownership/transfer');
    expect(coreCall?.[1]).toMatchObject({
      transfers: [{ resource_type: 'agent', resource_id: 'agent-1', to_user_id: 'target' }],
      confirmation: 'TRANSFER_OWNERSHIP',
    });
  });

  it('prepares Core, CAS-transfers knowledge backing, then finalizes Core metadata', async () => {
    const fixture = buildApp({
      assetType: 'llm_wiki',
      boundAssets: [{ asset_id: 'wiki-1', asset_type: 'llm_wiki' }],
    });
    const response = await fixture.app.request('/account/ownership/transfer', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Tdai-Service-Id': 'local',
        'X-Tdai-User-Key': 'key',
      },
      body: JSON.stringify({
        team_id: 'team-1',
        transfers: [{
          resource_type: 'asset', resource_id: 'wiki-1', to_user_id: 'target',
          from_agent_id: 'source-agent', to_agent_id: 'target-agent',
        }],
        idempotency_key: '33333333-3333-4333-8333-333333333333',
        confirmation: 'TRANSFER_OWNERSHIP',
      }),
    });
    expect(response.status).toBe(200);
    expect(fixture.kernelPost.mock.calls.map(([path]) => path)).toEqual([
      '/v3/internal/meta/asset/prepare-transfer',
      '/v3/internal/meta/asset/finalize-bound-transfer',
    ]);
    expect(fixture.transferOwnership).toHaveBeenCalledWith(expect.objectContaining({
      resource_type: 'llm_wiki',
      from_owner_user_id: 'caller',
      to_owner_user_id: 'target',
    }));
  });

  it('requires a recipient Agent and coordinates Skill backing before atomic metadata/binding finalize', async () => {
    const fixture = buildApp({
      assetType: 'skill',
      boundAssets: [{ asset_id: 'skill-1', asset_type: 'skill' }],
    });
    const request = (toAgentId?: string) => fixture.app.request('/account/ownership/transfer', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Tdai-Service-Id': 'local', 'X-Tdai-User-Key': 'key' },
      body: JSON.stringify({
        team_id: 'team-1',
        transfers: [{
          resource_type: 'asset', resource_id: 'skill-1', to_user_id: 'target',
          from_agent_id: 'source-agent', ...(toAgentId ? { to_agent_id: toAgentId } : {}),
        }],
        idempotency_key: toAgentId ? '66666666-6666-4666-8666-666666666666' : '55555555-5555-4555-8555-555555555555',
        confirmation: 'TRANSFER_OWNERSHIP',
      }),
    });
    expect((await request()).status).toBe(400);
    expect((await request('target-agent')).status).toBe(200);
    expect(fixture.kernelPost.mock.calls.map(([path]) => path)).toEqual(expect.arrayContaining([
      '/v3/internal/meta/asset/prepare-transfer',
      '/v3/internal/meta/skill/transfer-owner',
      '/v3/internal/meta/skill/finalize-transfer',
    ]));
  });

  it('creates a default recipient Agent when none exists and keeps standalone Chat Memory attached', async () => {
    const fixture = buildApp({
      assetType: 'chat_memory',
      targetHasAgent: false,
      boundAssets: [{ asset_id: 'memory-1', asset_type: 'chat_memory' }],
    });
    const response = await fixture.app.request('/account/ownership/transfer', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Tdai-Service-Id': 'local', 'X-Tdai-User-Key': 'key' },
      body: JSON.stringify({
        team_id: 'team-1',
        transfers: [{
          resource_type: 'asset', resource_id: 'memory-1', to_user_id: 'target',
          from_agent_id: 'source-agent',
        }],
        idempotency_key: '88888888-8888-4888-8888-888888888888',
        confirmation: 'TRANSFER_OWNERSHIP',
      }),
    });
    expect(response.status).toBe(200);
    expect(fixture.kernelPost.mock.calls.map(([path]) => path)).toContain(
      '/v3/internal/meta/agent/create-for-handoff',
    );
    const transfer = fixture.invoke.mock.calls.find(([action]) => action === 'ownership/transfer');
    expect(transfer?.[1]).toMatchObject({
      transfers: [{
        resource_type: 'asset', resource_id: 'memory-1', to_user_id: 'target',
        from_agent_id: 'source-agent', to_agent_id: 'handoff-agent',
      }],
    });
  });

  it('rejects standalone asset transfer from an inactive source Agent', async () => {
    const fixture = buildApp({
      assetType: 'chat_memory',
      sourceAgentStatus: 'inactive',
      boundAssets: [{ asset_id: 'memory-1', asset_type: 'chat_memory' }],
    });
    const response = await fixture.app.request('/account/ownership/transfer', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Tdai-Service-Id': 'local', 'X-Tdai-User-Key': 'key' },
      body: JSON.stringify({
        team_id: 'team-1',
        transfers: [{
          resource_type: 'asset', resource_id: 'memory-1', to_user_id: 'target',
          from_agent_id: 'source-agent', to_agent_id: 'target-agent',
        }],
        idempotency_key: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        confirmation: 'TRANSFER_OWNERSHIP',
      }),
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ message: 'SOURCE_AGENT_NOT_ACTIVE' });
    expect(fixture.invoke.mock.calls.some(([action]) => action === 'ownership/transfer')).toBe(false);
  });
});
