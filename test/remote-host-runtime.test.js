import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, lstat, mkdir, readFile, rename, unlink, writeFile, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RemoteHostRuntimePool, REMOTE_HELPER_SHA256, REMOTE_RUNTIME_PROTOCOL } from '../dist/remote-host-runtime.js';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const helper = path.join(projectRoot, 'runtime', 'agent.mjs');

function runHelper(method, cwd, id = 'test-request') {
  const payload = Buffer.from(JSON.stringify({ protocol: 1, id, method, cwd })).toString('base64url');
  const result = spawnSync(process.execPath, [helper, payload], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
test('bundled helper uses strict versioned JSON protocol and runs read-only Git in its real cwd', () => {
  const hello = runHelper('hello');
  assert.equal(hello.ok, true);
  assert.equal(hello.result.protocol, REMOTE_RUNTIME_PROTOCOL);
  assert.equal(hello.result.digest, REMOTE_HELPER_SHA256);
  assert.equal(hello.result.platform, process.platform);
  const inspected = runHelper('inspect', projectRoot);
  assert.equal(inspected.ok, true);
  assert.equal(inspected.result.cwd, projectRoot);
  assert.equal(inspected.result.git.available, true);
  assert.ok(typeof inspected.result.git.root === 'string');
  assert.ok(typeof inspected.result.git.status === 'string');
  assert.ok(typeof inspected.result.git.worktrees === 'string');
  assert.equal(runHelper('shell', projectRoot).ok, false, 'cannot run arbitrary commands');
  assert.equal(runHelper('inspect', '/nonexistent-dsh-test-project').ok, false);
  const invalid = spawnSync(process.execPath, [helper, 'a.!b'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(JSON.parse(invalid.stdout).ok, false);
});
function fakeSftp() {
  return {
    lstat(p, cb) { lstat(p, cb); },
    mkdir(p, opts, cb) { mkdir(p, { mode: opts.mode }, cb); },
    readFile(p, cb) { readFile(p, cb); },
    writeFile(p, bytes, opts, cb) { writeFile(p, bytes, { mode: opts.mode }, cb); },
    rename(a, b, cb) { rename(a, b, cb); },
    unlink(p, cb) { unlink(p, cb); },
  };
}
function fixture(remoteHome, overrides = {}) {
  let commands = [];
  const conn = {
    async remoteHome() { return remoteHome; },
    async ensure() {},
    sftp: fakeSftp(),
    async exec(command) {
      commands.push(command);
      if (command === 'uname -s') return { code: 0, stdout: 'Linux\n', stderr: '', truncated: false };
      if (command === 'node --version') return { code: 0, stdout: process.version + '\n', stderr: '', truncated: false };
      const args = /^node '([^']+)' '([A-Za-z0-9_-]+)'$/.exec(command);
      assert.ok(args, 'expected only a quoted node helper invocation: ' + command.slice(0, 100));
      const child = spawnSync(process.execPath, [args[1], args[2]], { encoding: 'utf8', timeout: 10000 });
      return { code: child.status, stdout: child.stdout, stderr: child.stderr, truncated: false };
    },
    ...overrides,
  };
  return { conn, manager: { async connection(host) { assert.equal(host,'host1'); return conn; } }, commands };
}
test('automatic SSH helper bootstrap verifies digest, deduplicates connections and inspects remote Git', async t => {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-runtime-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const fx = fixture(home);
  const pool = new RemoteHostRuntimePool(fx.manager);
  const [first, second] = await Promise.all([pool.connect('host1'), pool.connect('host1')]);
  assert.deepEqual(first, second);
  assert.equal(first.verified, true);
  assert.equal(first.helperHash, REMOTE_HELPER_SHA256);
  assert.equal(first.platform, 'linux');
  assert.equal(pool.list().length, 1);
  assert.equal(fx.commands.filter(x => /^node '/.test(x)).length, 1);
  const status = await pool.inspect('host1', projectRoot);
  assert.equal(status.git.available, true);
  assert.ok(status.git.root);
  assert.equal((await pool.dshVersion('host1')).installed, false);
  const pool2 = new RemoteHostRuntimePool(fx.manager);
  assert.equal((await pool2.connect('host1')).helperPath, first.helperPath);
  pool2.closeAll();
  await assert.rejects(() => pool2.connect('host1'), /disposed/);
  pool.closeAll();
});
test('tampered remote helper is rejected; SSH identity cannot silently fall back to local execution', async t => {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-runtime-tamper-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const fx = fixture(home);
  const first = await new RemoteHostRuntimePool(fx.manager).connect('host1');
  await new Promise((resolve, reject) => writeFile(first.helperPath, 'process.exit(0)', err => err ? reject(err) : resolve()));
  const second = new RemoteHostRuntimePool(fx.manager);
  await assert.rejects(() => second.connect('host1'), /checksum mismatch/);
});
test('Linux and Node prerequisites are checked before attempting helper installation', async t => {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-runtime-bad-platform-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const linux = fixture(home);
  const wrongPlatform = fixture(home, { exec: async () => ({code:0,stdout:'Darwin\n',stderr:'',truncated:false}) });
  await assert.rejects(() => new RemoteHostRuntimePool(wrongPlatform.manager).connect('host1'), /requires Linux/);
  const tooOld = fixture(home, { exec: async command => command === 'uname -s'
    ? {code:0,stdout:'Linux\n',stderr:'',truncated:false} 
    : {code:0,stdout:'v18.0.0\n',stderr:'',truncated:false}
  });
  await assert.rejects(() => new RemoteHostRuntimePool(tooOld.manager).connect('host1'), /Node.js >=20/);
  assert.equal(linux.commands.length, 0);
});

test('changing SSH host config while bootstrap is running invalidates its result', async t => {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-runtime-race-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fx = fixture(home, { async remoteHome() { await gate; return home; } });
  const pool = new RemoteHostRuntimePool(fx.manager);
  const pending = pool.connect('host1');
  await new Promise(resolve => setImmediate(resolve));
  pool.clear('host1');
  release();
  await assert.rejects(pending, /configuration changed/);
  assert.deepEqual(pool.list(), []);
  const next = await pool.connect('host1');
  assert.equal(next.verified, true);
  pool.closeAll();
});
