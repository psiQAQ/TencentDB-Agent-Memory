import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { InstanceRegistry } from '../src/panel/config/instance-registry.js';
import type { PanelDeps } from '../src/panel/panel-deps.js';
import { registerUpstreamTestRoute } from '../src/panel/http/routes/upstream-test.js';
import { registerMetaProxyRoutes } from '../src/panel/http/routes/meta/proxy.js';

const invoke = vi.fn();
const proxyFetch = vi.fn();
let app: Hono;
const draft = {
  agent_source: 'default', type: 'conversation', base_url: 'https://api.deepseek.com',
  model_id: 'deepseek-v4-flash', credential_ref: 'deployment_default',
};
const call = (body: unknown = draft, action = 'test') => app.request('/meta/instance-upstream/' + action, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-tdai-service-id': 'a', 'x-tdai-user-key': 'sk-mem-private' },
  body: JSON.stringify(body),
});

beforeEach(() => {
  vi.stubEnv('MODEL_PROBE_PROXY_URL', 'http://proxy:8096');
  invoke.mockReset().mockResolvedValue({ code: 0, data: { valid: true, user: { user_type: 'system_admin' } } });
  proxyFetch.mockReset().mockResolvedValue(Response.json({ results: [
    { protocol: 'chat', status: 'ready' }, { protocol: 'responses', status: 'ready' }, { protocol: 'anthropic', status: 'ready' },
  ] }));
  vi.stubGlobal('fetch', proxyFetch);
  app = new Hono();
  const deps = {
    instanceRegistry: new InstanceRegistry([{ instance_id: 'a', name: 'A', gateway_endpoint: 'http://core', api_key: 'gateway-secret' }]),
    metaKernel: { invoke },
  } as unknown as PanelDeps;
  registerUpstreamTestRoute(app, deps);
  registerMetaProxyRoutes(app, deps);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it('delegates a bounded draft probe to Proxy without a supplier key in the body', async () => {
  const response = await call();
  expect(response.status).toBe(200);
  const [url, init] = proxyFetch.mock.calls[0];
  expect(url).toBe('http://proxy:8096/internal/upstream/test');
  expect(init.headers.authorization).toBe('Bearer gateway-secret');
  expect(init.headers['x-tdai-service-id']).toBe('a');
  expect(JSON.parse(init.body).protocols).toEqual(['chat', 'responses', 'anthropic']);
  expect(JSON.stringify(init.body)).not.toContain('gateway-secret');
  expect(JSON.stringify(await response.json())).not.toContain('gateway-secret');
});

it('probes only Chat for extraction', async () => {
  await call({ ...draft, type: 'extraction' });
  expect(JSON.parse(proxyFetch.mock.calls[0][1].body).protocols).toEqual(['chat']);
});

it('forwards an independent local key only to the internal probe and does not return it', async () => {
  const local = {
    agent_source: 'default', type: 'conversation', base_url: 'http://192.168.1.20:11434/v1',
    model_id: 'my-local-model', api_key: 'local-secret', local: true, protocols: ['chat'],
  };
  const response = await call(local);
  expect(response.status).toBe(200);
  const forwarded = JSON.parse(proxyFetch.mock.calls[0][1].body);
  expect(forwarded).toMatchObject(local);
  expect(JSON.stringify(await response.json())).not.toContain('local-secret');
});

it('keeps protocol choices for a cloud provider with an independent key', async () => {
  const response = await call({
    ...draft, base_url: 'https://api.anthropic.com/v1', model_id: 'claude-sonnet-4-6',
    credential_ref: undefined, api_key: 'anthropic-secret', protocols: ['anthropic'],
  });
  expect(response.status).toBe(200);
  expect(JSON.parse(proxyFetch.mock.calls[0][1].body).protocols).toEqual(['anthropic']);
});

it('requests an authenticated Proxy refresh and relays the adoption result', async () => {
  proxyFetch.mockResolvedValueOnce(Response.json({ adopted: true }));
  const response = await call(draft, 'refresh');
  expect(response.status).toBe(200);
  const [url, init] = proxyFetch.mock.calls[0];
  expect(url).toBe('http://proxy:8096/internal/upstream/refresh');
  expect(init.headers.authorization).toBe('Bearer gateway-secret');
  expect((await response.json()).data.adopted).toBe(true);
});

it('checks adoption of a stored independent credential without sending it again', async () => {
  proxyFetch.mockResolvedValueOnce(Response.json({ adopted: true }));
  const response = await call({
    agent_source: 'default', type: 'conversation', base_url: 'https://api.openai.com/v1',
    model_id: 'gpt-5.6-sol', credential_ref: 'stored',
  }, 'refresh');
  expect(response.status).toBe(200);
  expect(JSON.parse(proxyFetch.mock.calls[0][1].body).credential_ref).toBe('stored');
});

it('allows a reset refresh with no model or endpoint', async () => {
  proxyFetch.mockResolvedValueOnce(Response.json({ adopted: true }));
  const response = await call({
    agent_source: 'default', type: 'extraction', base_url: '', model_id: '', credential_ref: 'none',
  }, 'refresh');
  expect(response.status).toBe(200);
  expect((await response.json()).data.adopted).toBe(true);
});

it('blocks a non-admin caller before making a Proxy request', async () => {
  invoke.mockResolvedValue({ code: 0, data: { valid: true, user: { user_type: 'normal' } } });
  expect((await call()).status).toBe(403);
  expect(proxyFetch).not.toHaveBeenCalled();
});

it.each([{ ...draft, credential_ref: 'other' }, { ...draft, agent_source: 'pi' }, { ...draft, model_id: '' }])(
  'rejects an unsupported draft without a Proxy request', async (body) => {
    expect((await call(body)).status).toBe(400);
    expect(proxyFetch).not.toHaveBeenCalled();
  },
);

it('fails clearly when the local Proxy probe endpoint is unavailable', async () => {
  vi.stubEnv('MODEL_PROBE_PROXY_URL', '');
  expect((await call()).status).toBe(503);
  expect(proxyFetch).not.toHaveBeenCalled();
});

it.each(['list', 'set', 'reset', 'get-for-edit'])('forwards Core %s under the caller identity', async (action) => {
  invoke.mockResolvedValue({ code: 0, data: { items: [] } });
  const response = await call({ agent_source: 'default', type: 'conversation' }, action);
  expect(response.status).toBe(200);
  expect(invoke.mock.calls[0][0]).toBe('instance-upstream/' + action);
  expect(invoke.mock.calls[0][2].userKey).toBe('sk-mem-private');
});
