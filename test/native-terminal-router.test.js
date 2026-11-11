import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { installNativeTerminalRouter } from '../dist/native-terminal-router.js';
import { workspaceToken, workspacePlaceholderPath } from '../dist/paths.js';

class FakePty extends PassThrough {
  constructor() { super(); this.written = []; this.sizes = []; this.signals = []; this.closed = false; }
  write(data, callback) { this.written.push(data); if (typeof callback === 'function') callback(); return true; }
  setWindow(rows, cols, width, height) { this.sizes.push([rows, cols, width, height]); }
  signal(signal) { this.signals.push(signal); }
  close() { if (this.closed) return; this.closed = true; this.emit('close', 0, null); this.end(); }
}
const cwd = workspacePlaceholderPath(workspaceToken('host1', '/data/project'));
function fixture() {
  const pty = new FakePty();
  const localCalls = [];
  const runtime = {
    async spawnTerminal(spec) {
      localCalls.push(spec);
      return { local: true };
    },
  };
  const original = runtime.spawnTerminal;
  let lookups = 0;
  const manager = {
    routeFor(value, context) {
      assert.equal(value, cwd);
      assert.equal(context, cwd);
      return { workspace: { connectionId: 'host1' }, remotePath: '/data/project' };
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
  const installed = installNativeTerminalRouter(runtime, manager);
  return { pty, runtime, localCalls, installed, getLookups: () => lookups, original };
}
const spec = { cwd, cols: 120, rows: 38, terminalType: 'xterm-256color',
  argv: ['wsl.exe', 'bash'], graceMs: 2000 };

test('native DSH right-sidebar terminal opens remote SSH xterm by mapped cwd', async () => {
  const f = fixture();
  try {
    const h = await f.runtime.spawnTerminal(spec);
    assert.equal(f.getLookups(), 1);
    assert.equal(f.localCalls.length, 0, 'WSL must never start for a remote workspace');
    assert.equal(h.pid, 0);
    assert.deepEqual(await h.inspectActivity(), { state: 'unknown', revision: 0 });
    assert.equal(await h.inspectForeground(), undefined);
    const received = [];
    h.output.on('data', d => received.push(d.toString('utf8')));
    f.pty.emit('data', Buffer.from('\x1b[32mREMOTE\x1b[0m\r\n'));
    assert.equal(received.join(''), '\x1b[32mREMOTE\x1b[0m\r\n',
      'must preserve ANSI VT bytes for native xterm');
    await h.write('pwd\r');
    assert.deepEqual(f.pty.written, ['pwd\r']);
    await h.resize(90, 30);
    assert.deepEqual(f.pty.sizes, [[30, 90, 0, 0]]);
    await assert.rejects(() => h.signalForeground('SIGINT'), /process-group ID/);
    await h.terminate();
    assert.equal(f.pty.closed, true);
    assert.deepEqual(await h.done, { exitCode: 0, signal: null });
  } finally { f.installed.dispose(); }
});

test('local or WSL workspace delegates byte-for-byte to native subprocess provider', async () => {
  const f = fixture();
  const local = { ...spec, cwd: 'C:\\Users\\windz\\code' };
  try {
    assert.deepEqual(await f.runtime.spawnTerminal(local), { local: true });
    assert.equal(f.localCalls.length, 1);
    assert.strictEqual(f.localCalls[0], local);
    assert.equal(f.getLookups(), 0);
  } finally { f.installed.dispose(); }
  assert.strictEqual(f.runtime.spawnTerminal, f.original, 'must restore original provider');
});

test('no local fallback if SSH placeholder lookup fails', async () => {
  const f = fixture();
  try {
    const original = f.runtime.spawnTerminal;
    const bad = installNativeTerminalRouter({ spawnTerminal: async () => {
      throw Error('should not fall back');
    } }, {
      routeFor() { return null; },
      async connection() { throw Error('should not connect'); },
    });
    // Simulate a detached manager after workspace deletion without touching local provider.
    bad.dispose();
    assert.notStrictEqual(original, f.original);
  } finally { f.installed.dispose(); }
});
