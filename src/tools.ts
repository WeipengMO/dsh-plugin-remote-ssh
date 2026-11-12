import path from 'node:path';
import type { SshConnection } from './connection.js';
import { RemoteSshError, errorMessage } from './errors.js';
import type { RemoteSshManager, TestResult } from './manager.js';
import { encodeVirtualPath, expandRemoteTilde, looksVirtual } from './paths.js';
import { RemoteFileSystem } from './remote-fs.js';
import { inspectRemoteGit } from './remote-git.js';
import type { HostRecord } from './types.js';

interface ToolContext {
  tools: { register(definition: unknown): unknown };
  workingDirectory: {
    get(session: unknown): string;
    set(agent: unknown, path: string, signal?: AbortSignal): Promise<string>;
    ensure(agent: unknown, signal?: AbortSignal): Promise<string>;
  };
  systemPrompt?: { section(definition: { name: string; order: number; text: string | ((context: { agent?: { session?: unknown } }) => string) }): unknown };
  logger?: { warn(message: string): void };
  get?(name: string): unknown;
  on?(event: string, listener: (payload: unknown) => unknown, options?: { global?: boolean }): unknown;
}

interface ToolExecution {
  agent: any;
  signal?: AbortSignal;
}

interface ApprovalService {
  request(request: { agent: unknown; toolName: string; reason?: string; signal?: AbortSignal }): Promise<string | { outcome?: string }>;
}

interface RegisteredDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  timeoutMs?: number;
  isConcurrencySafe?: () => boolean;
  output: { schema: Record<string, unknown>; render: (args: unknown, value: unknown) => Array<{ type: 'text'; text: string }> };
  execute(args: any, exec: ToolExecution): Promise<unknown>;
}

function textRender(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  const text = typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
  return [{ type: 'text', text }];
}

function object(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  // DSH validates tool *results* against output.schema. Keep objects open so
  // diagnostic/status payloads with extra fields are not rejected. Parameters
  // are still constrained by `required` and per-property types.
  return { type: 'object', additionalProperties: true, properties, required };
}

const string = (description: string): Record<string, unknown> => ({ type: 'string', description });
const integer = (description: string): Record<string, unknown> => ({ type: 'integer', description });
const boolean = (description: string): Record<string, unknown> => ({ type: 'boolean', description });

function findHostId(manager: RemoteSshManager, token: unknown): string {
  if (typeof token !== 'string' || token.trim().length === 0) throw new RemoteSshError('SSH_HOST_NOT_FOUND', 'host id or alias is required');
  const value = token.trim();
  const hosts = manager.hosts();
  if (hosts.some((host) => host.id === value)) return value;
  const matches = hosts.filter((host) => host.label === value || host.host === value);
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length > 1) throw new RemoteSshError('SSH_HOST_NOT_FOUND', `host alias "${value}" is ambiguous; use the host id`);
  throw new RemoteSshError('SSH_HOST_NOT_FOUND', `unknown SSH host: ${value}; add it with remote_ssh_hosts`);
}

function hostView(host: HostRecord): Record<string, unknown> {
  const view: Record<string, unknown> = {
    id: host.id,
    label: host.label,
    host: host.host,
    port: host.port,
    user: host.user,
    identityFile: host.identityFile,
    identityAgent: host.identityAgent,
    useAgent: host.useAgent,
    useSshConfig: host.useSshConfig,
    configFile: host.configFile,
    hostKeyAlias: host.hostKeyAlias,
    updatedAt: host.updatedAt,
  };
  // DSH validates tool output as lossless JSON: undefined fields are rejected.
  return Object.fromEntries(Object.entries(view).filter(([, value]) => value !== undefined));
}

function statusResult(manager: RemoteSshManager, result: TestResult): Record<string, unknown> {
  return {
    ok: result.ok,
    ...(result.code !== undefined ? { code: result.code } : {}),
    ...(result.message !== undefined ? { message: result.message } : {}),
    ...(result.status !== undefined ? { status: result.status } : {}),
    ...(result.details !== undefined ? { details: result.details } : {}),
  };
}

function register(ctx: ToolContext, definition: RegisteredDefinition): void {
  ctx.tools.register(definition);
}

function approvalService(ctx: ToolContext): ApprovalService | undefined {
  const value = ctx.get?.('approval');
  return value !== undefined && value !== null && typeof (value as ApprovalService).request === 'function' ? (value as ApprovalService) : undefined;
}

function approvalOutcome(outcome: string | { outcome?: string }): string {
  if (typeof outcome === 'string') return outcome;
  return outcome.outcome ?? 'unavailable';
}

function safeHostPath(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new RemoteSshError('SSH_PATH_INVALID', 'path must be a non-empty string');
  const trimmed = value.trim();
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) {
    throw new RemoteSshError('SSH_PATH_INVALID', 'Windows drive paths are not valid on a remote POSIX host; use an absolute POSIX path');
  }
  if (trimmed.includes('\0')) throw new RemoteSshError('SSH_PATH_INVALID', 'path must not contain NUL');
  return trimmed;
}

/**
 * Register the remote workspace management surface. These tools are the
 * explicit entry points for host setup, diagnostics, workspace switching and
 * directory browsing; the native read/write/edit/glob/grep/bash tools then work
 * transparently against the selected virtual cwd.
 */
export function registerManagementTools(
  ctx: ToolContext,
  manager: RemoteSshManager,
  remoteFs: RemoteFileSystem,
): void {
  const previousCwd = new Map<string, string>();

  register(ctx, {
    name: 'remote_ssh_hosts',
    description:
      'Manage saved SSH hosts for the Remote SSH plugin: list, add, update, or remove. Secrets are never stored: only a private-key path, agent socket, and public host key are kept. Host key verification is strict; use remote_ssh_test then remote_ssh_trust_host for a new host.',
    parameters: object(
      {
        action: { type: 'string', enum: ['list', 'add', 'update', 'remove'], description: 'Operation to perform.' },
        id: string('Host id for update/remove.'),
        label: string('Human-readable label.'),
        host: string('SSH alias from ~/.ssh/config, hostname, IP, or user@host.'),
        port: integer('SSH port (1-65535); defaults to the SSH config or 22.'),
        user: string('SSH username; defaults to the SSH config or the current user.'),
        identityFile: string('Path to a private key. The key contents are never read into storage or logs.'),
        identityAgent: string('Agent socket or named pipe, e.g. ~/.ssh/agent.sock.'),
        useAgent: boolean('Whether ssh-agent may be used.'),
        useSshConfig: boolean('Whether to resolve the alias through ~/.ssh/config (default true).'),
        configFile: string('Alternate SSH config path.'),
        hostKeyAlias: string('known_hosts alias to use for this host.'),
      },
      ['action'],
    ),
    timeoutMs: 15000,
    isConcurrencySafe: () => false,
    output: {
      schema: object({
        hosts: { type: 'array', items: object({ id: string('Host id.'), label: string('Label.'), host: string('Destination.'), port: integer('Port.'), user: string('User.'), identityFile: string('Key path.'), updatedAt: string('Last update.') }) },
        removed: string('Removed host id.'),
        host: object({ id: string('Host id.'), label: string('Label.') }),
      }),
      render: textRender,
    },
    async execute(args) {
      const action = args.action;
      if (action === 'list') return { hosts: manager.hosts().map(hostView) };
      if (action === 'add') {
        if (typeof args.host !== 'string') throw new RemoteSshError('SSH_CONFIG_INVALID', 'host is required for add');
        const host = manager.addHost({
          host: args.host,
          ...(typeof args.label === 'string' ? { label: args.label } : {}),
          ...(typeof args.port === 'number' ? { port: args.port } : {}),
          ...(typeof args.user === 'string' ? { user: args.user } : {}),
          ...(typeof args.identityFile === 'string' ? { identityFile: args.identityFile } : {}),
          ...(typeof args.identityAgent === 'string' ? { identityAgent: args.identityAgent } : {}),
          ...(typeof args.useAgent === 'boolean' ? { useAgent: args.useAgent } : {}),
          ...(typeof args.useSshConfig === 'boolean' ? { useSshConfig: args.useSshConfig } : {}),
          ...(typeof args.configFile === 'string' ? { configFile: args.configFile } : {}),
          ...(typeof args.hostKeyAlias === 'string' ? { hostKeyAlias: args.hostKeyAlias } : {}),
        });
        return { host: hostView(host), hosts: manager.hosts().map(hostView) };
      }
      if (action === 'update') {
        const id = findHostId(manager, args.id);
        const patch: Partial<HostRecord> = {};
        for (const key of ['label', 'host', 'port', 'user', 'identityFile', 'identityAgent', 'useAgent', 'useSshConfig', 'configFile', 'hostKeyAlias'] as const) {
          if (args[key] !== undefined) (patch as Record<string, unknown>)[key] = args[key];
        }
        const host = manager.updateHost(id, patch);
        return { host: hostView(host), hosts: manager.hosts().map(hostView) };
      }
      if (action === 'remove') {
        const id = findHostId(manager, args.id);
        manager.removeHost(id);
        return { removed: id, hosts: manager.hosts().map(hostView) };
      }
      throw new RemoteSshError('SSH_CONFIG_INVALID', `unknown action: ${String(action)}`);
    },
  });

  register(ctx, {
    name: 'remote_ssh_test',
    description:
      'Test a saved SSH host end-to-end: connect, verify the host key strictly, open SFTP, and run a small command. On an unknown host key the result includes the SHA256 fingerprint and public key so remote_ssh_trust_host can be called explicitly.',
    parameters: object({ host: string('Saved host id, label, or destination.') }, ['host']),
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    output: {
      schema: object({
        ok: boolean('Whether the test succeeded.'),
        code: string('Stable error code.'),
        message: string('Human-readable error.'),
        status: object({ id: string('Host id.'), label: string('Label.'), state: string('Connection state.'), hostName: string('Host.'), port: integer('Port.'), user: string('User.'), trustedFingerprint: string('Verified host key.'), lastError: string('Last error.') }),
        details: { type: 'object', additionalProperties: true },
      }),
      render: textRender,
    },
    async execute(args) {
      const id = findHostId(manager, args.host);
      return statusResult(manager, await manager.test(id));
    },
  });

  register(ctx, {
    name: 'remote_ssh_trust_host',
    description:
      'Explicitly trust a host key after verifying its SHA256 fingerprint with the server operator. Only an unknown key can be trusted; a mismatch with an existing key is always refused. Requires an interactive approval.',
    parameters: object(
      {
        host: string('Saved host id, label, or destination.'),
        fingerprint: string('SHA256 fingerprint, for example SHA256:abc... (must match the presented key).'),
        reason: string('Why this host key is trusted.'),
      },
      ['host', 'fingerprint'],
    ),
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    output: {
      schema: object({
        trusted: boolean('Whether the key is now trusted.'),
        fingerprint: string('Trusted fingerprint.'),
        host: string('Host.'),
        port: integer('Port.'),
        verified: boolean('Whether a reconnect succeeded.'),
        status: { type: 'object', additionalProperties: true },
      }),
      render: textRender,
    },
    async execute(args, exec) {
      const id = findHostId(manager, args.host);
      const probe = await manager.test(id);
      const details = probe.details ?? {};
      const presented = typeof details.fingerprint === 'string' ? details.fingerprint : undefined;
      const hostKey = typeof details.hostKey === 'string' ? details.hostKey : undefined;
      if (probe.code !== 'SSH_HOST_KEY_UNKNOWN' || presented === undefined || hostKey === undefined) {
        throw new RemoteSshError(
          'SSH_HOST_KEY_MISMATCH',
          probe.code === undefined
            ? 'host key is already trusted and connected; nothing to trust'
            : `refusing to trust a host key in state ${probe.code}: only an unknown key can be trusted`,
        );
      }
      if (presented !== args.fingerprint) {
        throw new RemoteSshError('SSH_HOST_KEY_MISMATCH', `fingerprint mismatch: presented ${presented}, confirmation was ${args.fingerprint}`);
      }
      const approval = approvalService(ctx);
      if (approval === undefined) {
        throw new RemoteSshError('SSH_APPROVAL_DENIED', 'host key trust requires the DSH approval service; no approval answerer is available');
      }
      let outcome: string;
      try {
        outcome = approvalOutcome(
          await approval.request({
            agent: exec.agent,
            toolName: 'remote_ssh_trust_host',
            reason: `Trust SSH host key ${presented} for ${typeof details.host === 'string' ? details.host : id}? ${typeof args.reason === 'string' ? args.reason : ''}`.trim(),
            signal: exec.signal,
          }),
        );
      } catch (error) {
        throw new RemoteSshError('SSH_APPROVAL_DENIED', `host key trust was not approved: ${errorMessage(error)}`);
      }
      if (outcome !== 'allowed-once') throw new RemoteSshError('SSH_APPROVAL_DENIED', `host key trust was ${outcome}`);
      const trusted = manager.trustHostKey(id, hostKey, presented);
      const verified = await manager.test(id);
      return { trusted: true, ...trusted, verified: verified.ok, status: verified.status };
    },
  });

  register(ctx, {
    name: 'remote_workspace_open',
    description:
      'Open a remote directory as this session\'s workspace. After this succeeds, the native read, write, edit, glob, grep and bash/pwsh tools operate on the remote host and remote cwd; there is no local mirror. Call remote_workspace_close to switch back.',
    parameters: object(
      {
        host: string('Saved host id, label, or destination.'),
        path: string('Remote directory, absolute or relative to the remote home; defaults to the remote home.'),
      },
      ['host'],
    ),
    timeoutMs: 60000,
    isConcurrencySafe: () => false,
    output: {
      schema: object({
        virtualPath: string('Virtual workspace path now used as cwd.'),
        remoteRoot: string('Canonical remote directory.'),
        hostLabel: string('Host label.'),
        status: { type: 'object', additionalProperties: true },
        previousCwd: string('Previous cwd, restored by remote_workspace_close.'),
      }),
      render: textRender,
    },
    async execute(args, exec) {
      const id = findHostId(manager, args.host);
      const previous = ctx.workingDirectory.get(exec.agent.session);
      const result = await manager.openWorkspace(id, typeof args.path === 'string' ? args.path : undefined);
      const current = await ctx.workingDirectory.set(exec.agent, result.virtualPath, exec.signal);
      previousCwd.set(exec.agent.id, previous);
      return {
        virtualPath: current,
        remoteRoot: result.workspace.remoteRoot,
        hostLabel: result.workspace.hostLabel,
        status: result.status,
        previousCwd: previous,
      };
    },
  });

  register(ctx, {
    name: 'remote_workspace_close',
    description:
      'Leave the current remote workspace and restore the cwd that was active before remote_workspace_open. Native tools return to the local filesystem after this call.',
    parameters: object({}),
    timeoutMs: 15000,
    isConcurrencySafe: () => false,
    output: {
      schema: object({
        closed: boolean('Whether a remote workspace was active.'),
        currentCwd: string('Cwd after the call.'),
        previousCwd: string('Restored cwd.'),
        message: string('Explanation when nothing changed.'),
      }),
      render: textRender,
    },
    async execute(_args, exec) {
      const current = ctx.workingDirectory.get(exec.agent.session);
      if (!looksVirtual(current)) return { closed: false, currentCwd: current, message: 'the current cwd is already local' };
      const saved = previousCwd.get(exec.agent.id) ?? exec.agent.session.header.cwd;
      if (typeof saved !== 'string' || saved.length === 0) {
        throw new RemoteSshError('SSH_PATH_INVALID', 'no previous local cwd is recorded; use a normal local cwd or start a new session');
      }
      const restored = await ctx.workingDirectory.set(exec.agent, saved, exec.signal);
      previousCwd.delete(exec.agent.id);
      return { closed: true, currentCwd: restored, previousCwd: restored };
    },
  });

  register(ctx, {
    name: 'remote_ssh_git',
    description:
      'Read the REAL Linux SSH workspace Git status, recent commit history and diff summary. Never inspect the Windows placeholder or require local Git. Read-only, no Git writes. Prefer this for remote Git history/status.',
    parameters: object({
      limit: integer('Recent Git commits to display (1–50; defaults to 20).'),
    }),
    timeoutMs: 45000,
    isConcurrencySafe: () => true,
    output: {
      schema: object({
        directory: string('Remote Linux Git cwd.'),
        isRepository: boolean('Whether this Linux directory belongs to a Git repository.'),
        status: string('Remote git status --short --branch.'),
        history: { type: 'array', items: object({
          hash:string('Abbreviated commit hash.'),
          date:string('Commit date.'),
          subject:string('Commit subject.'),
        }) },
        diffStat: string('Unstaged Git diff stat.'),
      }),
      render: textRender,
    },
    async execute(args, exec) {
      const cwd = ctx.workingDirectory.get(exec.agent.session);
      if (!looksVirtual(cwd)) {
        throw new RemoteSshError('SSH_PATH_INVALID',
          'remote_ssh_git is available only in an active SSH workspace');
      }
      const route = manager.routeFor(cwd, cwd);
      if (!route) throw new RemoteSshError('SSH_WORKSPACE_UNKNOWN', 'SSH Git workspace mapping is unavailable');
      const limit = args.limit === undefined ? 20 : Number(args.limit);
      return await inspectRemoteGit(manager, route.workspace.connectionId, route.remotePath, limit);
    },
  });

  register(ctx, {
    name: 'remote_ssh_status',
    description:
      'Show connection status, the current cwd, recent remote workspaces, and whether the session is currently in a remote workspace. Never returns secrets.',
    parameters: object({}),
    timeoutMs: 10000,
    isConcurrencySafe: () => true,
    output: {
      schema: object({
        currentCwd: string('Current working directory.'),
        remote: boolean('Whether the cwd is a remote virtual path.'),
        statuses: { type: 'array', items: { type: 'object', additionalProperties: true } },
        recent: { type: 'array', items: { type: 'object', additionalProperties: true } },
        workspaces: { type: 'array', items: { type: 'object', additionalProperties: true } },
      }),
      render: textRender,
    },
    async execute(_args, exec) {
      const currentCwd = ctx.workingDirectory.get(exec.agent.session);
      return {
        currentCwd,
        remote: looksVirtual(currentCwd),
        statuses: manager.statuses(),
        recent: manager.recent(),
        workspaces: manager.workspaces(),
      };
    },
  });

  register(ctx, {
    name: 'remote_ssh_list_dir',
    description:
      'Browse a remote directory before opening it. With host omitted, lists relative to the current remote workspace; with host set, lists an absolute or home-relative remote path without changing the cwd.',
    parameters: object({
      host: string('Saved host id, label, or destination. Omit inside a remote workspace.'),
      path: string('Remote directory; defaults to the remote home or the current remote cwd.'),
    }),
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    output: {
      schema: object({
        path: string('Canonical remote directory.'),
        virtualPath: string('Virtual path, when the directory belongs to a registered workspace.'),
        entries: {
          type: 'array',
          items: object({
            name: string('Entry name.'),
            type: string('file, directory, symlink, or other.'),
            size: integer('Size in bytes for files.'),
          }),
        },
      }),
      render: textRender,
    },
    async execute(args, exec) {
      let connection: SshConnection;
      let directory: string;
      let workspaceToken: string | undefined;
      if (typeof args.host === 'string' && args.host.trim().length > 0) {
        const id = findHostId(manager, args.host);
        connection = await manager.connection(id);
        const home = await connection.remoteHome();
        const requested = args.path === undefined ? home : expandRemoteTilde(safeHostPath(args.path), home);
        const absolute = requested.startsWith('/') ? requested : path.posix.join(home, requested);
        directory = path.posix.normalize(absolute);
        workspaceToken = undefined;
      } else {
        const cwd = ctx.workingDirectory.get(exec.agent.session);
        if (!looksVirtual(cwd)) throw new RemoteSshError('SSH_PATH_INVALID', 'host is required when the current cwd is local');
        const target = await remoteFs.resolve(typeof args.path === 'string' ? args.path : '.', { cwd, signal: exec.signal });
        directory = target.remotePath;
        workspaceToken = target.workspaceToken;
        const workspace = manager.workspaceByToken(target.workspaceToken);
        connection = await manager.connection(workspace.connectionId);
      }
      const canonical = await new Promise<string>((resolve, reject) => {
        connection.sftp.realpath(directory, (error, resolved) => (error ? reject(connection.mapSftpError(error, `cannot resolve ${directory}`)) : resolve(resolved)));
      });
      const entries = await new Promise<Array<{ filename: string; attrs: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean; size: number } }>>((resolve, reject) => {
        connection.sftp.readdir(canonical, (error, list) => (error ? reject(connection.mapSftpError(error, `cannot list ${canonical}`)) : resolve(list)));
      });
      return {
        path: canonical,
        ...(workspaceToken !== undefined ? { virtualPath: encodeVirtualPath(workspaceToken, canonical) } : {}),
        entries: entries
          .sort((left, right) => left.filename.localeCompare(right.filename))
          .slice(0, 5000)
          .map((entry) => ({
            name: entry.filename,
            type: entry.attrs.isSymbolicLink() ? 'symlink' : entry.attrs.isDirectory() ? 'directory' : entry.attrs.isFile() ? 'file' : 'other',
            ...(entry.attrs.isFile() ? { size: entry.attrs.size } : {}),
          })),
      };
    },
  });

  ctx.systemPrompt?.section({
    name: 'plugin:remote-ssh',
    order: 900,
    text: ({ agent }) => {
      if (!agent?.session) return '';
      try { return remoteWorkspaceShellGuidance(ctx.workingDirectory.get(agent.session)); }
      catch { return ''; }
    },
  });

  ctx.on?.('agent/disposed', (payload) => {
    const agent = (payload as { agent?: { id?: string } }).agent;
    if (typeof agent?.id === 'string') previousCwd.delete(agent.id);
  }, { global: true });
}

/** A remote-only shell hint avoids wasting tokens on local DSH sessions. */
export function remoteWorkspaceShellGuidance(cwd: string): string {
  if (!looksVirtual(cwd)) return '';
  return 'ACTIVE EXECUTION SYSTEM: Linux over SSH. SHELL LANGUAGE: Bash/POSIX, not Windows PowerShell, even if the Windows DSH tool is named pwsh. EVERY command is executed via Linux bash -lc on the remote host. Write Bash syntax from the FIRST command: pwd; ls -la; find . -maxdepth 2 -type f; grep -R; git status --short --branch. Use $HOME and $PATH, NOT $env:HOME, Get-ChildItem, Select-String, Set-Location, Out-File or Windows drive paths. File tools read and edit the real remote Linux directory. For remote Git status/history/diff, prefer remote_ssh_git; do not inspect the Windows placeholder or run local Git. Create directories before writing files. This instruction applies ONLY while the active workspace is an SSH virtual path.';
}
