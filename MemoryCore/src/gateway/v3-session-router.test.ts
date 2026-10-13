import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalStorageBackend } from '../core/storage/local-backend.js';
import { StorageAdapter } from '../core/storage/adapter.js';
import { handleV3SessionRoute } from './v3-session-router.js';

describe('session HTTP route with local storage', () => {
  let server: Server;
  let root: string;
  let base: string;
  const body = {
    source: 'online', started_at: '2026-10-13T00:00:00.000Z', ended_at: '2026-10-13T00:00:01.000Z',
    user_query: 'synthetic question', model: 'synthetic-model',
    messages: [{ role: 'user', content: 'synthetic question' }],
    output: { role: 'assistant', content: 'synthetic answer' },
  };
  const headers = {
    'content-type': 'application/json', 'x-tdai-service-id': 'instance-a',
    'x-tdai-user-id': 'user-a', 'x-tdai-session-id': 'session-a', 'x-tdai-team-id': 'team-a',
  };
  beforeAll(async () => {
    await mkdir('node_modules/.cache', { recursive: true });
    root = await mkdtemp('node_modules/.cache/session-route-');
    server = createServer(async (req, res) => {
      await handleV3SessionRoute(req, res, req.url!, req.method!, async (request) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        return JSON.parse(Buffer.concat(chunks).toString());
      }, (response, status, data) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(data));
      }, {
        resolveStorage: async (instance) => new StorageAdapter(new LocalStorageBackend(join(root, instance))),
        logger: { info() {}, warn() {}, error() {} },
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test listener');
    base = `http://127.0.0.1:${address.port}/v3/session/add`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });
  it('persists records under each request instance and header identity', async () => {
    for (const instance of ['instance-a', 'instance-b']) {
      const response = await fetch(base, { method: 'POST', headers: { ...headers, 'x-tdai-service-id': instance }, body: JSON.stringify(body) });
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.data.object_key).toContain('sessions/online/team-a/user-a/session-a/');
      const saved = JSON.parse(await readFile(join(root, instance, result.data.object_key), 'utf8'));
      expect(saved.messages).toEqual(body.messages);
      expect(saved.output).toEqual(body.output);
    }
  });
  it.each(['../other', '.', '..', 'team/other'])('rejects path-segment identity %s', async (team) => {
    const response = await fetch(base, { method: 'POST', headers: { ...headers, 'x-tdai-team-id': team }, body: JSON.stringify(body) });
    expect(response.status).toBe(400);
  });
  it('rejects missing identity and body identity overrides', async () => {
    const missing = { ...headers };
    delete (missing as Partial<typeof headers>)['x-tdai-user-id'];
    expect((await fetch(base, { method: 'POST', headers: missing, body: JSON.stringify(body) })).status).toBe(400);
    expect((await fetch(base, { method: 'POST', headers, body: JSON.stringify({ ...body, user: 'other' }) })).status).toBe(422);
  });
});
