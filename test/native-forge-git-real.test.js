import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installNativeGitRouter } from '../dist/native-git-router.js';
import { workspacePlaceholderPath } from '../dist/paths.js';

const available=process.platform!=='win32'
  && spawnSync('git',['--version']).status===0
  && spawnSync('bash',['--version']).status===0;

test('real Forge Git read-only checkout inspection works over SSH virtual cwd', {skip:!available},async()=>{
  const directory=mkdtempSync(join(tmpdir(),'remote-forge-'));
  const remote=join(directory,"Git project's code");
  mkdirSync(remote);
  const git=(...args)=>execFileSync('git',['-C',remote,...args],{encoding:'utf8'}).trim();
  let router;
  try{
    git('init','-b','main');
    git('config','user.name','Test');
    git('config','user.email','test@example.invalid');
    writeFileSync(join(remote,'README.md'),'test\n');
    git('add','README.md');
    git('commit','-m','Test native Forge via SSH');

    const virtual=workspacePlaceholderPath('w0123456789abcdef');
    const outgoing=[];
    const subprocess={spawn(){throw Error('local Git MUST NOT execute in virtual workspace')}};
    const manager={
      routeFor(cwd){
        assert.equal(cwd,virtual);
        return {remotePath:remote,workspace:{connectionId:'ssh-host',token:'w0123456789abcdef'}};
      },
      async connection(id){
        assert.equal(id,'ssh-host');
        return {exec(command,opts){
          outgoing.push(command);
          return new Promise((resolve,reject)=>{
            execFile('bash',['-lc',command],
              {timeout:opts.timeoutMs,maxBuffer:opts.maxBytes},
              (error,stdout,stderr)=>{
                if(error&&typeof error.code!=='number')return reject(error);
                resolve({code:error?.code??0,signal:null,stdout,stderr,truncated:false});
              });
          });
        }};
      },
    };
    router=installNativeGitRouter(subprocess,manager);
    const wrapper=[
      'C:\\Program Files\\nodejs\\node.exe',
      'C:\\DSH\\sandbox\\runner.js',
      '--workspace',virtual,'--mode','read-only','--',
      'C:\\Program Files\\Git\\cmd\\git.exe',
    ];
    const prefix=['--no-optional-locks','-c','core.hooksPath=/dev/null',
      '-c','core.fsmonitor=false'];
    const probes=[
      [...wrapper,...prefix,'rev-parse','--show-toplevel'],
      ['git','rev-parse','--path-format=absolute','--git-common-dir'],
      ['git','rev-parse','--path-format=absolute','--git-dir'],
      ['git','symbolic-ref','--quiet','--short','HEAD'],
      ['git','rev-parse','--short','HEAD'],
      ['git','remote','-v'],
      ['git','log','--oneline','-1'],
    ];
    const results=[];
    for(const argv of probes){
      const process=subprocess.spawn({argv,cwd:virtual,env:{},
        stdio:{stdin:'ignore',stdout:{maxBytes:65536},stderr:{maxBytes:65536}}});
      const completion=await process.done;
      assert.equal(completion.exitCode,0);
      results.push(process.collected.stdout.readFrom(0).text.trim());
    }
    assert.equal(results[0],remote);
    assert.equal(results[3],'main');
    assert.ok(results[4].length>=4);
    assert.match(results[6],/Test native Forge via SSH/);
    assert.equal(outgoing.length,probes.length);
    assert.ok(outgoing.every(command=>command.includes("core.hooksPath=/dev/null")));
    assert.ok(outgoing.every(command=>command.includes("core.fsmonitor=false")));
    assert.ok(outgoing.every(command=>command.includes("GIT_OPTIONAL_LOCKS=0")));
    assert.throws(()=>subprocess.spawn({
      argv:['git','reset','--hard'],cwd:virtual,env:{},
      stdio:{stdin:'ignore',stdout:{maxBytes:65536},stderr:{maxBytes:65536}},
    }),/Remote Git\/Forge query blocked/);
    assert.equal(outgoing.length,probes.length,'blocked mutating commands are never sent to Linux');
  } finally {
    router?.dispose();
    rmSync(directory,{recursive:true,force:true});
  }
});
