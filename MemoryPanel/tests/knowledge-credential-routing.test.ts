import { afterEach, describe, expect, it, vi } from 'vitest';

import { HttpKnowledgeClient } from '../src/panel/kernel/adapters/http-knowledge-client.js';

afterEach(() => vi.unstubAllGlobals());

describe('HttpKnowledgeClient credential routing', () => {
  it('uses the lifecycle credential only for delete and ownership operations', async () => {
    const calls: Array<{ path: string; authorization: string | null }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({
        path: new URL(url).pathname,
        authorization: new Headers(init.headers).get('authorization'),
      });
      return new Response(JSON.stringify({ code: 0, data: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));

    const client = new HttpKnowledgeClient({
      baseUrl: 'http://localhost:8421',
      authToken: 'service-key',
      lifecycleAuthToken: 'lifecycle-key',
      serviceId: 'default',
    });
    await client.wikiIngest('wiki-1');
    await client.wikiDelete(['wiki-1']);
    await client.wikiRawRm('team-1', 'wiki-1', ['source.md']);
    await client.wikiPageRm('team-1', 'wiki-1', ['page-1']);
    await client.codeGraphDelete(['graph-1']);
    await client.transferOwnership({ resource_type: 'llm_wiki', resource_id: 'wiki-1',
      from_owner_user_id: 'old', to_owner_user_id: 'new' });
    await client.listIntegrityInventory();

    expect(calls).toEqual([
      { path: '/v3/wiki/ingest', authorization: 'Bearer service-key' },
      { path: '/v3/wiki/delete', authorization: 'Bearer lifecycle-key' },
      { path: '/v3/wiki/raw/rm', authorization: 'Bearer lifecycle-key' },
      { path: '/v3/wiki/page/rm', authorization: 'Bearer lifecycle-key' },
      { path: '/v3/code-graph/delete', authorization: 'Bearer lifecycle-key' },
      { path: '/v3/internal/lifecycle/ownership/transfer', authorization: 'Bearer lifecycle-key' },
      { path: '/v3/internal/lifecycle/integrity/inventory', authorization: 'Bearer lifecycle-key' },
    ]);
  });
});
