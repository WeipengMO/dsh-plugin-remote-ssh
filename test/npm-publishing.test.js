import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/build.yml'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const docs = fs.readFileSync(path.join(root, 'docs/npm-publishing.md'), 'utf8');

test('npm metadata identifies the canonical public repository and package', () => {
  assert.equal(manifest.name, 'dsh-plugin-remote-ssh');
  assert.equal(manifest.repository.type, 'git');
  assert.equal(manifest.repository.url, 'git+https://github.com/WeipengMO/dsh-plugin-remote-ssh.git');
  assert.equal(manifest.publishConfig.access, 'public');
  assert.equal(manifest.publishConfig.registry, 'https://registry.npmjs.org');
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(manifest.exports['./client'].default, './lib/client.js');
});

test('npm publishing is gated on new successful main release and explicit repo opt-in', () => {
  const section = workflow.split('\n  npm_publish:\n')[1];
  assert.ok(section, 'separate npm publish job must exist');
  assert.match(section, /needs: \[build, release\]/);
  assert.match(section, /github\.event_name == 'push'/);
  assert.match(section, /github\.ref == 'refs\/heads\/main'/);
  assert.match(section, /github\.repository == 'WeipengMO\/dsh-plugin-remote-ssh'/);
  assert.match(section, /vars\.NPM_PUBLISH_ENABLED == 'true'/);
  assert.match(section, /needs\.release\.outputs\.published == 'true'/);
  assert.match(workflow, /release:[\s\S]*?published: \$\{\{ steps\.tag_check\.outputs\.publish \}\}/);
});

test('the npm job uses OIDC and the exact verified installer artifact', () => {
  const section = workflow.split('\n  npm_publish:\n')[1];
  assert.match(section, /id-token: write/);
  assert.match(section, /node-version: '24'/);
  assert.match(section, /package-manager-cache: false/);
  assert.match(section, /npm install --global npm@11\.21\.0/);
  assert.match(section, /name: dsh-remote-ssh-\$\{\{ github\.sha \}\}/);
  assert.match(section, /tar -xOzf "\$file" package\/package\.json/);
  assert.match(section, /npm publish "artifacts\/dsh-plugin-remote-ssh-\$\{version\}\.tgz" --access public --tag latest --ignore-scripts/);
  assert.match(section, /npm view "dsh-plugin-remote-ssh@\$\{version\}" version --silent/);
  assert.doesNotMatch(section, /secrets\.NPM_TOKEN|NODE_AUTH_TOKEN|--\/\/registry\.npmjs\.org/);
});

test('GitHub Release retains the previously validated installer', () => {
  const release = workflow.split('\n  release:\n')[1].split('\n  npm_publish:\n')[0];
  assert.match(release, /uses: actions\/download-artifact@v4/);
  assert.match(release, /name: dsh-remote-ssh-\$\{\{ github\.sha \}\}/);
  assert.match(release, /uses: softprops\/action-gh-release@v2/);
  assert.match(release, /files: artifacts\/\*\.tgz/);
});

test('onboarding instructions do not claim npm is live without ownership and trust', () => {
  assert.match(docs, /首次人工发布/);
  assert.match(docs, /Trusted Publisher/);
  assert.match(docs, /NPM_PUBLISH_ENABLED/);
  assert.match(docs, /build\.yml/);
  assert.match(docs, /已经.*\.tgz|\.tgz.*安装/);
});
