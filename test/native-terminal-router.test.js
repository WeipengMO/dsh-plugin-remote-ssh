import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { installNativeTerminalRouter } from '../dist/native-terminal-router.js';
import { workspaceToken, workspacePlaceholderPath } from '../dist/paths.js';

class FakePty extends PassThrough {
  constructor() { super(); this.written = []; this.sizes = []; this.signals = []; this.closedFlag = false; }
  write(data, callback) { this.written.push(data); if (typeof callback === 'function') callback(); return true; }
  setWindow(rows, cols, width, height) { this.sizes.push([rows, cols, width, height]); }
  signal(signal) { this.signals.push(signal); }
  close() { if (this.closedFlag) return; this.closedFlag = true; this.emit('close', 0, null); this.end(); }
}
const cwd = workspacePlaceholderPath(workspaceToken('host1', '/data/project'));
const otherRemoteCwd = workspacePlaceholderPath(workspaceToken('host2', '/code'));
const localCwd = process.platform === 'win32' ? 'C:\\Users\\windz\\code' : '/home/windz/code';
const spec = { cwd, cols: 120, rows: 38, terminalType: 'xterm-256color',
  argv: ['wsl.exe', 'bash'], env: { DSH_SESSION_ID: 'session-remote' }, graceMs: 2000 };

function fixture(originBySession = { 'session-remote': cwd, 'session-local': localCwd }) {
  const pty = new FakePty();
  const localCalls = [];
  const logs = [];
  const runtime = {
    async spawnTerminal(input) {
      localCalls.push(input);
      return { local: true, cwd: input.cwd, argv: input.argv };
    },
  };
  const original = runtime.spawnTerminal;
  let lookups = 0;
  const manager = {
    routeFor(value, context) {
      assert.equal(value, cwd);
      assert.equal(context, cwd);
      return { workspace: { connectionId: 'host1', token: workspaceToken('host1', '/data/project') },
        remotePath: '/data/project' };
    },
    async connection(host) {
      lookups++;
      assert.equal(host, 'host1');
      return {
        async terminalInDirectory(remote, columns, rows, type) {
          assert.equal(remote, '/data/project');
          assert.deepEqual([columns, rows, type], [120, 38, 'xterm-256color']);
          return pty;
        },
      };
    },
  };
  const installed = installNativeTerminalRouter(runtime, manager,
    { info: msg => logs.push(msg), warn: msg => logs.push(msg) },
    id => originBySession[id]);
  return { pty, runtime, localCalls, installed, getLookups: () => lookups, original, logs };
}

test('native DSH SSH project opens remote xterm only when same-session ownership is verified', async () => {
  const f = fixture();
  try {
    const h = await f.runtime.spawnTerminal(spec);
    assert.equal(f.getLookups(), 1);
    assert.equal(f.localCalls.length, 0);
    assert.equal(h.pid, 0);
    assert.deepEqual(await h.inspectActivity(), { state: 'unknown', revision: 0 });
    const received = [];
    h.output.on('data', d => received.push(d.toString('utf8')));
    f.pty.emit('data', Buffer.from('\x1b[32mREMOTE\x1b[0m\r\n'));
    assert.equal(received.join(''), '\x1b[32mREMOTE\x1b[0m\r\n');
    await h.write('pwd\r');
    assert.deepEqual(f.pty.written, ['pwd\r']);
    await h.resize(90, 30);
    assert.deepEqual(f.pty.sizes, [[30, 90, 0, 0]]);
    await assert.rejects(() => h.signalForeground('SIGINT'), /process-group ID/);
    await h.terminate();
    assert.equal(f.pty.closedFlag, true);
    assert.deepEqual(await h.done, { exitCode: 0, signal: null });
  } finally { f.installed.dispose(); }
});

test('native local and WSL terminals delegate unchanged, including PowerShell selection', async () => {
  const f = fixture();
  const local = { ...spec, cwd: localCwd, env: { DSH_SESSION_ID: 'session-local' },
    argv: ['powershell.exe', '-NoLogo'] };
  try {
    const result = await f.runtime.spawnTerminal(local);
    assert.deepEqual(result, { local: true, cwd: localCwd, argv: ['powershell.exe', '-NoLogo'] });
    assert.strictEqual(f.localCalls[0], local);
    assert.equal(f.getLookups(), 0);
  } finally { f.installed.dispose(); }
  assert.strictEqual(f.runtime.spawnTerminal, f.original);
});

test('local session with stale SSH placeholder cwd is restored to local provider (regression)', async () => {
  const f = fixture();
  const stale = { ...spec, env: { DSH_SESSION_ID: 'session-local' },
    argv: ['powershell.exe', '-NoLogo'] };
  try {
    const result = await f.runtime.spawnTerminal(stale);
    assert.equal(result.local, true);
    assert.equal(result.cwd, localCwd);
    assert.deepEqual(result.argv, ['powershell.exe', '-NoLogo']);
    assert.equal(f.getLookups(), 0, 'MUST NOT open remote SSH for a local session');
    assert.equal(f.localCalls.length, 1);
    assert.equal(f.localCalls[0].cwd, localCwd);
    assert.ok(f.logs.some(x => /refused SSH terminal for local session/.test(x)));
  } finally { f.installed.dispose(); }
});

test('stale terminal cwd from another SSH workspace cannot connect to wrong host', async () => {
  const f = fixture({ 'session-remote': otherRemoteCwd });
  try {
    await assert.rejects(() => f.runtime.spawnTerminal(spec), /different hosts/);
    assert.equal(f.getLookups(), 0);
    assert.equal(f.localCalls.length, 0);
  } finally { f.installed.dispose(); }
});

test('unknown remote session or missing identity never becomes SSH or local fallback', async () => {
  const f = fixture({});
  try {
    await assert.rejects(() => f.runtime.spawnTerminal(spec), /Cannot verify terminal session ownership/);
    await assert.rejects(() => f.runtime.spawnTerminal({ ...spec, env: undefined }), /Cannot verify terminal session ownership/);
    assert.equal(f.localCalls.length, 0);
    assert.equal(f.getLookups(), 0);
  } finally { f.installed.dispose(); }
});

test('no local fallback if registered SSH route is missing', async () => {
  const localCalls = [];
  const runtime = { spawnTerminal: async value => { localCalls.push(value); return {}; } };
  const installed = installNativeTerminalRouter(runtime, {
    routeFor() { return null; },
    async connection() { throw Error('should not connect'); },
  }, undefined, id => id === 'session-remote' ? cwd : undefined);
  try {
    await assert.rejects(() => runtime.spawnTerminal(spec), /refusing local fallback/);
    assert.equal(localCalls.length, 0);
  } finally { installed.dispose(); }
});
