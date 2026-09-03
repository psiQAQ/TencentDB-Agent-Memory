import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerMetaProxyRoutes } from '../src/panel/http/routes/meta/proxy.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createApp(role: 'admin' | 'member' | 'reviewer' | null) {
  const agentTemplateDir = mkdtempSync(path.join(tmpdir(), 'memory-panel-template-auth-'));
  temporaryDirectories.push(agentTemplateDir);
  const invoke = vi.fn(async (action: string) => {
    if (action === 'auth/verify') {
      return {
        code: 0,
        message: 'ok',
        request_id: 'r',
        data: { valid: true, user: { user_id: 'caller', user_type: 'system_admin' } },
      };
    }
    if (action === 'team-member/get') {
      if (!role) return { code: 404, message: 'member_not_found', request_id: 'r', data: null };
      return {
        code: 0,
        message: 'ok',
        request_id: 'r',
        data: { team_id: 'team-1', user_id: 'caller', role, status: 'active' },
      };
    }
    if (action === 'team-member/add') {
      return { code: 0, message: 'ok', request_id: 'r', data: { ok: true } };
    }
    throw new Error(`unexpected meta action: ${action}`);
  });
  const deps = {
    instanceRegistry: {
      resolve: () => ({ instance_id: 'local', gateway_endpoint: 'http://core', api_key: 'secret' }),
    },
    config: { agentTemplateDir },
    metaKernel: { invoke },
  } as never;
  const app = new Hono();
  registerMetaProxyRoutes(app, deps);
  return { app, invoke };
}

function call(app: Hono, action: string, body: Record<string, unknown>) {
  return app.request(`/meta/${action}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Tdai-Service-Id': 'local',
      'X-Tdai-User-Key': 'system-admin-key',
    },
    body: JSON.stringify(body),
  });
}

describe('default Agent template Team-role authorization', () => {
  it('adding a member only forwards membership and creates no Agent or Skill', async () => {
    const { app, invoke } = createApp('admin');
    const response = await call(app, 'team-member/add', {
      team_id: 'team-1',
      user_id: 'new-member',
      role: 'member',
    });

    expect(response.status).toBe(200);
    expect(invoke.mock.calls.map(([action]) => action)).toEqual(['team-member/add']);
  });

  it('does not let a system_admin Team member write the template', async () => {
    const { app } = createApp('member');
    const response = await call(app, 'agent/set-default-template', {
      team_id: 'team-1',
      template: { name: 'blocked' },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: 403, message: 'permission_denied' });
  });

  it('allows a real Team admin to write and active members to read', async () => {
    const admin = createApp('admin');
    const write = await call(admin.app, 'agent/set-default-template', {
      team_id: 'team-1',
      template: { name: 'team-default', visibility: 'team' },
    });
    expect(write.status).toBe(200);

    const read = await call(admin.app, 'agent/get-default-template', { team_id: 'team-1' });
    await expect(read.json()).resolves.toMatchObject({
      code: 0,
      data: { name: 'team-default', visibility: 'team' },
    });
  });

  it('blocks a caller without active Team membership from reading', async () => {
    const { app } = createApp(null);
    const response = await call(app, 'agent/get-default-template', { team_id: 'team-1' });
    expect(response.status).toBe(403);
  });
});
