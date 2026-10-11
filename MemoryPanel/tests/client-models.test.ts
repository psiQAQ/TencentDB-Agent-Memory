import { describe, expect, it } from 'vitest';
import { resolveClientModels, type ConversationModelMetadata } from '../src/shared/client-models.js';
import { notifyModelConfigChanged, onModelConfigChanged } from '../web/src/lib/model-config-events.js';

describe('client model metadata', () => {
  const client = (assignment: NonNullable<ConversationModelMetadata['clients']>[number]['assignment'], agent_source = 'pi') =>
    ({ agent_source, display_name: agent_source, protocol: 'openai-chat', assignment });
  it('distinguishes absent deployment defaults, missing assignments and disabled groups', () => {
    const clients = [client({ enabled: true, mode: 'official' }), client(null),
      client({ enabled: false, mode: 'custom_unified', model_id: 'saved-model' }),
      client({ enabled: true, mode: 'custom_unified' })];
    expect(resolveClientModels({ clients })?.map((entry) => entry.status)).toEqual(['default_missing', 'unassigned', 'disabled', 'model_missing']);
    expect(resolveClientModels({ clients }, 'deployment-model')?.[0]).toMatchObject({ model_id: 'deployment-model', status: 'ready' });
  });
  it('checks subscription clients and does not export connection references or supplier keys', () => {
    const assignment = { enabled: true, mode: 'custom_unified', model_id: 'subscription-model', credential_kind: 'chatgpt_oauth',
      api_key: 'private-key', credential_ref: 'private-ref' };
    const result = resolveClientModels({ clients: [client(assignment), client(assignment, 'claude-code'),
      client({ ...assignment, credential_kind: 'api_key', mode: 'custom_passthrough' })] });
    expect(result?.map((entry) => entry.status)).toEqual(['ready', 'unsupported', 'client_credentials']);
    expect(JSON.stringify(result)).not.toMatch(/private-key|private-ref|assignment/);
  });
  it('refreshes only subscribers of the saved instance and removes listeners', () => {
    const target = new EventTarget();
    let calls = 0;
    const unsubscribe = onModelConfigChanged('instance-a', () => { calls++; }, target);
    notifyModelConfigChanged('instance-b', target); expect(calls).toBe(0);
    notifyModelConfigChanged('instance-a', target); expect(calls).toBe(1);
    unsubscribe(); notifyModelConfigChanged('instance-a', target); expect(calls).toBe(1);
  });
});
