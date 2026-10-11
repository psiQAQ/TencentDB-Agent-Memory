#!/usr/bin/env node
// Cross-platform Pi client installer, connectivity check, and secure launcher.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const tls = require('node:tls');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

function fail(message) {
  process.stderr.write(`ERROR: ${message}\n`);
  process.exit(1);
}

function usage() {
  process.stdout.write(`Usage:
  node pi-client.js install --config FILE [--replace]
  node pi-client.js check   --config FILE
  node pi-client.js run     --config FILE [-- PI_ARGS...]
  node pi-client.js smoke   --config FILE --prompt TEXT

install  安装 Pi extension；不同版本已存在时需显式 --replace。
check    核对配置、Key、TLS、插件和 Pi，检查 HTTPS 和业务身份；不调用 LLM。
run      安全读取 Key 后启动交互式 Pi；额外 Pi 参数放在 -- 之后。
smoke    发起一次真实 Pi/LLM 请求，仅在明确允许外部请求时执行。
`);
}

function mergeNoProxy(value, ...hostnames) {
  const entries = String(value || '')
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const normalized = new Set(entries.map((entry) => entry.toLowerCase()));
  for (const required of hostnames) {
    if (!normalized.has(required.toLowerCase())) {
      entries.push(required);
      normalized.add(required.toLowerCase());
    }
  }
  return entries.join(',');
}

function parseArgs(argv) {
  const action = argv.shift();
  if (action === '-h' || action === '--help') {
    usage();
    process.exit(0);
  }
  if (!['install', 'check', 'run', 'smoke'].includes(action)) {
    usage();
    process.exit(action ? 2 : 0);
  }
  let configFile = '';
  let prompt = '';
  let replace = false;
  let passthrough = [];
  while (argv.length > 0) {
    const argument = argv.shift();
    if (argument === '--config') configFile = argv.shift() || '';
    else if (argument === '--prompt') prompt = argv.shift() || '';
    else if (argument === '--replace') replace = true;
    else if (argument === '--') {
      passthrough = argv.splice(0);
      break;
    } else if (argument === '-h' || argument === '--help') {
      usage();
      process.exit(0);
    } else fail(`未知参数：${argument}`);
  }
  if (!configFile) fail('缺少 --config FILE');
  if (action === 'smoke' && !prompt) fail('smoke 缺少 --prompt TEXT');
  return { action, configFile, prompt, replace, passthrough };
}

function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(text);
  } catch (error) {
    fail(`配置文件读取失败：${file}；${error.message}`);
  }
}

function requiredString(config, key, allowEmpty = false) {
  const value = config[key];
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || /[\0\r\n]/.test(value)) {
    fail(`配置字段 ${key} 无效`);
  }
  return value.trim();
}

function safeIdentity(value, key, allowEmpty = false) {
  if (allowEmpty && value === '') return value;
  if (/^replace-with-/i.test(value)) fail(`配置字段 ${key} 仍是模板占位值`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    fail(`配置字段 ${key} 只能包含字母、数字、点、下划线、冒号和连字符`);
  }
  return value;
}

function resolveFile(configDirectory, value, key) {
  const resolved = path.resolve(configDirectory, value);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    fail(`${key} 文件不存在：${resolved}`);
  }
  if (!stat.isFile()) fail(`${key} 不是普通文件：${resolved}`);
  return resolved;
}

function normalizeFingerprint(value) {
  return value.replace(/[:\s]/g, '').toUpperCase();
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function normalizeHttpsUrl(value, name) {
  if (typeof value !== 'string' || !value || /[\s\\?#]/.test(value)) {
    throw new Error(`${name} 必须是 HTTPS 基地址，不能包含空白、查询或 fragment`);
  }
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} 不是合法 URL`); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) {
    throw new Error(`${name} 必须使用 HTTPS，且不能包含凭据`);
  }
  return url.toString().replace(/\/+$/, '');
}

function publicCertificate(file) {
  const pem = fs.readFileSync(file, 'utf8');
  if (!/^\s*-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/.test(pem)) {
    throw new Error('caFile 必须只包含一张公开 CA certificate');
  }
  const certificate = new crypto.X509Certificate(pem);
  if (!certificate.ca) throw new Error('caFile 不是 CA certificate');
  return { pem, fingerprint: normalizeFingerprint(certificate.fingerprint256) };
}

function tlsOptions(config) {
  if (!config.caFile) return { rejectUnauthorized: true };
  const roots = typeof tls.getCACertificates === 'function' ? tls.getCACertificates('default') : tls.rootCertificates;
  return { rejectUnauthorized: true, ca: [...roots, publicCertificate(config.caFile).pem] };
}

function reportTrust(config) {
  process.stdout.write(config.caFile
    ? `PASS: CA SHA-256 -> ${config.actualFingerprint}\n`
    : 'PASS: TLS 使用运行时默认信任\n');
}

function loadConfig(configFile) {
  const absoluteConfig = path.resolve(configFile);
  const directory = path.dirname(absoluteConfig);
  const raw = readJson(absoluteConfig);
  if (/^replace-with-/i.test(raw.model || '')) fail('model 仍是占位值，请复制 Panel 当前 Pi 客户端包配置');
  const proxyUrl = normalizeHttpsUrl(requiredString(raw, 'proxyUrl'), 'proxyUrl');
  const panelUrl = normalizeHttpsUrl(raw.panelUrl ?? new URL(proxyUrl).origin, 'panelUrl');
  if ((raw.caFile !== undefined) !== (raw.expectedCaSha256 !== undefined)) {
    fail('caFile 和 expectedCaSha256 必须同时提供或同时省略');
  }
  let caFile, expectedCaSha256, actualFingerprint;
  if (raw.caFile !== undefined) {
    caFile = resolveFile(directory, requiredString(raw, 'caFile'), 'caFile');
    expectedCaSha256 = normalizeFingerprint(requiredString(raw, 'expectedCaSha256'));
    if (!/^[A-F0-9]{64}$/.test(expectedCaSha256)) fail('expectedCaSha256 必须是 64 位十六进制指纹');
    actualFingerprint = publicCertificate(caFile).fingerprint;
    if (actualFingerprint !== expectedCaSha256) fail('CA SHA-256 不匹配');
  }

  const config = {
    configFile: absoluteConfig,
    proxyUrl,
    panelUrl,
    spaceId: safeIdentity(requiredString(raw, 'spaceId'), 'spaceId'),
    teamId: safeIdentity(requiredString(raw, 'teamId'), 'teamId'),
    agentId: safeIdentity(requiredString(raw, 'agentId'), 'agentId'),
    taskId: safeIdentity(raw.taskId === undefined ? '' : requiredString(raw, 'taskId', true), 'taskId', true),
    model: requiredString(raw, 'model'),
    expectedCaSha256,
    actualFingerprint,
    userKeyFile: resolveFile(directory, requiredString(raw, 'userKeyFile'), 'userKeyFile'),
    caFile,
    pluginFile: resolveFile(directory, requiredString(raw, 'pluginFile'), 'pluginFile'),
    piCommand: requiredString(raw, 'piCommand'),
  };
  const userKey = fs.readFileSync(config.userKeyFile, 'utf8').trim();
  if (!userKey || /\s/.test(userKey)) fail('userKeyFile 必须只包含一行非空业务 user_key');
  if (process.platform !== 'win32') {
    const mode = fs.statSync(config.userKeyFile).mode & 0o777;
    if ((mode & 0o077) !== 0) fail(`userKeyFile 权限过宽：${mode.toString(8)}；请执行 chmod 600`);
  }
  config.userKey = userKey;
  return config;
}

function clientHome() {
  return path.resolve(process.env.PI_CLIENT_HOME || path.join(os.homedir(), '.pi', 'agent'));
}

function installedPluginPath() {
  const directory = path.join(clientHome(), 'extensions');
  const current = path.join(directory, 'tdai-memory.ts');
  const legacy = path.join(directory, 'tdai-memory-local-ds.ts');
  if (fs.existsSync(current) && fs.existsSync(legacy)) {
    fail(`存在两份 Pi extension，请先核对并只保留一份：${current}；${legacy}`);
  }
  return fs.existsSync(legacy) ? legacy : current;
}

function checkPiCommand(command) {
  let executable = command;
  let argsPrefix = [];
  if (process.platform === 'win32') {
    let resolved = command;
    if (!path.isAbsolute(command)) {
      const lookupName = command === 'pi' ? 'pi.cmd' : command;
      const lookup = spawnSync('where.exe', [lookupName], {
        encoding: 'utf8',
        windowsHide: true,
      });
      resolved = lookup.status === 0
        ? String(lookup.stdout).split(/\r?\n/).find(Boolean) || lookupName
        : lookupName;
    }
    if (/\.cmd$/i.test(resolved)) {
      const cliFile = path.join(
        path.dirname(resolved),
        'node_modules',
        '@earendil-works',
        'pi-coding-agent',
        'dist',
        'bundle',
        'cli.js',
      );
      if (!fs.existsSync(cliFile)) {
        fail(`无法从 npm Windows shim 定位 Pi CLI：${cliFile}`);
      }
      executable = process.execPath;
      argsPrefix = [cliFile];
    } else {
      executable = resolved;
    }
  }
  const result = spawnSync(executable, [...argsPrefix, '--version'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    fail(`Pi 命令不可用：${command}；请先安装 @earendil-works/pi-coding-agent`);
  }
  const version = `${result.stdout || result.stderr}`.trim().split(/\r?\n/, 1)[0];
  process.stdout.write(`PASS: Pi command -> ${version || command}\n`);
  return { executable, argsPrefix };
}

function verifyInstalledPlugin(config) {
  const destination = installedPluginPath();
  if (!fs.existsSync(destination)) fail(`Pi extension 尚未安装：${destination}`);
  if (sha256File(destination) !== sha256File(config.pluginFile)) {
    fail('已安装 Pi extension 与客户端包中的插件不一致；请重新 install --replace');
  }
  process.stdout.write(`PASS: Pi extension -> ${destination}\n`);
  return destination;
}

function checkHttps(config) {
  const healthUrl = new URL(`${config.proxyUrl}/health`);
  return new Promise((resolve, reject) => {
    const request = https.get(healthUrl, {
      ...tlsOptions(config),
      agent: false,
      timeout: 15000,
    }, (response) => {
      response.resume();
      response.on('end', () => {
        if (response.statusCode !== 200) reject(new Error(`HTTP ${response.statusCode}（期望 200）`));
        else resolve();
      });
    });
    request.on('timeout', () => request.destroy(new Error('连接超时')));
    request.on('error', reject);
  });
}

function postPanelMeta(config, action, body, includeUserKey) {
  const url = new URL(`${config.panelUrl}/api/v1/meta/${action}`);
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  const headers = {
    'content-type': 'application/json',
    'content-length': String(payload.length),
    'x-tdai-service-id': config.spaceId,
  };
  if (includeUserKey) headers['x-tdai-user-key'] = config.userKey;

  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: 'POST',
      headers,
      ...tlsOptions(config),
      agent: false,
      timeout: 15000,
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) {
          request.destroy(new Error('响应超过 2 MiB 上限'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
          reject(new Error(`${action} 返回 HTTP ${response.statusCode}`));
          return;
        }
        try {
          const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (envelope?.code !== 0 || envelope.data === null || envelope.data === undefined) {
            reject(new Error(`${action} 返回业务错误 ${String(envelope?.code ?? 'unknown')}`));
            return;
          }
          resolve(envelope.data);
        } catch (error) {
          reject(new Error(`${action} 响应不是有效 JSON：${error.message}`));
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error(`${action} 连接超时`)));
    request.on('error', reject);
    request.end(payload);
  });
}

async function listPanelMeta(config, action, body) {
  const items = [];
  const limit = 100;
  for (let offset = 0; offset < 10000; offset += limit) {
    const page = await postPanelMeta(config, action, { ...body, limit, offset }, true);
    const batch = Array.isArray(page?.items) ? page.items : [];
    items.push(...batch);
    const total = Number.isSafeInteger(page?.total) ? page.total : undefined;
    if (batch.length === 0 || (total !== undefined && offset + limit >= total)) break;
  }
  return items;
}

function availableIds(items, idKey, nameKey) {
  if (items.length === 0) return '无';
  return items.slice(0, 20).map((item) => {
    const id = typeof item?.[idKey] === 'string' ? item[idKey] : '?';
    const name = typeof item?.[nameKey] === 'string' ? item[nameKey] : '';
    return name ? `${name} (${id})` : id;
  }).join(', ');
}

async function checkConfiguredIdentity(config) {
  const verified = await postPanelMeta(
    config,
    'auth/verify',
    { user_key: config.userKey },
    false,
  );
  const userId = verified?.valid === true && typeof verified?.user?.user_id === 'string'
    ? verified.user.user_id
    : '';
  if (!userId) throw new Error('业务 user_key 无效、已撤销或没有返回 user_id');

  const teams = await listPanelMeta(config, 'team/list', { user_id: userId });
  const team = teams.find((item) => item?.team_id === config.teamId);
  if (!team) {
    throw new Error(
      `teamId=${config.teamId} 不属于当前 user_key；可用 Team：${availableIds(teams, 'team_id', 'name')}`,
    );
  }

  const agents = await listPanelMeta(config, 'agent/list', {
    team_id: config.teamId,
    owner_user_id: userId,
    status: 'active',
  });
  const agent = agents.find((item) => item?.agent_id === config.agentId);
  if (!agent) {
    throw new Error(
      `agentId=${config.agentId} 不是当前用户在该 Team 中自己创建的 active Agent；可用 Agent：${availableIds(agents, 'agent_id', 'name')}`,
    );
  }

  process.stdout.write('PASS: user_key / teamId / agentId 归属校验通过\n');
}

function installPlugin(config, replace) {
  checkPiCommand(config.piCommand);
  const destination = installedPluginPath();
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  if (fs.existsSync(destination)) {
    if (sha256File(destination) === sha256File(config.pluginFile)) {
      process.stdout.write(`SKIP: Pi extension 已是当前版本 -> ${destination}\n`);
      return;
    }
    if (!replace) fail(`不同版本 extension 已存在：${destination}；确认后追加 --replace`);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${destination}.bak-${timestamp}`;
    fs.copyFileSync(destination, backup);
    process.stdout.write(`INFO: 旧 extension 已备份到 ${backup}\n`);
  }
  const temporary = `${destination}.tmp-${process.pid}`;
  fs.copyFileSync(config.pluginFile, temporary);
  fs.chmodSync(temporary, 0o644);
  fs.renameSync(temporary, destination);
  process.stdout.write(`PASS: 已安装 Pi extension -> ${destination}\n`);
}

function piEnvironment(config) {
  const proxyHostname = new URL(config.proxyUrl).hostname;
  // Both the launcher and Pi connect directly to the configured service hosts.
  const noProxy = mergeNoProxy(
    process.env.NO_PROXY || process.env.no_proxy || '',
    proxyHostname,
    new URL(config.panelUrl).hostname,
  );
  const environment = {
    ...process.env,
    NODE_TLS_REJECT_UNAUTHORIZED: '1',
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    TDAI_PROXY_URL: config.proxyUrl,
    TDAI_PROXY_BASE_URL: config.proxyUrl,
    TDAI_SPACE_ID: config.spaceId,
    TDAI_AGENT_SOURCE: 'pi',
    TDAI_TEAM_ID: config.teamId,
    TDAI_AGENT_ID: config.agentId,
    TDAI_USER_KEY: config.userKey,
    TDAI_MEMORY_USER_KEY: config.userKey,
    TDAI_MODEL: config.model,
  };
  if (config.caFile) environment.NODE_EXTRA_CA_CERTS = config.caFile;
  else delete environment.NODE_EXTRA_CA_CERTS;
  if (config.taskId) environment.TDAI_TASK_ID = config.taskId;
  else delete environment.TDAI_TASK_ID;
  return environment;
}

function checkPiNodeHttps(config) {
  const healthUrl = `${config.proxyUrl}/health`;
  const environment = piEnvironment(config);
  // The probe does not authenticate and must not receive the business key.
  delete environment.TDAI_USER_KEY;
  delete environment.TDAI_MEMORY_USER_KEY;
  const probe = [
    "const https = require('node:https');",
    "const request = https.get(process.argv[1], { agent: false }, (response) => {",
    "  response.resume();",
    "  response.on('end', () => process.exit(response.statusCode === 200 ? 0 : 2));",
    "});",
    "request.setTimeout(15000, () => request.destroy(new Error('timeout')));",
    "request.on('error', (error) => { console.error(error.code || error.message); process.exit(3); });",
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', probe, healthUrl], {
    env: environment,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20000,
  });
  if (result.error) {
    fail(`Pi Node HTTPS 环境检查失败：${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = `${result.stderr || result.stdout || `exit ${result.status}`}`.trim();
    fail(`Pi Node HTTPS 环境检查失败：${detail}`);
  }
  process.stdout.write(`PASS: Pi Node TLS/NO_PROXY -> ${healthUrl}\n`);
}

async function check(config) {
  checkPiCommand(config.piCommand);
  verifyInstalledPlugin(config);
  reportTrust(config);
  try {
    await checkHttps(config);
  } catch (error) {
    fail(`Proxy HTTPS health 检查失败：${error.message}`);
  }
  process.stdout.write(`PASS: ${config.proxyUrl}/health -> HTTP 200\n`);
  checkPiNodeHttps(config);
  try {
    await checkConfiguredIdentity(config);
  } catch (error) {
    fail(`Pi 业务身份检查失败：${error.message}`);
  }
  process.stdout.write('PASS: Pi 客户端配置检查完成；未发起 LLM 请求\n');
}

function runPi(config, command, args) {
  const child = spawn(command.executable, [...command.argsPrefix, ...args], {
    env: piEnvironment(config),
    stdio: 'inherit',
    windowsHide: false,
  });
  child.on('error', (error) => fail(`Pi 启动失败：${error.message}`));
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 22) fail('Pi 客户端需要 Node.js 22+');
  const options = parseArgs(process.argv.slice(2));
  const config = loadConfig(options.configFile);
  if (options.action === 'install') {
    installPlugin(config, options.replace);
    verifyInstalledPlugin(config);
    reportTrust(config);
    // Installation is local. The explicit check command verifies HTTPS and identity.
    process.stdout.write(`NEXT: node pi-client.js check --config "${config.configFile}"\n`);
    process.stdout.write(`NEXT: node pi-client.js run --config "${config.configFile}"\n`);
    return;
  }
  if (options.action === 'check') {
    await check(config);
    return;
  }

  const command = checkPiCommand(config.piCommand);
  verifyInstalledPlugin(config);
  try {
    await checkConfiguredIdentity(config);
  } catch (error) {
    fail(`Pi 业务身份检查失败：${error.message}`);
  }
  if (options.action === 'run') {
    runPi(config, command, ['--provider', 'tdai', '--model', config.model, ...options.passthrough]);
  } else {
    runPi(config, command, [
      '--print', '--no-session', '--no-context-files', '--no-skills',
      '--no-prompt-templates', '--no-approve', '--provider', 'tdai',
      '--model', config.model, '--mode', 'json', options.prompt,
    ]);
  }
}

module.exports = {
  checkConfiguredIdentity,
  normalizeHttpsUrl,
  publicCertificate,
  tlsOptions,
  installPlugin,
  installedPluginPath,
  loadConfig,
  mergeNoProxy,
  piEnvironment,
  normalizeFingerprint,
  sha256File,
};

if (require.main === module) {
  main().catch((error) => fail(error.stack || error.message));
}
