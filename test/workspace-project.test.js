import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RemoteSshManager } from '../dist/manager.js';
import { workspaceToken, workspacePlaceholderPath, parseVirtualPath, looksVirtual } from '../dist/paths.js';
import { prepareRemoteWorkspace } from '../dist/workspace-registration.js';

test('native DSH workspace registration returns real placeholder, never mirrors source files', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-native-workspace-'));
  const id = 'h1';
  const remoteRoot = '/data/mowp/GBM';
  const token = workspaceToken(id, remoteRoot);
  const localPath = workspacePlaceholderPath(token);
  t.after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(localPath, { recursive: true, force: true });
  });
  const ws = {
    token, connectionId: id, hostLabel: 'nansha', remoteRoot,
    remoteHome: '/home/mowp', createdAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString()
  };
  const logger = { info() {}, warn() {}, error() {} };
  const manager = new RemoteSshManager({ storageDir: tmp }, logger);
  // Stub only the network boundary; the workspace routing code stays real.
  manager.openWorkspace = async () => ({
    workspace: ws, virtualPath: '/dsh-ssh/' + token + '/data/mowp/GBM', status: { state: 'ready' }
  });
  fs.writeFileSync(manager.workspacesFile, JSON.stringify({ version: 1, workspaces: [ws], recent: [] }));
  const registered = [];
  const result = await prepareRemoteWorkspace(manager, id, remoteRoot, {
    create(local, title) { registered.push([local, title]); }
  });
  assert.equal(result.localPath, localPath);
  assert.equal(result.remoteRoot, remoteRoot);
  assert.equal(result.title, 'nansha · GBM');
  assert.equal(result.registered, true);
  assert.equal(fs.statSync(localPath).isDirectory(), true);
  assert.deepEqual(fs.readdirSync(localPath), []);
  assert.deepEqual(registered, [[localPath, 'nansha · GBM']]);

  const parsed = parseVirtualPath(localPath);
  assert.equal(parsed.workspaceToken, token);
  assert.equal(parsed.placeholder, true);
  assert.equal(parsed.remotePath, '/');
  assert.equal(looksVirtual(localPath), true);
  assert.equal(manager.routeFor(localPath, undefined).remotePath, remoteRoot);
  assert.equal(manager.routeFor('src/main.py', localPath).remotePath, '/data/mowp/GBM/src/main.py');
  assert.equal(manager.routeFor(path.join(localPath, 'results'), undefined).remotePath, '/data/mowp/GBM/results');
  assert.equal(manager.routeFor(path.join(tmp, 'local'), undefined), null);
  assert.equal(looksVirtual(path.join(os.tmpdir(), 'ordinary-project')), false);
});

test('native workspace preparation works without registry for DSH directoryFlow onPicked', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-native-workspace-'));
  const token = workspaceToken('h2', '/home/ubuntu/project');
  const localPath = workspacePlaceholderPath(token);
  t.after(() => { fs.rmSync(localPath, { recursive: true, force: true }); fs.rmSync(tmp, { recursive: true, force: true }); });
  const manager = {
    async openWorkspace() {
      return { workspace: { token, hostLabel: 'txcloud', remoteRoot: '/home/ubuntu/project' } };
    }
  };
  const result = await prepareRemoteWorkspace(manager, 'h2', '/home/ubuntu/project');
  assert.equal(result.registered, false);
  assert.equal(result.localPath, localPath);
});
