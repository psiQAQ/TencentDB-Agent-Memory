import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

function createApp(role: 'admin' | 'member' | 'reviewer' | null, setupLegacy = false) {
  const agentTemplateDir = mkdtempSync(path.join(tmpdir(), 'memory-panel-template-auth-'));
  temporaryDirectories.push(agentTemplateDir);
  if (setupLegacy) {
    const teamDir = path.join(agentTemplateDir, 'local', 'team-1');
    mkdirSync(teamDir, { recursive: true });
    writeFileSync(
      path.join(teamDir, 'template.json'),
      JSON.stringify({ name: 'legacy-default', visibility: 'team' }),
      'utf8',
    );
  }
  const invoke = vi.fn(async (action: string) => {
    if (action === 'auth/verify') {
      return {
        code: 0,
        message: 'ok',
        request_id: 'r',
        data: {
          valid: true,
          user: { user_id: 'caller', user_type: 'system_admin' },
        },
      };
    }
    if (action === 'team-member/get') {
      if (!role)
        return {
          code: 404,
          message: 'member_not_found',
          request_id: 'r',
          data: null,
        };
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
      resolve: () => ({
        instance_id: 'local',
        gateway_endpoint: 'http://core',
        api_key: 'secret',
      }),
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

  it.each(['member', 'reviewer'] as const)(
    'lets an active %s create, edit, list, and delete Team templates',
    async (role) => {
      const { app } = createApp(role);
      const createdResponse = await call(app, 'agent/create-default-template', {
        team_id: 'team-1',
        template: { name: `${role}-default`, visibility: 'team' },
      });
      expect(createdResponse.status).toBe(200);
      const created = (await createdResponse.json()) as {
        data: { template_id: string };
      };

      const updated = await call(app, 'agent/update-default-template', {
        team_id: 'team-1',
        template_id: created.data.template_id,
        template: { name: `${role}-updated`, visibility: 'team' },
      });
      await expect(updated.json()).resolves.toMatchObject({
        code: 0,
        data: {
          template_id: created.data.template_id,
          name: `${role}-updated`,
          updated_by: 'caller',
        },
      });

      const listed = await call(app, 'agent/list-default-templates', {
        team_id: 'team-1',
      });
      await expect(listed.json()).resolves.toMatchObject({
        code: 0,
        data: { total: 1, items: [{ name: `${role}-updated` }] },
      });

      const deleted = await call(app, 'agent/delete-default-template', {
        team_id: 'team-1',
        template_id: created.data.template_id,
      });
      await expect(deleted.json()).resolves.toMatchObject({
        code: 0,
        data: { deleted: true },
      });
    },
  );

  it('allows multiple templates instead of overwriting the Team default', async () => {
    const admin = createApp('admin');
    await call(admin.app, 'agent/create-default-template', {
      team_id: 'team-1',
      template: { name: 'team-default-a', visibility: 'team' },
    });
    await call(admin.app, 'agent/create-default-template', {
      team_id: 'team-1',
      template: { name: 'team-default-b', visibility: 'team' },
    });
    const listed = await call(admin.app, 'agent/list-default-templates', {
      team_id: 'team-1',
    });
    await expect(listed.json()).resolves.toMatchObject({
      code: 0,
      data: {
        total: 2,
        items: [{ name: 'team-default-a' }, { name: 'team-default-b' }],
      },
    });
  });

  it('rejects duplicate template names without overwriting an existing template', async () => {
    const member = createApp('member');
    await call(member.app, 'agent/create-default-template', {
      team_id: 'team-1',
      template: { name: 'Shared Template', visibility: 'team' },
    });
    const duplicate = await call(member.app, 'agent/create-default-template', {
      team_id: 'team-1',
      template: { name: ' shared template ', visibility: 'team' },
    });
    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toMatchObject({ code: 409, message: 'TEMPLATE_NAME_EXISTS' });
  });

  it('exposes the legacy single template as a stable collection item', async () => {
    const { app } = createApp('member', true);
    const response = await call(app, 'agent/list-default-templates', {
      team_id: 'team-1',
    });
    await expect(response.json()).resolves.toMatchObject({
      code: 0,
      data: {
        total: 1,
        items: [{ template_id: 'tpl-legacy', name: 'legacy-default' }],
      },
    });
  });

  it('blocks a caller without active Team membership from reading', async () => {
    const { app } = createApp(null);
    const response = await call(app, 'agent/get-default-template', {
      team_id: 'team-1',
    });
    expect(response.status).toBe(403);
  });
});
