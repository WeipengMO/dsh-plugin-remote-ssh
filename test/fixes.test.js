import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { encodeVirtualPath } from '../dist/paths.js';
import { installFsRouter } from '../dist/fs-router.js';
import { installRemoteSearchShadow } from '../dist/remote-search.js';
import { createNativeHttpHandler } from '../dist/http-api.js';
import { RemoteSshManager } from '../dist/manager.js';
import { registerManagementTools } from '../dist/tools.js';

const logger = { info() {}, warn() {}, error() {} };
const virtual = encodeVirtualPath('w0123456789abcdef', '/data/project');
const local = path.join(os.tmpdir(), 'rssh-fixes', 'project');

/** A ctx.fs stand-in: every provider method records its call and returns a marker. */
function mockFs() {
  const calls = [];
  const target = {};
  const proxy = new Proxy(target, {
    get(obj, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop in obj) return obj[prop];
      return (...args) => {
        calls.push({ method: prop, args });
        return { local: prop, args };
      };
    },
    set(obj, prop, value) { obj[prop] = value; return true; },
  });
  return { proxy, calls };
}

/** resolveRoute() -> null makes remoteFs.resolve throw SSH_PATH_INVALID. */
function fakeManager() {
  return { resolveRoute: async () => null };
}

test('fs-router: an absolute local path escapes a virtual cwd', async () => {
  const { proxy, calls } = mockFs();
  installFsRouter({ fs: proxy }, fakeManager());
  const result = await proxy.resolve(local, { cwd: virtual });
  assert.equal(result.local, 'resolve');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [local, { cwd: virtual }]);
});

test('fs-router: virtual and relative paths still route to SFTP', async () => {
  const { proxy } = mockFs();
  installFsRouter({ fs: proxy }, fakeManager());
  await assert.rejects(() => proxy.resolve(virtual, { cwd: local }), /not a remote workspace/);
  await assert.rejects(() => proxy.resolve('src/index.ts', { cwd: virtual }), /not a remote workspace/);
});

test('fs-router: lstat uses the same local/remote split', async () => {
  const { proxy } = mockFs();
  installFsRouter({ fs: proxy }, fakeManager());
  assert.equal((await proxy.lstat(local, { cwd: virtual })).local, 'lstat');
  await assert.rejects(() => proxy.lstat('notes.md', { cwd: virtual }), /not a remote workspace/);
});

test('fs-router: dispose restores the original provider methods', () => {
  const { proxy } = mockFs();
  const handle = installFsRouter({ fs: proxy }, fakeManager());
  handle.dispose();
  assert.equal(typeof proxy.resolve, 'function');
  assert.equal(typeof proxy.editText, 'function');
});

function mockTools() {
  const nativeGlob = { name: 'glob', execute: async () => 'native-glob', output: { schema: {}, render: () => [] } };
  const nativeGrep = { name: 'grep', execute: async () => 'native-grep', output: { schema: {}, render: () => [] } };
  const visible = new Map([['glob', nativeGlob], ['grep', nativeGrep]]);
  const tools = {
    get: (name) => visible.get(name),
    view: () => ({ visible: new Map(visible), registrations: new Map(), knownNames: new Set(['glob', 'grep']), restrictableNames: new Set(['glob', 'grep']) }),
  };
  return { tools, nativeGlob, nativeGrep };
}
function mockSearchCtx(wd) {
  return {
    tools: wd.tools,
    workingDirectory: wd.workingDirectory,
    logger,
  };
}
function fakeRemoteFs() {
  return { resolve: async () => { throw new Error('REMOTE_WALK'); } };
}

test('search shadow: a local scope keeps the native glob/grep definitions', () => {
  const { tools, nativeGlob, nativeGrep } = mockTools();
  const scope = { session: { cwd: local } };
  const wd = { get: (s) => s.cwd, ensure: async (a) => a.session.cwd };
  const restore = installRemoteSearchShadow(mockSearchCtx({ tools, workingDirectory: wd }), fakeManager(), fakeRemoteFs());
  assert.equal(tools.view(scope).visible.get('glob'), nativeGlob);
  assert.equal(tools.view(scope).visible.get('grep'), nativeGrep);
  restore();
});

test('search shadow: a remote scope gets stable shadows that honor cwd at call time', async () => {
  const { tools, nativeGlob } = mockTools();
  const scope = { session: { cwd: virtual } };
  let ensured = virtual;
  const wd = { get: () => virtual, ensure: async () => ensured };
  const restore = installRemoteSearchShadow(mockSearchCtx({ tools, workingDirectory: wd }), fakeManager(), fakeRemoteFs());
  const shadow = tools.view(scope).visible.get('glob');
  assert.notEqual(shadow, nativeGlob);
  assert.equal(shadow.__dshRemoteSshShadow, true);
  assert.equal(tools.view(scope).visible.get('glob'), shadow, 'definition identity must stay stable for the step');
  ensured = local;
  assert.equal(await shadow.execute({}, { agent: scope }), 'native-glob', 'local cwd delegates to the native tool');
  ensured = virtual;
  await assert.rejects(() => shadow.execute({ pattern: '*' }, { agent: scope }), /REMOTE_WALK/, 'remote cwd uses the SFTP walk, not ripgrep');
  restore();
  assert.equal(tools.view(scope).visible.get('glob'), nativeGlob);
});

test('host list output never contains undefined fields', async () => {
  const manager = new RemoteSshManager({ storageDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rssh-fix-')) }, logger);
  manager.addHost({ host: 'example.com', user: 'dev' });
  let definition;
  registerManagementTools({
    tools: { register: (d) => { if (d.name === 'remote_ssh_hosts') definition = d; } },
    workingDirectory: { get: () => local, set: async () => local, ensure: async () => local },
    systemPrompt: { section() {} },
    on() {},
    get() { return undefined; },
  }, manager, {});
  assert.ok(definition);
  const result = await definition.execute({ action: 'list' }, { agent: {} });
  assert.equal(result.hosts.length, 1);
  for (const [key, value] of Object.entries(result.hosts[0])) {
    assert.notEqual(value, undefined, `host field ${key} must not be undefined`);
  }
  manager.closeAll();
});

function mockRequest(method, route, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  return {
    method,
    url: 'http://localhost/api/remote-ssh' + route,
    headers: {
      'sec-fetch-site': 'same-origin',
      host: 'localhost',
      'content-type': 'application/json',
      'x-dsh-remote-ssh': '1',
    },
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk; },
  };
}
function mockResponse() {
  return {
    statusCode: 0,
    payload: null,
    writeHead(status) { this.statusCode = status; },
    end(text) { this.payload = JSON.parse(text); },
  };
}

test('workspace/open defaults to the most recently announced session', async () => {
  const manager = new RemoteSshManager({ storageDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rssh-fix-')) }, logger);
  manager.openWorkspace = async () => ({ workspace: { remoteRoot: '/data/project' }, virtualPath: virtual, status: {} });
  const agent = { id: 'agent-1', session: { id: 'session-1', header: { cwd: local } } };
  const agents = new Map([['session-1', agent]]);
  let setArgument;
  const workingDirectory = {
    get: () => local,
    set: async (_agent, value) => { setArgument = value; return value; },
    ensure: async () => local,
  };
  const handler = createNativeHttpHandler({ manager, workingDirectory, agents, previousCwd: new Map(), requestRejection: () => undefined });
  const res = mockResponse();
  await handler(mockRequest('POST', '/workspace/open', { host: 'h-1', path: '/data/project' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.ok, true);
  assert.equal(res.payload.sessionId, 'session-1');
  assert.equal(setArgument, virtual);
  const missing = mockResponse();
  await handler(mockRequest('POST', '/workspace/open', { host: 'h-1', sessionId: 'no-such-session' }), missing);
  assert.equal(missing.statusCode, 409);
  const state = mockResponse();
  await handler(mockRequest('GET', '/state'), state);
  assert.equal(state.payload.sessions[0].latest, true);
  manager.closeAll();
});
