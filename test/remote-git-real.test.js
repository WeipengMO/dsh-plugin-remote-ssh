import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectRemoteGit } from '../dist/remote-git.js';

const available=process.platform!=='win32'
  && spawnSync('git',['--version']).status===0
  && spawnSync('bash',['--version']).status===0;

test('read real Git state/history over a Bash-backed fake SSH transport', { skip:!available }, async ()=>{
  const temp=mkdtempSync(path.join(os.tmpdir(),'ssh-git-'));
  const root=path.join(temp,"repo with ' apostrophe");
  mkdirSync(root);
  function git(...argv){
    return execFileSync('git',['-C',root,...argv],{encoding:'utf8'});
  }
  try {
    git('init','-b','main');
    git('config','user.name','Test User');
    git('config','user.email','user@example.test');
    writeFileSync(path.join(root,'source.txt'),'hello\n');
    git('add','source.txt');
    git('commit','-m','Initial remote history');
    appendFileSync(path.join(root,'source.txt'),'staged\n');
    git('add','source.txt');
    appendFileSync(path.join(root,'source.txt'),'unstaged\n');
    const before=statSync(path.join(root,'.git','index')).mtimeMs;
    const commands=[];
    const manager={
      async connection(host){
        assert.equal(host,'linux-host');
        return {exec(command,options){
          commands.push(command);
          return new Promise((resolve,reject)=>{
            execFile('bash',['-lc',command],{timeout:options.timeoutMs,maxBuffer:options.maxBytes},
              (error,stdout,stderr)=>{
                if(error && typeof error.code!=='number') return reject(error);
                resolve({code:error?.code??0,stdout,stderr,truncated:false});
              });
          });
        }};
      },
    };
    const snap=await inspectRemoteGit(manager,'linux-host',root,5);
    assert.equal(snap.isRepository,true);
    assert.match(snap.status,/MM source\.txt/);
    assert.match(snap.diffStat,/source\.txt/);
    assert.match(snap.stagedDiffStat,/source\.txt/);
    assert.equal(snap.history.length,1);
    assert.equal(snap.history[0].subject,'Initial remote history');
    assert.equal(snap.directory,root);
    assert.equal(statSync(path.join(root,'.git','index')).mtimeMs,before,
      'status/log/diff reads must not update the remote Git index');
    assert.equal(commands.length,4);
    assert.ok(commands.every(command=>command.includes("cd -- '/")));
  } finally {
    rmSync(temp,{recursive:true,force:true});
  }
});
