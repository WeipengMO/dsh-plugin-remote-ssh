import test from 'node:test';
import assert from 'node:assert/strict';
import { forgeGitQuery, installNativeGitRouter } from '../dist/native-git-router.js';
import { remoteWorkspaceShellGuidance } from '../dist/tools.js';
import { workspacePlaceholderPath } from '../dist/paths.js';

const cwd = workspacePlaceholderPath('w0123456789abcdef');
const prefix = ['/usr/bin/git', '--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];
const spec = (workdir, argv = [...prefix, 'rev-parse', '--show-toplevel']) => ({
  argv, cwd: workdir, env: { GIT_CONFIG_COUNT: '0' }, stdio: {
    stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 },
  },
});

test('accepts native Forge read-only Git probes and rejects changes', () => {
  assert.ok(forgeGitQuery([...prefix, 'rev-parse', '--show-toplevel']));
  assert.ok(forgeGitQuery([...prefix, 'status', '--porcelain=v1']));
  assert.ok(forgeGitQuery([...prefix, 'remote', '-v']));
  assert.equal(forgeGitQuery([...prefix, 'remote', 'remove', 'origin']), null);
  assert.equal(forgeGitQuery([...prefix, 'symbolic-ref', 'HEAD', 'refs/heads/other']), null);
  assert.equal(forgeGitQuery([...prefix, 'diff', '--output=/tmp/file']), null);
  assert.equal(forgeGitQuery([...prefix, 'checkout', 'main']), null);
  assert.equal(forgeGitQuery(['git', 'status']), null);
});

test('native Forge Git reaches SSH repo without leaking into local placeholder', async () => {
  let localCalls = 0, remoteCommand = '';
  const runtime = { spawn(_spec) { localCalls++; return { local: true }; } };
  const original = runtime.spawn;
  const manager = {
    routeFor(requested) {
      assert.equal(requested, cwd);
      return { remotePath: '/data/repository', workspace: { token: 'w0123456789abcdef', connectionId: 'host' } };
    },
    async connection(host) {
      assert.equal(host, 'host');
      return { async exec(command) {
        remoteCommand = command;
        return { stdout: '/data/repository\n', stderr: '', code: 0, signal: null, truncated: false };
      } };
    },
  };
  const router = installNativeGitRouter(runtime, manager);
  try {
    const remote = runtime.spawn(spec(cwd));
    assert.equal((await remote.done).exitCode, 0);
    assert.equal(remote.collected.stdout.readFrom(0).text, '/data/repository\n');
    assert.match(remoteCommand, /cd -- '\/data\/repository'/);
    assert.match(remoteCommand, /git '--no-optional-locks' '-c'/);
    assert.equal(localCalls, 0);
    assert.deepEqual(runtime.spawn(spec('/tmp/local')), { local: true });
    assert.equal(localCalls, 1);
    assert.throws(() => runtime.spawn(spec(cwd, [...prefix, 'reset', '--hard'])), /not an authorized read-only Git query/);
    assert.throws(() => runtime.spawn(spec(cwd, ['ls', '-la'])), /not an authorized read-only Git query/);
    assert.equal(localCalls, 1);
    assert.equal(await remote.waitForExit(), true);
  } finally { router.dispose(); }
  assert.equal(runtime.spawn, original);
});

test('Agent gets POSIX hint only for remote workspace', () => {
  assert.equal(remoteWorkspaceShellGuidance('/tmp/local'), '');
  assert.match(remoteWorkspaceShellGuidance(cwd), /POSIX/);
  assert.match(remoteWorkspaceShellGuidance(cwd), /PowerShell cmdlets/);
});

test('remote SSH uses blinking bar and CSS does not defeat blink animation', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const source = readFileSync(join(root, 'src/connection.ts'), 'utf8');
  const css = readFileSync(join(root, 'src/client.css'), 'utf8');
  assert.match(source, /DECSCUSR 5/);
  assert.match(source, /033\[5 q/);
  assert.match(css, /rss-terminal-bar-blink/);
  assert.doesNotMatch(css, /box-shadow: inset 2px 0 0 var\(--terminal-cursor, currentColor\) !important/);
});
