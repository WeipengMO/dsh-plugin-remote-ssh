import { looksVirtual, parseVirtualPath } from './paths.js';
import { RemoteSshError } from './errors.js';
function bounded(n, min, max) {
    return Math.max(min, Math.min(max, n));
}
/**
 * Wrap an already authenticated ssh2 PTY in DSH's SubprocessTerminalHandle
 * contract. Native xterm receives the unmodified ANSI bytes, unlike the
 * old text-only popup that stripped VT escape sequences.
 */
export class SshNativeTerminal {
    pid = 0; // SSH exec does not report a verifiable remote PID.
    output;
    done;
    channel;
    abort;
    abortHandler;
    grace;
    revision = 0;
    ended = false;
    termination;
    constructor(channel, options = {}) {
        this.channel = channel;
        this.output = channel;
        this.grace = bounded(options.graceMs ?? 1500, 200, 10_000);
        this.abort = options.signal;
        this.abortHandler = () => { void this.terminate().catch(() => { }); };
        this.done = new Promise((resolve, reject) => {
            channel.once('close', (code, remoteSignal) => {
                this.ended = true;
                this.abort?.removeEventListener('abort', this.abortHandler);
                resolve({ exitCode: typeof code === 'number' ? code : null,
                    signal: remoteSignal ? (remoteSignal.startsWith('SIG') ? remoteSignal : 'SIG' + remoteSignal) : null });
            });
            channel.once('error', (cause) => {
                this.ended = true;
                this.abort?.removeEventListener('abort', this.abortHandler);
                reject(cause);
            });
        });
        void this.done.catch(() => { }); // keep transport loss observable to consumers
        // Do not attach a 'data' listener here: that would switch the Readable
        // into flowing mode and could discard the remote shell banner before
        // DSH's native xterm consumer is attached.
        this.abort?.addEventListener('abort', this.abortHandler, { once: true });
        if (this.abort?.aborted)
            this.abortHandler();
    }
    async write(data) {
        if (this.ended)
            throw new RemoteSshError('SSH_CHANNEL_FAILED', 'SSH terminal is closed');
        this.revision++;
        await new Promise((resolve, reject) => {
            this.channel.write(data, (error) => error ? reject(error) : resolve());
        });
    }
    async resize(cols, rows) {
        if (this.ended)
            return;
        this.channel.setWindow(bounded(rows, 1, 200), bounded(cols, 2, 500), 0, 0);
        this.revision++;
    }
    async inspectForeground() {
        // ssh2 does not expose the remote kernel's foreground process-group ID.
        return undefined;
    }
    async inspectActivity() {
        // Silence is not proof of remote idleness. Never fabricate a status.
        return { state: 'unknown', revision: this.revision };
    }
    async signalForeground(signal) {
        // Native xterm Ctrl-C/Ctrl-Z enter as raw PTY input and work normally.
        // DSH's foreground-signal API requires the *actual* remote PGID, which the
        // plain SSH2 protocol does not provide; failing explicitly is safer.
        throw new RemoteSshError('SSH_FEATURE_UNSUPPORTED', 'Cannot confirm remote foreground process-group ID for ' + signal + '; use terminal Ctrl+C / Ctrl+Z');
    }
    async terminate() {
        if (this.termination)
            return await this.termination;
        if (this.ended)
            return;
        this.termination = (async () => {
            try {
                this.channel.signal('HUP');
            }
            catch { /* closing channel also ends the SSH PTY */ }
            try {
                this.channel.close();
            }
            catch { /* channel already closed */ }
            await Promise.race([
                this.done.then(() => { }, () => { }),
                new Promise((_resolve, reject) => {
                    const timer = setTimeout(() => {
                        reject(new RemoteSshError('SSH_CHANNEL_FAILED', 'SSH PTY channel did not close within the cleanup deadline'));
                    }, this.grace);
                    void this.done.finally(() => clearTimeout(timer)).catch(() => { });
                }),
            ]);
        })();
        return await this.termination;
    }
}
/**
 * Route DSH's EXISTING right-sidebar terminalController -> subprocess
 * spawnTerminal primitive. This preserves the native xterm tab, terminal
 * retention and session identity: only the process execution location changes.
 *
 * Dispatch is deliberately based on the provider call's cwd, not on the last
 * selected host or a global toggle. Native Windows and WSL projects are
 * byte-for-byte delegated to the original subprocess provider.
 */
/**
 * The DSH terminal controller supplies `env.DSH_SESSION_ID` from the Agent.
 * Session ownership is independent of the *current* working directory:
 * a local session may retain an SSH placeholder cwd after a workspace switch.
 * Never start a remote shell merely because that cwd looks like our placeholder.
 */
export function installNativeTerminalRouter(runtime, manager, logger, sessionOrigin) {
    const original = runtime.spawnTerminal;
    if (typeof original !== 'function')
        throw new Error('DSH subprocess.spawnTerminal is unavailable');
    const routed = async (spec) => {
        // A local (including WSL) cwd MUST always use the original provider, with
        // the full original argv. Do not change its default shell or candidates.
        if (!looksVirtual(spec.cwd))
            return await original.call(runtime, spec);
        const id = spec.env?.DSH_SESSION_ID;
        const origin = typeof id === 'string' && id.length > 0 ? sessionOrigin?.(id) : undefined;
        const requested = parseVirtualPath(spec.cwd);
        const actualOrigin = parseVirtualPath(origin);
        if (!requested)
            return await original.call(runtime, spec);
        // The terminal process can have a stale placeholder after switching a
        // LOCAL session back from SSH. Restore its original LOCAL cwd and delegate
        // instead of allowing the SSH plugin to hijack the native terminal.
        if (typeof origin === 'string' && origin.length > 0 && !looksVirtual(origin)) {
            logger?.warn?.('remote-ssh: refused SSH terminal for local session ' + id +
                '; restoring local cwd=' + origin);
            return await original.call(runtime, { ...spec, cwd: origin });
        }
        // Unknown session ownership is ambiguous and cannot authorize a remote
        // process. Fail closed rather than unpredictably launching SSH or WSL.
        if (!actualOrigin) {
            throw new RemoteSshError('SSH_WORKSPACE_UNKNOWN', 'Cannot verify terminal session ownership for SSH workspace; open a new DSH session in this remote project and retry');
        }
        if (actualOrigin.workspaceToken !== requested.workspaceToken) {
            throw new RemoteSshError('SSH_WORKSPACE_UNKNOWN', 'Terminal session and requested SSH workspace belong to different hosts; refusing cross-workspace terminal');
        }
        spec.signal?.throwIfAborted();
        const route = manager.routeFor(spec.cwd, spec.cwd);
        if (!route || route.workspace.token !== requested.workspaceToken) {
            throw new RemoteSshError('SSH_WORKSPACE_UNKNOWN', 'Remote terminal cannot map this session to a registered SSH workspace; refusing local fallback');
        }
        logger?.info('remote-ssh: native DSH terminal routed to SSH host ' +
            route.workspace.connectionId + ' cwd=' + route.remotePath);
        const conn = await manager.connection(route.workspace.connectionId);
        const channel = await conn.terminalInDirectory(route.remotePath, spec.cols, spec.rows, spec.terminalType || 'xterm-256color');
        if (spec.signal?.aborted) {
            channel.close();
            spec.signal.throwIfAborted();
        }
        return new SshNativeTerminal(channel, spec);
    };
    runtime.spawnTerminal = routed;
    return { dispose() { runtime.spawnTerminal = original; } };
}
//# sourceMappingURL=native-terminal-router.js.map