import { describe, expect, it, vi } from 'vitest';
import { MetadataService } from './metadata-service.js';

function serviceWith(existing: Record<string, unknown> | null = null) {
  const getInstanceUpstreamConfig = vi.fn().mockResolvedValue(existing);
  const upsertInstanceUpstreamConfig = vi.fn(async (input) => ({
    ...existing,
    id: 1,
    agent_source: input.agent_source ?? 'default',
    type: input.type ?? 'conversation',
    mode: input.mode,
    base_url: input.base_url ?? '',
    api_key: input.api_key ?? '',
    credential_ref: input.credential_ref ?? '',
    model_id: input.model_id ?? '',
    description: '', created_at: '', updated_at: '',
  }));
  const store = { getInstanceUpstreamConfig, upsertInstanceUpstreamConfig };
  return { service: new MetadataService(store as any), store };
}

describe('instance upstream credential isolation', () => {
  it('stores a deployment reference without copying a supplier key into Core', async () => {
    const { service, store } = serviceWith();
    const result = await service.setInstanceUpstreamConfig({
      agent_source: 'default', type: 'conversation', mode: 'custom_unified',
      base_url: 'https://api.deepseek.com/v1', model_id: 'deepseek-v4-flash',
      credential_ref: 'deployment_default',
    });
    expect(store.upsertInstanceUpstreamConfig).toHaveBeenCalledWith(expect.objectContaining({ api_key: '' }));
    expect(result.base_url).toBe('https://api.deepseek.com');
    expect(result.endpoint).toEqual({ protocol: 'https', host: 'api.deepseek.com', port: '' });
    expect(result.credential_status).toBe('deployment_default');
    expect(JSON.stringify(result)).not.toContain('/v1');
  });

  it('never retains a saved raw key when the target host changes', async () => {
    const old = { mode: 'custom_unified', base_url: 'https://old.example/v1', api_key: 'old-secret', credential_ref: '' };
    const { service, store } = serviceWith(old);
    await expect(service.setInstanceUpstreamConfig({
      mode: 'custom_unified', base_url: 'https://new.example/v1', model_id: 'model',
    })).rejects.toThrow('api_key or credential_ref is required');
    expect(store.upsertInstanceUpstreamConfig).not.toHaveBeenCalled();
  });

  it('retains a raw key only for the same supplier origin', async () => {
    const old = { mode: 'custom_unified', base_url: 'https://provider.example/v1', api_key: 'old-secret', credential_ref: '' };
    const { service, store } = serviceWith(old);
    await service.setInstanceUpstreamConfig({
      mode: 'custom_unified', base_url: 'https://provider.example/v2', model_id: 'model',
    });
    expect(store.upsertInstanceUpstreamConfig).toHaveBeenCalledWith(expect.objectContaining({ api_key: 'old-secret' }));
  });

  it('separates public summary from the editor URL and removes URL credentials', async () => {
    const old = {
      id: 1, agent_source: 'default', type: 'conversation', mode: 'custom_unified',
      base_url: 'https://user:password@provider.example/v1?token=secret#section',
      api_key: 'old-secret', credential_ref: '', model_id: 'model', description: '', created_at: '', updated_at: '',
    };
    const { service } = serviceWith(old);
    const publicView = await service.getInstanceUpstreamConfig('default', 'conversation');
    const editor = await service.getInstanceUpstreamConfigForEdit('default', 'conversation');
    expect(JSON.stringify(publicView)).not.toMatch(/password|token=|\/v1|old-secret/);
    expect(editor.base_url).toBe('https://provider.example/v1');
    expect(JSON.stringify(editor)).not.toMatch(/password|token=|old-secret/);
  });
});
