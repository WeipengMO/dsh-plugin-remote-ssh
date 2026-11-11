import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root,'src/client-web.js'),'utf8');
const api = readFileSync(join(root,'src/http-api.ts'),'utf8');

test('Windows DSH source picker is native and supports configured SSH alias import', () => {
  assert.match(source, /function RemoteProjectDirectoryFlow\(props\)/);
  assert.match(source, /state\.aliases\s*\|\|\s*\[\]/);
  assert.match(source, /host\/quick-add/);
  assert.match(source, /在 Desktop 打开工作区/);
  assert.match(source, /setHostProbe/);
  assert.match(source, /onConfirm: verifyHostFingerprint/);
  assert.match(source, /e\.code === 'SSH_HOST_KEY_UNKNOWN'/);
  assert.match(source, /error\.code = data\.code/);
  assert.match(source, /setTab\('files'\)/);
  assert.match(source, /const \[tab, setTab\] = useState\('files'\)/);
});

test('alias quick-add is explicit and does not bypass SSH host-key verification', () => {
  assert.match(api, /route === '\/host\/quick-add'/);
  assert.match(api, /listSshConfigAliases\(\)\.includes\(alias\)/);
  assert.match(api, /useSshConfig: true, useAgent: true/);
  assert.match(api, /manager\.hosts\(\)\.find\(host => host\.host === alias \|\| host\.sshAlias === alias\)/);
  const section = api.slice(api.indexOf("if (route === '/host/quick-add')"),api.indexOf("if (route === '/host/add')"));
  assert.doesNotMatch(section, /trustHostKey|trust.*Host|trustHost/);
  assert.match(section, /alias\.startsWith\('-'\)/);
});
