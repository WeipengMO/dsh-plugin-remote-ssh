import path from 'node:path';
import { authorizeRemoteBashSpec, type ShellRequest, type ShellSpec } from './shell-router.js';
import type { SshConnection } from './connection.js';
import { RemoteSshError, errorMessage } from './errors.js';
import type { RemoteSshManager, TestResult } from './manager.js';
import { encodeVirtualPath, expandRemoteTilde, looksVirtual, remoteContains } from './paths.js';
import { RemoteFileSystem } from './remote-fs.js';
import { inspectRemoteGit } from './remote-git.js';
import type { HostRecord } from './types.js';

interface ToolContext {
  tools: { register(definition: unknown, options?: { when?: (selection: { agent?: { session?: unknown } }) => boolean }): unknown };
  workingDirectory: {
    get(session: unknown): string;
    set(agent: unknown, path: string, signal?: AbortSignal): Promise<string>;
    ensure(agent: unknown, signal?: AbortSignal): Promise<string>;
  };
  shell?: {
    sandboxMode?: string;
    resolve(request: ShellRequest): ShellSpec;
    execute(spec: ShellSpec): Promise<{ result(): Promise<{
      exitCode?: number | null;
      stdout?: { text?: string; truncated?: boolean };
      stderr?: { text?: string; truncated?: boolean };
      aborted?: boolean;
      timedOut?: boolean;
    }> }>;
  };
  systemPrompt?: { section(definition: { name: string; order: number; text: string | ((context: { agent?: { session?: unknown } }) => string) }): unknown };
  logger?: { warn(message: string): void };
  get?(name: string): unknown;
  on?(event: string, listener: (payload: unknown) => unknown, options?: { global?: boolean }): unknown;
}

interface ToolExecution {
  agent: any;
  callId?: string;
  signal?: AbortSignal;
}

interface ApprovalService {
  request(request: { agent: unknown; toolName: string; callId?: string; reason?: string; signal?: AbortSignal }): Promise<string | { outcome?: string }>;
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
        stagedDiffStat: string('Staged Git diff stat.'),
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
  return 'ACTIVE EXECUTION SYSTEM: Linux over SSH. SHELL LANGUAGE: Bash/POSIX, not Windows PowerShell, and prefer the remote_bash tool; the native Windows pwsh tool is a compatibility fallback only. EVERY command is executed via Linux bash -lc on the remote host. Write Bash syntax from the FIRST command: pwd; ls -la; find . -maxdepth 2 -type f; grep -R; git status --short --branch. Use $HOME and $PATH, NOT $env:HOME, Get-ChildItem, Select-String, Set-Location, Out-File or Windows drive paths. File tools read and edit the real remote Linux directory. For remote Git status/history/diff, prefer remote_ssh_git; do not inspect the Windows placeholder or run local Git. Create directories before writing files. This instruction applies ONLY while the active workspace is an SSH virtual path.';
}

/**
 * A model-facing Bash tool for remote SSH workspaces.
 *
 * The local DSH shell sandbox confines the local SSH client process, NOT
 * the remote Bash process. Rather than pretend that the remote program is
 * locally sandboxed, require explicit consent to the unrestricted SSH
 * capability (once per Agent/workspace by default) and fail closed when
 * the effective DSH session policy is read-only.
 */
export type RemoteBashApprovalMode = 'session' | 'command' | 'off';

export function registerRemoteBashTool(
  ctx: ToolContext,
  manager: RemoteSshManager,
  approvalMode: RemoteBashApprovalMode = 'session',
): void {
  const shell = ctx.shell;
  if (!shell || typeof shell.resolve !== 'function' || typeof shell.execute !== 'function') {
    throw new RemoteSshError('SSH_FEATURE_UNSUPPORTED', 'remote_bash requires the DSH shell service');
  }
  if (!['session', 'command', 'off'].includes(approvalMode)) {
    throw new RemoteSshError('SSH_CONFIG_INVALID', 'remoteBashApproval must be session, command or off');
  }

  // Session objects (not strings/IDs) are the authority boundary. A new
  // session always requires new consent; no permission survives a restart.
  const grants = new WeakMap<object, Set<string>>();
  const sandboxPolicy = ctx.get?.('sandboxPolicy') as
    | { resolve(context: { session: unknown }): { mode: string } | undefined }
    | undefined;

  ctx.tools.register({
    name: 'remote_bash',
    description:
      'Run a Bash command on the ACTIVE remote Linux SSH workspace. Use POSIX paths, not Windows PowerShell syntax. '
      + 'The remote process is NOT confined by the local DSH sandbox. '
      + 'Remote shell access requires user approval unless explicitly configured otherwise; read-only sessions cannot use remote_bash. '
      + 'Each call runs in the foreground with a hard timeout; no background job is created.',
    parameters: object({
      command: string('Bash/POSIX command to run on the remote Linux server.'),
      workdir: string('Optional remote POSIX directory inside this active SSH workspace, absolute or relative to the active remote directory.'),
      timeoutMs: integer('Execution timeout in milliseconds, 1000–600000 (default 120000).'),
      stdoutMaxBytes: integer('Maximum captured stdout bytes, 1024–2000000 (default 200000).'),
    }, ['command']),
    timeoutMs: 660000,
    isConcurrencySafe: () => false,
    output: {
      schema: object({
        cwd: string('POSIX command working directory.'),
        exitCode: integer('Remote process exit code (-1 if signalled/timed out).'),
        stdout: string('Captured standard output.'),
        stderr: string('Captured standard error.'),
        timedOut: boolean('True if command exceeded its deadline.'),
        stdoutTruncated: boolean('True if captured stdout was truncated.'),
        stderrTruncated: boolean('True if captured stderr was truncated.'),
      }, ['cwd', 'exitCode', 'stdout', 'stderr', 'timedOut', 'stdoutTruncated', 'stderrTruncated']),
      render: textRender,
    },
    async execute(args: any, exec: ToolExecution) {
      const agent = exec.agent;
      if (!agent?.session) {
        throw new RemoteSshError('SSH_PATH_INVALID', 'remote_bash requires an active Agent session');
      }
      const session = agent.session as object;
      const cwd = ctx.workingDirectory.get(session);
      if (!looksVirtual(cwd)) {
        throw new RemoteSshError('SSH_PATH_INVALID', 'remote_bash is available only in an SSH workspace; use the native shell for local projects');
      }
      if (typeof args.command !== 'string' || !args.command.trim()) {
        throw new RemoteSshError('SSH_PATH_INVALID', 'a non-empty Bash command is required');
      }
      const rawWorkdir = args.workdir === undefined ? '.' : args.workdir;
      if (typeof rawWorkdir !== 'string' || !rawWorkdir.trim()) {
        throw new RemoteSshError('SSH_PATH_INVALID', 'workdir must be a non-empty remote POSIX path');
      }
      const active = manager.routeFor(cwd, cwd);
      const route = manager.routeFor(rawWorkdir, cwd);
      if (!active || !route || route.workspace.token !== active.workspace.token) {
        throw new RemoteSshError('SSH_PATH_INVALID', 'remote_bash workdir must belong to the active SSH workspace');
      }
      if (!remoteContains(active.workspace.remoteRoot, route.remotePath)) {
        throw new RemoteSshError('SSH_PATH_INVALID', 'remote_bash working directory must be inside the selected remote project');
      }
      const timeout = args.timeoutMs === undefined ? 120000 : args.timeoutMs;
      if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 600000) {
        throw new RemoteSshError('SSH_PATH_INVALID', 'timeoutMs must be between 1000 and 600000');
      }
      const stdoutMaxBytes = args.stdoutMaxBytes === undefined ? 200000 : args.stdoutMaxBytes;
      if (!Number.isInteger(stdoutMaxBytes) || stdoutMaxBytes < 1024 || stdoutMaxBytes > 2000000) {
        throw new RemoteSshError('SSH_PATH_INVALID', 'stdoutMaxBytes must be between 1024 and 2000000');
      }
      if (exec.signal?.aborted) {
        throw new RemoteSshError('SSH_REMOTE_SHELL_FAILED', 'remote Bash command was cancelled before execution');
      }

      // DSH may provide an effective per-session mode even when its shell
      // executor runs without an OS-level sandbox. Never treat such an
      // unconfined SSH run as an enforced read-only operation.
      const standingPolicy = sandboxPolicy?.resolve({ session });
      if (standingPolicy?.mode === 'read-only') {
        throw new RemoteSshError(
          'SSH_REMOTE_SHELL_FAILED',
          'remote_bash is disabled in read-only sessions: SSH commands are not confined by the local DSH sandbox. Switch session permissions explicitly.',
        );
      }
      if (shell.sandboxMode !== undefined && (!sandboxPolicy || typeof sandboxPolicy.resolve !== 'function')) {
        throw new RemoteSshError('SSH_FEATURE_UNSUPPORTED', 'DSH shell advertises sandboxing but the session sandboxPolicy service is unavailable');
      }

      const grantKey = route.workspace.token;
      if (approvalMode !== 'off' && (approvalMode === 'command' || !grants.get(session)?.has(grantKey))) {
        const approval = approvalService(ctx);
        if (!approval) {
          throw new RemoteSshError(
            'SSH_APPROVAL_DENIED',
            'remote Bash needs explicit approval because the remote process is not constrained by the local sandbox; no approval service is available',
          );
        }
        const reason =
          'Permit Linux Bash execution over SSH on '
          + route.workspace.hostLabel + ' (' + route.workspace.remoteRoot + ')? '
          + 'Commands run with the SSH account permissions, not within the local DSH sandbox. '
          + (approvalMode === 'session' ? 'This approval covers this Agent session and SSH workspace.' : 'This approval covers this command only.');
        let outcome: string;
        try {
          outcome = approvalOutcome(await approval.request({
            agent,
            toolName: 'remote_bash',
            ...(typeof exec.callId === 'string' ? { callId: exec.callId } : {}),
            reason,
            signal: exec.signal,
          }));
        } catch (error) {
          throw new RemoteSshError('SSH_APPROVAL_DENIED', 'remote Bash authorization failed: ' + errorMessage(error));
        }
        if (outcome !== 'allowed-once') {
          throw new RemoteSshError('SSH_APPROVAL_DENIED', 'remote Bash permission was ' + outcome);
        }
        if (approvalMode === 'session') {
          const allowed = grants.get(session) ?? new Set<string>();
          allowed.add(grantKey);
          grants.set(session, allowed);
        }
      }

      // Approval is asynchronous. Never use a grant if this Agent moved to
      // another directory/host while its approval dialog was pending.
      const current = ctx.workingDirectory.get(session);
      const live = looksVirtual(current) ? manager.routeFor(current, current) : null;
      if (!live || live.workspace.token !== active.workspace.token || current !== cwd) {
        throw new RemoteSshError('SSH_PATH_INVALID', 'remote workspace changed while authorizing the command; retry in the new workspace');
      }
      if (exec.signal?.aborted) {
        throw new RemoteSshError('SSH_REMOTE_SHELL_FAILED', 'remote Bash command was cancelled before execution');
      }
      const spec = shell.resolve({
        command: args.command,
        workdir: route.virtualPath,
        timeoutMs: timeout,
        stdoutMaxBytes,
        onExpiry: 'kill',
        signal: exec.signal,
      });
      if (!looksVirtual(spec.workdir)) {
        throw new RemoteSshError('SSH_PATH_INVALID', 'shell.resolve returned a local workdir for a remote command');
      }
      const resolvedRoute = manager.routeFor(spec.workdir, spec.workdir);
      if (!resolvedRoute || resolvedRoute.workspace.token !== active.workspace.token
          || !remoteContains(active.workspace.remoteRoot, resolvedRoute.remotePath)) {
        throw new RemoteSshError('SSH_PATH_INVALID', 'shell.resolve escaped the active remote workspace');
      }

      authorizeRemoteBashSpec(spec);
      const outcome = await (await shell.execute(spec)).result();
      if (outcome.aborted) {
        throw new RemoteSshError('SSH_REMOTE_SHELL_FAILED', 'remote Bash command was cancelled');
      }
      return {
        cwd: resolvedRoute.remotePath,
        exitCode: typeof outcome.exitCode === 'number' ? outcome.exitCode : -1,
        stdout: outcome.stdout && typeof outcome.stdout.text === 'string' ? outcome.stdout.text : '',
        stderr: outcome.stderr && typeof outcome.stderr.text === 'string' ? outcome.stderr.text : '',
        timedOut: outcome.timedOut === true,
        stdoutTruncated: outcome.stdout?.truncated === true,
        stderrTruncated: outcome.stderr?.truncated === true,
      };
    },
  }, {
    when: ({ agent }) => {
      if (!agent?.session) return false;
      try { return looksVirtual(ctx.workingDirectory.get(agent.session)); }
      catch { return false; }
    },
  });
}

/**
 * In Agent scopes, hide the inherited Windows pwsh schema only while the
 * session is remote. Scope changes are reversible on workdir changes.
 */
export function installRemoteShellScope(ctx: ToolContext): () => void {
  const masks = new Map<string, { agent: any; dispose: () => void }>();
  const warned = new Set<string>();
  const wd = ctx.workingDirectory;
  const savedSet = wd.set;
  const originalSet = wd.set.bind(wd);
  const unwrap = (event: any): any => event && typeof event === 'object' && 'agent' in event ? event.agent : event;
  const clear = (id: string): void => {
    const previous = masks.get(id);
    if (previous) {
      previous.dispose();
      masks.delete(id);
    }
  };
  const sync = (value: unknown): void => {
    const agent = unwrap(value);
    if (!agent || typeof agent.id !== 'string' || !agent.session) return;
    const id = agent.id;
    let remote = false;
    try { remote = looksVirtual(wd.get(agent.session)); }
    catch { return; }
    const previous = masks.get(id);
    if (!remote) { clear(id); return; }
    if (previous && previous.agent === agent) return;
    clear(id);
    const restrict = agent.ctx && agent.ctx.tools && agent.ctx.tools.restrict;
    if (typeof restrict !== 'function') {
      if (!warned.has(id)) {
        warned.add(id);
        ctx.logger?.warn('remote-ssh: Agent-scoped tool restrictions unavailable; remote_bash is visible, but the host may also show pwsh');
      }
      return;
    }
    try {
      const dispose = restrict.call(agent.ctx.tools, { deny: ['pwsh'] });
      if (typeof dispose === 'function') masks.set(id, { agent, dispose });
    } catch (error) {
      if (!warned.has(id)) {
        warned.add(id);
        ctx.logger?.warn('remote-ssh: cannot hide native pwsh for Agent ' + id + ': ' + errorMessage(error));
      }
    }
  };
  wd.set = async (agent: unknown, next: string, signal?: AbortSignal): Promise<string> => {
    const result = await originalSet(agent, next, signal);
    sync(agent);
    return result;
  };
  const offCreated = ctx.on?.('agent/created', sync, { global: true });
  const offDisposed = ctx.on?.('agent/disposed', (payload: unknown) => {
    const agent = unwrap(payload);
    if (agent && typeof agent.id === 'string') {
      clear(agent.id);
      warned.delete(agent.id);
    }
  }, { global: true });
  return () => {
    wd.set = savedSet;
    for (const id of [...masks.keys()]) clear(id);
    if (typeof offCreated === 'function') offCreated();
    if (typeof offDisposed === 'function') offDisposed();
  };
}
