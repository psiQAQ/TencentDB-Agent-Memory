import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { registerAgentLifecycleRoutes } from '../src/panel/http/routes/agent-lifecycle.js';

function buildApp(ownerUserId = 'caller') {
  const invoke = vi.fn(async (action: string, body: Record<string, unknown>) => {
    if (action === 'auth/verify') {
      return { code: 0, message: 'ok', data: { valid: true, user: { user_id: 'caller' } } };
    }
    if (action === 'agent/get') {
      return {
        code: 0,
        message: 'ok',
        data: { agent_id: body.agent_id, team_id: 'team-1', owner_user_id: ownerUserId, status: 'active' },
      };
    }
    if (action === 'agent/archive') {
      return {
        code: 0,
        message: 'ok',
        data: { agent_id: body.agent_id, team_id: 'team-1', owner_user_id: ownerUserId, status: 'inactive' },
      };
    }
    throw new Error(`unexpected meta action: ${action}`);
  });
  const skillInvoke = vi.fn();
  const deps = {
    instanceRegistry: {
      resolve: () => ({ instance_id: 'local', gateway_endpoint: 'http://core', api_key: 'gateway' }),
    },
    metaKernel: { invoke },
    skillKernel: { invoke: skillInvoke },
    config: { agentTemplateDir: '/tmp/memory-panel-missing-template' },
  } as never;
  const app = new Hono();
  registerAgentLifecycleRoutes(app, deps);
  return { app, invoke, skillInvoke };
}

function archive(app: Hono) {
  return app.request('/agent/archive', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Tdai-Service-Id': 'local',
      'X-Tdai-User-Key': 'key',
    },
    body: JSON.stringify({ agent_id: 'agent-1' }),
  });
}

describe('recoverable Agent archive', () => {
  it('archives only the Agent and never deletes Skill or other assets', async () => {
    const fixture = buildApp();
    const response = await archive(fixture.app);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { archived: true, agent_id: 'agent-1', assets_preserved: true },
    });
    expect(fixture.invoke).toHaveBeenCalledWith('agent/archive', { agent_id: 'agent-1' }, expect.anything());
    expect(fixture.skillInvoke).not.toHaveBeenCalled();
  });

  it('does not let a Team admin archive another owner Agent', async () => {
    const fixture = buildApp('other-user');
    expect((await archive(fixture.app)).status).toBe(403);
    expect(fixture.invoke.mock.calls.some(([action]) => action === 'agent/archive')).toBe(false);
  });
});
