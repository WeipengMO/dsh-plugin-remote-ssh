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
 * Guard the one unsafe fallback in DSH's working-directory service: when a
 * current directory no longer exists it restores the session's original local
 * project. For a virtual remote cwd that would silently move the agent back to
 * local files after a remote failure, so remote cwds are validated explicitly
 * and never auto-restored.
 */
function guardWorkingDirectory(ctx: PluginContext): () => void {
  const workingDirectory = ctx.workingDirectory;
  const originalEnsure = workingDirectory.ensure.bind(workingDirectory);
  workingDirectory.ensure = async (agent: unknown, signal?: AbortSignal): Promise<string> => {
    const sessionAgent = agent as { session: unknown };
    const current = workingDirectory.get(sessionAgent.session);
    if (!looksVirtual(current)) return await originalEnsure(agent, signal);
    const target = await (ctx.fs as any).resolve(current, { signal });
    const info = await (ctx.fs as any).stat(target, signal);
    if (info?.type !== 'directory') {
      throw new RemoteSshError(
        'SSH_PATH_INVALID',
        `remote workspace directory ${current} no longer exists or is not a directory; refusing to fall back to local files. Reconnect or open another remote workspace.`,
      );
    }
    const result = await originalEnsure(agent, signal);
    if (!looksVirtual(result)) {
      try {
        await workingDirectory.set(agent, current, signal);
      } catch {
        // Best effort; the error below is the authoritative outcome.
      }
      throw new RemoteSshError(
        'SSH_PATH_INVALID',
        `remote workspace ${current} could not be validated and DSH tried to restore a local cwd; refused. Reopen the remote workspace.`,
      );
    }
    return result;
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
  ctx.on('agent/created', (event: unknown) => {
    const agent = agentFromCreatedEvent(event);
    const id = agent?.session?.id ?? agent?.session?.header?.id;
    if (agent && typeof id === 'string' && id.length > 0) {
      agents.delete(id);
      agents.set(id, agent);
      if (agents.size > 80) agents.delete(agents.keys().next().value!);
    }
  }, { global: true });

  ctx.effect(() => {
    const fsHandle = installFsRouter(ctx as unknown as { fs: Record<string, unknown>; effect?: (fn: () => () => void) => void }, manager);
    const shellHandle = installShellRouter(ctx as unknown as { shell: Record<string, unknown>; effect?: (fn: () => () => void) => void }, manager);
    const remoteFs = fsHandle.remoteFs;
    installRemoteSearchShadow(
      ctx as unknown as Parameters<typeof installRemoteSearchShadow>[0],
      manager,
      remoteFs,
    );
    const restoreWorkingDirectory = guardWorkingDirectory(ctx);
    registerManagementTools(ctx as unknown as Parameters<typeof registerManagementTools>[0], manager, remoteFs);
    const unregisterHttp = webServer.register({
      kind: 'prefix',
      path: '/api/remote-ssh',
      handler: createNativeHttpHandler({ manager, workingDirectory: ctx.workingDirectory, agents, previousCwd, requestRejection: request => connection.requestRejection(request) }) as (req: unknown, res: unknown) => Promise<void>,
    });
    ctx.logger.info(`remote-ssh: ready (storage ${storageDir})`);
    return () => {
      unregisterHttp?.();
      restoreWorkingDirectory();
      shellHandle.dispose();
      fsHandle.dispose();
      manager.closeAll();
    };
  });
}
