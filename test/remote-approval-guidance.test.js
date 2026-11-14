import test from 'node:test';
import assert from 'node:assert/strict';
import { registerManagementTools, registerRemoteBashTool, remoteWorkspaceShellGuidance } from '../dist/tools.js';
import { encodeVirtualPath, workspaceToken } from '../dist/paths.js';

const root = '/srv/test-project';
const home = '/home/test-user';
const token = workspaceToken('integration-test-host', root);
const cwd = encodeVirtualPath(token, root);
const workspace = {
  token, remoteRoot: root, remoteHome: home,
  hostLabel: 'test-host', connectionId: 'test-host-id',
};

function routeFor(pathValue) {
  const requested = pathValue === '.' || pathValue === cwd
    ? root
    : pathValue === 'src'
      ? root + '/src'
      : pathValue;
  if (!requested.startsWith('/')) return null;
  return {
    workspace, remotePath: requested,
    virtualPath: encodeVirtualPath(token, requested),
  };
}

function makeHarness({ approvalResult = 'allowed-once', approvalAvailable = true, readOnly = false } = {}) {
  let tool;
  let calls = 0;
  let executed = 0;
  const requests = [];
  const logs = [];
  const agent = { id: 'test-agent', session: { id: 'test-session' } };
  const ctx = {
    tools: { register(definition) { if (definition.name === 'remote_bash') tool = definition; } },
    workingDirectory: { get: () => cwd },
    shell: {
      resolve(request) { return request; },
      async execute(spec) {
        executed++;
        assert.equal(spec.workdir, cwd);
        return { async result() {
          return {
            exitCode: 0, stdout: { text: root + '\n', truncated: false },
            stderr: { text: '', truncated: false }, timedOut: false,
          };
        } };
      },
    },
    get(name) {
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode: readOnly ? 'read-only' : 'workspace-write' }) };
      if (name !== 'approval' || !approvalAvailable) return undefined;
      return { async request(request) {
        calls++;
        requests.push(request);
        return typeof approvalResult === 'function' ? await approvalResult(request) : approvalResult;
      } };
    },
    logger: {
      info(message) { logs.push({ level: 'info', message }); },
      warn(message) { logs.push({ level: 'warn', message }); },
    },
  };
  registerRemoteBashTool(ctx, { routeFor }, 'session');
  assert.ok(tool, 'remote_bash was registered');
  return {
    invoke(args = {}, options = {}) {
      return tool.execute({ command: 'pwd', ...args }, { agent, callId: 'tool-call-test', ...options });
    },
    get calls() { return calls; },
    get executed() { return executed; },
    requests, logs, tool,
  };
}

test('remote prompt uses resolved project root instead of login home and stays remote-only', () => {
  const data = { remoteCwd: root + '/src', remoteRoot: root, remoteHome: home };
  const guidance = remoteWorkspaceShellGuidance(cwd, data);
  assert.match(guidance, /remote_bash/);
  assert.match(guidance, /run_code/);
  assert.match(guidance, /danger-full-access/);
  assert.match(guidance, /project root="\/srv\/test-project"/);
  assert.match(guidance, /login home="\/home\/test-user"/);
  assert.match(guidance, /workdir/);
  assert.equal(remoteWorkspaceShellGuidance('/tmp/local-project', data), '');

  const sections = [];
  const ctx = {
    tools: { register() {} },
    workingDirectory: { get: () => cwd },
    systemPrompt: { section(definition) { sections.push(definition); } },
    on: () => () => {},
  };
  const manager = { routeFor };
  registerManagementTools(ctx, manager, {});
  assert.equal(sections.length, 1);
  assert.match(sections[0].text({ agent: { session: {} } }), /selected remote project root="\/srv\/test-project"/);
  assert.equal(sections[0].text({}), '');
});

test('one remote Bash approval is reused for the same agent/workspace, and stages are logged', async () => {
  const h = makeHarness();
  const one = await h.invoke();
  assert.equal(one.exitCode, 0);
  assert.equal(one.stdout, root + '\n');
  assert.equal(h.calls, 1);
  assert.equal(h.executed, 1);
  assert.equal(h.requests[0].toolName, 'remote_bash');
  assert.equal(h.requests[0].callId, 'tool-call-test');
  assert.match(h.requests[0].reason, /SSH account permissions/);
  assert.equal((await h.invoke()).exitCode, 0);
  assert.equal(h.calls, 1, 'reused per-session approval');
  assert.equal(h.executed, 2);
  assert.ok(h.logs.some(x => x.message.includes('awaiting user approval')));
  assert.ok(h.logs.some(x => x.message.includes('approval allowed-once after')));
  assert.equal(h.logs.filter(x => x.message.includes('execution started')).length, 2);
  assert.ok(h.logs.every(x => !x.message.includes('pwd') && !x.message.includes(home)));
});

test('SSH approval rejection/cancellation/unavailability stops before execution', async () => {
  for (const [outcome, expected] of [
    ['rejected', /not executed/],
    ['cancelled', /cancelled before command execution/],
    ['unavailable', /approval UI\/answerer is unavailable/],
  ]) {
    const h = makeHarness({ approvalResult: outcome });
    await assert.rejects(() => h.invoke(), error =>
      error.code === 'SSH_APPROVAL_DENIED' && expected.test(error.message));
    assert.equal(h.calls, 1, outcome);
    assert.equal(h.executed, 0, outcome);
    assert.ok(h.logs.some(x => x.message.includes('approval ' + outcome)), outcome);
  }

  const h = makeHarness({ approvalAvailable: false });
  await assert.rejects(() => h.invoke(), error => error.code === 'SSH_APPROVAL_DENIED');
  assert.equal(h.executed, 0);
});

test('aborted approval never starts a remote command or grants a session permission', async () => {
  let answer;
  const pending = new Promise(resolve => { answer = resolve; });
  const h = makeHarness({ approvalResult: () => pending });
  const controller = new AbortController();
  const running = h.invoke({}, { signal: controller.signal });
  assert.equal(h.calls, 1);
  controller.abort();
  answer('cancelled');
  await assert.rejects(() => running, error =>
    error.code === 'SSH_APPROVAL_DENIED' && /cancelled before command execution/.test(error.message));
  assert.equal(h.executed, 0);
  assert.ok(h.logs.some(x => x.message.includes('approval cancelled')));
});

test('out-of-project workdirs and read-only mode fail closed without requesting approval', async () => {
  const h = makeHarness();
  await assert.rejects(() => h.invoke({ workdir: home }), error =>
    error.code === 'SSH_PATH_INVALID' && /selected remote project/.test(error.message));
  assert.equal(h.calls, 0);
  assert.equal(h.executed, 0);

  const readOnly = makeHarness({ readOnly: true });
  await assert.rejects(() => readOnly.invoke(), error =>
    error.code === 'SSH_REMOTE_SHELL_FAILED' && /read-only/.test(error.message));
  assert.equal(readOnly.calls, 0);
  assert.equal(readOnly.executed, 0);
});

test('late approval after outer run_code cancellation never executes or caches permission', async () => {
  const controller = new AbortController();
  const h = makeHarness({ approvalResult: async () => {
    controller.abort();
    return 'allowed-once';
  } });
  await assert.rejects(() => h.invoke({}, { signal: controller.signal }), error =>
    error.code === 'SSH_APPROVAL_DENIED' && /arrived after caller cancellation/.test(error.message));
  assert.equal(h.executed, 0);
  assert.equal(h.calls, 1);
  assert.ok(h.logs.some(x => x.message.includes('ignored late approval')));
  // A later explicit user-requested attempt must ask again, never reuse a
  // grant from the cancelled request.
  await h.invoke();
  assert.equal(h.calls, 2);
  assert.equal(h.executed, 1);
});
