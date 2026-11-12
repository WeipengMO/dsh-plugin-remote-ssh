import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectRemoteGit } from '../dist/remote-git.js';

function mock(outcomes={}){
  const calls=[];
  const manager={async connection(host){
    assert.equal(host,'gpu-host');
    return {async exec(command,options){
      calls.push({command,options});
      const type=command.includes("'status'")?'status':
        command.includes("'log'")?'log':'diff';
      return outcomes[type]??(type==='status'?
        {code:0,stdout:'## feature...origin/feature\n M src/app.py\n',stderr:'',truncated:false}:
        type==='log'?
        {code:0,stdout:'a1b2c3\t2026-11-10\tFix SSH routing\nf0e1d2\t2026-11-09\tInitial commit\n',stderr:'',truncated:false}:
        {code:0,stdout:' src/app.py | 2 ++\n 1 file changed\n',stderr:'',truncated:false});
    }};
  }};
  return {manager,calls};
}
test('read-only SSH Git snapshots include status, commit history and diff from Linux cwd',async()=>{
  const {manager,calls}=mock();
  const result=await inspectRemoteGit(manager,'gpu-host','/home/research/project',20);
  assert.equal(result.isRepository,true);
  assert.match(result.status,/M src\/app.py/);
  assert.equal(result.history.length,2);
  assert.equal(result.history[0].subject,'Fix SSH routing');
  assert.match(result.diffStat,/1 file changed/);
  assert.equal(typeof result.stagedDiffStat,'string');
  assert.equal(calls.length,4);
  assert.ok(calls.every(c=>c.command.includes("cd -- '/home/research/project'")));
  assert.ok(calls.every(c=>c.command.includes('GIT_OPTIONAL_LOCKS=0')));
   assert.ok(calls.every(c=>c.command.includes('core.quotepath=false')));
  assert.ok(calls.every(c=>c.command.includes("core.fsmonitor=false")));
  assert.ok(calls.every(c=>c.command.includes("exec env")));
  assert.ok(calls.every(c=>!c.command.includes('dsh ')));
});
test('Git snapshot refuses Windows paths and invalid history limits',async()=>{
  const f=mock();
  await assert.rejects(()=>inspectRemoteGit(f.manager,'gpu-host','C:\\git'),/absolute Linux/);
  await assert.rejects(()=>inspectRemoteGit(f.manager,'gpu-host','/repo',51),/between 1 and 50/);
  assert.equal(f.calls.length,0);
});
test('non-repository SSH folders report no history and do not attempt git log/diff',async()=>{
  const f=mock({status:{code:128,stdout:'',stderr:'fatal: not a git repository',truncated:false}});
  const result=await inspectRemoteGit(f.manager,'gpu-host','/data');
  assert.equal(result.isRepository,false);
  assert.deepEqual(result.history,[]);
  assert.equal(f.calls.length,1);
});
test('no HEAD yet is not a Git connection error',async()=>{
  const f=mock({log:{code:128,stdout:'',stderr:"fatal: your current branch 'main' does not have any commits yet",truncated:false}});
  const result=await inspectRemoteGit(f.manager,'gpu-host','/repo');
  assert.equal(result.isRepository,true);
  assert.deepEqual(result.history,[]);
});
test('Git status cannot hide truncated output or failures',async()=>{
  const f=mock({status:{code:0,stdout:'huge',stderr:'',truncated:true}});
  await assert.rejects(()=>inspectRemoteGit(f.manager,'gpu-host','/repo'),/output limit/);
});
