import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RemoteTerminalPool } from '../dist/remote-terminal.js';

class FakeChannel extends EventEmitter {
  constructor() { super(); this.sent = []; this.sizes = []; this.closed = false; this.stderr = new EventEmitter(); }
  write(value) { this.sent.push(value); }
  setWindow(rows, cols) { this.sizes.push({ rows, cols }); }
  close() { this.closed = true; this.emit('close'); }
}
function fixture() {
  const channel = new FakeChannel();
  const manager = {
    async openWorkspace(hostId, remotePath) {
      assert.equal(hostId, 'nansha');
      return { workspace: { remoteRoot: remotePath } };
    },
    async connection() { return { async shell() { return channel; } }; },
  };
  return { channel, pool: new RemoteTerminalPool(manager) };
}
test('remote terminal opens actual SSH channel, quotes cwd and streams output', async () => {
  const { channel, pool } = fixture();
  const result = await pool.open('nansha', "/data/project's folder");
  assert.match(result.id, /^[0-9a-f-]{36}$/);
  assert.equal(result.remoteRoot, "/data/project's folder");
  assert.equal(channel.sent.length, 1);
  assert.ok(channel.sent[0].startsWith('cd -- '));
  assert.ok(!channel.sent[0].includes("cd -- /data/project's folder"));
  channel.emit('data', Buffer.from('hello\r\n'));
  const first = pool.read(result.id, 0);
  assert.equal(first.output, 'hello\r\n');
  assert.equal(first.closed, false);
  assert.deepEqual(pool.read(result.id, first.cursor).output, '');
  pool.write(result.id, 'pwd\n');
  assert.equal(channel.sent.at(-1), 'pwd\n');
  pool.resize(result.id, 100, 30);
  assert.deepEqual(channel.sizes, [{ rows: 30, cols: 100 }]);
  pool.close(result.id);
  assert.equal(channel.closed, true);
  assert.throws(() => pool.read(result.id, 0), /unknown SSH terminal/);
});
test('editing one SSH Host closes only its terminal channels', async () => {
  const channels=[];
  const manager={
    async openWorkspace(hostId,remotePath){return {workspace:{remoteRoot:remotePath}};},
    async connection(hostId){return {async shell(){
      const ch=new FakeChannel();ch.hostId=hostId;channels.push(ch);return ch;
    }};},
  };
  const pool=new RemoteTerminalPool(manager);
  const first=await pool.open('alpha','/alpha');
  const second=await pool.open('beta','/beta');
  assert.equal(pool.read(first.id,0).closed,false);
  pool.closeAllFor('alpha');
  assert.equal(channels[0].closed,true);
  assert.equal(channels[1].closed,false);
  assert.throws(()=>pool.read(first.id,0),/unknown SSH terminal/);
  assert.equal(pool.read(second.id,0).closed,false);
  pool.closeAll();
});

test('remote terminal refuses excessively large input and caps terminal count', async () => {
  const { pool } = fixture();
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push((await pool.open('nansha', '/tmp')).id);
  await assert.rejects(() => pool.open('nansha', '/tmp'), /close an existing/);
  assert.throws(() => pool.write(ids[0], 'x'.repeat(9000)), /too large/);
  pool.closeAll();
  assert.throws(() => pool.read(ids[1], 0), /unknown SSH terminal/);
});
