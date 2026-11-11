import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installWorkspaceCleanup } from '../dist/workspace-cleanup.js';

test('DSH workspace deletion removes only the owned empty placeholder and its route', t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-ssh-cleanup-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'placeholders');
  const storage = path.join(tmp, 'state');
  const token = 'w0123456789abcdef', target = path.join(root, token);
  fs.mkdirSync(target, { recursive: true });
  const handlers = [];
  const forgotten = [];
  const manager = {
    workspaceByToken(value) {
      assert.equal(value, token);
      return { token: value };
    },
    forgetWorkspace(value) { forgotten.push(value); },
  };
  const logger = { warn() {} };
  const ctx = { on(event, handler) { assert.equal(event, 'domain/changed'); handlers.push(handler); return () => {}; } };
  const cleanup = installWorkspaceCleanup(ctx, manager, storage, logger, { root });
  const event = handlers[0];
  event({ domain: 'workspace', table: 'workspaces', key: 'ws-id',
    operation: 'put', value: { path: target } });
  assert.equal(cleanup.mappings().get('ws-id'), target);
  event({ domain: 'workspace', table: 'workspaces', key: 'ws-id', operation: 'deleted' });
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(forgotten, [token]);
  assert.equal(cleanup.mappings().size, 0);
  cleanup.dispose();
});

test('cleanup ignores arbitrary local folders and never deletes a nonempty placeholder', t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-ssh-cleanup-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'placeholders');
  const token = 'waaaaaaaaaaaaaaaa', target = path.join(root, token);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'user-document.txt'), 'DO NOT DELETE');
  const handlers = [], forgotten = [], warnings = [];
  const cleanup = installWorkspaceCleanup({ on(_event, handler) { handlers.push(handler); } }, {
    workspaceByToken() { return {}; }, forgetWorkspace(id) { forgotten.push(id); },
  }, path.join(tmp, 'state'), { warn(msg) { warnings.push(msg); } }, { root });
  const event = handlers[0];
  event({ domain: 'workspace', table: 'workspaces', key: 'untrusted', operation: 'put',
    value: { path: path.join(tmp, 'unrelated') } });
  event({ domain: 'workspace', table: 'workspaces', key: 'untrusted', operation: 'deleted' });
  event({ domain: 'workspace', table: 'workspaces', key: 'real', operation: 'put', value: { path: target } });
  event({ domain: 'workspace', table: 'workspaces', key: 'real', operation: 'deleted' });
  assert.equal(fs.readFileSync(path.join(target, 'user-document.txt'), 'utf8'), 'DO NOT DELETE');
  assert.deepEqual(forgotten, []);
  assert.match(warnings.join('\n'), /not empty/);
  cleanup.dispose();
});

test('cleanup recovers workspace mapping after host restart', t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-ssh-cleanup-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'placeholders');
  const token = 'wbbbbbbbbbbbbbbbb', target = path.join(root, token);
  fs.mkdirSync(target, { recursive: true });
  const storage = path.join(tmp, 'state'), forgotten = [];
  const ctx = { on(_name, fn) { this.fn = fn; } };
  const manager = { workspaceByToken() { return {}; }, forgetWorkspace(token) { forgotten.push(token); } };
  const logger = { warn() {} };
  const first = installWorkspaceCleanup(ctx, manager, storage, logger, { root });
  ctx.fn({ domain: 'workspace', table: 'workspaces', operation: 'put', key: 'ws1', value: { path: target } });
  first.dispose();
  const restart = installWorkspaceCleanup(ctx, manager, storage, logger, { root });
  assert.equal(restart.mappings().get('ws1'), target);
  ctx.fn({ domain: 'workspace', table: 'workspaces', operation: 'delete', key: 'ws1' });
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(forgotten, [token]);
});

test('existing DSH workspaces are tracked even when created before the cleanup hook', t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-ssh-cleanup-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'placeholders');
  const target = path.join(root, 'wcccccccccccccccc');
  fs.mkdirSync(target, { recursive: true });
  let handler;
  const forgotten = [];
  installWorkspaceCleanup({ on(_name, fn) { handler = fn; } },
    { workspaceByToken() { return {}; }, forgetWorkspace(t) { forgotten.push(t); } },
    path.join(tmp, 'state'), { warn() {} }, { root,
      registered: () => [{ id: 'existing', path: target }] });
  handler({ domain: 'workspace', table: 'workspaces', key: 'existing', operation: 'deleted' });
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(forgotten, ['wcccccccccccccccc']);
});
