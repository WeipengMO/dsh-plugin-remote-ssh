import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RemoteSshManager } from '../dist/manager.js';

test('clearing recent directories persists an empty list without modifying remote-workspace registrations', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ssh-history-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workspaces = [
    { token: 'w0011223344556677', connectionId: 'host-a', remoteRoot: '/srv/project-a', hostLabel: 'host-a' },
    { token: 'w8899aabbccddeeff', connectionId: 'host-b', remoteRoot: '/srv/project-b', hostLabel: 'host-b' },
  ];
  const recent = workspaces.map((x, i) => ({
    connectionId: x.connectionId,
    hostLabel: x.hostLabel,
    remoteRoot: x.remoteRoot,
    openedAt: new Date(2026, 10, 11, i).toISOString(),
  }));
  const file = path.join(dir, 'workspaces.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, workspaces, recent }));
  const manager = new RemoteSshManager({ storageDir: dir }, { info() {}, warn() {}, error() {} });
  assert.equal(manager.recent().length, 2);
  assert.equal(manager.clearRecentHistory(), 2);
  assert.deepEqual(manager.recent(), []);
  assert.deepEqual(manager.workspaces(), workspaces);
  assert.equal(manager.clearRecentHistory(), 0, 'idempotent clear must not touch registrations');

  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(disk.recent, []);
  assert.deepEqual(disk.workspaces, workspaces);
  const reload = new RemoteSshManager({ storageDir: dir }, { info() {}, warn() {}, error() {} });
  assert.deepEqual(reload.recent(), []);
  assert.deepEqual(reload.workspaces(), workspaces, 'registrations must persist across restarts');
});

test('Settings history has one divider, an accessible toggle and a separate clear action', () => {
  const css = fs.readFileSync(new URL('../src/client.css', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('../src/client-web.js', import.meta.url), 'utf8');
  assert.match(css, /\.rss-settings-container \.rss-recent-wrap\s*\{\s*border-top:\s*0 !important;/);
  assert.match(js, /'aria-label': '最近使用的远程目录'/);
  assert.match(js, /'aria-expanded': recentExpanded/);
  assert.match(js, /api\('\/recent\/clear', \{ confirmed: true \}\)/);
  assert.match(js, /不会删除已经创建的 DSH 工作区或服务器文件/);
  assert.match(js, /disabled: !!busy \|\| state\.recent\.length === 0/);
});

test('native DSH sidebar terminal overrides block-cursor visuals with a vertical bar', () => {
  const css = fs.readFileSync(new URL('../src/client.css', import.meta.url), 'utf8');
  assert.match(css, /\[data-sidebar-terminal\] \.xterm \.xterm-rows \.xterm-cursor\.xterm-cursor-block/);
  assert.match(css, /background-color: transparent !important;/);
  assert.match(css, /box-shadow: inset 2px 0 0 var\(--terminal-cursor, currentColor\);/);
  assert.doesNotMatch(css, /box-shadow: inset 2px 0 0 var\(--terminal-cursor, currentColor\) !important;/);
  assert.match(css, /@keyframes rss-terminal-bar-blink/);
  assert.match(css, /animation: rss-terminal-bar-blink 1s step-end infinite !important;/);
});
