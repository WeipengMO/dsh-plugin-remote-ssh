import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareGithubPackage, selectPublishVersion } from '../scripts/prepare-github-package.mjs';

const patch = [
  '- insert:',
  '    - id: remote-ssh',
  '      name: dsh-plugin-remote-ssh',
  '      config:',
  '        storageDir: ~/.dsh/remote-ssh',
  '',
].join('\n');

function staging(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-github-pkg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of ['dist', 'lib', 'vendor/ssh2']) fs.mkdirSync(path.join(dir, name), { recursive: true });
  for (const name of ['dist/index.js', 'lib/client.js']) fs.writeFileSync(path.join(dir, name), '// built\n');
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), patch);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'dsh-plugin-remote-ssh', version: '1.1.1', main: 'dist/index.js',
    files: ['dist', 'lib', 'vendor/ssh2', 'cordis.patch.yml'],
  }));
  return dir;
}

const mainEnv = {
  GITHUB_REPOSITORY: 'WeipengMO/dsh-plugin-remote-ssh',
  GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'main',
  GITHUB_RUN_NUMBER: '42', GITHUB_RUN_ATTEMPT: '1',
};

test('each main build creates a unique next-tagged prerelease package', () => {
  assert.deepEqual(selectPublishVersion('1.1.1', {
    refType: 'branch', refName: 'main', runNumber: '42', runAttempt: '1',
  }), { version: '1.1.2-dev.42.1', distTag: 'next' });
  assert.equal(selectPublishVersion('1.1.1', {
    refType: 'branch', refName: 'main', runNumber: '42', runAttempt: '2',
  }).version, '1.1.2-dev.42.2');
});

test('tagged releases use the exact source version with latest tag', () => {
  assert.deepEqual(selectPublishVersion('1.1.1', {
    refType: 'tag', refName: 'v1.1.1',
  }), { version: '1.1.1', distTag: 'latest' });
  assert.throws(() => selectPublishVersion('1.1.1', {
    refType: 'tag', refName: 'v1.1.2',
  }), /does not match/);
  assert.throws(() => selectPublishVersion('1.1.1', {
    refType: 'branch', refName: 'feature', runNumber: '42', runAttempt: '1',
  }), /only be published/);
});

test('scoped GitHub package changes only temporary package identity and DSH patch', t => {
  const dir = staging(t);
  const result = prepareGithubPackage(dir, mainEnv);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  assert.deepEqual(result, {
    name: '@weipengmo/dsh-plugin-remote-ssh', version: '1.1.2-dev.42.1', distTag: 'next',
  });
  assert.equal(meta.name, result.name);
  assert.equal(meta.version, result.version);
  assert.equal(meta.main, 'dist/index.js');
  assert.match(meta.repository.url, /github\.com\/WeipengMO\/dsh-plugin-remote-ssh\.git$/);
  assert.equal(meta.publishConfig.registry, 'https://npm.pkg.github.com');
  assert.match(fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8'), /name: @weipengmo\/dsh-plugin-remote-ssh/);
  assert.ok(fs.existsSync(path.join(dir, 'dist/index.js')));
  assert.ok(fs.existsSync(path.join(dir, 'lib/client.js')));
  assert.ok(fs.existsSync(path.join(dir, 'vendor/ssh2')));
});

test('publishing refuses unexpected repository or missing DSH runtime assets', t => {
  const dir = staging(t);
  assert.throws(() => prepareGithubPackage(dir, { ...mainEnv, GITHUB_REPOSITORY: 'untrusted/other' }), /unexpected repository/);
  fs.rmSync(path.join(dir, 'lib/client.js'));
  assert.throws(() => prepareGithubPackage(dir, mainEnv), /missing distribution asset/);
});
