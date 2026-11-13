import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { SshConnection } from '../dist/connection.js';

// Use the exact vendored ssh2 constructor that SshConnection uses. Mock only
// transport events so the regression is independent of network availability.
const { Client } = createRequire(import.meta.url)('../vendor/ssh2/lib/index.js');
const logger = { info() {}, warn() {}, error() {} };

function connection(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rssh-handshake-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const key = path.join(dir, 'test-key');
  // The mocked transport never parses this key, but authCandidates must find
  // an existing file to offer an authentication method.
  fs.writeFileSync(key, 'mock-key', { mode: 0o600 });
  return new SshConnection('test-host', 'test host', {
    alias: 'test-host',
    hostName: '127.0.0.1',
    port: 22,
    user: 'tester',
    identityFiles: [key],
    identitiesOnly: true,
    useAgent: false,
    userKnownHostsFiles: [],
    connectTimeoutSec: 2,
    serverAliveIntervalSec: 0,
    serverAliveCountMax: 0,
    configFound: false,
    matchedHostConfig: false,
  }, { verify() { return { trusted: true }; } }, logger);
}

function mockConnect(t, implementation) {
  const originalConnect = Client.prototype.connect;
  Client.prototype.connect = implementation;
  t.after(() => { Client.prototype.connect = originalConnect; });
}

test('multiple pre-handshake SSH errors do not crash the DSH process', async (t) => {
  mockConnect(t, function connect() {
    process.nextTick(() => {
      this.emit('error', new Error('Connection lost before handshake'));
      // With once('error'), this second event used to be an uncaught exception.
      this.emit('error', new Error('socket hang up during teardown'));
      this.emit('close');
    });
    return this;
  });

  const conn = connection(t);
  await assert.rejects(conn.ensure(), /closed before the SSH handshake/);
  assert.equal(conn.state, 'failed');
  assert.match(conn.status().lastError, /closed before the SSH handshake/);
});

test('close before the handshake followed by multiple error events is safe', async (t) => {
  mockConnect(t, function connect() {
    process.nextTick(() => {
      this.emit('close');
      this.emit('error', new Error('Connection lost before handshake'));
      this.emit('error', new Error('second error after close'));
    });
    return this;
  });

  const conn = connection(t);
  await assert.rejects(conn.ensure(), /closed during setup/);
  assert.equal(conn.state, 'failed');
});

test('post-handshake transport errors invalidate the connection and allow reconnect', async (t) => {
  let active;
  let attempts = 0;
  mockConnect(t, function connect() {
    attempts += 1;
    active = this;
    process.nextTick(() => this.emit('ready'));
    return this;
  });
  const originalSftp = Client.prototype.sftp;
  Client.prototype.sftp = function sftp(callback) { callback(null, {}); };
  t.after(() => { Client.prototype.sftp = originalSftp; });

  const conn = connection(t);
  await conn.ensure();
  assert.equal(conn.state, 'ready');
  assert.equal(attempts, 1);

  active.emit('error', new Error('ECONNRESET'));
  active.emit('error', new Error('EPIPE'));
  active.emit('close');
  assert.notEqual(conn.state, 'ready');
  assert.throws(() => conn.sftp, /SFTP is not open/);

  await conn.ensure();
  assert.equal(conn.state, 'ready');
  assert.equal(attempts, 2);
  conn.close();
});

test('missing authentication method immediately transitions to failed', async (t) => {
  const conn = connection(t);
  conn.config.identityFiles.length = 0;
  await assert.rejects(conn.ensure(), /no SSH authentication method is available/);
  assert.equal(conn.state, 'failed');
});
