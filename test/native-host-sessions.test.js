import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHash, createHmac } from 'node:crypto';
import { NativeHostSessions } from '../dist/native-host-sessions.js';
import { createNativeHttpHandler } from '../dist/http-api.js';

async function mockCore(host, auth={}) {
  const calls=[];
  let connected=0;
  let authorized=true;
  let nextSessionId='same-id';
  let peerCookie='';
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1');
    // Official DSH Core /connect exchanges the launch token for a *v2 API
    // Peer* signed cookie. Its value contains two literal dots; unlike
    // GET /?token=... which issues an independent v1 browser cookie (303).
    if(req.method==='GET' && url.pathname==='/connect'
      && url.searchParams.get('token')===host+'-token'
      && url.searchParams.get('interactions')==='none'){
      connected++;
      const version=auth.cookieVersion??2;
      const authority=req.headers.host;
      const body=Buffer.from(JSON.stringify({
        version,authority,id:host+'-peer',issuedAt:1700000000000,expiresAt:2000000000000,
      })).toString('base64url');
      const sig=createHmac('sha256',Buffer.alloc(32,7)).update(body).digest('base64url');
      const name='dsh-auth-'+createHash('sha256').update(authority).digest('base64url');
      peerCookie=name+'=v'+version+'.'+body+'.'+sig;
      const headers={location:auth.location??'./api/remote.mux',
        'set-cookie':peerCookie+'; Max-Age=3600; Path=/; HttpOnly; SameSite=Strict'};
      if(auth.omitCookie) delete headers['set-cookie'];
      res.writeHead(auth.status??302,headers);
      res.end();return;
    }
    if(req.headers.cookie!==peerCookie||!authorized) {
      res.writeHead(401);res.end('not authorized');return;
    }
    if(req.method!=='POST'||!url.pathname.startsWith('/api/session/')){res.writeHead(404);res.end();return;}
    const chunks=[];
    for await(const part of req)chunks.push(part);
    const request=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    calls.push(request);
    const method=url.pathname.slice('/api/'.length);
    // Validate the same argument field names as DSH's Typert descriptors.
    const args=request.payload?.args;
    assert.ok(args && typeof args==='object');
    assert.deepEqual(Object.keys(args),[method==='session/list'?'_request':'request']);
    if(method==='session/list')assert.deepEqual(args._request,{});
    let value;
    switch(method){
      case 'session/list':
        value={items:[
          {sessionId:'same-id',cwd:'/'+host+'/project',title:host+' job',
            updatedAt:100,running:false,blank:false},
          {sessionId:'other-workspace',cwd:'/'+host+'/private',title:'Unrelated project',
            updatedAt:200,running:true,blank:false},
        ]};break;
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
        assert.equal(request.payload.args.request.content[0].type,'text');
        assert.equal(typeof request.payload.args.request.content[0].text,'string');
        value={accepted:true};break;
      case 'session/cancel':
        value={accepted:true};break;
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
  const ensured=new Map();
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
      ensured.set(host,(ensured.get(host)||0)+1);
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
  return {pool:new NativeHostSessions(deps),hostRecords,tunnels,ensured};
}
test('session/list names its field _request, not request, as declared by DSH Typert',async t=>{
  const core=await mockCore('alpha');
  t.after(()=>core.close());
  const fx=setup(new Map([['alpha',core]]));
  t.after(()=>fx.pool.dispose());
  const list=await fx.pool.list('alpha','~');
  assert.equal(list.phase,'ready');
  const envelope=core.calls.find(call=>call.method==='session/list');
  assert.ok(envelope);
  assert.deepEqual(envelope.payload,{args:{_request:{}}});
  await fx.pool.create('alpha','~');
  const create=core.calls.find(call=>call.method==='session/create');
  assert.deepEqual(create.payload.args,{request:{cwd:'/alpha/project'}});
});

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
  assert.equal(first.sessions.length,1,
    'Host-wide session/list must never expose Sessions from another Linux Workspace');
  assert.equal(second.sessions.length,1);
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
  assert.equal(fx.ensured.get('alpha'),1,'repeated RPCs must reuse a Host health check');
  assert.equal(fx.ensured.get('beta'),1,'other Host is checked independently');
  assert.equal(fx.tunnels.size,2,'two hosts retain isolated listeners');
  const cancellation=await fx.pool.cancel(first.sessions[0].ref);
  assert.equal(cancellation.accepted,true);
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
test('native API login rejects browser v1 cookies and malformed /connect responses',async t=>{
  const variants=[
    {cookieVersion:1},
    {status:303},
    {status:401,omitCookie:true},
    {location:'./'},
  ];
  const hosts=[];
  t.after(async()=>Promise.all(hosts.map(host=>host.close())));
  for(const [index,variant] of variants.entries()){
    const name='host'+index;
    const host=await mockCore(name,variant);
    hosts.push(host);
    const fx=setup(new Map([[name,host]]));
    await assert.rejects(
      ()=>fx.pool.list(name,'~'),
      err=>err.status===401 && /\/connect refused authentication/.test(err.message)
        && !err.message.includes(name+'-token'),
      'reject invalid HTTP status, redirect or cookie version without leaking the token'
    );
    fx.pool.dispose();
  }
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
  // Larger UTF-8 prompts must not hit the former global 16-KiB configuration API cap.
  const chinese=await call('prompt',{ref:listed.body.sessions[0].ref,message:'科研分析'.repeat(2000)});
  assert.equal(chinese.status,200);
  assert.equal(chinese.body.accepted,true);
});
