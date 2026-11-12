import assert from 'node:assert/strict';
import test from 'node:test';
import { workspacePlaceholderPath } from '../dist/paths.js';
import { installRemoteSearchShadow } from '../dist/remote-search.js';

const token = 'w0123456789abcdef';
const nativeCwd = workspacePlaceholderPath(token);
const remoteCwd = '/data/user/mowp/test/dsh_test';

function setup() {
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
