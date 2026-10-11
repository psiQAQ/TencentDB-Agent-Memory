import { expect, it } from 'vitest';
import { buildPiBundleConfig } from '../web/src/pages/ApiKeysPage/pi-client-bundle-config.js';

it('builds backward compatible custom-CA configuration with the current model', () => {
  const value = JSON.parse(buildPiBundleConfig({ available: true, expectedCaSha256: 'A'.repeat(64) }, 'default', 'https://memory.home.arpa/proxy/', 'current-model'));
  expect(value).toMatchObject({ proxyUrl: 'https://memory.home.arpa/proxy', panelUrl: 'https://memory.home.arpa',
    caFile: './root.crt', expectedCaSha256: 'A'.repeat(64), model: 'current-model', userKeyFile: './pi-user.key' });
  expect(value).not.toHaveProperty('userKey');
});

it('uses the exported Panel prefix and omits CA fields for default trust', () => {
  const value = JSON.parse(buildPiBundleConfig({ available: true, proxyUrl: 'https://proxy.example:443/prefix/',
    panelUrl: 'https://panel.example/console' }, 'team-instance', 'https://proxy.example/prefix', 'assigned-model'));
  expect(value.panelUrl).toBe('https://panel.example/console');
  expect(value.spaceId).toBe('team-instance');
  expect(value).not.toHaveProperty('caFile');
  expect(value).not.toHaveProperty('expectedCaSha256');
});

it('refuses unavailable, HTTP, credential-bearing and mismatched endpoints', () => {
  expect(() => buildPiBundleConfig({ available: false, reason: 'missing' }, 'a', 'https://proxy.example', 'model')).toThrow('missing');
  for (const url of ['http://proxy.example', 'https://user:secret@proxy.example', 'https://proxy.example?query']) {
    expect(() => buildPiBundleConfig({ available: true }, 'a', url, 'model')).toThrow();
  }
  expect(() => buildPiBundleConfig({ available: true, proxyUrl: 'https://old.example' }, 'a', 'https://new.example', 'model')).toThrow('重新导出');
});
