import test from 'node:test';
import assert from 'node:assert/strict';
import { registerRemoteBashTool, installRemoteShellScope, remoteWorkspaceShellGuidance } from '../dist/tools.js';
import { workspacePlaceholderPath, encodeVirtualPath } from '../dist/paths.js';

const workspaceId = 'w0123456789abcdef';
const other = 'wfedcba9876543210';
const remoteCwd = workspacePlaceholderPath(workspaceId);
const localCwd = process.platform === 'win32' ? 'C:\\Users\\dev\\project' : '/home/dev/project';

function fixture() {
  const definitions = new Map();
  const events = new Map();
  const calls = [];
  const wd = {
    current: remoteCwd,
    get() { return this.current; },
    async set(_agent, value) { this.current = value; return value; },
  };
  const ctx = {
    tools: { register(definition, options) { definitions.set(definition.name, { definition, options }); return () => {}; } },
    workingDirectory: wd,
    shell: {
      resolve(request) {
        calls.push({ kind: 'resolve', request });
        return { ...request, onExpiry: 'kill' };
      },
      async execute(spec) {
        calls.push({ kind: 'execute', spec });
        return { async result() { return { exitCode: 0, stdout: { text: 'Linux remote output\\n' }, stderr: { text: '' } }; } };
      },
    },
    logger: { warn() {} },
    on(event, handler) { events.set(event, handler); return () => events.delete(event); },
  };
  const manager = {
    routeFor(value, cwd) {
      if (/^[A-Za-z]:[\\\\/]/.test(value)) throw new Error('Windows path is not a remote POSIX path');
      const workspaceToken = value.startsWith('//other/') ? other : workspaceId;
      let remotePath = '/srv/project';
      if (value === '.' || value === cwd) remotePath = '/srv/project';
      else if (value.startsWith('/')) remotePath = value;
      else remotePath = '/srv/project/' + value;
      return {
        workspace: { token: workspaceToken },
        remotePath,
        virtualPath: encodeVirtualPath(workspaceToken, remotePath),
      };
    },
  };
  return { ctx, wd, calls, definitions, events, manager };
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
  assert.equal(output.stdout, 'Linux remote output\\n');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].request.command, 'pwd; ls -la');
  assert.equal(calls[0].request.workdir, encodeVirtualPath(workspaceId, '/srv/project'));
  assert.equal(definition.output.render({}, output)[0].type, 'text');
  wd.current = localCwd;
  assert.equal(options.when({ agent }), false);
  await assert.rejects(() => definition.execute({ command: 'pwd' }, { agent }), /only available in a remote SSH workspace/);
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

test('pwsh masking follows the Agent remote/local workspace without affecting other Agents', async () => {
  const { ctx, wd, events } = fixture();
  const changes = [];
  const agent = {
    id: 'remote-agent', session: {},
    ctx: { tools: { restrict(filter) {
      changes.push({ type: 'restrict', filter });
      return () => changes.push({ type: 'restore' });
    } } },
  };
  const originalSet = wd.set;
  const dispose = installRemoteShellScope(ctx);
  events.get('agent/created')({ agent });
  assert.deepEqual(changes[0], { type: 'restrict', filter: { deny: ['pwsh'] } });
  await wd.set(agent, localCwd);
  assert.deepEqual(changes[1], { type: 'restore' });
  await wd.set(agent, remoteCwd);
  assert.equal(changes.filter(change => change.type === 'restrict').length, 2);
  events.get('agent/disposed')({ agent });
  assert.equal(changes.filter(change => change.type === 'restore').length, 2);
  dispose();
  assert.equal(wd.set, originalSet);
  assert.equal(events.size, 0);
  assert.match(remoteWorkspaceShellGuidance(remoteCwd), /remote_bash/);
  assert.equal(remoteWorkspaceShellGuidance(localCwd), '');
});
