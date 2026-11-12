import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { NativeHostSessions } from '../dist/native-host-sessions.js';
import { createNativeHttpHandler } from '../dist/http-api.js';

async function mockCore(host) {
  const calls=[];
  let connected=0;
  let authorized=true;
  let nextSessionId='same-id';
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1');
    if(req.method==='GET' && url.pathname==='/' && url.searchParams.get('token')===host+'-token'){
      connected++;
      res.writeHead(303,{'set-cookie':'dsh-auth-test='+host+'-cookie; Path=/; HttpOnly; SameSite=Strict',location:'./'});
      res.end();return;
    }
    if(req.headers.cookie!=='dsh-auth-test='+host+'-cookie'||!authorized) {
      res.writeHead(401);res.end('not authorized');return;
    }
    if(req.method!=='POST'||!url.pathname.startsWith('/api/session/')){res.writeHead(404);res.end();return;}
    const chunks=[];
    for await(const part of req)chunks.push(part);
    const request=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    calls.push(request);
    const method=url.pathname.slice('/api/'.length);
    let value;
    switch(method){
      case 'session/list':
        value={items:[{sessionId:'same-id',cwd:'/'+host+'/project',title:host+' job',updatedAt:100,running:false,blank:false}]};break;
      case 'session/create':
        assert.equal(request.payload.args.request.cwd,'/'+host+'/project');
        value={sessionId:nextSessionId};break;
      case 'session/events':
        value={records:[
          {type:'event',event:{type:'user/message',seq:1,data:{content:[{type:'text',text:'Hello '+host}]}}},
          {type:'event',event:{type:'assistant/message',seq:2,data:{message:{content:[{type:'text',text:'Reply '+host}]}}}},
        ],hasMore:false,cursor:2};break;
      case 'session/prompt':
        assert.equal(request.payload.args.request.sessionId,'same-id');
        assert.equal(request.payload.args.request.mode,'queue');
        assert.deepEqual(request.payload.args.request.content,[{type:'text',text:'Run on '+host}]);
        value={accepted:true};break;
      case 'session/cancel':
        value={cancelled:true};break;
      default:
        res.writeHead(404);res.end();return;
    }
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({type:'server-response',rpcId:request.rpcId,result:{ok:true,value}}));
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const port=server.address().port;
  return {port,calls,setAuthorized:(v)=>{authorized=v},connections:()=>connected,
    close:()=>new Promise(resolve=>server.close(resolve))};
}
function setup(coreHosts) {
  const hostRecords=new Map([...coreHosts.keys()].map(id=>[id,{updatedAt:'v1'}]));
  const tunnels=new Map();
  const deps={
    manager:{
      getHost(host){if(!hostRecords.has(host))throw Error('Unknown Host');return hostRecords.get(host);},
      async openWorkspace(host,chosenPath){
        if(!hostRecords.has(host))throw Error('Unknown Host');
        return {workspace:{remoteRoot:chosenPath==='~'?'/'+host+'/project':chosenPath}};
      },
    },
    runtime:{async ensureWeb(host,remoteRoot) {
      const core=coreHosts.get(host);
      return {phase:'ready',cwd:remoteRoot,port:core.port,
        url:'http://127.0.0.1:'+core.port+'/?token='+host+'-token'};
    }},
    tunnels:{
      list(){return [...tunnels.values()];},
      close(key){return tunnels.delete(key)},
      async openScoped(key,host,remotePort){
        let entry=tunnels.get(key);
        if(!entry){
          entry={key,host,remotePort,localPort:coreHosts.get(host).port,
            localUrl:'http://127.0.0.1:'+coreHosts.get(host).port};
          tunnels.set(key,entry);
        }
        return entry;
      },
    },
  };
  return {pool:new NativeHostSessions(deps),hostRecords,tunnels};
}
test('native Session RPC binds same ID to independent Hosts and keeps credentials server-side',async t=>{
  const a=await mockCore('alpha'),b=await mockCore('beta');
  t.after(async()=>{await Promise.all([a.close(),b.close()])});
  const fx=setup(new Map([['alpha',a],['beta',b]]));
  t.after(()=>fx.pool.dispose());
  const first=await fx.pool.list('alpha','~');
  const second=await fx.pool.list('beta','~');
  assert.equal(first.phase,'ready');
  assert.equal(second.phase,'ready');
  assert.notEqual(first.sessions[0].ref,second.sessions[0].ref);
  assert.equal(first.sessions[0].title,'alpha job');
  assert.ok(!JSON.stringify(first).includes('alpha-token'));
  assert.ok(!JSON.stringify(first).includes('dsh-auth-'));
  assert.equal(a.connections(),1);
  assert.equal(b.connections(),1);
  const own=await fx.pool.events(first.sessions[0].ref);
  const another=await fx.pool.events(second.sessions[0].ref);
  assert.equal(own.messages[0].text,'Hello alpha');
  assert.equal(another.messages[1].text,'Reply beta');
  await fx.pool.prompt(first.sessions[0].ref,'Run on alpha');
  await fx.pool.prompt(second.sessions[0].ref,'Run on beta');
  assert.equal(a.calls.filter(x=>x.method==='session/prompt').length,1);
  assert.equal(b.calls.filter(x=>x.method==='session/prompt').length,1);
  assert.equal(a.connections(),1,'Connection auth is reused within Host Sessions');
  assert.equal(fx.tunnels.size,2,'two hosts retain isolated listeners');
  await fx.pool.cancel(first.sessions[0].ref);
  assert.equal(a.calls.at(-1).method,'session/cancel');

  fx.hostRecords.set('alpha',{updatedAt:'v2'});
  await assert.rejects(()=>fx.pool.events(first.sessions[0].ref),/binding has expired/);
  assert.equal((await fx.pool.events(second.sessions[0].ref)).phase,'ready','other Host unaffected');
});
test('remote Host auth failures fail closed, and clear revokes bound Session refs',async t=>{
  const core=await mockCore('alpha');
  t.after(()=>core.close());
  const fx=setup(new Map([['alpha',core]]));
  t.after(()=>fx.pool.dispose());
  const listed=await fx.pool.list('alpha','~');
  core.setAuthorized(false);
  await assert.rejects(()=>fx.pool.events(listed.sessions[0].ref),/authentication lost/);
  fx.pool.clear('alpha');
  await assert.rejects(()=>fx.pool.events(listed.sessions[0].ref),/binding has expired/);
});
test('same-origin plugin native endpoints never expose arbitrary RPC or unauthenticated access',async t=>{
  const core=await mockCore('alpha');
  t.after(()=>core.close());
  const fx=setup(new Map([['alpha',core]]));
  t.after(()=>fx.pool.dispose());
  const handler=createNativeHttpHandler({
    manager:fx.pool.deps?.manager ?? {},
    desktopProfile:true,nativeSessions:fx.pool,agents:new Map(),previousCwd:new Map(),
    requestRejection(){return undefined;},
  });
  const server=http.createServer(handler);
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port+'/api/remote-ssh/runtime/native/';
  const call=async(method,payload,headers={})=>{
    const response=await fetch(base+method,{
      method:'POST',
      headers:{'content-type':'application/json','x-dsh-remote-ssh':'1',...headers},
      body:JSON.stringify(payload),
    });
    return {status:response.status,body:await response.json()};
  };
  const listed=await call('list',{host:'alpha',path:'~'});
  assert.equal(listed.status,200);
  assert.equal(listed.body.phase,'ready');
  assert.ok(listed.body.sessions[0].ref);
  const wrong=await call('rpc',{endpoint:'session/list',host:'alpha'});
  assert.equal(wrong.status,404);
  const invalid=await call('events',{ref:'nonexistent'});
  assert.equal(invalid.status,409);
  const attack=await call('list',{host:'alpha',path:'~'},{'sec-fetch-site':'cross-site'});
  assert.equal(attack.status,403);
});
