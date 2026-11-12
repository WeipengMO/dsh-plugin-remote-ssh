import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { listSshConfigAliases, resolveSshConfig } from '../dist/ssh-config.js';
import { validateCloudflaredCommand, cloudflaredProxy } from '../dist/proxy-command.js';
import { buildSshArgv } from '../dist/shell-router.js';

const sample = [
  'Host nansha',
  '  HostName 172.18.50.60',
  '  User mowp',
  String.raw`  IdentityFile C:\Users\windz\.ssh\key\nansha`,
  '',
  'Host ipf',
  '  HostName 172.18.6.205',
  '  User mowp',
  '  ServerAliveInterval 60',
  '  ServerAliveCountMax 30',
  '',
  'Host txcloud',
  '  HostName txcloud.weipmo.de',
  '  User ubuntu',
  '  IdentityFile /home/windz/.ssh/key/txcloud.pem',
  '  ProxyCommand cloudflared access ssh --hostname %h',
  '  ServerAliveInterval 10',
  '',
].join('\r\n');

test('three real-world Windows OpenSSH aliases resolve without manual re-entry', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ssh-config-import-'));
  t.after(() => fs.rmSync(dir, {recursive:true,force:true}));
  const configFile = path.join(dir, 'config');
  fs.writeFileSync(configFile, sample);
  assert.deepEqual(listSshConfigAliases(configFile), ['ipf', 'nansha', 'txcloud']);
  const nansha = resolveSshConfig({host:'nansha',configFile});
  assert.equal(nansha.configFound, true);
  assert.equal(nansha.matchedHostConfig, true);
  assert.equal(nansha.hostName, '172.18.50.60');
  assert.equal(nansha.user,'mowp');
  assert.equal(nansha.port, 22);
  assert.match(nansha.identityFiles[0], /C:\\Users\\windz\\.ssh\\key\\nansha/);
  const ipf = resolveSshConfig({host:'ipf',configFile});
  assert.equal(ipf.hostName, '172.18.6.205');
  assert.equal(ipf.user,'mowp');
  assert.equal(ipf.serverAliveIntervalSec,60);
  assert.equal(ipf.serverAliveCountMax,30);
  const txcloud = resolveSshConfig({host:'txcloud',configFile});
  assert.equal(txcloud.hostName,'txcloud.weipmo.de');
  assert.equal(txcloud.user,'ubuntu');
  assert.equal(txcloud.identityFiles[0],path.normalize('/home/windz/.ssh/key/txcloud.pem'));
  assert.equal(txcloud.proxyCommand,'cloudflared access ssh --hostname %h');
  assert.equal(txcloud.serverAliveIntervalSec,10);
  const cli = buildSshArgv({config:txcloud},'/tmp/knownhosts', {workdir:'/srv/project',command:'pwd'});
  assert.ok(cli.includes('ProxyCommand=cloudflared access ssh --hostname %h'));
});

test('explicit settings are optional overrides; absent values retain SSH config', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-ssh-override-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const configFile=path.join(dir,'config');fs.writeFileSync(configFile,'Host nansha\n  User mowp\n  Port 2255\n  IdentityFile ~/.ssh/id_custom\n');
  const inherited=resolveSshConfig({host:'nansha',configFile});
  assert.equal(inherited.port,2255); assert.equal(inherited.user,'mowp');
  const overridden=resolveSshConfig({host:'nansha',configFile,port:22,user:'root'});
  assert.equal(overridden.port,22); assert.equal(overridden.user,'root');
});

test('Cloudflare ProxyCommand uses restricted no-shell allowlist', () => {
  assert.deepEqual(validateCloudflaredCommand('cloudflared access ssh --hostname %h'),
    ['cloudflared','access','ssh','--hostname','%h']);
  for(const command of [
    'bash -c echo hello',
    'nc %h %p',
    'cloudflared access ssh --hostname %h;touch /tmp/x',
    'cloudflared access ssh --hostname %h && whoami',
  ]) assert.throws(()=>validateCloudflaredCommand(command),error=>error.code==='SSH_PROXY_UNSUPPORTED');
});

test('Cloudflare ProxyCommand socket provides bidirectional byte stream without shell', {skip:process.platform==='win32'}, async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-ssh-cloudflared-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const executable=path.join(dir,'cloudflared');
  fs.writeFileSync(executable, '#!/bin/sh\ncat\n', {mode:0o700});
  const {stream,child}=cloudflaredProxy(`${executable} access ssh --hostname %h`, 'txcloud.weipmo.de');
  t.after(()=>{stream.destroy();child.kill();});
  const received=[];
  const data=new Promise((resolve,reject)=>{stream.on('data',c=>{received.push(c); resolve();});stream.on('error',reject);});
  stream.write(Buffer.from('hello ssh2'));
  await data;
  assert.equal(Buffer.concat(received).toString(),'hello ssh2');
});

test('clearing saved overrides restores config inheritance for an existing host', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'dsh-ssh-manager-updates-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const managerModulePromise = import('../dist/manager.js');
  return managerModulePromise.then(({RemoteSshManager})=>{
    const manager = new RemoteSshManager({storageDir:dir}, {info(){},warn(){},error(){}});
    const added=manager.addHost({host:'example.com',port:22,user:'old',identityFile:'/old/key',useSshConfig:true});
    const updated=manager.updateHost(added.id,{port:null,user:null,identityFile:null});
    assert.equal(Object.hasOwn(updated,'port'),false);
    assert.equal(Object.hasOwn(updated,'user'),false);
    assert.equal(Object.hasOwn(updated,'identityFile'),false);
  });
});


test('imported HostName retains original alias for ProxyCommand and supports form edits', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ssh-form-import-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configFile = path.join(dir, 'config');
  fs.writeFileSync(configFile, sample);
  const imported = resolveSshConfig({
    host: 'txcloud.weipmo.de', sshAlias: 'txcloud',
    user: 'ubuntu', port: 22,
    identityFile: '/home/windz/.ssh/key/txcloud.pem',
    useSshConfig: true, configFile,
  });
  assert.equal(imported.alias, 'txcloud');
  assert.equal(imported.hostName, 'txcloud.weipmo.de');
  assert.equal(imported.proxyCommand, 'cloudflared access ssh --hostname %h');
  const override = resolveSshConfig({
    host: '192.0.2.10', sshAlias: 'txcloud', user: 'other', port: 2222,
    useSshConfig: true, configFile,
  });
  assert.equal(override.hostName, '192.0.2.10');
  assert.equal(override.user, 'other');
  assert.equal(override.port, 2222);
  assert.equal(override.proxyCommand, imported.proxyCommand);
});
