import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const helper=fileURLToPath(new URL('../runtime/agent.mjs',import.meta.url));
function invoke(method,cwd,env) {
  const id='req-'+Math.random().toString(16).slice(2);
  const request=Buffer.from(JSON.stringify({protocol:1,id,method,cwd,installIfMissing:false})).toString('base64url');
  const result=spawnSync(process.execPath,[helper,request],{encoding:'utf8',timeout:18000,env});
  assert.equal(result.status,0,result.stderr);
  const parsed=JSON.parse(result.stdout);
  assert.equal(parsed.id,id);
  return parsed;
}
test('remote DSH auto-start launches private loopback and reuses its verified URL',async t=>{
  // webEnsure requires a POSIX home and launches a POSIX-shell fake `dsh`.
  if (process.platform==='win32') {t.skip('web.ensure fixtures require a POSIX home/shell; Linux CI runs them');return;}
  const [major,minor]=process.versions.node.split('.').map(Number);
  if (major<24||(major===24&&minor<9)) {t.skip('requires Node >=24.9');return;}
  const home=mkdtempSync(join(tmpdir(),'dsh-web-host-test-'));
  const repo=join(home,'source');
  const secondRepo=join(home,'other-project');
  const bin=join(home,'bin');
  mkdirSync(repo);
  mkdirSync(secondRepo);
  mkdirSync(bin);
  const fake=join(bin,'dsh');
  writeFileSync(fake,[
    '#!/usr/bin/env node',
    "const http=require('node:http');",
    "const argv=process.argv;",
    "const port=Number(argv[argv.indexOf('--port')+1]);",
    "const server=http.createServer((_req,res)=>{res.end('remote agent host');});",
    "server.listen(port,'127.0.0.1',()=>{console.log('dsh web: http://127.0.0.1:'+port+'/?token=test-secret');});",
    '',
  ].join('\n'),{mode:0o755});
  const env={...process.env,HOME:home,PATH:bin+':'+process.env.PATH};
  let pid;
  try {
    let response=invoke('web.ensure',repo,env);
    assert.equal(response.ok,true,JSON.stringify(response.error));
    assert.equal(response.result.phase,'starting');
    for(let i=0;i<30;i++){
      await new Promise(resolve=>setTimeout(resolve,250));
      response=invoke('web.ensure',repo,env);
      if(response.ok&&response.result.phase==='ready')break;
    }
    assert.equal(response.ok,true,JSON.stringify(response.error));
    assert.equal(response.result.phase,'ready');
    assert.match(response.result.url,/^http:\/\/127\.0\.0\.1:\d+\/\?token=test-secret$/);
    const body=await (await fetch('http://127.0.0.1:'+response.result.port)).text();
    assert.equal(body,'remote agent host');
    const firstPort=response.result.port;
    const second=invoke('web.ensure',secondRepo,env);
    assert.equal(second.ok,true,JSON.stringify(second.error));
    assert.equal(second.result.phase,'ready','another project must reuse the same DSH Host');
    assert.equal(second.result.cwd,secondRepo,'validate and preserve the requested project identity');
    assert.equal(second.result.port,firstPort,'one remote OS user has one Host listener');
    assert.equal(second.result.url,response.result.url,'all Sessions use the same Core Host');
    const state=JSON.parse(readFileSync(join(home,'.cache','dsh-remote-ssh','web','v2','host','state.json'),'utf8'));
    assert.equal(state.port,firstPort);
    assert.equal(state.cwd,home,'Host lifecycle is independent of the selected project');
    pid=state.pid;
  } finally {
    if(pid){try{process.kill(-pid,'SIGTERM');}catch{};try{process.kill(pid,'SIGTERM');}catch{}}
    rmSync(home,{recursive:true,force:true});
  }
});
