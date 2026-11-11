import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { agentFromCreatedEvent, createNativeHttpHandler } from '../dist/http-api.js';
import { encodeVirtualPath, workspaceToken } from '../dist/paths.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// This matters much more than rendering a disconnected demo HTML page.
test('official DSH package publishes built native web bundle and profile patch', () => {
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.equal(manifest.exports['./client'].default, './lib/client.js');
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.ok(fs.existsSync(path.join(root, 'lib', 'client.js')));
  assert.ok(fs.existsSync(path.join(root, 'dist', 'index.js')));
  const patch = fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /name: dsh-plugin-remote-ssh/);
});

test('client registers settings plus native remote project directory flows', () => {
  let result;
  const registrations = [];
  const fakeReact = {
    createElement: (tag, props, ...children) => ({ tag, props, children }),
    useEffect: () => {},
    useState: value => [value, () => {}],
    useCallback: fn => fn,
  };
  const sandbox = {
    document: { head: { appendChild() {} }, createElement() { return { remove() {}, textContent: '', id: '' }; } },
    window: { __ModuleLoader__: { load: ({ id, factory }) => {
      assert.equal(id, 'dsh-plugin-remote-ssh');
      result = factory(name => {
        assert.equal(name, 'react'); return fakeReact;
      });
    } } },
  };
  const source = fs.readFileSync(path.join(root, 'lib', 'client.js'), 'utf8');
  vm.runInNewContext(source, sandbox);
  assert.deepEqual([...result.inject], ['slots', 'workspaces']);
  result.apply({
    effect(callback) { callback(); },
    slots: {
      inject(slot, callback) { assert.ok(['settings.section', 'conversation.hero.workspace.directoryFlow', 'sidebar.workspaces.directoryFlow', 'sidebar.right.tab.guide.actions'].includes(slot)); const result = callback(); if (result && result[Symbol.iterator]) for (const _ of result) { /* Cordis effect iterator */ } },
      register(record, component) { registrations.push({ record, component }); return () => {}; },
    },
  });
  assert.equal(registrations.length, 4);
  assert.equal(registrations[1].record.name, 'sidebar.right.tab.guide.actions');
  assert.equal(registrations[1].record.id, 'remote-ssh-terminal');
  assert.deepEqual(registrations.slice(2).map(x => x.record.name), ['conversation.hero.workspace.directoryFlow', 'sidebar.workspaces.directoryFlow']);
  assert.ok(registrations.slice(2).every(x => x.record.priority === -2));
  assert.ok(registrations.slice(1).every(x => typeof x.record.inject === 'function'));
  assert.ok(registrations.slice(1).every(x => typeof x.component === 'function'));
  assert.ok(!source.includes("h('section', { className: 'rss-session' }"));
  assert.equal(registrations[0].record.name, 'settings.section');
  assert.equal(registrations[0].record.id, 'remote-ssh');
  assert.equal(registrations[0].record.label(), 'Remote SSH');
  assert.equal(typeof registrations[0].component, 'function');
  const section = registrations[0].component({});
  assert.equal(section.props.className, 'rss-settings-container');
  assert.equal(section.children[0].props.className, 'rss-app');
  assert.equal(section.children[0].props.role, 'region');
  assert.ok(!source.includes("name: 'sidebar.footer.action'"));
  assert.ok(!source.includes("name: 'shell.overlay'"));
});

function fixture() {
  const cwd = new Map([['session-1', '/local/project']]);
  const agent = { id: 'agent-1', session: { id: 'session-1', header: { cwd: '/local/project' } } };
  const changes = [];
  let authorized = true;
  let trusted = false;
  let probeFingerprint = 'SHA256:ABCDEFGHIJKLMNOP';
  const hosts = [{ id: 'h1', label: 'GPU host', host: 'gpu.example.com' }];
  const conn = {
    async remoteHome() { return '/home/research'; },
    sftp: {
      realpath(input, cb) { cb(null, input); },
      readdir(_input, cb) {
        cb(null, [
          { filename: 'project', attrs: { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false } },
          { filename: 'README.md', attrs: { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, size: 42 } },
        ]);
      },
    },
    async exec(command) { return { code: 0, stdout: command, stderr: '', truncated: false }; },
  };
  const manager = {
    hosts() { return hosts; }, effectiveConfig() { return { identityFiles: [], proxyCommand: undefined }; }, statuses() { return [{ id: 'h1', state: 'ready' }]; }, recent() { return []; },
    getHost(id) { const match = hosts.find(h => h.id === id); if (!match) throw Object.assign(Error('not found'), { code: 'SSH_HOST_NOT_FOUND' }); return match; },
    addHost(host) { const newHost = { ...host, id: 'h' + (hosts.length + 1) }; hosts.push(newHost); return newHost; },
    updateHost(id, patch) { const host = this.getHost(id); Object.assign(host, patch); return host; },
    removeHost(id) { this.getHost(id); hosts.splice(hosts.findIndex(h => h.id === id), 1); },
    async test() { return trusted ? { ok: true } : { ok: false, code: 'SSH_HOST_KEY_UNKNOWN', details: { fingerprint: probeFingerprint, hostKey: 'AAABBB' } }; },
    trustHostKey(_id, key, fingerprint) { assert.equal(key, 'AAABBB'); assert.equal(fingerprint, probeFingerprint); trusted = true; return { fingerprint }; },
    async connection() { return conn; },
    async openWorkspace(host, selectedPath) {
      assert.equal(host, 'h1');
      assert.equal(selectedPath, '/home/research/project');
      return { virtualPath: encodeVirtualPath(workspaceToken(host, selectedPath), selectedPath), workspace: { remoteRoot: selectedPath } };
    },
  };
  const handler = createNativeHttpHandler({ manager,
    agents: new Map([['session-1', agent]]),
    previousCwd: new Map(),
    requestRejection() { return authorized ? undefined : 401; },
    workingDirectory: {
      get(session) { return cwd.get(session.id); },
      async set(_agent, next) { changes.push(next); cwd.set(_agent.session.id, next); return next; },
    },
  });
  return { handler, changes, cwd, manager, setAuthorized(value) { authorized = value; }, setFingerprint(value) { probeFingerprint = value; } };
}

async function withServer(run) {
  const fx = fixture();
  const server = http.createServer((req, res) => fx.handler(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/remote-ssh`;
  async function call(route, body, options = {}) {
    const res = await fetch(base + route, body === undefined ? { ...options } : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-dsh-remote-ssh': '1', ...options.headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  }
  try { await run({ call, ...fx }); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('native API rejects unauthenticated requests and browser CSRF before reading state', async () => {
  await withServer(async ({ call, setAuthorized }) => {
    setAuthorized(false);
    const noSession = await call('/state');
    assert.equal(noSession.status, 401);
    setAuthorized(true);
    assert.equal((await call('/state')).data.sessions[0].id, 'session-1');
    const noHeader = await call('/host/add', { host: 'another.example.com' }, { headers: { 'x-dsh-remote-ssh': '' } });
    assert.equal(noHeader.status, 403);
    const crossSite = await call('/host/add', { host: 'another.example.com' }, { headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(crossSite.status, 403);
    const success = await call('/host/add', { host: 'another.example.com', port: 2222 });
    assert.equal(success.status, 200);
    assert.equal(success.data.host.port, 2222);
    const invalidPort = await call('/host/add', { host: 'third.example.com', port: 0 });
    assert.equal(invalidPort.status, 400);
  });
});

test('host trust requires typed matching fingerprint and re-probes before persistence', async () => {
  await withServer(async ({ call }) => {
    const probe = await call('/test', { host: 'h1' });
    assert.equal(probe.data.probe.code, 'SSH_HOST_KEY_UNKNOWN');
    assert.equal((await call('/trust', { host: 'h1', fingerprint: 'SHA256:ABCDEFGHIJKLMNOP' })).status, 400);
    assert.equal((await call('/trust', { host: 'h1', fingerprint: 'SHA256:WRONG', confirmed: true })).status, 409);
    const approved = await call('/trust', { host: 'h1', fingerprint: 'SHA256:ABCDEFGHIJKLMNOP', confirmed: true });
    assert.equal(approved.status, 200);
    assert.equal(approved.data.connected, true);
  });
});

test('SFTP browse and remote command use the shared host connection', async () => {
  await withServer(async ({ call }) => {
    const listing = await call('/browse?host=h1&path=~');
    assert.equal(listing.status, 200);
    assert.equal(listing.data.path, '/home/research');
    assert.equal(listing.data.entries[0].name, 'project');
    const command = await call('/exec', { host: 'h1', path: '/home/research/project', command: 'git status --short' });
    assert.equal(command.status, 200);
    assert.match(command.data.stdout, /git status --short/);
    assert.match(command.data.stdout, /cd --/);
  });
});

test('workspace selection changes the REAL agent cwd, and closing restores the previous local cwd', async () => {
  await withServer(async ({ call, changes, cwd }) => {
    const bad = await call('/workspace/open', { sessionId: 'absent', host: 'h1', path: '/home/research/project' });
    assert.equal(bad.status, 409);
    assert.equal(changes.length, 0);
    const opened = await call('/workspace/open', { sessionId: 'session-1', host: 'h1', path: '/home/research/project' });
    assert.equal(opened.status, 200);
    assert.match(opened.data.cwd, /dsh-ssh/);
    assert.equal(cwd.get('session-1'), opened.data.cwd);
    const state = await call('/state');
    assert.equal(state.data.sessions[0].remote, true);
    const closed = await call('/workspace/close', { sessionId: 'session-1' });
    assert.equal(closed.status, 200);
    assert.equal(closed.data.cwd, '/local/project');
    assert.equal(changes.length, 2);
  });
});

test('compact Settings UI keeps a single-column, theme-safe, accessible structure', () => {
  const css = fs.readFileSync(path.join(root, 'src/client.css'), 'utf8');
  const source = fs.readFileSync(path.join(root, 'src/client-web.js'), 'utf8');
  assert.match(css, /\.rss-settings-container\s*\{/);
  assert.match(css, /container:\s*remote-ssh-settings\s*\/\s*inline-size/);
  assert.match(css, /--rss-bg:#ffffff/);
  assert.match(css, /@container remote-ssh-settings \(max-width:440px\)/);
  assert.doesNotMatch(source, /rss-topbar-sub|rss-layout|rss-hero-kicker|rss-session-bar/);
  assert.match(source, /role: 'tablist'/);
  assert.match(source, /'aria-pressed': selected === item.id/);
  assert.doesNotMatch(source, /'aria-label': '选择 DSH Agent 会话'/);
  assert.match(source, /'aria-label': '远程源目录'/);
  assert.match(source, /'aria-live': 'polite'/);
  assert.match(source, /'添加为 DSH 工作区'/);
  assert.match(source, /'rss-project-flow'/);
  assert.match(source, /'rss-directory-dialog'/);
  assert.match(source, /'aria-modal': true/);
  assert.match(source, /'RemoteTerminalAction'/);
  assert.doesNotMatch(source, /来自 SSH Config/);
  assert.match(source, /'主机地址 \/ HostName'/);
});

test('native SSH config preview API is authenticated and returns effective fields without key contents', async () => {
  await withServer(async ({ call, setAuthorized }) => {
    const preview = await call('/config/resolve?alias=example.com');
    assert.equal(preview.status, 200);
    assert.equal(preview.data.effective.alias, 'example.com');
    assert.ok(Number.isSafeInteger(preview.data.effective.port));
    assert.ok(typeof preview.data.effective.user === 'string');
    assert.ok(Array.isArray(preview.data.effective.identityFiles));
    assert.equal(JSON.stringify(preview.data).includes('PRIVATE KEY-----'), false);
    const bad = await call('/config/resolve?alias=-oBad');
    assert.equal(bad.status, 400);
    setAuthorized(false);
    assert.equal((await call('/config/resolve?alias=example.com')).status, 401);
  });
});

test('state exposes the build version so the client can detect a stale host module', async () => {
  await withServer(async ({ call }) => {
    const state = await call('/state');
    assert.equal(state.status, 200);
    assert.equal(state.data.version, manifest.version);
  });
});

test('config preview accepts both GET and POST, and 405 names the route and the restart fix', async () => {
  await withServer(async ({ call }) => {
    const viaGet = await call('/config/resolve?alias=example.com');
    assert.equal(viaGet.status, 200);
    const viaPost = await call('/config/resolve', { alias: 'example.com' });
    assert.equal(viaPost.status, 200);
    assert.equal(viaPost.data.effective.alias, 'example.com');
    const unknown = await call('/config/resolve-v2');
    assert.equal(unknown.status, 405);
    assert.match(unknown.data.error, /\/config\/resolve-v2/);
    assert.match(unknown.data.error, /restart/i);
  });
});

test('built client bundle resolves CSS and version placeholders from package.json', () => {
  const source = fs.readFileSync(path.join(root, 'lib', 'client.js'), 'utf8');
  assert.doesNotMatch(source, /__CSS_TEXT__|__PLUGIN_VERSION__/);
  assert.ok(source.includes('const CLIENT_VERSION = ' + JSON.stringify(manifest.version) + ';'));
});


test('DSH agent/created event wrapper is unwrapped into a usable session', () => {
  const agent = { id: 'agent-1', session: { id: 's-1', header: { cwd: '/home/project' } } };
  assert.equal(agentFromCreatedEvent({ agent }), agent);
  assert.equal(agentFromCreatedEvent(agent), agent);
  assert.equal(agentFromCreatedEvent({ agent: {} }), undefined);
  assert.equal(agentFromCreatedEvent(null), undefined);
});
