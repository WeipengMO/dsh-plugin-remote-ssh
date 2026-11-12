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
  assert.ok(forgeGitQuery([...prefix, 'log', '--max-count=20', '--format=%h%x09%s']));
  assert.ok(forgeGitQuery([...prefix, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']));
  assert.ok(forgeGitQuery([...prefix, 'worktree', 'list', '--porcelain']));
  assert.ok(forgeGitQuery([...prefix, 'branch', '--list', '--format=%(refname:short)']));
  assert.equal(forgeGitQuery([...prefix, 'branch', '--delete', 'main']), null);
  assert.equal(forgeGitQuery([...prefix, 'worktree', 'prune']), null);
  assert.ok(forgeGitQuery([...prefix, 'remote', '-v']));
  assert.equal(forgeGitQuery([...prefix, 'remote', 'remove', 'origin']), null);
  assert.equal(forgeGitQuery([...prefix, 'symbolic-ref', 'HEAD', 'refs/heads/other']), null);
  assert.equal(forgeGitQuery([...prefix, 'diff', '--output=/tmp/file']), null);
  assert.equal(forgeGitQuery([...prefix, 'checkout', 'main']), null);
  assert.ok(forgeGitQuery(['git', 'status']));
});

test('accepts other safety-prefixed read-only probe shapes', () => {
  // DSH releases vary the number and order of global options before the
  // subcommand; only their kind (and one safety marker) should matter.
  assert.ok(forgeGitQuery(['/usr/bin/git', '--no-optional-locks', 'status', '--porcelain=v1']));
  assert.ok(forgeGitQuery(['git', '-c', 'core.quotepath=false', '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false', 'diff', '--numstat']));
  assert.ok(forgeGitQuery(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
    '--literal-pathspecs', 'log', '-5']));
  assert.ok(forgeGitQuery(['git.exe', '-ccore.quotepath=false', '--no-optional-locks',
    'rev-parse', '--show-toplevel']));
  assert.ok(forgeGitQuery([...prefix, 'remote', 'get-url', 'origin']));
  assert.ok(forgeGitQuery([...prefix, 'symbolic-ref', '--short', 'HEAD']));
  // Safe unprefixed reads are allowed; unsafe Git config remains blocked.
  assert.ok(forgeGitQuery(['git', 'status']));
  assert.equal(forgeGitQuery(['git', '-c', 'core.fsmonitor=!evil', 'status']), null);
  assert.equal(forgeGitQuery(['git', '-c', 'include.path=/etc/passwd', 'status']), null);
  assert.equal(forgeGitQuery(['git', '-c', 'core.sshCommand=evil', 'status']), null);
  assert.equal(forgeGitQuery(['git', '-c', 'core.pager=less', 'status']), null);
  assert.equal(forgeGitQuery(['git', '-C', '/tmp', '--no-optional-locks', 'status']), null);
  assert.equal(forgeGitQuery(['git', '--no-optional-locks', 'push', 'origin', 'main']), null);
  assert.equal(forgeGitQuery(['git', '--no-optional-locks', 'diff', '--output=/tmp/x']), null);
  assert.equal(forgeGitQuery(['git', '--no-optional-locks', 'symbolic-ref', 'HEAD', 'refs/heads/other']), null);
});

test('Windows native ACL sandbox wrapper accepts canonical DSH Forge Git probes', () => {
  const sandbox = [
    'C:\\Program Files\\nodejs\\node.exe', 'C:\\DSH\\sandbox\\runner.js',
    '--workspace', 'C:\\Users\\user\\.dsh\\remote-ssh-workspaces\\w0123456789abcdef',
    '--temp', 'C:\\Users\\user\\AppData\\Local\\Temp',
    '--mode', 'read-only', '--',
    'C:\\Program Files\\Git\\cmd\\git.exe',
  ];
  const root = [...sandbox, '--no-optional-locks', '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false'];
  assert.ok(forgeGitQuery([...root, 'rev-parse', '--show-toplevel']));
  assert.ok(forgeGitQuery([...root, 'rev-parse', '--path-format=absolute', '--git-common-dir']));
  assert.ok(forgeGitQuery([...root, 'symbolic-ref', '--quiet', '--short', 'HEAD']));
  assert.ok(forgeGitQuery([...root, 'remote', '-v']));
  assert.ok(forgeGitQuery([...root, 'for-each-ref', '--sort=-committerdate',
    '--count=50', '--format=%(refname:lstrip=2)', 'refs/heads/']));
  assert.equal(forgeGitQuery([...root, 'remote', 'remove', 'origin']), null);
  assert.equal(forgeGitQuery([...root, 'reset', '--hard']), null);
});

test('safe bare Git checks can be routed without version-specific Forge prefix', () => {
  assert.deepEqual(forgeGitQuery(['git', 'rev-parse', '--show-toplevel']),
    ['rev-parse', '--show-toplevel']);
  assert.deepEqual(forgeGitQuery(['C:\\Program Files\\Git\\cmd\\git.exe', 'status', '--short']),
    ['status', '--short']);
  assert.deepEqual(forgeGitQuery(['git.cmd', 'log', '-5']), ['log', '-5']);
  assert.equal(forgeGitQuery(['git', '-c', 'core.fsmonitor=!evil', 'status']), null);
  assert.equal(forgeGitQuery(['git', '-c', 'include.path=/tmp/unsafe', 'status']), null);
  assert.equal(forgeGitQuery(['git', '--git-dir=/tmp/other', 'status']), null);
  assert.equal(forgeGitQuery(['git', '-C', '/tmp/other', 'status']), null);
  assert.equal(forgeGitQuery(['git', 'diff', '--output=/tmp/other']), null);
  assert.equal(forgeGitQuery(['gh', 'pr', 'list']), null);
});

test('rejected probe shapes are logged for later whitelisting', () => {
  const warnings = [];
  const runtime = { spawn(_spec) { return { local: true }; } };
  const manager = {
    routeFor() {
      return { remotePath: '/data/repository', workspace: { token: 'w0123456789abcdef', connectionId: 'host' } };
    },
    async connection() { throw new Error('should not connect for a rejected shape'); },
  };
  const router = installNativeGitRouter(runtime, manager, {
    info() {}, warn(message) { warnings.push(message); },
  });
  try {
    assert.throws(() => runtime.spawn(spec(cwd, ['git', 'push', 'origin', 'main'])), /Remote Git\/Forge query blocked/);
  } finally { router.dispose(); }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\["git","push","origin","main"\]/);
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
    assert.throws(() => runtime.spawn(spec(cwd, [...prefix, 'reset', '--hard'])), /Remote Git\/Forge query blocked/);
    assert.throws(() => runtime.spawn(spec(cwd, ['ls', '-la'])), /Remote Git\/Forge query blocked/);
    assert.equal(localCalls, 1);
    assert.equal(await remote.waitForExit(), true);
  } finally { router.dispose(); }
  assert.equal(runtime.spawn, original);
});

test('Agent gets POSIX hint only for remote workspace', () => {
  assert.equal(remoteWorkspaceShellGuidance('/tmp/local'), '');
  assert.match(remoteWorkspaceShellGuidance(cwd), /Bash\/POSIX/);
  assert.match(remoteWorkspaceShellGuidance(cwd), /remote_ssh_git/);
  assert.match(remoteWorkspaceShellGuidance(cwd), /Windows PowerShell/);
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
