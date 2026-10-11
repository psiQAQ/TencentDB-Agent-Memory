const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { spawnSync, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const { installPlugin, loadConfig, checkConfiguredIdentity } = require('../pi-client.js');

async function main() {
  const cache = path.resolve(__dirname, '../../../workspace/pi-tests');
  fs.mkdirSync(cache, { recursive: true });
  const directory = fs.mkdtempSync(path.join(cache, 'https-'));
  const key = path.join(directory, 'test.key');
  const ca = path.join(directory, 'root.crt');
  const server = https.createServer();
  try {
    const openssl = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', ca,
      '-days', '1', '-subj', '/CN=localhost', '-addext', 'basicConstraints=critical,CA:TRUE',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { encoding: 'utf8' });
    assert.equal(openssl.status, 0, openssl.stderr);
    server.setSecureContext({ key: fs.readFileSync(key), cert: fs.readFileSync(ca) });
    const requests = [];
    let redirect = false;
    server.on('request', (request, response) => {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        requests.push(request.url);
        if (redirect) { response.writeHead(302, { location: '/redirect-target' }); response.end(); return; }
        if (request.url === '/prefix/proxy/health') {
          assert.equal(request.headers['x-tdai-user-key'], undefined);
          response.end('healthy'); return;
        }
        assert.equal(request.headers['x-tdai-service-id'], 'default');
        const body = JSON.parse(Buffer.concat(chunks).toString());
        let data;
        if (request.url === '/panel/api/v1/meta/auth/verify') {
          assert.equal(body.user_key, 'synthetic-business-key');
          data = { valid: true, user: { user_id: 'user-test' } };
        } else {
          assert.equal(request.headers['x-tdai-user-key'], 'synthetic-business-key');
          if (request.url === '/panel/api/v1/meta/team/list') data = { items: [{ team_id: 'team-test' }], total: 1 };
          else if (request.url === '/panel/api/v1/meta/agent/list') data = { items: [{ agent_id: 'agent-test' }], total: 1 };
          else { response.writeHead(404); response.end(); return; }
        }
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ code: 0, data }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const output = path.join(directory, 'export');
    await execute('python3', [path.resolve(__dirname, '../export.py'), '--proxy-url', `https://localhost:${port}/prefix/proxy`,
      '--panel-url', `https://127.0.0.1:${port}/panel`, '--instance-id', 'default', '--ca-file', ca, '--output', output]);
    await execute('python3', ['-c', 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])',
      path.join(output, 'pi-client-bundle.zip'), directory]);
    const bundle = path.join(directory, 'pi-client-bundle');
    const configFile = path.join(bundle, 'pi-client.jsonc');
    fs.writeFileSync(path.join(bundle, 'pi-user.key'), 'synthetic-business-key', { mode: 0o600 });
    const fakePi = path.join(directory, 'pi');
    fs.writeFileSync(fakePi, [
      '#!/usr/bin/env bash', 'set -eu',
      'if [[ "$1" == "--version" ]]; then echo "pi test-version"; exit 0; fi',
      'test "$TDAI_MEMORY_USER_KEY" = "synthetic-business-key"',
      'test "$TDAI_USER_KEY" = "$TDAI_MEMORY_USER_KEY"',
      'test "$TDAI_PROXY_BASE_URL" = "$TDAI_PROXY_URL"',
      'test "$1" = "--provider" && test "$2" = "tdai"',
      'test "$3" = "--model" && test "$4" = "test-model"',
      'echo PI_LAUNCH_READY', '',
    ].join('\n'), { mode: 0o755 });
    fs.writeFileSync(configFile, JSON.stringify({
      proxyUrl: `https://localhost:${port}/prefix/proxy`, panelUrl: `https://127.0.0.1:${port}/panel`,
      spaceId: 'default', teamId: 'team-test', agentId: 'agent-test', taskId: '', model: 'test-model',
      userKeyFile: './pi-user.key', pluginFile: './tdai-memory.ts', caFile: './root.crt',
      expectedCaSha256: new crypto.X509Certificate(fs.readFileSync(ca)).fingerprint256.replace(/:/g, ''), piCommand: fakePi,
    }));
    process.env.PI_CLIENT_HOME = path.join(directory, 'home');
    const config = loadConfig(configFile);
    installPlugin(config, false);
    const launcher = path.join(bundle, 'pi-client.js');
    const result = await execute(process.execPath, [launcher, 'check', '--config', configFile]);
    assert.match(result.stdout, /Pi Node TLS\/NO_PROXY/);
    assert.match(result.stdout, /业务|归属校验通过/);
    assert.equal(requests.filter((url) => url === '/prefix/proxy/health').length, 2);
    assert.ok(requests.includes('/panel/api/v1/meta/agent/list'));
    const launched = await execute(process.execPath, [launcher, 'run', '--config', configFile]);
    assert.match(launched.stdout, /PI_LAUNCH_READY/);
    redirect = true;
    await assert.rejects(checkConfiguredIdentity(config), /HTTP 302/);
    assert.ok(!requests.includes('/redirect-target'), 'business credentials must not follow redirects');
    console.log('Pi exported ZIP install/check/run passed with a CLI fixture: custom CA, separate hosts, path prefixes, identity and no redirects');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
