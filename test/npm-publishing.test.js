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
  assert.match(section, /needs\.release\.outputs\.npm_eligible == 'true'/);
  assert.match(workflow, /release:[\s\S]*?published: \$\{\{ steps\.tag_check\.outputs\.publish \}\}/);
});

test('the npm job uses OIDC and the exact verified installer artifact', () => {
  const section = workflow.split('\n  npm_publish:\n')[1];
  assert.match(section, /id-token: write/);
  assert.match(section, /node-version: '24'/);
  assert.match(section, /package-manager-cache: false/);
  assert.match(section, /npm install --global npm@11\.21\.0/);
  assert.match(section, /uses: actions\/download-artifact@v8/);
  assert.match(section, /name: dsh-plugin-remote-ssh-\$\{\{ needs\.build\.outputs\.package_version \}\}\.tgz/);
  assert.match(section, /tar -xOzf "\$file" package\/package\.json/);
  assert.match(section, /file="\.\/artifacts\/dsh-plugin-remote-ssh-\$\{version\}\.tgz"/);
  assert.match(section, /npm publish "\$file" --access public --tag latest --ignore-scripts/);
  assert.match(section, /npm view "dsh-plugin-remote-ssh@\$\{version\}" version --silent/);
  assert.doesNotMatch(section, /secrets\.NPM_TOKEN|NODE_AUTH_TOKEN|--\/\/registry\.npmjs\.org/);
});

test('GitHub Release retains the previously validated installer', () => {
  const release = workflow.split('\n  release:\n')[1].split('\n  npm_publish:\n')[0];
  assert.match(release, /uses: actions\/download-artifact@v8/);
  assert.match(release, /name: dsh-plugin-remote-ssh-\$\{\{ needs\.build\.outputs\.package_version \}\}\.tgz/);
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

test('PR installer is uploaded directly only after package security checks', () => {
  const build = workflow.split('\n  build:\n')[1].split('\n  release:\n')[0];
  assert.match(build, /uses: actions\/upload-artifact@v7/);
  assert.match(build, /archive: false/);
  assert.match(build, /path: artifacts\/dsh-plugin-remote-ssh-\$\{\{ steps\.version\.outputs\.version \}\}\.tgz/);
  assert.match(build, /pnpm audit --prod --audit-level high/);
  assert.match(build, /sudo freshclam --stdout/);
  assert.match(build, /clamscan --recursive --infected/);
  assert.match(build, /clamscan --infected "\$package_file"/);
  assert.ok(build.indexOf('Audit production dependencies') < build.indexOf('Upload verified installer'));
  assert.ok(build.indexOf('Malware-scan packaged installer') < build.indexOf('Upload verified installer'));
});

test('existing tagged release permits npm retry only after exact release asset digest comparison', () => {
  const release = workflow.split('\n  release:\n')[1].split('\n  npm_publish:\n')[0];
  assert.match(release, /npm_eligible: \$\{\{ steps\.tag_check\.outputs\.npm_eligible \}\}/);
  assert.match(release, /EXPECTED_DIGEST: sha256:\$\{\{ needs\.build\.outputs\.installer_sha256 \}\}/);
  assert.match(release, /asset_digest=.*gh api/);
  assert.match(release, /\[ "\$asset_digest" = "\$EXPECTED_DIGEST" \]/);
  assert.match(release, /npm_eligible=false/);
  assert.match(release, /npm_eligible=true/);
  assert.match(release, /needs: \[build, verify_artifact\]/);
});

test('npm staged package processing is not republished indefinitely and registry digest is verified', () => {
  const section = workflow.split('\n  npm_publish:\n')[1];
  assert.match(section, /Cannot publish over previously staged version/);
  assert.match(section, /if grep -q/);
  assert.match(section, /else\s+exit 1/);
  assert.match(section, /for attempt in \$\(seq 1 36\)/);
  assert.match(section, /npm view "dsh-plugin-remote-ssh@\$\{version\}" dist\.shasum --silent/);
  assert.match(section, /expected_sha1="\$\(sha1sum "\$file"/);
  assert.match(section, /\[ "\$actual_sha1" = "\$expected_sha1" \]/);
  assert.match(section, /npm did not expose the validated version after the registry visibility retry budget/);
});
