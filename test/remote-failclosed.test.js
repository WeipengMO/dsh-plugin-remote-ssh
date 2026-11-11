import test from 'node:test';
import assert from 'node:assert/strict';
import { guardWorkingDirectory } from '../dist/index.js';
import { workspacePlaceholderPath } from '../dist/paths.js';

test('SSH failure retains remote cwd instead of silently transitioning to Windows local', async () => {
  const cwd = workspacePlaceholderPath('w0123456789abcdef');
  let localChanges = 0, nativeEnsures = 0;
  const wd = {
    get() { return cwd; },
    async set() { localChanges++; return '/local/project'; },
    async ensure() { nativeEnsures++; return '/local/project'; },
  };
  const original = wd.ensure;
  const warnings = [];
  const restore = guardWorkingDirectory({
    workingDirectory: wd,
    fs: { async resolve() { throw new Error('SSH lost'); } },
    logger: { warn(m) { warnings.push(m); } },
  });
  const output = await wd.ensure({ session: { header: { cwd: '/local/project' } } });
  assert.equal(output, cwd);
  assert.equal(localChanges, 0);
  assert.equal(nativeEnsures, 0);
  assert.equal(warnings.length, 1);
  restore();
  assert.notEqual(wd.ensure, undefined);
});
