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
export const name = 'remote-ssh';
/** The plugin needs the native tool seams before it can route remote work. */
export const inject = ['fs', 'shell', 'tools', 'workingDirectory', 'systemPrompt', 'webServer', 'connection'];
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
function guardWorkingDirectory(ctx) {
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
            ctx.logger.warn(`remote-ssh: remote workspace ${current} is unavailable: ${error?.message ?? String(error)}`);
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
            }
            catch (error) {
                ctx.logger.warn(`remote-ssh: could not restore local cwd ${original}: ${error?.message ?? String(error)}`);
            }
        }
        return await originalEnsure(agent, signal);
    };
    return () => {
        workingDirectory.ensure = originalEnsure;
    };
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
    ctx.on('agent/created', (event) => {
        const agent = agentFromCreatedEvent(event);
        const id = agent?.session?.id ?? agent?.session?.header?.id;
        if (agent && typeof id === 'string' && id.length > 0) {
            agents.delete(id);
            agents.set(id, agent);
            if (agents.size > 80)
                agents.delete(agents.keys().next().value);
        }
    }, { global: true });
    ctx.effect(() => {
        const fsHandle = installFsRouter(ctx, manager);
        const shellHandle = installShellRouter(ctx, manager);
        const remoteFs = fsHandle.remoteFs;
        const restoreSearch = installRemoteSearchShadow(ctx, manager, remoteFs);
        const restoreWorkingDirectory = guardWorkingDirectory(ctx);
        registerManagementTools(ctx, manager, remoteFs);
        const unregisterHttp = webServer.register({
            kind: 'prefix',
            path: '/api/remote-ssh',
            handler: createNativeHttpHandler({ manager, workingDirectory: ctx.workingDirectory, agents, previousCwd, requestRejection: request => connection.requestRejection(request) }),
        });
        ctx.logger.info(`remote-ssh: ready (storage ${storageDir})`);
        return () => {
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