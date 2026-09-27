import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config.js';
import { resolveInstanceCredential, resolveInstanceTargetUrl, type InstanceUpstreamConfigEntry } from '../instance-upstream-cache.js';
import { createApp } from '../server.js';

const configured: InstanceUpstreamConfigEntry = {
  agent_source: 'default', type: 'conversation', mode: 'custom_unified',
  base_url: 'https://api.deepseek.com', api_key: '', credential_ref: 'deployment_default',
  model_id: 'deepseek-v4-flash',
};
const config = {
  ...DEFAULT_CONFIG,
  upstream: { url: 'https://api.deepseek.com/v1', apiKey: 'deployment-secret', agents: {
    'claude-code': { url: 'https://api.deepseek.com/anthropic/v1', apiKey: 'deployment-secret' },
  } },
  coreSkill: { ...DEFAULT_CONFIG.coreSkill, serviceToken: 'service-secret' },
};

describe('deployment upstream reference', () => {
  it('resolves the deployment credential only for the same HTTPS origin', () => {
    expect(resolveInstanceCredential(configured, config)).toBe('deployment-secret');
    expect(resolveInstanceCredential(configured, config, 'claude-code')).toBe('deployment-secret');
    expect(resolveInstanceCredential({ ...configured, base_url: 'https://elsewhere.example' }, config)).toBeNull();
    expect(resolveInstanceCredential({ ...configured, base_url: 'http://api.deepseek.com' }, config)).toBeNull();
    expect(resolveInstanceCredential({ ...configured, base_url: 'https://user:pass@api.deepseek.com' }, config)).toBeNull();
  });

  it('uses DeepSeek protocol endpoints behind one default conversation row', () => {
    expect(resolveInstanceTargetUrl(configured, 'https://api.deepseek.com/v1/chat/completions')).toBe('https://api.deepseek.com/chat/completions');
    expect(resolveInstanceTargetUrl(configured, 'https://api.deepseek.com/v1/responses')).toBe('https://api.deepseek.com/responses');
    expect(resolveInstanceTargetUrl(configured, 'https://api.deepseek.com/v1/messages')).toBe('https://api.deepseek.com/anthropic/v1/messages');
  });

  it('rejects unauthenticated and private-address connection probes', async () => {
    const app = createApp({ ...config, upstream: { url: 'https://127.0.0.1', apiKey: 'secret', agents: {} } });
    const body = JSON.stringify({
      agent_source: 'default', type: 'conversation', base_url: 'https://127.0.0.1',
      model_id: 'model', credential_ref: 'deployment_default', protocols: ['chat'],
    });
    const unauthorized = await app.request('/internal/upstream/test', { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-tdai-service-id': 'probe-a' } });
    expect(unauthorized.status).toBe(403);
    const denied = await app.request('/internal/upstream/test', { method: 'POST', body, headers: {
      'content-type': 'application/json', 'x-tdai-service-id': 'probe-b', authorization: 'Bearer service-secret',
    } });
    expect(denied.status).toBe(400);
    expect((await denied.json()).error).toBe('non_public_target');
  });

  it('protects the cache refresh endpoint with the service token', async () => {
    const app = createApp(config);
    const response = await app.request('/internal/upstream/refresh', {
      method: 'POST', headers: { 'x-tdai-service-id': 'a' }, body: '{}',
    });
    expect(response.status).toBe(403);
  });
});
