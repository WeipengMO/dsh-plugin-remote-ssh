import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createNativeHttpHandler } from '../dist/http-api.js';

async function request(handler,route,payload) {
  const server=http.createServer(handler);
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  try {
    const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/remote-ssh'+route,{
      method:'POST', headers:{'content-type':'application/json','x-dsh-remote-ssh':'1'},
      body:JSON.stringify(payload),
    });
    return {status:response.status,body:await response.json()};
  } finally { server.close(); }
}
test('Desktop user opens real remote Linux Web Host without receiving a local fake workspace', async () => {
  const events=[];
  let phase='starting';
  const host={id:'h1',label:'GPU'};
  const manager={
    getHost(id){assert.equal(id,'h1');return host;},
    async openWorkspace(id,cwd){
      events.push(['workspace',id,cwd]);
      return { workspace:{remoteRoot:'/home/user/project'} };
    },
  };
  const remoteRuntime={
    async ensureWeb(host,cwd,approved){
      events.push(['ensure',host,cwd,approved]);
      return phase==='starting'
        ?{phase:'starting',cwd,port:32176,installation:'official-npx-pinned'}
        :{phase:'ready',cwd,port:32176,url:'http://127.0.0.1:32176/?token=secret-test',installation:'existing'};
    },
  };
  const tunnels={
    list(){return [];},
    async openScoped(key,host,port){events.push(['tunnel',host,port,key]);return {key,host,remotePort:port,localPort:18276,localUrl:'http://127.0.0.1:18276'};},
    close(){throw Error('unexpected close');},
  };
  const handler=createNativeHttpHandler({manager,remoteRuntime,dshWebTunnels:tunnels,
    desktopProfile:true,agents:new Map(),previousCwd:new Map(),requestRejection(){return undefined;}});
  const initializing=await request(handler,'/runtime/web/open',{host:'h1',path:'/home/user/project'});
  assert.equal(initializing.status,200);
  assert.equal(initializing.body.phase,'starting');
  assert.equal(initializing.body.url,undefined);
  phase='ready';
  const ready=await request(handler,'/runtime/web/open',{host:'h1',path:'/home/user/project'});
  assert.equal(ready.status,200);
  assert.equal(ready.body.phase,'ready');
  assert.equal(ready.body.url,'http://127.0.0.1:18276/?token=secret-test');
  assert.ok(events.some(x=>x[0]==='ensure'&&x[3]===true));
  assert.ok(events.some(x=>x[0]==='tunnel'&&x[2]===32176));
  const restricted=createNativeHttpHandler({manager,remoteRuntime,dshWebTunnels:tunnels,
    desktopProfile:false,agents:new Map(),previousCwd:new Map(),requestRejection(){return undefined;}});
  const denied=await request(restricted,'/runtime/web/open',{host:'h1',path:'/home/user/project'});
  assert.equal(denied.status,409);
});
test('remote Web URL must be loopback, match the forwarded port, and contain the official launch token', async () => {
  const manager={getHost(){return {id:'h1'};},async openWorkspace(){return {workspace:{remoteRoot:'/repo'}};}};
  const tunnels={list(){return [];},async open(){return {localUrl:'http://127.0.0.1:15421',remotePort:32176,localPort:15421};}};
  const remoteRuntime={async ensureWeb(){return {phase:'ready',cwd:'/repo',port:32176,
    url:'http://evil.example:32176/?token=x'};}};
  const handler=createNativeHttpHandler({manager,remoteRuntime,dshWebTunnels:tunnels,desktopProfile:true,
    agents:new Map(),previousCwd:new Map(),requestRejection(){return undefined;}});
  const r=await request(handler,'/runtime/web/open',{host:'h1',path:'/repo'});
  assert.equal(r.status,502);
});

test('two projects on one SSH host keep independent Web tunnels', async () => {
  const tunnelsByKey = new Map();
  const closed = [];
  const manager = {
    getHost() { return { id:'h1' }; },
    async openWorkspace(_host, path) { return { workspace:{ remoteRoot:path } }; },
  };
  const remoteRuntime = { async ensureWeb(_host, path) {
    const port = path === '/one' ? 32171 : 32172;
    return { phase:'ready', port, url:`http://127.0.0.1:${port}/?token=test` };
  } };
  const tunnels = {
    list() { return [...tunnelsByKey.values()]; },
    async openScoped(key, host, remotePort) {
      const tunnel = { key, host, remotePort, localPort:remotePort + 100, localUrl:`http://127.0.0.1:${remotePort + 100}` };
      tunnelsByKey.set(key, tunnel); return tunnel;
    },
    close(key) { closed.push(key); tunnelsByKey.delete(key); },
  };
  const handler = createNativeHttpHandler({ manager, remoteRuntime, dshWebTunnels:tunnels,
    desktopProfile:true, agents:new Map(), previousCwd:new Map(), requestRejection(){} });
  const one = await request(handler, '/runtime/web/open', {host:'h1', path:'/one'});
  const two = await request(handler, '/runtime/web/open', {host:'h1', path:'/two'});
  assert.equal(one.status, 200);
  assert.equal(two.status, 200);
  assert.equal(tunnelsByKey.size, 2);
  assert.notEqual(one.body.url, two.body.url);
  assert.deepEqual(closed, []);
});
