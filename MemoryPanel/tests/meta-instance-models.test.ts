import { afterEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { InstanceRegistry } from '../src/panel/config/instance-registry.js';
import type { PanelDeps } from '../src/panel/panel-deps.js';
import { registerMetaInstanceRoutes } from '../src/panel/http/routes/meta/instances.js';

afterEach(() => vi.unstubAllGlobals());

function app(deploymentModel?: string) {
  const api = new Hono();
  registerMetaInstanceRoutes(api, {
    config: { featureAnalyticsEnabled: false },
    instanceRegistry: new InstanceRegistry([{ instance_id: 'a', name: 'A', gateway_endpoint: 'http://core',
      api_key: 'gateway-secret', upstream_model: deploymentModel }]),
  } as unknown as PanelDeps);
  return api;
}

it('publishes each client model and deployment default separately without private fields', async () => {
  const call = vi.fn().mockResolvedValue(Response.json({ data: {
    model_ids: { pi: 'subscription-model', codex: null }, official_agents: ['codex'],
    clients: [
      { agent_source: 'pi', display_name: 'Pi', protocol: 'openai-chat', assignment: {
        enabled: true, mode: 'custom_unified', model_id: 'subscription-model', credential_kind: 'chatgpt_oauth', api_key: 'private-key', credential_ref: 'private-reference',
      } },
      { agent_source: 'codex', display_name: 'Codex', protocol: 'openai-responses', assignment: { enabled: true, mode: 'official' } },
    ],
  } }));
  vi.stubGlobal('fetch', call);
  const result = await (await app('deployment-model').request('/meta/instances')).json();
  expect(result.instances[0]).toMatchObject({ deployment_model: 'deployment-model', model_status: 'ready',
    upstream_models: { pi: 'subscription-model', codex: 'deployment-model' },
    client_models: [{ model_id: 'subscription-model', status: 'ready' }, { model_id: 'deployment-model', status: 'ready' }],
  });
  expect(call.mock.calls[0]?.[1].headers.authorization).toBe('Bearer gateway-secret');
  expect(JSON.stringify(result)).not.toMatch(/gateway-secret|private-key|private-reference/);
});

it('does not invent a default model when deployment metadata is absent', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ data: {
    model_ids: { pi: null }, official_agents: ['pi'], clients: [
      { agent_source: 'pi', display_name: 'Pi', protocol: 'openai-chat', assignment: { enabled: true, mode: 'official' } },
    ],
  } })));
  const result = await (await app().request('/meta/instances')).json();
  expect(result.instances[0]).toMatchObject({ deployment_model: null, client_models: [{ status: 'default_missing', model_id: null }] });
});

it('marks failed model lookups unavailable instead of falling back to a stale shared model', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('failure', { status: 503 })));
  const result = await (await app('deployment-model').request('/meta/instances')).json();
  expect(result.instances[0].model_status).toBe('unavailable');
  expect(result.instances[0]).not.toHaveProperty('upstream_models');
  expect(result.instances[0]).not.toHaveProperty('upstream_model');
});
