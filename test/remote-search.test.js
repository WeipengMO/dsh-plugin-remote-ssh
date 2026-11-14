import assert from 'node:assert/strict';
import test from 'node:test';
import { workspacePlaceholderPath } from '../dist/paths.js';
import { installRemoteSearchShadow } from '../dist/remote-search.js';

const token = 'w0123456789abcdef';
const nativeCwd = workspacePlaceholderPath(token);
const remoteCwd = '/data/user/mowp/test/dsh_test';

function setup({ readdirOverride } = {}) {
  const calls = { stat: [], readdir: [], reads: [] };
  const attrs = (kind, size = 42) => ({
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'directory',
    isSymbolicLink: () => false,
    size, mtime: 100,
  });
  const connection = {
    sftp: {
      stat(remote, cb) {
        calls.stat.push(remote);
        if (remote.endsWith('.py')) cb(null, attrs('file'));
        else cb(null, attrs('directory'));
      },
      readdir(remote, cb) {
        calls.readdir.push(remote);
        if (readdirOverride) {
          const intercepted = readdirOverride(remote, attrs, cb);
          // null means keep this SFTP request pending until the caller aborts.
          if (intercepted === null) return;
          if (intercepted !== undefined) { cb(null, intercepted); return; }
        }
        const entries = remote === remoteCwd ? [
          { filename: 'alpha.py', attrs: attrs('file') },
          { filename: '.hidden.py', attrs: attrs('file') },
          { filename: '.hidden-dir', attrs: attrs('directory') },
        ] : [];
        cb(null, entries);
      },
    },
    mapSftpError(err) { return err; },
  };
  const manager = {
    workspaceByToken: () => ({ token, connectionId: 'nansha' }),
    connection: async () => connection,
    routeFor(_pathname, cwd) {
      if (cwd !== nativeCwd) throw Error('unexpected cwd: ' + cwd);
      return { remotePath: remoteCwd };
    },
  };
  const remoteFs = {
    resolve: async (selected, { cwd }) => {
      assert.equal(cwd, nativeCwd);
      const remote = !selected || selected === '.' ? remoteCwd
        : selected.startsWith('/') ? selected : remoteCwd + '/' + selected;
      return { remotePath: remote, workspaceToken: token, targetKey: 'ssh:' + token + ':' + remote, displayPath: remote };
    },
    readWholeBytes: async target => {
      calls.reads.push(target.remotePath);
      return Buffer.from('def test_function():\n    return 1\n');
    },
  };
  const nativeGrep = { name: 'grep', execute: async () => ({ matches: [{ path: 'local', lineNumber: 1, line: 'local' }] }) };
  const nativeGlob = { name: 'glob', execute: async () => ({ paths: ['local'] }) };
  const visible = new Map([['grep', nativeGrep], ['glob', nativeGlob]]);
  const tools = {
    view: () => ({ visible, registrations: new Map(), knownNames: new Set(), restrictableNames: new Set() }),
  };
  const scope = { session: { cwd: nativeCwd } };
  const ctx = {
    tools,
    workingDirectory: { get: s => s.cwd, ensure: async () => nativeCwd },
  };
  const restore = installRemoteSearchShadow(ctx, manager, remoteFs);
  return { scope, tools, calls, restore };
}

test('grep on one absolute remote Python file searches that file, not a directory', async () => {
  const { scope, tools, calls, restore } = setup();
  try {
    const grep = tools.view(scope).visible.get('grep');
    const result = await grep.execute({
      pattern: 'def test_function', path: '/data/user/mowp/test/dsh_test/alpha.py', include: '*.py',
    }, { agent: scope });
    assert.deepEqual(result.matches, [{
      path: 'alpha.py', lineNumber: 1, line: 'def test_function():',
    }]);
    assert.deepEqual(calls.stat, ['/data/user/mowp/test/dsh_test/alpha.py']);
    assert.deepEqual(calls.readdir, [], 'a file must never be passed to SFTP readdir');
    assert.equal(calls.reads.length, 1);
  } finally { restore(); }
});

test('grep on explicit hidden file succeeds, recursive directory grep still ignores hidden files', async () => {
  const { scope, tools, calls, restore } = setup();
  try {
    const grep = tools.view(scope).visible.get('grep');
    const explicit = await grep.execute({ pattern: 'return', path: '.hidden.py' }, { agent: scope });
    assert.equal(explicit.matches.length, 1);
    assert.equal(explicit.matches[0].path, '.hidden.py');
    const recursive = await grep.execute({ pattern: 'return', path: '.' }, { agent: scope });
    assert.deepEqual(recursive.matches.map(x => x.path), ['alpha.py']);
    assert.deepEqual(calls.readdir, [remoteCwd]);
  } finally { restore(); }
});

test('remote glob outputs Linux-relative file paths rather than Windows placeholder paths', async () => {
  const { scope, tools, restore } = setup();
  try {
    const glob = tools.view(scope).visible.get('glob');
    const value = await glob.execute({ pattern: '**/*.py', path: '.' }, { agent: scope });
    assert.deepEqual(value.paths, ['.hidden.py', 'alpha.py']);
    assert.equal(value.root, '.');
    assert.ok(value.paths.every(x => !x.includes('.dsh') && !x.includes('remote-ssh-workspaces')));
  } finally { restore(); }
});


test('basename glob is root-only and does not traverse unrelated directories', async () => {
  const { scope, tools, calls, restore } = setup({
    readdirOverride(remote, attrs) {
      if (remote.endsWith('/.hidden-dir')) return [
        { filename: 'deep.py', attrs: attrs('file') },
      ];
      return undefined;
    },
  });
  try {
    const glob = tools.view(scope).visible.get('glob');
    const first = await glob.execute({ pattern: '*.py', path: '.' }, { agent: scope });
    assert.deepEqual(first.paths, ['.hidden.py', 'alpha.py']);
    assert.deepEqual(calls.readdir, [remoteCwd], 'basename glob must not enumerate nested directories');

    calls.readdir.length = 0;
    const recursive = await glob.execute({ pattern: '**/*.py', path: '.' }, { agent: scope });
    assert.deepEqual(recursive.paths, ['.hidden-dir/deep.py', '.hidden.py', 'alpha.py']);
    assert.ok(calls.readdir.includes(remoteCwd + '/.hidden-dir'),
      'explicit recursive glob must still traverse nested directories');
  } finally { restore(); }
});

test('glob for a specific subdirectory does not recurse beyond the pattern depth', async () => {
  const { scope, tools, calls, restore } = setup({
    readdirOverride(remote, attrs) {
      if (remote === remoteCwd) return [
        { filename: 'src', attrs: attrs('directory') },
        { filename: 'other', attrs: attrs('directory') },
      ];
      if (remote === remoteCwd + '/src') return [
        { filename: 'file.py', attrs: attrs('file') },
        { filename: 'sub', attrs: attrs('directory') },
      ];
      if (remote === remoteCwd + '/other') return [
        { filename: 'ignored.py', attrs: attrs('file') },
      ];
      if (remote === remoteCwd + '/src/sub') return [
        { filename: 'deep.py', attrs: attrs('file') },
      ];
      return [];
    },
  });
  try {
    const glob = tools.view(scope).visible.get('glob');
    const result = await glob.execute({ pattern: 'src/*.py' }, { agent: scope });
    assert.deepEqual(result.paths, ['src/file.py']);
    assert.ok(!calls.readdir.includes(remoteCwd + '/src/sub'),
      'a two-segment pattern should not traverse third-level directories');
  } finally { restore(); }
});

test('glob aborts an in-flight SFTP listing without waiting for a hanging callback', async () => {
  const { scope, tools, calls, restore } = setup({
    readdirOverride(remote) {
      if (remote === remoteCwd) return null;
      return undefined;
    },
  });
  const controller = new AbortController();
  try {
    const glob = tools.view(scope).visible.get('glob');
    const pending = glob.execute({ pattern: '.dsh-ssh-smoke.*', path: '.' },
      { agent: scope, signal: controller.signal });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls.readdir, [remoteCwd]);
    controller.abort();
    await assert.rejects(pending, error => error.code === 'FS_ABORTED');
  } finally { restore(); }
});


test('recursive glob overlaps SFTP directory listings without exceeding the 8-worker cap', async () => {
  let active = 0;
  let maxActive = 0;
  const directories = Array.from({ length: 16 }, (_, i) => 'branch-' + i);
  const { scope, tools, calls, restore } = setup({
    readdirOverride(remote, attrs, cb) {
      if (remote === remoteCwd) {
        return directories.map(filename => ({ filename, attrs: attrs('directory') }));
      }
      if (remote.startsWith(remoteCwd + '/branch-')) {
        active += 1;
        maxActive = Math.max(active, maxActive);
        setImmediate(() => {
          active -= 1;
          cb(null, [{ filename: 'file.py', attrs: attrs('file') }]);
        });
        return null;
      }
      return [];
    },
  });
  try {
    const glob = tools.view(scope).visible.get('glob');
    const results = await glob.execute({ pattern: '**/*.py', path: '.' }, { agent: scope });
    assert.equal(results.paths.length, 16);
    assert.ok(maxActive >= 2, 'recursive search must overlap directory SFTP requests');
    assert.ok(maxActive <= 8, 'remote SFTP directory concurrency is bounded');
    assert.equal(calls.readdir.length, 17);
  } finally { restore(); }
});

test('literal glob prefix prunes unrelated directory branches before SFTP listing', async () => {
  const { scope, tools, calls, restore } = setup({
    readdirOverride(remote, attrs) {
      if (remote === remoteCwd) return [
        { filename: 'src', attrs: attrs('directory') },
        { filename: 'unrelated', attrs: attrs('directory') },
      ];
      if (remote === remoteCwd + '/src') return [
        { filename: 'module.py', attrs: attrs('file') },
        { filename: 'nested', attrs: attrs('directory') },
      ];
      if (remote === remoteCwd + '/src/nested') return [
        { filename: 'deeper.py', attrs: attrs('file') },
      ];
      if (remote === remoteCwd + '/unrelated') return [
        { filename: 'skip.py', attrs: attrs('file') },
      ];
      return [];
    },
  });
  try {
    const glob = tools.view(scope).visible.get('glob');
    const result = await glob.execute({ pattern: 'src/**/*.py', path: '.' }, { agent: scope });
    assert.deepEqual(result.paths.sort(), ['src/module.py', 'src/nested/deeper.py'].sort());
    assert.ok(!calls.readdir.includes(remoteCwd + '/unrelated'),
      'literal root should prevent unrelated SFTP readdir');
  } finally { restore(); }
});

test('remote glob preserves SSH_SEARCH_TIMEOUT marker even when host strips error.code', async () => {
  const originalNow = Date.now;
  const started = originalNow();
  const { scope, tools, restore } = setup({
    readdirOverride(remote, attrs) {
      if (remote === remoteCwd) {
        Date.now = () => started + 25_000;
        return [{ filename: 'new.py', attrs: attrs('file') }];
      }
      return [];
    },
  });
  try {
    const glob = tools.view(scope).visible.get('glob');
    await assert.rejects(
      () => glob.execute({ pattern: '**/*.py', path: '.' }, { agent: scope }),
      e => e.code === 'SSH_SEARCH_TIMEOUT' && /SSH_SEARCH_TIMEOUT:/.test(e.message));
  } finally {
    Date.now = originalNow;
    restore();
  }
});
