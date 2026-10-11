#!/usr/bin/env node

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  installPlugin,
  installedPluginPath,
  loadConfig,
  mergeNoProxy,
  piEnvironment,
  sha256File,
} = require('../pi-client.js');

const cache = path.resolve(__dirname, '../../../workspace/pi-tests');
fs.mkdirSync(cache, { recursive: true });
const temporaryRoot = fs.mkdtempSync(path.join(cache, 'client-'));
process.on('exit', () => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
const certificate = path.join(temporaryRoot, 'root.crt');
const privateKey = path.join(temporaryRoot, 'test-root.key');
const plugin = path.join(temporaryRoot, 'tdai-memory.ts');
const userKey = path.join(temporaryRoot, 'pi-user.key');
const fakePi = path.join(temporaryRoot, 'pi');
const configFile = path.join(temporaryRoot, 'pi-client.jsonc');
const clientHome = path.join(temporaryRoot, 'pi-home');

const openssl = spawnSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
  '-keyout', privateKey, '-out', certificate, '-days', '1',
  '-subj', '/CN=Pi Client Test CA',
  '-addext', 'basicConstraints=critical,CA:TRUE',
], { encoding: 'utf8' });
assert.equal(openssl.status, 0, openssl.stderr);

fs.writeFileSync(plugin, 'export default function testPlugin() {}\n');
fs.writeFileSync(userKey, 'sk-mem-test-only\n', { mode: 0o600 });
fs.writeFileSync(fakePi, '#!/usr/bin/env bash\necho "pi 1.1.0"\n', { mode: 0o755 });

const x509 = new crypto.X509Certificate(fs.readFileSync(certificate));
const expectedCaSha256 = x509.fingerprint256.replace(/:/g, '');
fs.writeFileSync(configFile, `${JSON.stringify({
  proxyUrl: 'https://agent-memory.home.arpa/proxy',
  spaceId: 'default',
  teamId: 'team-test',
  agentId: 'agent-test',
  taskId: '',
  model: 'deepseek-flash',
  userKeyFile: './pi-user.key',
  caFile: './root.crt',
  expectedCaSha256,
  pluginFile: './tdai-memory.ts',
  piCommand: fakePi,
}, null, 2)}\n`);

process.env.PI_CLIENT_HOME = clientHome;
const config = loadConfig(configFile);
assert.equal(config.panelUrl, 'https://agent-memory.home.arpa');
assert.equal(config.proxyUrl, 'https://agent-memory.home.arpa/proxy');
assert.equal(config.userKey, 'sk-mem-test-only');
assert.equal(config.actualFingerprint, expectedCaSha256);
const customModel = JSON.parse(fs.readFileSync(configFile, 'utf8'));
customModel.model = 'local-custom-model';
fs.writeFileSync(configFile, `${JSON.stringify(customModel, null, 2)}\n`);
assert.equal(loadConfig(configFile).model, 'local-custom-model');
const installCommand = spawnSync(process.execPath, [path.resolve(__dirname, '../pi-client.js'), 'install', '--config', configFile], {
  encoding: 'utf8', env: { ...process.env, PI_CLIENT_HOME: clientHome },
});
assert.ifError(installCommand.error);
assert.equal(installCommand.status, 0, installCommand.stderr);
assert.ok(installCommand.stdout.includes('NEXT: node pi-client.js check'));
assert.ok(!installCommand.stdout.includes('HTTP 200'));

assert.equal(
  mergeNoProxy('localhost,127.0.0.1', 'agent-memory.home.arpa'),
  'localhost,127.0.0.1,agent-memory.home.arpa',
);
assert.equal(
  mergeNoProxy('AGENT-MEMORY.HOME.ARPA,.home.arpa', 'agent-memory.home.arpa'),
  'AGENT-MEMORY.HOME.ARPA,.home.arpa',
);
const previousNoProxy = process.env.NO_PROXY;
const previousLowerNoProxy = process.env.no_proxy;
process.env.NO_PROXY = 'localhost';
delete process.env.no_proxy;
const environment = piEnvironment(config);
assert.equal(environment.NO_PROXY, 'localhost,agent-memory.home.arpa');
assert.equal(environment.no_proxy, environment.NO_PROXY);
assert.equal(environment.NODE_EXTRA_CA_CERTS, certificate);
// Exercise the Bash expansion used by the proxy's injected memory recipes.
for (const inheritedValue of [undefined, 'stale-other-client']) {
  const names = ['TDAI_MEMORY_USER_KEY', 'TDAI_PROXY_BASE_URL'];
  const previous = names.map((name) => process.env[name]);
  try {
    for (const name of names) {
      if (inheritedValue === undefined) delete process.env[name];
      else process.env[name] = inheritedValue;
    }
    const recipeEnvironment = piEnvironment(config);
    const recipe = spawnSync('bash', ['-c', [
      ': "${TDAI_MEMORY_USER_KEY:?TDAI_MEMORY_USER_KEY is required}"',
      'test "$TDAI_MEMORY_USER_KEY" = "$TDAI_USER_KEY"',
      'test "$TDAI_PROXY_BASE_URL" = "$TDAI_PROXY_URL"',
    ].join(' && ')], { env: recipeEnvironment, encoding: 'utf8' });
    assert.ifError(recipe.error);
    assert.equal(recipe.status, 0, recipe.stderr || 'Memory recipe must use the configured identity and Proxy URL');
  } finally {
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
  }
}
if (previousNoProxy === undefined) delete process.env.NO_PROXY;
else process.env.NO_PROXY = previousNoProxy;
if (previousLowerNoProxy === undefined) delete process.env.no_proxy;
else process.env.no_proxy = previousLowerNoProxy;

installPlugin(config, false);
const installed = installedPluginPath();
assert.equal(installed, path.join(clientHome, 'extensions', 'tdai-memory.ts'));
assert.equal(sha256File(installed), sha256File(plugin));

// A second install with the same content must be idempotent.
installPlugin(config, false);
assert.equal(sha256File(installed), sha256File(plugin));

// Existing installations stay at their old path, without a second loaded copy.
const legacy = path.join(clientHome, 'extensions', 'tdai-memory-local-ds.ts');
fs.renameSync(installed, legacy);
installPlugin(config, false);
assert.equal(installedPluginPath(), legacy);
assert.equal(fs.existsSync(installed), false);
fs.copyFileSync(plugin, installed);
const duplicate = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.resolve(__dirname, '../pi-client.js'))}).installedPluginPath()`], {
  encoding: 'utf8', env: { ...process.env, PI_CLIENT_HOME: clientHome },
});
assert.equal(duplicate.status, 1);
assert.match(duplicate.stderr, /存在两份/);
fs.unlinkSync(installed);
fs.writeFileSync(plugin, 'export default function updatedPlugin() {}\n');
const replacement = spawnSync(process.execPath, [path.resolve(__dirname, '../pi-client.js'), 'install', '--config', configFile], { encoding: 'utf8' });
assert.equal(replacement.status, 1);
installPlugin(config, true);
assert.equal(sha256File(legacy), sha256File(plugin));
assert.equal(fs.readdirSync(path.dirname(legacy)).filter((name) => name.includes('.bak-')).length, 1);

// Default TLS and a separate Panel preserve arbitrary deployment prefixes.
const standard = { ...customModel, proxyUrl: 'https://memory.example.com:9443/team/proxy/', panelUrl: 'https://panel.example.com/console/' };
delete standard.caFile;
delete standard.expectedCaSha256;
fs.writeFileSync(configFile, JSON.stringify(standard));
const loadedStandard = loadConfig(configFile);
assert.equal(loadedStandard.proxyUrl, 'https://memory.example.com:9443/team/proxy');
assert.equal(loadedStandard.panelUrl, 'https://panel.example.com/console');
assert.equal(loadedStandard.caFile, undefined);
const { tlsOptions } = require('../pi-client.js');
assert.deepEqual(tlsOptions(loadedStandard), { rejectUnauthorized: true });
assert.ok(tlsOptions(config).ca.length > 1, 'custom CA supplements default trust');
process.env.NODE_EXTRA_CA_CERTS = certificate;
assert.equal(piEnvironment(loadedStandard).NODE_EXTRA_CA_CERTS, undefined);
delete process.env.NODE_EXTRA_CA_CERTS;
assert.ok(piEnvironment(loadedStandard).NO_PROXY.includes('panel.example.com'));
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
assert.equal(piEnvironment(loadedStandard).NODE_TLS_REJECT_UNAUTHORIZED, '1');
delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
delete standard.taskId;
fs.writeFileSync(configFile, JSON.stringify(standard));
assert.equal(loadConfig(configFile).taskId, '');

const invalid = [
  { proxyUrl: 'http://memory.example.com' },
  { proxyUrl: 'https://user:secret@example.com' },
  { proxyUrl: 'https://example.com/proxy?query=1' },
  { proxyUrl: 'https://example.com/proxy#fragment' },
  { panelUrl: 'http://panel.example.com' },
  { caFile: certificate },
  { expectedCaSha256 },
  { caFile: certificate, expectedCaSha256: '0'.repeat(64) },
  { model: 'replace-with-panel-pi-model' },
];
for (const patch of invalid) {
  fs.writeFileSync(configFile, JSON.stringify({ ...standard, ...patch }));
  const rejected = spawnSync(process.execPath, [path.resolve(__dirname, '../pi-client.js'), 'install', '--config', configFile], { encoding: 'utf8' });
  assert.equal(rejected.status, 1, `must reject ${Object.keys(patch).join(',')}`);
}

console.log('Pi client offline install tests passed');
