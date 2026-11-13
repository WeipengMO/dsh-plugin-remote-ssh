import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const bundled = fs.readFileSync(path.join(root, 'lib/client.js'), 'utf8');
const source = fs.readFileSync(path.join(root, 'src/client-web.js'), 'utf8');

test('generated client bundle carries package version, not a stale release version', () => {
  assert.ok(
    bundled.includes('const CLIENT_VERSION = ' + JSON.stringify(manifest.version) + ';'),
    'run pnpm build before packing or committing the client bundle',
  );
});

function getBuildWarning() {
  const start = source.indexOf('    function buildWarningForState(next) {');
  const end = source.indexOf('    const iconPaths = {', start);
  assert.ok(start >= 0 && end > start, 'compatibility checker must be defined in the client bundle');
  return vm.runInNewContext(`(() => {
    const CLIENT_VERSION = ${JSON.stringify(manifest.version)};
    const CLIENT_API_VERSION = 1;
    ${source.slice(start, end)}
    return buildWarningForState;
  })()`);
}

test('host-only package version changes with unchanged API do not warn', () => {
  const warn = getBuildWarning();
  assert.equal(warn({ version: '2.9.0', apiVersion: 1 }), '');
  assert.equal(warn({ version: '1.0.0', apiVersion: 1 }), '');
});

test('incompatible or malformed API versions still trigger a warning', () => {
  const warn = getBuildWarning();
  assert.match(warn({ version: manifest.version, apiVersion: 2 }), /API 与界面不兼容/);
  assert.match(warn({ version: manifest.version, apiVersion: '1' }), /API 与界面不兼容/);
});

test('legacy hosts without API version are detected conservatively', () => {
  const warn = getBuildWarning();
  assert.equal(warn({ version: manifest.version }), '');
  assert.match(warn({ version: '1.0.0' }), /旧插件/);
  assert.match(warn({}), /旧插件/);
});
