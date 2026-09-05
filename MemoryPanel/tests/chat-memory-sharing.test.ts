import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { PanelDeps } from '../src/panel/panel-deps.js';
import { registerChatMemoryRoutes, type AssetRaw } from '../src/panel/http/routes/chat-memory.js';

const selfId = 'chat_memory-team-1-agt-reader';
const sharedId = 'chat_memory-team-1-agt-writer';
const binding = (id: string, type = 'chat_memory') => ({ asset_id: id, asset_type: type, injection_mode: 'summary', priority: 50, created_by: 'reader' });

function fixture() {
  const agent = { agent_id: 'agt-reader', team_id: 'team-1', owner_user_id: 'reader', name: 'Reader' };
  const assets = new Map<string, AssetRaw>([selfId, sharedId, 'memory-second', 'memory-third'].map((id) => [id, {
    asset_id: id, asset_type: 'chat_memory', team_id: 'team-1', owner_user_id: id === selfId ? 'reader' : 'writer',
    visibility: id === selfId ? 'private' : 'team', name: id, status: 'approved', updated_at: '',
  }]));
  const state = { bindings: [binding(selfId)], failList: false };
  const ok = (data: unknown) => ({ code: 0, message: 'ok', request_id: 'test-request', data });
  const invoke = vi.fn(async (action: string, body: Record<string, unknown>, ctx: { userKey?: string }) => {
    const userId = ctx.userKey === 'writer-key' ? 'writer' : 'reader';
    if (action === 'auth/verify') return ok({ valid: true, user: { user_id: userId } });
    if (action === 'agent/get') return ok(agent);
    if (action === 'asset/get') return ok(assets.get(String(body.asset_id)) ?? null);
    // Emulate the Core owner-only response; Core tests separately exercise the real check.
    if (action === 'asset/update') {
      const asset = assets.get(String(body.asset_id))!;
      if (asset.owner_user_id !== userId) return { code: 403, message: 'permission_denied', request_id: 'test-request' };
      asset.visibility = String(body.visibility);
      return ok(asset);
    }
    if (action === 'agent-fixed-asset/list' || action === 'agent-fixed-asset/list-with-detail') {
      if (state.failList) return { code: 503, message: 'metadata unavailable', request_id: 'test-request' };
      const offset = Number(body.offset ?? 0);
      const limit = Number(body.limit ?? 20);
      let items = state.bindings.slice(offset, offset + limit);
      if (body.apply_visibility_filter) items = items.filter((item) => {
        const asset = assets.get(item.asset_id);
        return !asset || asset.visibility === 'team' || asset.owner_user_id === agent.owner_user_id;
      });
      return ok({ items, total: state.bindings.length, offset, limit });
    }
    if (action === 'agent-fixed-asset/set') {
      state.bindings = body.bindings as typeof state.bindings;
      return ok({ updated: true });
    }
    throw new Error(`unexpected action ${action}`);
  });
  const app = new Hono();
  registerChatMemoryRoutes(app, {
    instanceRegistry: { resolve: () => ({ instance_id: 'test-instance', gateway_endpoint: 'https://core.invalid', api_key: 'synthetic-service-token' }) },
    config: { metadataRemoteTimeoutMs: 1_000 }, metaKernel: { invoke },
  } as unknown as PanelDeps);
  const call = (action: string, body: Record<string, unknown> = {}, userKey = 'reader-key') => app.request(`/chat-memory/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'X-Tdai-Service-Id': 'test-instance', 'X-Tdai-User-Key': userKey },
    body: JSON.stringify({ agent_id: agent.agent_id, team_id: agent.team_id, block_id: sharedId, ...body }),
  });
  const writes = () => invoke.mock.calls.filter(([action]) => action === 'agent-fixed-asset/set');
  return { agent, assets, state, invoke, call, writes };
}

describe('Chat Memory sharing and allocation routes', () => {
  it('forwards owner-only sharing changes and preserves Core permission errors', async () => {
    const { call, assets, invoke } = fixture();
    const denied = await call('patch-scope', { scope: 'private' });
    expect(denied.status).toBe(403);
    expect(assets.get(sharedId)?.visibility).toBe('team');
    const allowed = await call('patch-scope', { scope: 'private' }, 'writer-key');
    expect(allowed.status).toBe(200);
    expect((await allowed.json()).data).toMatchObject({ updated: true, scope: 'private' });
    expect(assets.get(sharedId)?.visibility).toBe('private');
    expect(invoke.mock.calls.filter(([action]) => action === 'asset/update').map(([, , ctx]) => ctx.userKey)).toEqual(['reader-key', 'writer-key']);
  });

  it.each(['allocate', 'set-agent-fixed', 'unbind'])('rejects non-owner %s before changing bindings', async (action) => {
    const { agent, state, call, writes } = fixture();
    agent.owner_user_id = 'another-user';
    const original = structuredClone(state.bindings);
    const response = await call(action, { block_ids: [sharedId] });
    expect(response.status).toBe(403);
    expect((await response.json()).message).toBe('NOT_YOUR_AGENT');
    expect(writes()).toEqual([]);
    expect(state.bindings).toEqual(original);
  });

  it.each([
    ['private', 'ASSET_NOT_SHARED'], ['cross-team', 'TEAM_MISMATCH'], ['wrong-type', 'NOT_CHAT_MEMORY'],
  ])('rejects a %s import without a binding write', async (kind, message) => {
    const { assets, call, writes } = fixture();
    const asset = assets.get(sharedId)!;
    if (kind === 'private') asset.visibility = 'private';
    if (kind === 'cross-team') asset.team_id = 'other-team';
    if (kind === 'wrong-type') asset.asset_type = 'skill';
    const response = await call('allocate');
    expect((await response.json()).message).toBe(message);
    expect(writes()).toEqual([]);
  });

  it('allows two external memories, rejects a third and rejects a duplicate allocation', async () => {
    const { call, state, writes } = fixture();
    expect((await call('allocate')).status).toBe(200);
    expect((await call('allocate', { block_id: 'memory-second' })).status).toBe(200);
    const original = structuredClone(state.bindings);
    const third = await call('allocate', { block_id: 'memory-third' });
    expect((await third.json()).message).toBe('IMPORT_LIMIT_EXCEEDED');
    expect((await call('allocate')).status).toBe(409);
    expect(state.bindings).toEqual(original);
    expect(writes()).toHaveLength(2);
  });

  it('preserves all existing bindings across pages during allocation', async () => {
    const { call, state, invoke, writes } = fixture();
    state.bindings.push(...Array.from({ length: 101 }, (_, i) => binding(`skill-${i}`, 'skill')));
    const original = structuredClone(state.bindings);
    expect((await call('allocate')).status).toBe(200);
    expect(state.bindings).toEqual([...original, binding(sharedId)]);
    expect(invoke.mock.calls.filter(([action]) => action === 'agent-fixed-asset/list').map(([, body]) => body.offset)).toEqual([0, 100]);
    expect(writes()).toHaveLength(1);
  });

  it('deduplicates batch imports, preserves self and other asset types, and uses one write', async () => {
    const { call, state, writes } = fixture();
    state.bindings.push(binding('skill-1', 'skill'), binding('memory-third'));
    const response = await call('set-agent-fixed', { block_ids: [selfId, sharedId, sharedId, 'memory-second'] });
    expect(response.status).toBe(200);
    expect(state.bindings).toEqual([binding('skill-1', 'skill'), binding(selfId), binding(sharedId), binding('memory-second')]);
    expect(writes()).toHaveLength(1);
  });

  it('rejects an oversized batch before any metadata write', async () => {
    const { call, writes } = fixture();
    expect((await (await call('set-agent-fixed', { block_ids: [sharedId, 'memory-second', 'memory-third'] })).json()).message).toBe('IMPORT_LIMIT_EXCEEDED');
    expect(writes()).toEqual([]);
  });

  it('validates the entire batch before replacing any binding', async () => {
    const { call, assets, state, writes } = fixture();
    assets.get('memory-second')!.visibility = 'private';
    const original = structuredClone(state.bindings);
    expect((await call('set-agent-fixed', { block_ids: [sharedId, 'memory-second'] })).status).toBe(403);
    expect(writes()).toEqual([]);
    expect(state.bindings).toEqual(original);
  });

  it('unbinds a revoked private import while preserving other bindings', async () => {
    const { call, assets, state, writes } = fixture();
    state.bindings.push(binding(sharedId), binding('skill-1', 'skill'), binding('memory-second'));
    assets.get(sharedId)!.visibility = 'private';
    expect((await call('unbind')).status).toBe(200);
    expect(state.bindings).toEqual([binding(selfId), binding('skill-1', 'skill'), binding('memory-second')]);
    expect(writes()).toHaveLength(1);
  });

  it('does not allow self-memory unbinding', async () => {
    const { call, writes } = fixture();
    expect((await (await call('unbind', { block_id: selfId })).json()).message).toBe('CANNOT_UNBIND_SELF_CHAT_MEMORY');
    expect(writes()).toEqual([]);
  });

  it.each(['allocate', 'set-agent-fixed', 'unbind'])('keeps bindings intact when %s cannot load the current binding list', async (action) => {
    const { call, state, writes } = fixture();
    state.failList = true;
    const original = structuredClone(state.bindings);
    const response = await call(action, { block_ids: [sharedId] });
    expect((await response.json()).code).toBe(503);
    expect(writes()).toEqual([]);
    expect(state.bindings).toEqual(original);
  });
});
