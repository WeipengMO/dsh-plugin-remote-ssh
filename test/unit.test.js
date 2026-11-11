import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { RemoteSshError, redactSecrets, throwIfAborted } from '../dist/errors.js';
import {
  VIRTUAL_NAMESPACE,
  encodeVirtualPath,
  encodeRemoteEnv,
  expandRemoteTilde,
  isValidEnvName,
  looksVirtual,
  parseVirtualPath,
  remoteContains,
  resolveRemotePath,
  shellQuote,
  virtualDirname,
  workspaceToken,
} from '../dist/paths.js';
import {
  expandUserPath,
  hostPatternMatches,
  resolveSshConfig,
} from '../dist/ssh-config.js';
import {
  HostKeyStore,
  keyTypeOf,
  knownHostsLine,
  sha256Fingerprint,
} from '../dist/known-hosts.js';
import { RemoteSshManager } from '../dist/manager.js';
import { registerManagementTools } from '../dist/tools.js';

const logger = { info() {}, warn() {}, error() {} };

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function keyBlob(type, data) {
  const name = Buffer.from(type, 'ascii');
  const head = Buffer.alloc(4);
  head.writeUInt32BE(name.length, 0);
  return Buffer.concat([head, name, Buffer.from(data, 'utf8')]);
}

const token = workspaceToken('connection-1', '/home/user/project');

test('workspace tokens are deterministic and namespaced', () => {
  assert.match(token, /^w[0-9a-f]{16}$/);
  assert.equal(workspaceToken('connection-1', '/home/user/project'), token);
  assert.notEqual(workspaceToken('connection-2', '/home/user/project'), token);
  assert.notEqual(workspaceToken('connection-1', '/home/user/other'), token);
});

test('virtual path encode/parse round trip in every supported spelling', () => {
  const encoded = encodeVirtualPath(token, '/home/user/project');
  assert.equal(looksVirtual(encoded), true);
  assert.equal(encoded.includes(VIRTUAL_NAMESPACE), true);
  assert.deepEqual(parseVirtualPath(encoded), { workspaceToken: token, remotePath: '/home/user/project' });

  // The POSIX spelling is always parseable, even on a Windows host.
  const posix = `/${VIRTUAL_NAMESPACE}/${token}/home/user/project`;
  assert.deepEqual(parseVirtualPath(posix), { workspaceToken: token, remotePath: '/home/user/project' });
  const unc = `//${VIRTUAL_NAMESPACE}/${token}/home/user/project`;
  assert.deepEqual(parseVirtualPath(unc), { workspaceToken: token, remotePath: '/home/user/project' });

  assert.equal(looksVirtual('/home/user/project'), false);
  assert.equal(looksVirtual(null), false);
  assert.equal(parseVirtualPath('/home/user/project'), null);
  assert.equal(parseVirtualPath(''), null);
  assert.throws(() => parseVirtualPath(`/${VIRTUAL_NAMESPACE}/not-a-token/home`), (error) => error.code === 'SSH_WORKSPACE_UNKNOWN');
  assert.throws(() => encodeVirtualPath('bad', '/home'), (error) => error.code === 'SSH_PATH_INVALID');
  assert.throws(() => encodeVirtualPath(token, 'home'), (error) => error.code === 'SSH_PATH_INVALID');
});

test('virtual paths normalize and reject unrepresentable segments', () => {
  assert.equal(parseVirtualPath(encodeVirtualPath(token, '/home/user/../user/project')).remotePath, '/home/user/project');
  assert.equal(parseVirtualPath(encodeVirtualPath(token, '/')).remotePath, '/');
  if (process.platform === 'win32') {
    assert.throws(
      () => encodeVirtualPath(token, '/home/user/bad:name'),
      (error) => error.code === 'SSH_PATH_UNREPRESENTABLE',
    );
  }
});

test('remote path resolution never falls back to local paths', () => {
  const cwd = '/home/user/project';
  const home = '/home/user';
  assert.equal(resolveRemotePath('main.py', cwd, home, token), '/home/user/project/main.py');
  assert.equal(resolveRemotePath('../shared/x.py', cwd, home, token), '/home/user/shared/x.py');
  assert.equal(resolveRemotePath('/etc/hosts', cwd, home, token), '/etc/hosts');
  assert.equal(resolveRemotePath('~/notes.txt', cwd, home, token), '/home/user/notes.txt');
  assert.equal(resolveRemotePath('~', cwd, home, token), '/home/user');
  assert.equal(
    resolveRemotePath(encodeVirtualPath(token, '/home/user/project/src/a.py'), cwd, home, token),
    '/home/user/project/src/a.py',
  );

  const other = workspaceToken('connection-2', '/srv');
  assert.throws(
    () => resolveRemotePath(encodeVirtualPath(other, '/srv/a.py'), cwd, home, token),
    (error) => error.code === 'SSH_PATH_INVALID' && /different remote workspace/.test(error.message),
  );
  assert.throws(
    () => resolveRemotePath('C:\\Users\\me\\file.txt', cwd, home, token),
    (error) => error.code === 'SSH_PATH_INVALID',
  );
  assert.throws(() => resolveRemotePath('   ', cwd, home, token), (error) => error.code === 'FS_NOT_FOUND');
  assert.throws(() => resolveRemotePath('a\0b', cwd, home, token), (error) => error.code === 'SSH_PATH_INVALID');
});

test('workspace containment and virtual dirname', () => {
  assert.equal(remoteContains('/home/user/project', '/home/user/project'), true);
  assert.equal(remoteContains('/home/user/project', '/home/user/project/src/a.py'), true);
  assert.equal(remoteContains('/home/user/project', '/home/user/project-other/a.py'), false);
  assert.equal(remoteContains('/home/user/project', '/home/user'), false);
  const child = encodeVirtualPath(token, '/home/user/project/src/a.py');
  assert.equal(virtualDirname(child), encodeVirtualPath(token, '/home/user/project/src'));
  assert.equal(virtualDirname('/local/path/file.txt'), path.dirname('/local/path/file.txt'));
});

test('shell quoting and environment encoding resist injection', () => {
  assert.equal(shellQuote('hello'), "'hello'");
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
  assert.equal(shellQuote('a\nb'), "'a\nb'");
  assert.equal(isValidEnvName('GOOD_NAME_1'), true);
  assert.equal(isValidEnvName('BAD-NAME'), false);
  assert.equal(isValidEnvName('1BAD'), false);
  assert.equal(isValidEnvName('BAD;rm -rf /'), false);
  assert.equal(
    encodeRemoteEnv({ GOOD: "a'b", 'BAD-NAME': 'ignored', SKIP: undefined, INJECT: "'; rm -rf /; '" }),
    `GOOD='a'\\''b' INJECT=''\\''; rm -rf /; '\\'''`,
  );
  assert.equal(encodeRemoteEnv(undefined), '');
  assert.equal(expandRemoteTilde('~/x', '/home/u'), '/home/u/x');
  assert.equal(expandRemoteTilde('~', '/home/u'), '/home/u');
  assert.equal(expandRemoteTilde('/abs', '/home/u'), '/abs');
});

test('error helpers redact secrets and map stable codes', () => {
  const fsError = new RemoteSshError('FS_NOT_FOUND', 'missing');
  assert.equal(fsError.name, 'FsError');
  assert.equal(fsError.code, 'FS_NOT_FOUND');
  assert.equal(new RemoteSshError('SSH_AUTH_FAILED', 'x').name, 'RemoteSshError');
  assert.equal(
    redactSecrets('-----BEGIN OPENSSH PRIVATE KEY-----\nSECRET\n-----END OPENSSH PRIVATE KEY-----\npassword=hunter2'),
    '[redacted private key]\npassword=[redacted]',
  );
  assert.equal(redactSecrets('Passphrase: abc'), 'Passphrase=[redacted]');
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => throwIfAborted(controller.signal, 'read'), (error) => error.code === 'FS_ABORTED');
  assert.doesNotThrow(() => throwIfAborted(undefined, 'read'));
});

test('ssh config resolution honours aliases, first-value-wins and stored overrides', (t) => {
  const dir = tempDir('dsh-remote-ssh-config-');
  const config = path.join(dir, 'config');
  fs.writeFileSync(
    config,
    [
      'Host devbox',
      '    HostName 192.168.1.50',
      '    User alice',
      '    Port 2201',
      '    IdentityFile ~/.ssh/dev_ed25519',
      '    ServerAliveInterval 30',
      '    HostName ignored.example', // first value wins
      'Host "prod-*" !prod-db',
      '    HostName %h.internal',
      '    User deploy',
      'Host jumpbox',
      '    ProxyJump bastion',
      '',
    ].join('\n'),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const resolved = resolveSshConfig({ host: 'devbox', configFile: config });
  assert.equal(resolved.alias, 'devbox');
  assert.equal(resolved.hostName, '192.168.1.50');
  assert.equal(resolved.user, 'alice');
  assert.equal(resolved.port, 2201);
  assert.equal(resolved.serverAliveIntervalSec, 30);
  assert.equal(resolved.identityFiles.length, 1);
  assert.match(resolved.identityFiles[0], /\.ssh[\\/]dev_ed25519$/);
  assert.equal(resolved.configPath, config);

  const overridden = resolveSshConfig({ host: 'devbox', configFile: config, port: 9999, user: 'bob', identityFile: 'C:/keys/explicit' });
  assert.equal(overridden.port, 9999);
  assert.equal(overridden.user, 'bob');
  assert.equal(overridden.identitiesOnly, true);
  assert.equal(overridden.identityFiles[0], path.normalize('C:/keys/explicit'));

  const wildcard = resolveSshConfig({ host: 'prod-web', configFile: config });
  assert.equal(wildcard.hostName, 'prod-web.internal');
  assert.equal(wildcard.user, 'deploy');
  assert.equal(resolveSshConfig({ host: 'prod-db', configFile: config }).hostName, 'prod-db');

  assert.throws(
    () => resolveSshConfig({ host: 'jumpbox', configFile: config }),
    (error) => error.code === 'SSH_PROXY_UNSUPPORTED',
  );
  assert.throws(
    () => resolveSshConfig({ host: '-oProxyCommand=evil', useSshConfig: false }),
    (error) => error.code === 'SSH_CONFIG_INVALID',
  );
  assert.throws(
    () => resolveSshConfig({ host: 'example.com', port: 0, useSshConfig: false }),
    (error) => error.code === 'SSH_CONFIG_INVALID',
  );
  assert.throws(
    () => resolveSshConfig({ host: '   ', useSshConfig: false }),
    (error) => error.code === 'SSH_CONFIG_INVALID',
  );

  const userHost = resolveSshConfig({ host: 'carol@10.0.0.9', useSshConfig: false });
  assert.equal(userHost.alias, '10.0.0.9');
  assert.equal(userHost.user, 'carol');
  assert.equal(userHost.port, 22);
  assert.deepEqual(userHost.identityFiles, []);

  // ssh-agent is on by default but can be disabled explicitly. It is a real
  // setting consumed by SshConnection.authCandidates(), not just stored state.
  assert.equal(resolveSshConfig({ host: 'example.com', useSshConfig: false }).useAgent, true);
  assert.equal(resolveSshConfig({ host: 'example.com', useSshConfig: false, useAgent: false }).useAgent, false);
  assert.equal(resolveSshConfig({ host: 'example.com', useSshConfig: false, useAgent: true }).useAgent, true);
  assert.equal(resolveSshConfig({ host: 'example.com', useSshConfig: false, identityAgent: 'none' }).identityAgent, undefined);
  assert.equal(resolveSshConfig({ host: 'example.com', useSshConfig: false, identityAgent: '~/.ssh/agent.sock' }).identityAgent, path.normalize(path.join(os.homedir(), '.ssh', 'agent.sock')));
});

test('host pattern matching supports wildcards and negation', () => {
  assert.equal(hostPatternMatches('prod-web', 'prod-*'), true);
  assert.equal(hostPatternMatches('prod-web', 'prod-?eb'), true);
  assert.equal(hostPatternMatches('prod-web', 'prod-*,!prod-web'), false);
  assert.equal(hostPatternMatches('prod-db', 'prod-*,!prod-web'), true);
  assert.equal(hostPatternMatches('devbox', 'prod-*'), false);
  assert.equal(hostPatternMatches('PROD-WEB', 'prod-*'), true);
});

test('expandUserPath expands home and environment variables', () => {
  assert.equal(expandUserPath('~'), path.normalize(os.homedir()));
  assert.equal(expandUserPath('~/x'), path.normalize(path.join(os.homedir(), 'x')));
  process.env.DSH_UNIT_VAR = 'expanded';
  assert.match(expandUserPath('${DSH_UNIT_VAR}/y'), /expanded[\\/]y$/);
  assert.match(expandUserPath('$DSH_UNIT_VAR/y'), /expanded[\\/]y$/);
  delete process.env.DSH_UNIT_VAR;
});

test('host key store is strict: unknown, trusted, mismatch, revoked', (t) => {
  const dir = tempDir('dsh-remote-ssh-hostkeys-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new HostKeyStore(dir, []);
  const good = keyBlob('ssh-ed25519', 'good-key-material');
  const evil = keyBlob('ssh-ed25519', 'evil-key-material');

  assert.equal(keyTypeOf(good), 'ssh-ed25519');
  assert.match(sha256Fingerprint(good), /^SHA256:[A-Za-z0-9+/]+$/);
  assert.equal(knownHostsLine('example.com', 22, good).split(' ')[0], 'example.com');
  assert.equal(knownHostsLine('example.com', 2222, good).split(' ')[0], '[example.com]:2222');

  const unknown = store.verify('example.com', 22, good);
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.trusted, false);
  assert.equal(unknown.keyBase64, good.toString('base64'));
  assert.match(unknown.fingerprint, /^SHA256:/);

  store.trust('example.com', 22, good, unknown.fingerprint);
  assert.equal(store.verify('example.com', 22, good).status, 'trusted');
  assert.equal(store.verify('example.com', 22, good).trusted, true);
  assert.equal(store.list().length, 1);
  const knownHosts = fs.readFileSync(store.knownHostsPath, 'utf8');
  assert.match(knownHosts, /^example\.com ssh-ed25519 /m);

  assert.throws(
    () => store.trust('example.com', 22, evil, unknown.fingerprint),
    (error) => error.code === 'SSH_HOST_KEY_MISMATCH',
  );
  const mismatch = store.verify('example.com', 22, evil);
  assert.equal(mismatch.status, 'mismatch');
  assert.equal(mismatch.trusted, false);
  assert.ok(mismatch.knownFingerprints.includes(unknown.fingerprint));

  // A different key for the same host is never trusted implicitly, and @revoked
  // entries are refused even when the key matches.
  const revokedFile = path.join(dir, 'revoked_hosts');
  fs.writeFileSync(revokedFile, `@revoked example.com ssh-ed25519 ${evil.toString('base64')}\n`);
  const revokedStore = new HostKeyStore(path.join(dir, 'second'), [revokedFile]);
  const revoked = revokedStore.verify('example.com', 22, evil);
  assert.equal(revoked.status, 'revoked');
  assert.equal(revoked.trusted, false);

  // Hashed |1| known_hosts entries must still match.
  const salt = Buffer.from('unit-test-salt');
  const field = '[example.com]:2222';
  const digest = createHmac('sha1', salt).update(field).digest('base64');
  const hashedFile = path.join(dir, 'hashed_hosts');
  fs.writeFileSync(hashedFile, `|1|${salt.toString('base64')}|${digest} ssh-ed25519 ${good.toString('base64')}\n`);
  const hashedStore = new HostKeyStore(path.join(dir, 'third'), [hashedFile]);
  assert.equal(hashedStore.verify('example.com', 2222, good).status, 'trusted');

  assert.equal(store.remove('example.com'), 1);
  assert.equal(store.list().length, 0);
  assert.equal(store.verify('example.com', 22, good).status, 'unknown');
});

test('management tools register valid definitions and perform host CRUD', async (t) => {
  const dir = tempDir('dsh-remote-ssh-tools-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manager = new RemoteSshManager({ storageDir: path.join(dir, 'state') }, logger);

  const definitions = new Map();
  const sections = [];
  const ctx = {
    tools: { register(definition) { definitions.set(definition.name, definition); return () => {}; } },
    workingDirectory: {
      get: () => '/local/workspace',
      set: async (_agent, value) => value,
      ensure: async () => '/local/workspace',
    },
    systemPrompt: { section(definition) { sections.push(definition); return () => {}; } },
    get: () => undefined,
    on: () => () => {},
  };
  const agent = { id: 'agent-1', session: { header: { cwd: '/local/workspace' } } };
  const invoke = async (name, args = {}) => {
    const definition = definitions.get(name);
    assert.ok(definition, `tool ${name} was registered`);
    return await definition.execute(args, { agent });
  };

  registerManagementTools(ctx, manager, {});
  assert.deepEqual(
    [...definitions.keys()].sort(),
    ['remote_ssh_hosts', 'remote_ssh_list_dir', 'remote_ssh_status', 'remote_ssh_test', 'remote_ssh_trust_host', 'remote_workspace_close', 'remote_workspace_open'].sort(),
  );
  assert.equal(sections.length, 1);
  assert.equal(typeof sections[0].text, 'function');
  assert.equal(sections[0].text({ agent }), ''); // local sessions spend no SSH prompt tokens
  assert.equal(sections[0].text({}), '');
  assert.equal(Number.isFinite(sections[0].order), true);

  // Every definition must satisfy DSH's raw JSON Schema subset and must not
  // reject extra keys in results (results are validated against output.schema).
  for (const [name, definition] of definitions) {
    assert.equal(typeof definition.name, 'string', name);
    assert.equal(typeof definition.description, 'string', name);
    assert.equal(typeof definition.execute, 'function', name);
    assert.equal(definition.parameters.type, 'object', name);
    assert.ok(Number.isFinite(definition.timeoutMs), name);
    if (definition.isConcurrencySafe !== undefined) assert.equal(typeof definition.isConcurrencySafe, 'function', name);
    const rendered = definition.output.render({}, { ok: true });
    assert.ok(Array.isArray(rendered) && rendered[0].type === 'text', name);
    const walk = (node, label) => {
      if (node === null || typeof node !== 'object') return;
      if ('additionalProperties' in node) {
        assert.notEqual(node.additionalProperties, false, `${name}.${label} would reject extra result keys`);
        assert.equal(typeof node.additionalProperties, 'boolean', `${name}.${label}`);
      }
      if ('type' in node) assert.equal(typeof node.type, 'string', `${name}.${label}`);
      if ('required' in node) assert.ok(Array.isArray(node.required), `${name}.${label}`);
      if ('items' in node) walk(node.items, `${label}.items`);
      if ('properties' in node) for (const [key, child] of Object.entries(node.properties)) walk(child, `${label}.properties.${key}`);
    };
    walk(definition.parameters, 'parameters');
    walk(definition.output.schema, 'output.schema');
  }

  assert.deepEqual(await invoke('remote_ssh_hosts', { action: 'list' }), { hosts: [] });
  const added = await invoke('remote_ssh_hosts', {
    action: 'add',
    host: '100.64.0.5',
    label: 'tailscale-box',
    user: 'dev',
    port: 2222,
    identityFile: '~/.ssh/id_ed25519',
  });
  assert.equal(added.host.label, 'tailscale-box');
  assert.equal(added.host.port, 2222);
  assert.equal(added.hosts.length, 1);
  assert.equal('privateKey' in added.host, false, 'private key material must never be returned');

  const updated = await invoke('remote_ssh_hosts', { action: 'update', id: added.host.id, label: 'renamed' });
  assert.equal(updated.host.label, 'renamed');
  const removed = await invoke('remote_ssh_hosts', { action: 'remove', id: added.host.id });
  assert.equal(removed.removed, added.host.id);
  assert.equal((await invoke('remote_ssh_hosts', { action: 'list' })).hosts.length, 0);

  await assert.rejects(
    () => invoke('remote_ssh_hosts', { action: 'remove', id: 'does-not-exist' }),
    (error) => error.code === 'SSH_HOST_NOT_FOUND',
  );

  const status = await invoke('remote_ssh_status');
  assert.equal(status.remote, false);
  assert.equal(status.currentCwd, '/local/workspace');
  assert.ok(Array.isArray(status.statuses));
  assert.ok(Array.isArray(status.recent));

  const closed = await invoke('remote_workspace_close');
  assert.equal(closed.closed, false);
  assert.match(closed.message, /already local/);

  // The approval path fails closed when no answerer is available.
  await assert.rejects(
    () => invoke('remote_ssh_trust_host', { host: 'nope', fingerprint: 'SHA256:x' }),
    (error) => error.code === 'SSH_HOST_NOT_FOUND',
  );
});

/**
 * When the extracted DSH reference modules are present, also validate tool
 * schemas and results with DSH's own JSON Schema implementation. This is a
 * best-effort integration check; the plugin itself has no runtime dependency
 * on the reference checkout.
 */
test('tool schemas pass DSH real schema validator when available', async (t) => {
  // Use DSH's standalone JSON Schema module. Its two runtime imports are not
  // present in the extracted reference checkout, so provide a faithful shim
  // and load the real validator source verbatim.
  const reference = path.resolve('..', '.dsh-checkout', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'types', 'json-schema.js');
  if (!fs.existsSync(reference)) {
    t.skip('DSH reference checkout not available');
    return;
  }
  const shimDir = tempDir('dsh-remote-ssh-shim-');
  t.after(() => fs.rmSync(shimDir, { recursive: true, force: true }));
  const shimPath = path.join(shimDir, 'shim.mjs');
  fs.writeFileSync(
    shimPath,
    [
      'export class HarnessError extends Error { constructor(message, options) { super(message, options); this.name = new.target.name; } }',
      'export function assertNever(value, label) { throw new Error(`unexpected ${label}: ${String(value)}`); }',
      'export function isJsonValue(value) {',
      '  if (value === null) return true;',
      '  const kind = typeof value;',
      '  if (kind === "string" || kind === "boolean") return true;',
      '  if (kind === "number") return Number.isFinite(value) && !Object.is(value, -0);',
      '  if (kind !== "object") return false;',
      '  if (Array.isArray(value)) {',
      '    for (let i = 0; i < value.length; i += 1) if (!(i in value) || !isJsonValue(value[i])) return false;',
      '    return true;',
      '  }',
      '  const proto = Object.getPrototypeOf(value);',
      '  if (proto !== Object.prototype && proto !== null) return false;',
      '  for (const child of Object.values(value)) if (!isJsonValue(child)) return false;',
      '  return true;',
      '}',
      '',
    ].join('\n'),
  );
  const source = fs
    .readFileSync(reference, 'utf8')
    .replace(/^import .*from '@deepseek-ai\/dsh-llm';$/m, "import { HarnessError } from './shim.mjs';")
    .replace(/^import .*from '@deepseek-ai\/dsh-util-values';$/m, "import { assertNever, isJsonValue } from './shim.mjs';");
  const modulePath = path.join(shimDir, 'schema.mjs');
  fs.writeFileSync(modulePath, source);
  const { assertSupportedJsonSchema, validateJsonSchemaValue } = await import(pathToFileURL(modulePath).href);
  const dir = tempDir('dsh-remote-ssh-schema-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manager = new RemoteSshManager({ storageDir: path.join(dir, 'state') }, logger);
  const definitions = new Map();
  const ctx = {
    tools: { register(definition) { definitions.set(definition.name, definition); } },
    workingDirectory: { get: () => '/local', set: async (_a, v) => v, ensure: async () => '/local' },
    systemPrompt: { section: () => {} },
    get: () => undefined,
    on: () => () => {},
  };
  registerManagementTools(ctx, manager, {});
  for (const [name, definition] of definitions) {
    assert.doesNotThrow(() => assertSupportedJsonSchema(definition.output.schema), `${name}.output.schema`);
    assert.doesNotThrow(() => assertSupportedJsonSchema(definition.parameters), `${name}.parameters`);
    assert.deepEqual(validateJsonSchemaValue(definition.output.schema, { ok: true, extra: 1 }, 'value'), [], `${name} result with extra keys`);
  }
});
