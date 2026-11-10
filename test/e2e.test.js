import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ssh2 from '../vendor/ssh2/lib/index.js';
import { MockSshServer } from './mock-server.js';

const { utils: ssh2Utils } = ssh2;
import { RemoteSshManager } from '../dist/manager.js';
import { RemoteFileSystem } from '../dist/remote-fs.js';
import { installFsRouter } from '../dist/fs-router.js';
import { installShellRouter } from '../dist/shell-router.js';
import { buildSshArgv } from '../dist/shell-router.js';
import { applyHunks } from '@deepseek-ai/dsh-fs-patch';

const logger = { info() {}, warn() {}, error() {} };

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function setup(t) {
  const dir = tempDir('dsh-remote-ssh-e2e-');
  const keyPath = path.join(dir, 'id_ed25519');
  let clientPrivateKey;

  if (process.platform === 'win32') {
    // Windows OpenSSH checks the file ACL, not the POSIX mode. Let ssh-keygen
    // create the identity so it carries the secure, non-inherited ACL that
    // ssh.exe requires. It exits non-zero in this sandbox because writing the
    // .pub companion is blocked, but the private key itself is complete.
    spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath], { stdio: 'ignore' });
    if (fs.existsSync(keyPath) && fs.statSync(keyPath).size > 0) {
      clientPrivateKey = fs.readFileSync(keyPath, 'utf8');
    }
  }
  if (clientPrivateKey === undefined) {
    clientPrivateKey = ssh2Utils.generateKeyPairSync('ed25519').private;
    fs.writeFileSync(keyPath, clientPrivateKey, { mode: 0o600 });
  }

  const server = await new MockSshServer({ clientPrivateKey }).start();
  server.fs.ensureDir('/home/test/project');
  server.fs.ensureDir('/home/test/project/src');
  server.fs.setFile('/home/test/project/main.py', 'print("hello")\n');
  server.fs.setFile('/home/test/project/src/app.ts', 'export const value = 1;\n');
  server.fs.setFile('/home/test/project/README.md', '# demo\nsearch token here\n');
  const manager = new RemoteSshManager({ storageDir: path.join(dir, 'state') }, logger);
  const host = manager.addHost({
    host: '127.0.0.1',
    port: server.port,
    user: 'test',
    label: 'mock',
    identityFile: keyPath,
    useSshConfig: false,
  });
  t.after(async () => {
    manager.closeAll();
    await server.stop();
    // ssh-keygen protected the key file with an ACL this test token cannot
    // delete; leaking one temp directory is harmless for a test run.
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });
  return { server, dir, keyPath, manager, host };
}

test('strict host key trust, SFTP workspace, native filesystem seam', async (t) => {
  const { manager, host } = await setup(t);
  const probe = await manager.test(host.id);
  assert.equal(probe.ok, false);
  assert.equal(probe.code, 'SSH_HOST_KEY_UNKNOWN');
  assert.match(probe.details.fingerprint, /^SHA256:/);
  assert.ok(probe.details.hostKey.length > 40);

  manager.trustHostKey(host.id, probe.details.hostKey, probe.details.fingerprint);
  const tested = await manager.test(host.id);
  assert.equal(tested.ok, true, JSON.stringify(tested));
  assert.equal(tested.status.state, 'ready');

  const opened = await manager.openWorkspace(host.id, '/home/test/project');
  assert.equal(opened.workspace.remoteRoot, '/home/test/project');
  assert.match(opened.virtualPath, /^\\\\dsh-ssh\\|^\/dsh-ssh\//);

  const remoteFs = new RemoteFileSystem(manager);
  const target = await remoteFs.resolve(opened.virtualPath);
  assert.equal(target.remotePath, '/home/test/project');
  const stat = await remoteFs.stat(target);
  assert.equal(stat.type, 'directory');

  const fileTarget = await remoteFs.resolve(path.join(opened.virtualPath, 'main.py'));
  const read = await remoteFs.readText(fileTarget);
  assert.equal(read, 'print("hello")\n');
  assert.equal(fileTarget.targetKey.startsWith(`ssh:${opened.workspace.token}:`), true);

  const initial = await remoteFs.stat(fileTarget);
  const written = await remoteFs.writeText(fileTarget, 'print("updated")\n', { kind: 'replaceIfVersion', version: initial.version });
  assert.equal(written.operation, 'update');
  assert.equal(await remoteFs.readText(fileTarget), 'print("updated")\n');
  await assert.rejects(
    () => remoteFs.writeText(fileTarget, 'stale\n', { kind: 'replaceIfVersion', version: 'not-current' }),
    (error) => error.code === 'FS_STALE_VERSION',
  );

  const edited = await remoteFs.editText(fileTarget, { oldString: 'updated', newString: 'edited' });
  assert.match(edited.after, /edited/);
  assert.equal(await remoteFs.readText(fileTarget), 'print("edited")\n');

  const patchTarget = await remoteFs.resolve(path.join(opened.virtualPath, 'README.md'));
  const patched = await remoteFs.patchText(patchTarget, [
    { lineNumber: 2, oldLines: ['search token here'], newLines: ['patched token'] },
  ]);
  assert.match(patched.after, /patched token/);
  assert.equal(applyHunks('# demo\nsearch token here\n', [{ lineNumber: 2, oldLines: ['search token here'], newLines: ['patched token'] }]).ok, true);

  const listing = await remoteFs.listDir(target);
  assert.deepEqual(listing.map((entry) => entry.name).sort(), ['README.md', 'main.py', 'src'].sort());

  const src = await remoteFs.resolve(path.join(opened.virtualPath, 'src'));
  const file = await remoteFs.resolve(path.join(opened.virtualPath, 'main.py'));
  const moved = await remoteFs.moveFile(file, await remoteFs.resolve(path.join(opened.virtualPath, 'src', 'main.py')), {});
  assert.equal(moved.sourceDeleted, true);
  assert.equal(await remoteFs.readText(await remoteFs.resolve(path.join(opened.virtualPath, 'src', 'main.py'))), 'print("edited")\n');
  assert.equal(await remoteFs.stat(src).then((info) => info.type), 'directory');

  const outside = await remoteFs.resolve(`${opened.virtualPath}/../outside.txt`);
  await assert.rejects(
    () => remoteFs.writeText(outside, 'nope', undefined, undefined, { mode: 'workspace-write' }),
    (error) => error.code === 'FS_PERMISSION_DENIED',
  );
  // Containment must hold even when a caller forgets the sandbox policy.
  await assert.rejects(
    () => remoteFs.writeText(outside, 'nope'),
    (error) => error.code === 'FS_PERMISSION_DENIED',
  );
});

test('fs router delegates local and routes remote targets', async (t) => {
  const { manager, host } = await setup(t);
  const probe = await manager.test(host.id);
  manager.trustHostKey(host.id, probe.details.hostKey, probe.details.fingerprint);
  const opened = await manager.openWorkspace(host.id, '/home/test/project');

  const localCalls = [];
  const localTarget = { targetKey: 'local:/tmp/example', displayPath: '/tmp/example' };
  const local = {
    resolve: async (value) => {
      localCalls.push(['resolve', value]);
      return localTarget;
    },
    stat: async () => ({ type: 'file', version: 'local-version', size: 3 }),
    lstat: async () => ({ type: 'file', version: 'local-version', size: 3 }),
    readText: async () => 'local',
    streamText: async () => (async function* () { yield 'local'; })(),
    readBytes: async () => Buffer.from('local'),
    readByteRange: async () => Buffer.from('loc'),
    listDir: async () => [],
    writeText: async () => ({ operation: 'update', version: 'local-version', before: 'local', after: 'x' }),
    editText: async () => ({ version: 'local-version', before: 'local', after: 'x' }),
    patchText: async () => ({ version: 'local-version', before: 'local', after: 'x' }),
    deleteFile: async () => ({ before: 'local' }),
    moveFile: async () => ({ sourceDeleted: true }),
    watch: async () => () => {},
    processPath: (target) => target.displayPath,
    processPathFromHostPath: (value) => value,
    contains: () => true,
    fileUrl: (target) => `file://${target.displayPath}`,
  };
  const ctx = { fs: local };
  const handle = installFsRouter(ctx, manager);

  assert.equal(await ctx.fs.resolve('/tmp/example'), localTarget);
  assert.equal(localCalls.length, 1);
  assert.equal(await ctx.fs.readText(localTarget), 'local');

  const remote = await ctx.fs.resolve(path.join(opened.virtualPath, 'main.py'));
  assert.equal(remote.remotePath, '/home/test/project/main.py');
  assert.equal(ctx.fs.processPath(remote).startsWith(opened.virtualPath), true);
  assert.equal(await ctx.fs.readText(remote), 'print("hello")\n');

  const remoteStat = await ctx.fs.stat(remote);
  assert.equal(remoteStat.type, 'file');
  const remoteWrite = await ctx.fs.writeText(remote, 'print("router")\n', { kind: 'replaceIfVersion', version: remoteStat.version });
  assert.equal(remoteWrite.operation, 'update');
  assert.equal(await ctx.fs.readText(remote), 'print("router")\n');
  assert.equal(await ctx.fs.resolve('/tmp/example'), localTarget);
  handle.dispose();
  assert.equal(await ctx.fs.resolve('/tmp/example'), localTarget);
});

test('shell router builds strict ssh argv and executes through it', async (t) => {
  const { manager, host } = await setup(t);
  const probe = await manager.test(host.id);
  manager.trustHostKey(host.id, probe.details.hostKey, probe.details.fingerprint);
  const opened = await manager.openWorkspace(host.id, '/home/test/project');
  const connection = await manager.connection(host.id);
  const knownHosts = await manager.ensureKnownHostsFile(connection);
  const spec = { command: 'echo hello', workdir: '/home/test/project', timeoutMs: 30000, onExpiry: 'kill', stdoutMaxBytes: 1024 * 1024 };
  const argv = buildSshArgv(connection, knownHosts, spec);
  assert.equal(argv.includes('StrictHostKeyChecking=yes'), true);
  assert.equal(argv.includes(`UserKnownHostsFile=${knownHosts}`), true);
  assert.equal(argv.includes('-F'), true);
  assert.match(argv.at(-1), /^cd -- '\/home\/test\/project' && exec env .*bash -lc 'echo hello'$/);
  if (spawnSync('ssh', ['-V']).error?.code === 'ENOENT') {
    t.skip('system OpenSSH binary unavailable in test container; command construction verified');
    return;
  }

  const outDir = tempDir('dsh-remote-ssh-shell-');
  const fakeShell = {
    resolve(request) {
      return { command: request.command, workdir: request.workdir ?? os.tmpdir(), timeoutMs: request.timeoutMs ?? 30000, onExpiry: 'kill', stdoutMaxBytes: request.stdoutMaxBytes ?? 1024 * 1024 };
    },
    async execute(specValue) {
      return { local: true, specValue };
    },
    async executeArgv(specValue, sshArgv) {
      const stdoutPath = path.join(outDir, 'stdout');
      const stderrPath = path.join(outDir, 'stderr');
      const stdoutFd = fs.openSync(stdoutPath, 'w');
      const stderrFd = fs.openSync(stderrPath, 'w');
      const child = spawn(sshArgv[0], sshArgv.slice(1), { cwd: specValue.workdir, stdio: ['ignore', stdoutFd, stderrFd] });
      const done = waitForExit(child).then(({ code, signal }) => {
        fs.closeSync(stdoutFd);
        fs.closeSync(stderrFd);
        return {
          exitCode: code,
          signal,
          stdout: { text: fs.readFileSync(stdoutPath, 'utf8') },
          stderr: { text: fs.readFileSync(stderrPath, 'utf8') },
        };
      });
      return {
        result: () => done,
        kill: () => child.kill(),
      };
    },
  };
  const ctx = { shell: fakeShell };
  const handle = installShellRouter(ctx, manager);
  const handleResult = await ctx.shell.execute({ ...spec, workdir: opened.virtualPath });
  const result = await handleResult.result();
  assert.equal(result.exitCode, 0, result.stderr.text);
  assert.equal(result.stdout.text, 'hello\n');
  assert.equal((await ctx.shell.execute({ ...spec, workdir: os.tmpdir() })).local, true);
  handle.dispose();
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
});
