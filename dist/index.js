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
import { agentFromCreatedEvent, createNativeHttpHandler } from './http-api.js';
import { installWorkspaceCleanup } from './workspace-cleanup.js';
import { RemoteTerminalPool } from './remote-terminal.js';
import { RemoteDshWebTunnelPool } from './dsh-web-tunnel.js';
import { RemoteHostRuntimePool } from './remote-host-runtime.js';
import { installNativeTerminalRouter } from './native-terminal-router.js';
import { installNativeGitRouter } from './native-git-router.js';
export const name = 'remote-ssh';
/** The plugin needs the native tool seams before it can route remote work. */
export const inject = ['fs', 'shell', 'tools', 'workingDirectory', 'systemPrompt', 'webServer', 'connection'];
/**
 * Fail closed when an SSH workspace is temporarily unavailable. Never change
 * the session to a Windows LOCAL cwd without an explicit user request.
 *
 * DSH calls workingDirectory.ensure() while constructing agent prompts.
 * Throwing would strand those prompts, so return the unchanged virtual cwd;
 * subsequent remote file/process calls will surface the SSH failure.
 */
export function guardWorkingDirectory(ctx) {
    const workingDirectory = ctx.workingDirectory;
    const originalEnsure = workingDirectory.ensure.bind(workingDirectory);
    workingDirectory.ensure = async (agent, signal) => {
        const sessionAgent = agent;
        const current = workingDirectory.get(sessionAgent.session);
        if (!looksVirtual(current))
            return await originalEnsure(agent, signal);
        try {
            const target = await ctx.fs.resolve(current, { signal });
            const info = await ctx.fs.stat(target, signal);
            if (info?.type === 'directory')
                return await originalEnsure(agent, signal);
        }
        catch (error) {
            ctx.logger.warn('remote-ssh: remote workspace is temporarily unavailable; preserving SSH cwd: ' +
                (error?.message ?? String(error)));
        }
        // The only safe automatic recovery is to retain the remote identity.
        // User-controlled remote_workspace_close is the explicit local transition.
        return current;
    };
    return () => { workingDirectory.ensure = originalEnsure; };
}
export function apply(ctx, config = {}) {
    const storageDir = config.storageDir !== undefined ? expandUserPath(config.storageDir) : path.join(os.homedir(), '.dsh', 'remote-ssh');
    const manager = new RemoteSshManager({ storageDir, ...(config.maxRecent !== undefined ? { maxRecent: config.maxRecent } : {}) }, ctx.logger);
    const webServer = ctx.get('webServer');
    if (!webServer || typeof webServer.register !== 'function') {
        throw new RemoteSshError('SSH_FEATURE_UNSUPPORTED', 'DSH webServer is required for the native left sidebar plugin');
    }
    const connection = ctx.get('connection');
    if (!connection || typeof connection.requestRejection !== 'function') {
        throw new RemoteSshError('SSH_FEATURE_UNSUPPORTED', 'DSH Connection browser session authorization is required');
    }
    const agents = new Map();
    const previousCwd = new Map();
    // The native terminal-controller passes the Agent ID in
    // spec.env.DSH_SESSION_ID. Record the original DSH Session workspace to
    // distinguish a real SSH project from a local session with a stale cwd.
    const terminalSessionOrigins = new Map();
    ctx.on('agent/created', (event) => {
        const agent = agentFromCreatedEvent(event);
        const id = agent?.session?.id ?? agent?.session?.header?.id;
        if (agent && typeof id === 'string' && id.length > 0) {
            agents.delete(id);
            agents.set(id, agent);
            if (agents.size > 80)
                agents.delete(agents.keys().next().value);
            const origin = agent.session.header?.cwd;
            if (typeof origin === 'string' && origin.length > 0) {
                for (const key of new Set([id, agent.id])) {
                    if (typeof key !== 'string' || key.length === 0)
                        continue;
                    terminalSessionOrigins.delete(key);
                    terminalSessionOrigins.set(key, origin);
                }
                while (terminalSessionOrigins.size > 160) {
                    const oldest = terminalSessionOrigins.keys().next().value;
                    if (oldest === undefined)
                        break;
                    terminalSessionOrigins.delete(oldest);
                }
            }
        }
    }, { global: true });
    ctx.effect(() => {
        const workspaceCleanup = installWorkspaceCleanup(ctx, manager, storageDir, ctx.logger, {
            registered: () => {
                const registry = ctx.get('workspaceRegistry');
                return typeof registry?.list === 'function' ? registry.list() : [];
            },
        });
        const fsHandle = installFsRouter(ctx, manager);
        const shellHandle = installShellRouter(ctx, manager);
        const remoteFs = fsHandle.remoteFs;
        const restoreSearch = installRemoteSearchShadow(ctx, manager, remoteFs);
        const restoreWorkingDirectory = guardWorkingDirectory(ctx);
        registerManagementTools(ctx, manager, remoteFs);
        // `subprocess` is deliberately an OPTIONAL service. inject (above) is a
        // hard dependency list: adding it there would refuse to load the entire
        // plugin on any DSH build that does not expose this exact service name.
        // Resolve it with ctx.get() and degrade gracefully, like workspaceRegistry.
        // The native right-side terminal is created by terminalController through
        // subprocess.spawnTerminal(). Route only when its cwd is an SSH placeholder,
        // preserving ordinary local/WSL terminals without a second UI surface.
        const subprocess = ctx.get('subprocess');
        const nativeTerminal = subprocess && typeof subprocess.spawnTerminal === 'function'
            ? installNativeTerminalRouter(subprocess, manager, ctx.logger, sessionId => terminalSessionOrigins.get(sessionId))
            : undefined;
        if (!nativeTerminal)
            ctx.logger.warn('remote-ssh: native DSH terminal router unavailable (subprocess service missing)');
        const nativeGit = subprocess && typeof subprocess.spawn === 'function'
            ? installNativeGitRouter(subprocess, manager, ctx.logger) : undefined;
        if (!nativeGit)
            ctx.logger.warn('remote-ssh: native Git subprocess router unavailable (no subprocess service or spawn()); ' +
                'sidebar Changes / Code Review will not see remote Git data');
        const remoteTerminals = new RemoteTerminalPool(manager);
        const dshWebTunnels = new RemoteDshWebTunnelPool(manager);
        const remoteRuntime = new RemoteHostRuntimePool(manager);
        const desktopProfile = ctx.get('profileContext')?.name === 'desktop';
        const workspaceRegistry = () => ctx.get('workspaceRegistry');
        const requestRejection = (request) => connection.requestRejection(request);
        const unregisterHttp = webServer.register({
            kind: 'prefix',
            path: '/api/remote-ssh',
            handler: createNativeHttpHandler({ manager, workingDirectory: ctx.workingDirectory, agents, previousCwd, workspaceRegistry,
                remoteTerminals, dshWebTunnels, remoteRuntime, desktopProfile,
                requestRejection }),
        });
        ctx.logger.info(`remote-ssh: ready (storage ${storageDir})`);
        return () => {
            nativeGit?.dispose();
            nativeTerminal?.dispose();
            remoteRuntime.closeAll();
            dshWebTunnels.closeAll();
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
//# sourceMappingURL=index.js.map