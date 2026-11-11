import os from 'node:os';
import path from 'node:path';
import { RemoteSshError } from './errors.js';
import { installFsRouter } from './fs-router.js';
import { RemoteSshManager } from './manager.js';
import { looksVirtual } from './paths.js';
import { expandUserPath } from './ssh-config.js';
import { installRemoteSearchShadow } from './remote-search.js';
import { installShellRouter } from './shell-router.js';
import { registerManagementTools } from './tools.js';
import { agentFromCreatedEvent, createNativeHttpHandler, type AgentRef } from './http-api.js';
import type { WorkspaceRegistry } from './workspace-registration.js';
import { installWorkspaceCleanup } from './workspace-cleanup.js';
import { RemoteTerminalPool } from './remote-terminal.js';
import { installNativeTerminalRouter } from './native-terminal-router.js';

export const name = 'remote-ssh';

/** The plugin needs the native tool seams before it can route remote work. */
export const inject = ['fs', 'shell', 'tools', 'workingDirectory', 'systemPrompt', 'webServer', 'connection'];

export interface Config {
  storageDir?: string;
  maxRecent?: number;
}

interface PluginContext {
  fs: Record<string, unknown>;
  shell: Record<string, unknown>;
  tools: Record<string, unknown>;
  workingDirectory: {
    get(session: unknown): string;
    set(agent: unknown, path: string, signal?: AbortSignal): Promise<string>;
    ensure(agent: unknown, signal?: AbortSignal): Promise<string>;
  };
  systemPrompt: Record<string, unknown>;
  logger: { info(message: string): void; warn(message: string): void; error(message: string): void };
  effect(fn: () => () => void): unknown;
  on(event: string, listener: (payload: unknown) => unknown, opts?: { global?: boolean }): unknown;
  get(name: string): unknown;
}

/**
 * Keep remote cwds from being silently discarded, but never break the session
 * when the remote host becomes unreachable.
 *
 * The fs router already makes resolve/stat of a virtual cwd succeed over SFTP,
 * so DSH's original ensure() keeps a healthy remote cwd. When SFTP fails, this
 * wrapper recovers to the session's original LOCAL cwd with a real set() (a
 * committed change plus DSH's own notice) instead of throwing: ensure() runs
 * while assembling every system prompt, so throwing would strand the session.
 */
function guardWorkingDirectory(ctx: PluginContext): () => void {
  const workingDirectory = ctx.workingDirectory;
  const originalEnsure = workingDirectory.ensure.bind(workingDirectory);
  workingDirectory.ensure = async (agent: unknown, signal?: AbortSignal): Promise<string> => {
    const sessionAgent = agent as { session: { header?: { cwd?: string } } };
    const current = workingDirectory.get(sessionAgent.session);
    if (!looksVirtual(current)) return await originalEnsure(agent, signal);
    try {
      const target = await (ctx.fs as any).resolve(current, { signal });
      const info = await (ctx.fs as any).stat(target, signal);
      if (info?.type === 'directory') return await originalEnsure(agent, signal);
    } catch (error) {
      ctx.logger.warn(`remote-ssh: remote workspace ${current} is unavailable: ${(error as Error)?.message ?? String(error)}`);
    }
    // The remote workspace is gone. Recover with a real workingDirectory.set()
    // to the session's original LOCAL cwd: that commits a
    // working-directory/change event and injects DSH's own notice. Never
    // throw here -- DSH calls ensure() while assembling every system prompt,
    // and a thrown error leaves the session unable to continue at all.
    const original = sessionAgent.session?.header?.cwd;
    if (typeof original === 'string' && !looksVirtual(original)) {
      try {
        return await workingDirectory.set(agent, original, signal);
      } catch (error) {
        ctx.logger.warn(`remote-ssh: could not restore local cwd ${original}: ${(error as Error)?.message ?? String(error)}`);
      }
    }
    return await originalEnsure(agent, signal);
  };
  return () => {
    workingDirectory.ensure = originalEnsure;
  };
}

export function apply(ctx: PluginContext, config: Config = {}): void {
  const storageDir = config.storageDir !== undefined ? expandUserPath(config.storageDir) : path.join(os.homedir(), '.dsh', 'remote-ssh');
  const manager = new RemoteSshManager({ storageDir, ...(config.maxRecent !== undefined ? { maxRecent: config.maxRecent } : {}) }, ctx.logger);

  const webServer = ctx.get('webServer') as { register(options: { kind: 'prefix'; path: string; handler: (req: unknown, res: unknown) => Promise<void> }): () => void } | undefined;
  if (!webServer || typeof webServer.register !== 'function') {
    throw new RemoteSshError('SSH_FEATURE_UNSUPPORTED', 'DSH webServer is required for the native left sidebar plugin');
  }
  const connection = ctx.get('connection') as { requestRejection(req: unknown): number | undefined } | undefined;
  if (!connection || typeof connection.requestRejection !== 'function') {
    throw new RemoteSshError('SSH_FEATURE_UNSUPPORTED', 'DSH Connection browser session authorization is required');
  }
  const agents = new Map<string, AgentRef>();
  const previousCwd = new Map<string, string>();
  // The native terminal-controller passes the Agent ID in
  // spec.env.DSH_SESSION_ID. Record the original DSH Session workspace to
  // distinguish a real SSH project from a local session with a stale cwd.
  const terminalSessionOrigins = new Map<string, string>();
  ctx.on('agent/created', (event: unknown) => {
    const agent = agentFromCreatedEvent(event);
    const id = agent?.session?.id ?? agent?.session?.header?.id;
    if (agent && typeof id === 'string' && id.length > 0) {
      agents.delete(id);
      agents.set(id, agent);
      if (agents.size > 80) agents.delete(agents.keys().next().value!);
      const origin = agent.session.header?.cwd;
      if (typeof origin === 'string' && origin.length > 0) {
        for (const key of new Set([id, agent.id])) {
          if (typeof key !== 'string' || key.length === 0) continue;
          terminalSessionOrigins.delete(key);
          terminalSessionOrigins.set(key, origin);
        }
        while (terminalSessionOrigins.size > 160) {
          const oldest = terminalSessionOrigins.keys().next().value;
          if (oldest === undefined) break;
          terminalSessionOrigins.delete(oldest);
        }
      }
    }
  }, { global: true });

  ctx.effect(() => {
    const workspaceCleanup = installWorkspaceCleanup(ctx, manager, storageDir, ctx.logger, {
      registered: () => {
        const registry = ctx.get('workspaceRegistry') as
          | { list?: () => Array<{ id: string; path: string }> }
          | undefined;
        return typeof registry?.list === 'function' ? registry.list() : [];
      },
    });
    const fsHandle = installFsRouter(ctx as unknown as { fs: Record<string, unknown>; effect?: (fn: () => () => void) => void }, manager);
    const shellHandle = installShellRouter(ctx as unknown as { shell: Record<string, unknown>; effect?: (fn: () => () => void) => void }, manager);
    const remoteFs = fsHandle.remoteFs;
    const restoreSearch = installRemoteSearchShadow(
      ctx as unknown as Parameters<typeof installRemoteSearchShadow>[0],
      manager,
      remoteFs,
    );
    const restoreWorkingDirectory = guardWorkingDirectory(ctx);
    registerManagementTools(ctx as unknown as Parameters<typeof registerManagementTools>[0], manager, remoteFs);
    // The native right-side terminal is created by terminalController through
    // subprocess.spawnTerminal(). Route only when its cwd is an SSH placeholder,
    // preserving ordinary local/WSL terminals without a second UI surface.
    const subprocess = ctx.get('subprocess') as
      | Parameters<typeof installNativeTerminalRouter>[0]
      | undefined;
    const nativeTerminal = subprocess && typeof subprocess.spawnTerminal === 'function'
      ? installNativeTerminalRouter(subprocess, manager, ctx.logger,
        sessionId => terminalSessionOrigins.get(sessionId))
      : undefined;
    if (!nativeTerminal) ctx.logger.warn(
      'remote-ssh: native DSH terminal router unavailable (subprocess service missing)',
    );
    const remoteTerminals = new RemoteTerminalPool(manager);
    const workspaceRegistry = (): WorkspaceRegistry | undefined => ctx.get('workspaceRegistry') as WorkspaceRegistry | undefined;
    const unregisterHttp = webServer.register({
      kind: 'prefix',
      path: '/api/remote-ssh',
      handler: createNativeHttpHandler({ manager, workingDirectory: ctx.workingDirectory, agents, previousCwd, workspaceRegistry, remoteTerminals, requestRejection: request => connection.requestRejection(request) }) as (req: unknown, res: unknown) => Promise<void>,
    });
    ctx.logger.info(`remote-ssh: ready (storage ${storageDir})`);
    return () => {
      nativeTerminal?.dispose();
      remoteTerminals.closeAll();
      workspaceCleanup.dispose();
      unregisterHttp?.();
      restoreSearch();
      restoreWorkingDirectory();
      shellHandle.dispose();
      fsHandle.dispose();
      manager.closeAll();
    };
  });
}
