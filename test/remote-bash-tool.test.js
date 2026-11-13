import test from 'node:test';
import assert from 'node:assert/strict';
import { registerRemoteBashTool, installRemoteShellScope, remoteWorkspaceShellGuidance } from '../dist/tools.js';
import { workspacePlaceholderPath, encodeVirtualPath, parseVirtualPath } from '../dist/paths.js';

const workspaceId = 'w0123456789abcdef';
const other = 'wfedcba9876543210';
const remoteCwd = workspacePlaceholderPath(workspaceId);
const localCwd = process.platform === 'win32' ? 'C:\\Users\\dev\\project' : '/home/dev/project';

function fixture() {
  const definitions = new Map();
  const events = new Map();
  const calls = [];
  const approvals = [];
  const state = {
    approvalAvailable: true,
    outcome: 'allowed-once',
    mode: 'workspace-write',
    sandboxAvailable: true,
    onApproval: undefined,
    result: undefined,
  };
  const wd = {
    current: remoteCwd,
    get() { return this.current; },
    async set(_agent, value) { this.current = value; return value; },
  };
  const ctx = {
    tools: { register(definition, options) { definitions.set(definition.name, { definition, options }); return () => {}; } },
    workingDirectory: wd,
    shell: {
      sandboxMode: 'workspace-write',
      resolve(request) {
        calls.push({ kind: 'resolve', request });
        return { ...request, onExpiry: 'kill' };
      },
      async execute(spec) {
        calls.push({ kind: 'execute', spec });
        return { async result() { return state.result ?? { exitCode: 0, timedOut: false, stdout: { text: 'Linux remote output\\n', truncated: false }, stderr: { text: '', truncated: false } }; } };
      },
    },
    get(name) {
      if (name === 'sandboxPolicy' && state.sandboxAvailable) return { resolve: () => ({ mode: state.mode }) };
      if (name === 'approval' && state.approvalAvailable) return {
        async request(request) {
          approvals.push(request);
          if (typeof state.onApproval === 'function') await state.onApproval(request);
          return state.outcome;
        },
      };
      return undefined;
    },
    logger: { warn() {} },
    on(event, handler) { events.set(event, handler); return () => events.delete(event); },
  };
  const manager = {
    routeFor(value, cwd) {
      if (/^[A-Za-z]:[\\\\/]/.test(value)) throw new Error('Windows path is not a remote POSIX path');
      const parsed = parseVirtualPath(value);
      const workspaceToken = value.startsWith('//other/') ? other : (parsed?.workspaceToken ?? workspaceId);
      let remotePath = '/srv/project';
      if (value === '.' || value === remoteCwd || value === cwd && parsed?.placeholder) remotePath = '/srv/project';
      else if (parsed && !parsed.placeholder) remotePath = parsed.remotePath;
      else if (value.startsWith('/')) remotePath = value;
      else remotePath = '/srv/project/' + value;
      return {
        workspace: { token: workspaceToken, remoteRoot: '/srv/project', hostLabel: 'test-ssh-host' },
        remotePath,
        virtualPath: encodeVirtualPath(workspaceToken, remotePath),
      };
    },
  };
  return { ctx, wd, calls, approvals, state, definitions, events, manager };
}

test('remote_bash has a Linux-facing schema and is conditional on the Agent workspace', async () => {
  const { ctx, definitions, manager, wd, calls } = fixture();
  registerRemoteBashTool(ctx, manager);
  const { definition, options } = definitions.get('remote_bash');
  assert.match(definition.description, /Bash/);
  assert.match(definition.description, /POSIX/);
  assert.match(definition.parameters.properties.workdir.description, /remote POSIX/);
  const agent = { id: 'agent-1', session: {} };
  assert.equal(options.when({ agent }), true);
  const output = await definition.execute({ command: 'pwd; ls -la' }, { agent });
  assert.equal(output.cwd, '/srv/project');
  assert.equal(output.exitCode, 0);
  assert.equal(output.timedOut, false);
  assert.equal(output.stdoutTruncated, false);
  assert.equal(output.stdout, 'Linux remote output\\n');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].request.command, 'pwd; ls -la');
  assert.equal(calls[0].request.workdir, encodeVirtualPath(workspaceId, '/srv/project'));
  assert.equal(definition.output.render({}, output)[0].type, 'text');
  wd.current = localCwd;
  assert.equal(options.when({ agent }), false);
  await assert.rejects(() => definition.execute({ command: 'pwd' }, { agent }), /only in an SSH workspace/);
  assert.equal(calls.length, 2, 'no local shell execution occurs');
});

test('remote_bash forbids cross-workspace and local workdir escapes', async () => {
  const { ctx, definitions, manager, calls } = fixture();
  registerRemoteBashTool(ctx, manager);
  const tool = definitions.get('remote_bash').definition;
  const exec = { agent: { id: 'agent-2', session: {} } };
  await assert.rejects(() => tool.execute({ command: 'pwd', workdir: '//other/escape' }, exec), /must belong to the active SSH workspace/);
  await assert.rejects(() => tool.execute({ command: 'pwd', workdir: 'C:\\Windows' }, exec), /remote/);
  await assert.rejects(() => tool.execute({ command: 'pwd', timeoutMs: 0 }, exec), /timeoutMs/);
  await assert.rejects(() => tool.execute({ command: '' }, exec), /non-empty Bash command/);
  assert.equal(calls.length, 0);
});

test('bash/pwsh masking follows the Agent remote/local workspace without affecting other Agents', async () => {
  const { ctx, wd, events } = fixture();
  const changes = [];
  const agent = {
    id: 'remote-agent', session: {},
    ctx: { tools: { restrict(filter) {
      changes.push({ type: 'restrict', filter });
      return () => changes.push({ type: 'restore' });
    } } },
  };
  const localAgent = { id: 'local-agent', session: {}, ctx: { tools: {
    restrict() { throw new Error('local Agent must retain native shell tools'); },
  } } };
  const originalGet = wd.get;
  wd.get = function get(session) {
    return session === localAgent.session ? localCwd : originalGet.call(this, session);
  };
  const originalSet = wd.set;
  const dispose = installRemoteShellScope(ctx);
  events.get('agent/created')({ agent: localAgent });
  assert.deepEqual(changes, [], 'local Agent retains its original shell tools');
  events.get('agent/created')({ agent });
  events.get('agent/created')({ agent });
  assert.equal(changes.length, 1, 'duplicate lifecycle events must not duplicate restrictions');
  assert.deepEqual(changes[0], { type: 'restrict', filter: { deny: ['bash', 'pwsh'] } });
  await wd.set(agent, localCwd);
  assert.deepEqual(changes[1], { type: 'restore' });
  await wd.set(agent, remoteCwd);
  assert.equal(changes.filter(change => change.type === 'restrict').length, 2);
  assert.deepEqual(changes.at(-1), { type: 'restrict', filter: { deny: ['bash', 'pwsh'] } });
  events.get('agent/disposed')({ agent });
  assert.equal(changes.filter(change => change.type === 'restore').length, 2);
  dispose();
  assert.equal(wd.set, originalSet);
  assert.equal(events.size, 0);
  assert.match(remoteWorkspaceShellGuidance(remoteCwd), /ONLY the remote_bash/);
  assert.match(remoteWorkspaceShellGuidance(remoteCwd), /Never call host-native bash or pwsh/);
  assert.equal(remoteWorkspaceShellGuidance(localCwd), '');
});


test('older DSH hosts without Agent tool restrictions warn once without bypassing shell approval', async () => {
  const { ctx, wd, events } = fixture();
  const warnings = [];
  ctx.logger.warn = message => warnings.push(message);
  const agent = { id: 'old-dsh', session: {}, ctx: { tools: {} } };
  const dispose = installRemoteShellScope(ctx);
  events.get('agent/created')({ agent });
  events.get('agent/created')({ agent });
  await wd.set(agent, localCwd);
  await wd.set(agent, remoteCwd);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /native bash\/pwsh may remain visible/);
  assert.match(warnings[0], /gated by remote_bash approval/);
  dispose();
});

test('remote workspace shell guidance does not recommend native-shell fallback', () => {
  const hint = remoteWorkspaceShellGuidance(remoteCwd);
  assert.match(hint, /use ONLY the remote_bash tool/);
  assert.doesNotMatch(hint, /compatibility fallback only|prefer the remote_bash/);
});

test('remote_bash requests approval once per Agent/workspace and does not reuse it for another session', async () => {
  const { ctx, manager, definitions, approvals } = fixture();
  registerRemoteBashTool(ctx, manager);
  const tool = definitions.get('remote_bash').definition;
  const one = { id: 'agent-A', session: {} };
  await tool.execute({ command: 'pwd' }, { agent: one, callId: 'call-a' });
  await tool.execute({ command: 'git status --short' }, { agent: one, callId: 'call-b' });
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].toolName, 'remote_bash');
  assert.equal(approvals[0].callId, 'call-a');
  assert.match(approvals[0].reason, /not within the local DSH sandbox/);
  await tool.execute({ command: 'pwd' }, { agent: { id: 'agent-B', session: {} } });
  assert.equal(approvals.length, 2, 'new Agent session must not inherit authorization');
});

test('remote_bash denies read-only, missing approval and rejected decisions before executing a command', async () => {
  const { ctx, manager, definitions, calls, state } = fixture();
  registerRemoteBashTool(ctx, manager);
  const tool = definitions.get('remote_bash').definition;
  const agent = { id: 'gate', session: {} };
  state.mode = 'read-only';
  await assert.rejects(() => tool.execute({ command: 'echo test' }, { agent }), /read-only sessions/);
  state.mode = 'workspace-write';
  state.approvalAvailable = false;
  await assert.rejects(() => tool.execute({ command: 'echo test' }, { agent }), /no approval service/);
  state.approvalAvailable = true;
  state.outcome = 'rejected';
  await assert.rejects(() => tool.execute({ command: 'echo test' }, { agent }), /permission was rejected/);
  assert.equal(calls.length, 0, 'denied commands never reach the local or remote executor');
});

test('command approval mode asks on every invocation; off still forbids read-only mode', async () => {
  const { ctx, manager, definitions, approvals, state } = fixture();
  registerRemoteBashTool(ctx, manager, 'command');
  const tool = definitions.get('remote_bash').definition;
  const agent = { id: 'scope', session: {} };
  await tool.execute({ command: 'pwd' }, { agent });
  await tool.execute({ command: 'ls' }, { agent });
  assert.equal(approvals.length, 2);
  const noApproval = fixture();
  noApproval.state.approvalAvailable = false;
  registerRemoteBashTool(noApproval.ctx, noApproval.manager, 'off');
  const direct = noApproval.definitions.get('remote_bash').definition;
  await direct.execute({ command: 'pwd' }, { agent: { session: {} } });
  noApproval.state.mode = 'read-only';
  await assert.rejects(() => direct.execute({ command: 'pwd' }, { agent: { session: {} } }), /read-only/);
});

test('pending authorization is invalidated if the SSH workspace changes', async () => {
  const { ctx, wd, manager, definitions, calls, state } = fixture();
  registerRemoteBashTool(ctx, manager);
  const tool = definitions.get('remote_bash').definition;
  state.onApproval = () => { wd.current = localCwd; };
  await assert.rejects(() => tool.execute({ command: 'pwd' }, { agent: { session: {} } }), /workspace changed/);
  assert.equal(calls.length, 0, 'no command runs after workspace context changed');
});

test('remote_bash reports non-zero exit status, truncated output, and timeouts truthfully', async () => {
  const { ctx, manager, definitions, state } = fixture();
  state.result = {
    exitCode: null, timedOut: true,
    stdout: { text: 'partial', truncated: true },
    stderr: { text: 'terminated', truncated: false },
  };
  registerRemoteBashTool(ctx, manager);
  const tool = definitions.get('remote_bash').definition;
  const result = await tool.execute({ command: 'sleep 100', timeoutMs: 1000 }, { agent: { session: {} } });
  assert.equal(result.exitCode, -1);
  assert.equal(result.timedOut, true);
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stderr, 'terminated');
  state.result = { exitCode: 17, timedOut: false, stdout: { text: '' }, stderr: { text: 'error' } };
  const failed = await tool.execute({ command: 'exit 17' }, { agent: { session: {} } });
  assert.equal(failed.exitCode, 17);
  assert.equal(failed.timedOut, false);
});
