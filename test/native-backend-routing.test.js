import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function routerFactory() {
  let plugin;
  const source=fs.readFileSync(new URL('../lib/client.js',import.meta.url),'utf8');
  vm.runInNewContext(source,{
    window:{ __ModuleLoader__:{ load({factory}) {
      plugin=factory(name=>{
        assert.equal(name,'react');
        return {createElement(){},useState(){},useEffect(){},useCallback(){},useRef(){}};
      });
    } } },
  });
  assert.equal(typeof plugin.installRemoteBackendWorkspaceNavigation,'function');
  return plugin.installRemoteBackendWorkspaceNavigation;
}
function setup(registrations=[
  {workspaceId:'remote-1',host:'linux-a',remoteRoot:'/data/alpha'},
  {workspaceId:'remote-2',host:'linux-b',remoteRoot:'/data/beta'},
]){
  const locals=[],remotes=[],errors=[];
  const original={
    openWorkspace(id,callback,options){locals.push(['open',id,callback,options]);return Promise.resolve()},
    startSession(id,options){locals.push(['new',id,options])},
    connectWorkspace(id,options){locals.push(['connect',id,options]);return Promise.resolve('local-session')},
  };
  const uiWorkspace={...original};
  const views=[
    {workspaceId:'local-1',path:'C:\\Users\\user\\code'},
    {workspaceId:'remote-1',path:'C:\\Users\\user\\.dsh\\remote-ssh-workspaces\\w0123456789abcdef'},
    {workspaceId:'remote-2',path:'C:\\Users\\user\\.dsh\\remote-ssh-workspaces\\waaaaaaaaaaaaaaaa'},
  ];
  const ctx={
    uiWorkspace,
    workspaces:{list:{getSnapshot(){return {items:views}}}},
  };
  let fail=false;
  const install=routerFactory();
  const dispose=install(ctx,{
    getState:async()=>{if(fail)throw Error('Backend disconnected');return {registeredWorkspaces:registrations}},
    openRemote:(remote,mode)=>remotes.push({remote,mode}),
    onError:error=>errors.push(error.message||String(error)),
  });
  return {uiWorkspace,locals,remotes,errors,original,dispose,fail:(x)=>{fail=x},registrations};
}
async function settle() {
  await new Promise(resolve=>setImmediate(resolve));
}

test('Desktop native left Workspace click opens Linux Host Agent, never local Agent',async()=>{
  const f=setup();
  await f.uiWorkspace.openWorkspace('remote-1');
  await f.uiWorkspace.openWorkspace('remote-2');
  assert.deepEqual(f.remotes.map(x=>[x.remote.host,x.remote.path,x.mode.intent]),[
    ['linux-a','/data/alpha','resume'],
    ['linux-b','/data/beta','resume'],
  ]);
  assert.deepEqual(f.locals,[],'Linux target must never be opened by Windows uiWorkspace');
  await f.uiWorkspace.openWorkspace('local-1');
  assert.deepEqual(f.locals.map(x=>x.slice(0,2)),[['open','local-1']]);
  assert.equal(f.remotes.length,2);
  f.dispose();
  assert.equal(f.uiWorkspace.openWorkspace,f.original.openWorkspace,'restore original method on plugin unload');
  assert.equal(f.uiWorkspace.startSession,f.original.startSession);
  assert.equal(f.uiWorkspace.connectWorkspace,f.original.connectWorkspace);
});
test('new Session in remote Workspace creates Linux Session, not Windows Agent',async()=>{
  const f=setup();
  f.uiWorkspace.startSession('remote-2');
  await settle();
  assert.deepEqual(f.remotes.map(x=>x.mode.intent),['new']);
  assert.equal(f.locals.length,0);
  f.uiWorkspace.startSession('local-1');
  await settle();
  assert.equal(f.locals[0][0],'new');
  assert.equal(f.locals[0][1],'local-1');
  f.dispose();
});
test('remote Workspace never silently falls back to local Agent if Host mapping disappears',async()=>{
  const f=setup();
  await f.uiWorkspace.openWorkspace('remote-1');
  f.fail(true);
  await assert.rejects(()=>f.uiWorkspace.openWorkspace('remote-1'),/拒绝本地回退/);
  f.uiWorkspace.startSession('remote-2');
  await settle();
  assert.match(f.errors[0],/拒绝本地回退/);
  assert.equal(f.locals.length,0);
  await f.uiWorkspace.openWorkspace('local-1');
  assert.equal(f.locals.length,1,'local Workspace must remain usable when remote backend is offline');
  f.dispose();
});
test('unmapped reserved SSH Workspace blocks local Session creation',async()=>{
  const f=setup([]);
  await assert.rejects(()=>f.uiWorkspace.openWorkspace('remote-1'),/失去远端 Host 映射/);
  await assert.rejects(()=>f.uiWorkspace.connectWorkspace('remote-2'),/失去远端 Host 映射/);
  assert.equal(f.locals.length,0);
  f.dispose();
});
test('old remote Workspace cannot use local connectWorkspace',async()=>{
  const f=setup();
  await assert.rejects(()=>f.uiWorkspace.connectWorkspace('remote-1'),/不能通过本地 connectWorkspace/);
  assert.equal(await f.uiWorkspace.connectWorkspace('local-1'),'local-session');
  assert.deepEqual(f.locals.map(x=>x.slice(0,2)),[['connect','local-1']]);
  f.dispose();
});
test('slow earlier Host selection may not steal a newer native Workspace navigation',async()=>{
  const f=setup();
  const original=f.dispose;
  f.dispose();
  let release;
  const waiting=new Promise(resolve=>{release=resolve});
  const remotes=[],locals=[];
  const uiWorkspace={
    openWorkspace(id){locals.push(id);return Promise.resolve()},
  };
  const install=routerFactory();
  const dispose=install({uiWorkspace,workspaces:{list:{getSnapshot(){return {items:[]}}}}},{
    getState:async()=>{
      const index=callCount++;
      if(index===0)await waiting;
      return {registeredWorkspaces:[{workspaceId:'remote-1',host:'linux-a',remoteRoot:'/data/alpha'}]};
    },
    openRemote:remote=>remotes.push(remote),
  });
  let callCount=0;
  const slow=uiWorkspace.openWorkspace('remote-1');
  const fast=uiWorkspace.openWorkspace('local-1');
  await fast;
  release();
  await slow;
  assert.deepEqual(locals,['local-1']);
  assert.deepEqual(remotes,[]);
  dispose();
});
test('remote workspace local beforeOpen callbacks do not get fake Session ids',async()=>{
  const f=setup();
  await assert.rejects(()=>f.uiWorkspace.openWorkspace('remote-1',()=>{}),/尚不支持本地 Session 回调/);
  assert.equal(f.locals.length,0);
  f.dispose();
});
