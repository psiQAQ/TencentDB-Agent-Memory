import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { InstanceRegistry } from '../src/panel/config/instance-registry.js';
import type { PanelDeps } from '../src/panel/panel-deps.js';
import { registerClientBundleRoutes } from '../src/panel/http/routes/client-bundle.js';

let directory: string;
let fixtures: string;
let archive: Buffer;
let metadata: Record<string, unknown>;
let modernMetadata: Record<string, unknown>;
beforeAll(async () => {
  await mkdir('node_modules/.cache', { recursive: true });
  fixtures = await mkdtemp('node_modules/.cache/pi-export-fixtures-');
  const certificate = resolve(fixtures, 'root.crt');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', resolve(fixtures, 'test.key'),
    '-out', certificate, '-days', '1', '-subj', '/CN=panel-test', '-addext', 'basicConstraints=critical,CA:TRUE'], { stdio: 'pipe' });
  for (const mode of ['custom', 'default']) {
    execFileSync('python3', [resolve('../clients/pi/export.py'), '--proxy-url', 'https://proxy.example/proxy',
      '--panel-url', 'https://panel.example/console', '--instance-id', 'a', '--output', resolve(fixtures, mode),
      ...(mode === 'custom' ? ['--ca-file', certificate] : [])], { stdio: 'pipe' });
  }
  archive = await readFile(join(fixtures, 'custom/pi-client-bundle.zip'));
  modernMetadata = JSON.parse(await readFile(join(fixtures, 'custom/download.json'), 'utf8'));
  const { proxyUrl: _proxy, panelUrl: _panel, ...legacy } = modernMetadata;
  metadata = legacy;
});
afterAll(async () => { if (fixtures) await rm(fixtures, { recursive: true, force: true }); });
beforeEach(async () => {
  await mkdir('node_modules/.cache', { recursive: true });
  directory = await mkdtemp('node_modules/.cache/pi-bundle-test-');
  await writeFile(join(directory, 'download.json'), JSON.stringify({ ...metadata, privateField: 'must-not-export' }));
  await writeFile(join(directory, 'pi-client-bundle.zip'), archive);
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

function app(valid = true, bundleDir: string | undefined = directory) {
  const api = new Hono();
  const invoke = vi.fn().mockResolvedValue({ code: 0, data: { valid } });
  registerClientBundleRoutes(api, {
    config: { clientBundleDir: bundleDir },
    instanceRegistry: new InstanceRegistry([{ instance_id: 'a', name: 'A', gateway_endpoint: 'http://core', proxy_endpoint: 'https://proxy.example/proxy', api_key: 'gateway-secret' },
      { instance_id: 'b', name: 'B', gateway_endpoint: 'http://core', api_key: 'other-secret' }]),
    metaKernel: { invoke },
  } as unknown as PanelDeps);
  return { api, invoke };
}
function request(api: Hono, body = {}, instance = 'a') {
  return api.request('/meta/client-bundle/pi', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tdai-service-id': instance, 'x-tdai-user-key': 'business-key' }, body: JSON.stringify(body) });
}

it('verifies business authentication and exports only public metadata until download is requested', async () => {
  const { api, invoke } = app();
  const result = await request(api);
  expect(result.headers.get('cache-control')).toBe('no-store');
  const json = await result.json();
  expect(json.data).toEqual({ available: true, ...metadata });
  expect(JSON.stringify(json)).not.toMatch(/secret|business-key|must-not-export|archiveBase64/);
  expect(invoke).toHaveBeenCalledWith('auth/verify', { user_key: 'business-key' }, expect.objectContaining({ instanceId: 'a' }));
  expect((await (await request(api, { download: true })).json()).data.archiveBase64).toBe(archive.toString('base64'));
});
it('rejects invalid credentials before accessing the bundle', async () => {
  expect((await request(app(false).api, { download: true })).status).toBe(401);
});
it('rejects arbitrary file requests', async () => {
  expect((await request(app().api, { download: true, path: '../private.key' })).status).toBe(400);
});
it('does not offer a bundle for a different instance or a deployment without an export', async () => {
  expect((await (await request(app().api, {}, 'b')).json()).data.available).toBe(false);
  expect((await (await request(app(true, '').api)).json()).data.available).toBe(false);
});
it('fails closed for missing or modified archives', async () => {
  await writeFile(join(directory, 'pi-client-bundle.zip'), 'modified');
  expect((await (await request(app().api, { download: true })).json()).data.available).toBe(false);
  await rm(join(directory, 'pi-client-bundle.zip'));
  expect((await (await request(app().api)).json()).data.available).toBe(false);
});

it('serves the actual independently exported default-trust ZIP and deployment addresses', async () => {
  const metadata = JSON.parse(await readFile(join(fixtures, 'default/download.json'), 'utf8'));
  const zip = await readFile(join(fixtures, 'default/pi-client-bundle.zip'));
  await writeFile(join(directory, 'download.json'), JSON.stringify(metadata));
  await writeFile(join(directory, 'pi-client-bundle.zip'), zip);
  const response = await request(app().api, { download: true });
  const { data } = await response.json();
  expect(data).toMatchObject({ available: true, proxyUrl: 'https://proxy.example/proxy', panelUrl: 'https://panel.example/console' });
  expect(data).not.toHaveProperty('expectedCaSha256');
  const downloaded = Buffer.from(data.archiveBase64, 'base64');
  expect(downloaded.equals(zip)).toBe(true);
  expect(createHash('sha256').update(downloaded).digest('hex')).toBe(data.archiveSha256);
});

it('rejects exports for a different public Proxy address and malformed deployment metadata', async () => {
  for (const changed of [
    { ...modernMetadata, proxyUrl: 'https://other.example/proxy' },
    { ...modernMetadata, panelUrl: 'http://panel.example' },
    { ...modernMetadata, panelUrl: undefined },
  ]) {
    await writeFile(join(directory, 'download.json'), JSON.stringify(changed));
    expect((await (await request(app().api, { download: true })).json()).data.available).toBe(false);
  }
});
