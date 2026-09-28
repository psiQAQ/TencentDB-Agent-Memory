import { expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../config.js';
import { createApp } from '../server.js';

vi.mock('node:dns/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:dns/promises')>(),
  lookup: async () => [{ address: '8.8.8.8', family: 4 }],
}));

vi.mock('node:https', async (importOriginal) => {
  const { EventEmitter } = await import('node:events');
  return {
    ...await importOriginal<typeof import('node:https')>(),
    request: (url: URL, _options: unknown, onResponse: (response: InstanceType<typeof EventEmitter>) => void) => {
      const req = new EventEmitter() as InstanceType<typeof EventEmitter> & {
        end: (body: string) => void;
        destroy: (error: Error) => void;
      };
      req.destroy = (error) => { req.emit('error', error); };
      req.end = (body) => {
        const input = JSON.parse(body) as {
          thinking?: { type: string }; reasoning?: { effort: string };
          max_tokens?: number; max_output_tokens?: number;
        };
        const finalText = (input.thinking?.type === 'disabled' || input.reasoning?.effort === 'none') &&
          (input.max_tokens ?? input.max_output_tokens ?? 0) >= 64;
        const response = Object.assign(new EventEmitter(), { statusCode: 200 });
        onResponse(response);
        const data = url.pathname.endsWith('/responses')
          ? { output: [{ content: [{ text: 'OK' }] }] }
          : url.pathname.endsWith('/messages')
            ? { content: finalText ? [{ type: 'text', text: 'OK' }] : [{ type: 'thinking', thinking: 'checking' }] }
            : { choices: [{ message: { content: finalText ? 'OK' : '', reasoning_content: finalText ? '' : 'checking' } }] };
        queueMicrotask(() => { response.emit('data', Buffer.from(JSON.stringify(data))); response.emit('end'); });
      };
      return req;
    },
  };
});

it('gets final text from DeepSeek across Chat, Responses and Anthropic probes', async () => {
  const config = {
    ...DEFAULT_CONFIG,
    upstream: { url: 'https://api.deepseek.com', apiKey: 'deployment-secret', agents: {} },
    coreSkill: { ...DEFAULT_CONFIG.coreSkill, serviceToken: 'service-secret' },
  };
  const response = await createApp(config).request('/internal/upstream/test', {
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'x-tdai-service-id': 'thinking-probe',
      authorization: 'Bearer service-secret',
    },
    body: JSON.stringify({
      agent_source: 'default', type: 'conversation', base_url: 'https://api.deepseek.com',
      model_id: 'deepseek-flash', credential_ref: 'deployment_default',
      protocols: ['chat', 'responses', 'anthropic'],
    }),
  });
  expect(response.status).toBe(200);
  const result = await response.json() as { results: Array<{ protocol: string; status: string }> };
  expect(result.results).toEqual([
    { protocol: 'chat', status: 'ready', httpStatus: 200 },
    { protocol: 'responses', status: 'ready', httpStatus: 200 },
    { protocol: 'anthropic', status: 'ready', httpStatus: 200 },
  ]);
});
