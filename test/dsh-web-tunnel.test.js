import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { RemoteDshWebTunnelPool } from '../dist/dsh-web-tunnel.js';
import { createNativeHttpHandler } from '../dist/http-api.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
async function createServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('remote DSH: ' + req.url);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, port: server.address().port };
}
function managerFor(targetPort) {
  let count = 0;
  return {
    get count() { return count; },
    async connection(host) {
      assert.equal(host, 'host1');
      return { async forwardLoopback(port) {
        assert.equal(port, targetPort);
        count++;
        const socket = net.connect(port, '127.0.0.1');
        try { await once(socket, 'connect'); } catch (e) { socket.destroy(); throw e; }
        return socket;
      } };
    },
  };
}
test('loopback SSH tunnel proxies HTTP to the remote Web port and tears down', async t => {
  const remote = await createServer();
  const manager = managerFor(remote.port);
  const pool = new RemoteDshWebTunnelPool(manager);
  t.after(() => { pool.closeAll(); remote.server.close(); });
  assert.deepEqual(pool.list(), []);
  const address = await pool.open('host1', remote.port);
  assert.match(address.localUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(address.remotePort, remote.port);
  assert.equal(address.host, 'host1');
  assert.equal(pool.list().length, 1);
  assert.equal((await pool.open('host1', remote.port)).localPort, address.localPort);
  assert.equal(pool.list().length, 1);
  await assert.rejects(pool.open('host1', remote.port + 1), /Close the existing/);
  assert.equal(await (await fetch(address.localUrl + '/repo?q=1')).text(), 'remote DSH: /repo?q=1');
  assert.ok(manager.count >= 2);
  assert.equal(pool.close('host1'), true);
  assert.equal(pool.list().length, 0);
  assert.equal(pool.close('host1'), false);
  await assert.rejects(fetch(address.localUrl + '/'));
  pool.closeAll();
  await assert.rejects(pool.open('host1', remote.port), /disposed/);
});
test('tunnel refuses invalid ports and never binds a listener if remote forwarding is disallowed', async () => {
  const pool = new RemoteDshWebTunnelPool({
    async connection() { return { async forwardLoopback() { throw Error('administratively prohibited'); } }; },
  });
  await assert.rejects(pool.open('host1', 80), /1024/);
  await assert.rejects(pool.open('host1', 3080), /administratively prohibited/);
  assert.deepEqual(pool.list(), []);
});
test('client rejects untrusted URLs and preserves only official token URL path/query over local tunnel', () => {
  let client;
  const source = fs.readFileSync(path.join(root, 'src/client-web.js'), 'utf8')
    .replace('__CSS_TEXT__', "''").replace('__PLUGIN_VERSION__', "'test'");
  vm.runInNewContext(source, {
    URL,
    window: { __ModuleLoader__: { load({ factory }) {
      client = factory(name => {
        assert.equal(name, 'react');
        return { createElement() {}, useEffect() {}, useState() {}, useCallback() {} };
      });
    } } },
  });
  assert.equal(typeof client.localDshAccessUrl, 'function');
  const tunnel = { localPort: 14000, remotePort: 3080, localUrl: 'http://127.0.0.1:14000' };
  assert.equal(client.localDshAccessUrl('http://127.0.0.1:3080/token?x=1#part', tunnel),
    'http://127.0.0.1:14000/token?x=1#part');
  assert.throws(() => client.localDshAccessUrl('https://example.com/path?token=abc', tunnel), /仅接受/);
  assert.throws(() => client.localDshAccessUrl('http://evil.example:3080/path', tunnel), /仅接受/);
  assert.throws(() => client.localDshAccessUrl('http://127.0.0.1:6666/path', tunnel), /端口必须/);
  assert.throws(() => client.localDshAccessUrl('http://user:pass@127.0.0.1:3080/path', tunnel), /端口必须/);
  assert.throws(() => client.localDshAccessUrl('not a URL', tunnel), /完整/);
});
async function callApi(handler, route, payload) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const port = server.address().port;
    const response = await fetch('http://127.0.0.1:' + port + '/api/remote-ssh' + route, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-remote-ssh': '1' },
      body: JSON.stringify(payload),
    });
    return { status: response.status, json: await response.json() };
  } finally { server.close(); }
}
test('API denies managed tunnels on non-desktop Hosts; desktop opens/tears down with authenticated route', async () => {
  const events = [];
  const manager = {
    getHost(id) { assert.equal(id, 'host1'); return { id }; },
  };
  const tunnels = {
    list() { return []; },
    async open(host, port) { events.push(['open',host,port]); return { host, remotePort:port, localPort:17890,localUrl:'http://127.0.0.1:17890'}; },
    close(host) { events.push(['close',host]); return true; },
  };
  const fixture = desktopProfile => createNativeHttpHandler({
    manager, dshWebTunnels:tunnels, desktopProfile,
    agents:new Map(), previousCwd:new Map(),
    workingDirectory:{ get() { return ''; } },
    requestRejection() { return undefined; },
  });
  const denied = await callApi(fixture(false), '/dsh/tunnel/open', {host:'host1',port:3080});
  assert.equal(denied.status, 409);
  assert.deepEqual(events, []);
  const bad = await callApi(fixture(true), '/dsh/tunnel/open', {host:'host1',port:80});
  assert.equal(bad.status, 400);
  const opened = await callApi(fixture(true), '/dsh/tunnel/open', {host:'host1',port:3080});
  assert.equal(opened.status, 200);
  assert.equal(opened.json.tunnel.localPort, 17890);
  const closed = await callApi(fixture(true), '/dsh/tunnel/close', {host:'host1'});
  assert.equal(closed.status, 200);
  assert.deepEqual(events, [['open','host1',3080], ['close','host1']]);
});
