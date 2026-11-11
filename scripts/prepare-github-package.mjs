/**
 * Turn a tested, DSH-installable npm tarball (unscoped package name) into a
 * separately named GitHub Packages npm distribution.
 *
 * Never modify the source package or the original .tgz used by dsh plugin add.
 * The scoped distribution has its own package metadata AND Cordis patch name.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const sourcePackage = 'dsh-plugin-remote-ssh';
export const registryPackage = '@weipengmo/dsh-plugin-remote-ssh';
const repo = 'WeipengMO/dsh-plugin-remote-ssh';

export function selectPublishVersion(sourceVersion, { refType, refName, runNumber, runAttempt }) {
  if (!/^\d+\.\d+\.\d+$/.test(sourceVersion)) {
    throw new Error('package.json version must use plain X.Y.Z SemVer');
  }
  if (refType === 'tag') {
    if (refName !== 'v' + sourceVersion) {
      throw new Error('Git tag ' + refName + ' does not match package.json version v' + sourceVersion);
    }
    return { version: sourceVersion, distTag: 'latest' };
  }
  if (refType !== 'branch' || refName !== 'main') {
    throw new Error('GitHub Packages may only be published from main or an exact version tag');
  }
  if (!/^[1-9]\d*$/.test(String(runNumber)) || !/^[1-9]\d*$/.test(String(runAttempt))) {
    throw new Error('runNumber and runAttempt must be positive integers');
  }
  const [major, minor, patch] = sourceVersion.split('.').map(Number);
  const nextPatch = [major, minor, patch + 1].join('.');
  return {
    version: nextPatch + '-dev.' + runNumber + '.' + runAttempt,
    distTag: 'next',
  };
}

export function prepareGithubPackage(directory, env) {
  const packageFile = path.join(directory, 'package.json');
  const patchFile = path.join(directory, 'cordis.patch.yml');
  if (!fs.statSync(directory).isDirectory()) throw new Error('staging root must be a directory');
  const manifest = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  if (manifest.name !== sourcePackage) throw new Error('unexpected source package name: ' + manifest.name);
  if (env.GITHUB_REPOSITORY !== repo) {
    throw new Error('refusing to publish a package for an unexpected repository');
  }
  for (const required of ['dist/index.js', 'lib/client.js', 'cordis.patch.yml', 'vendor/ssh2']) {
    if (!fs.existsSync(path.join(directory, required))) throw new Error('missing distribution asset: ' + required);
  }
  const selected = selectPublishVersion(manifest.version, {
    refType: env.GITHUB_REF_TYPE,
    refName: env.GITHUB_REF_NAME,
    runNumber: env.GITHUB_RUN_NUMBER,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
  });

  const patch = fs.readFileSync(patchFile, 'utf8');
  const matched = patch.match(/^\s*name:\s*dsh-plugin-remote-ssh\s*$/gm) ?? [];
  if (matched.length !== 1) throw new Error('expected exactly one unscoped Cordis package name');
  const nextPatch = patch.replace(
    /^(\s*name:\s*)dsh-plugin-remote-ssh(\s*)$/m,
    '$1' + registryPackage + '$2',
  );
  const nextManifest = {
    ...manifest,
    name: registryPackage,
    version: selected.version,
    repository: { type: 'git', url: 'git+https://github.com/' + repo + '.git' },
    homepage: 'https://github.com/' + repo,
    publishConfig: { registry: 'https://npm.pkg.github.com' },
  };
  // Writes only to the temporary extracted copy, never the original installer.
  fs.writeFileSync(patchFile, nextPatch);
  fs.writeFileSync(packageFile, JSON.stringify(nextManifest, null, 2) + '\n');

  return { ...selected, name: registryPackage };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const dir = process.argv[2];
  if (!dir) throw new Error('usage: node scripts/prepare-github-package.mjs <extracted-package-directory>');
  const result = prepareGithubPackage(path.resolve(dir), process.env);
  const lines = ['package_name=' + result.name, 'package_version=' + result.version, 'dist_tag=' + result.distTag];
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, lines.join('\n') + '\n');
  console.log('GitHub npm package prepared: ' + result.name + '@' + result.version + ' (' + result.distTag + ')');
}
