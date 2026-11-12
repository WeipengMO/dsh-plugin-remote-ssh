import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSshArgv, usesPowerShellSyntax } from '../dist/shell-router.js';
import { remoteWorkspaceShellGuidance } from '../dist/tools.js';
import { workspacePlaceholderPath } from '../dist/paths.js';

const connection={
  config:{
    hostName:'linux.example.net',user:'researcher',port:22,identityFiles:[],
    connectTimeoutSec:10,serverAliveIntervalSec:10,serverAliveCountMax:3,
    identitiesOnly:false,
  },
};
const spec={
  command:'pwd; echo $HOME; git status --short',
  workdir:'/home/researcher/project',
  timeoutMs:10000,onExpiry:'kill',stdoutMaxBytes:20000,
  env:{
    PATH:'C:\\Windows\\System32',PSModulePath:'C:\\Windows\\PowerShell',
    COMSPEC:'C:\\Windows\\System32\\cmd.exe',
    USERPROFILE:'C:\\Users\\test',DSH_SESSION_ID:'session1',
  },
};
test('Windows shell tools execute SSH workspaces with Linux bash, not pwsh',()=>{
  const argv=buildSshArgv(connection,'/tmp/verified_known_hosts',spec);
  const remote=argv.at(-1);
  assert.match(remote,/bash -lc/);
  assert.match(remote,/pwd; echo \$HOME; git status --short/);
  assert.match(remote,/DSH_REMOTE_PLATFORM='linux'/);
  assert.match(remote,/DSH_REMOTE_SHELL='bash'/);
  assert.match(remote,/DSH_SESSION_ID='session1'/);
  assert.doesNotMatch(remote,/C:\\Windows|PSModulePath|COMSPEC|USERPROFILE|pwsh|PowerShell/i);
  assert.ok(argv.includes('StrictHostKeyChecking=yes'));
});
test('only remote SSH sessions get Bash guidance; local sessions retain Windows shell',()=>{
  const ssh=remoteWorkspaceShellGuidance(workspacePlaceholderPath('w0123456789abcdef'));
  assert.match(ssh,/Bash\/POSIX/);
  assert.match(ssh,/Windows PowerShell/);
  assert.match(ssh,/remote_ssh_git/);
  assert.equal(remoteWorkspaceShellGuidance('C:\\Users\\test\\repo'),'');
});

test('PowerShell-only command text is diagnosed before SSH execution',()=>{
  assert.equal(usesPowerShellSyntax('Get-ChildItem -Recurse'),true);
  assert.equal(usesPowerShellSyntax('echo $env:PATH'),true);
  assert.equal(usesPowerShellSyntax('pwd && ls -la'),false);
  assert.equal(usesPowerShellSyntax('git log --oneline -5'),false);
});
