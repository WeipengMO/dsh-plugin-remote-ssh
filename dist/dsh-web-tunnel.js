/**
 * Private browser path to an independently running DSH Web Host.
 *
 * Windows desktop DSH keeps SSH credentials and this listener. The remote
 * DSH owns its own Sessions, Agent, Git, filesystem and terminal: we never
 * pretend that a local placeholder directory is the remote Git repository.
 */
import net from 'node:net';
import { RemoteSshError } from './errors.js';
export const DEFAULT_DSH_WEB_PORT = 3080;
/** Per-Host local loopback forwarder. No public bind or upstream HTTP parsing. */
export class RemoteDshWebTunnelPool {
    manager;
    tunnels = new Map();
    pending = new Map();
    disposed = false;
    constructor(manager) {
        this.manager = manager;
    }
    list() {
        return [...this.tunnels.entries()].map(([key, tunnel]) => this.describe(key, tunnel));
    }
    describe(key, tunnel) {
        return { key, host: tunnel.host, remotePort: tunnel.remotePort, localPort: tunnel.localPort,
            localUrl: 'http://127.0.0.1:' + tunnel.localPort };
    }
    /** Open one tunnel per SSH Host (legacy single-Web mode). */
    async open(host, remotePort = DEFAULT_DSH_WEB_PORT) {
        return await this.openScoped(host, host, remotePort);
    }
    /**
     * Open a tunnel keyed by a stable remote DSH Host id. One SSH Host may carry
     * several Linux DSH Web instances, each with its own remote port; keys keep
     * them independent without closing a sibling's listener.
     */
    async openScoped(key, host, remotePort = DEFAULT_DSH_WEB_PORT) {
        if (this.disposed)
            throw new RemoteSshError('SSH_FEATURE_UNSUPPORTED', 'DSH Web tunnel pool is disposed');
        if (!Number.isSafeInteger(remotePort) || remotePort < 1024 || remotePort > 65535) {
            throw new RemoteSshError('SSH_PATH_INVALID', 'DSH Web remote port must be in 1024–65535');
        }
        const existing = this.tunnels.get(key);
        if (existing) {
            if (existing.host !== host || existing.remotePort !== remotePort) {
                throw new RemoteSshError('SSH_FEATURE_UNSUPPORTED', 'Close the existing DSH Web tunnel before changing ports');
            }
            return this.describe(key, existing);
        }
        const opening = this.pending.get(key);
        if (opening) {
            if (opening.host !== host || opening.remotePort !== remotePort)
                throw new RemoteSshError('SSH_FEATURE_UNSUPPORTED', 'Close the existing DSH Web tunnel before changing ports');
            return await opening.promise;
        }
        const pending = { host, remotePort, cancelled: false };
        this.pending.set(key, pending);
        pending.promise = this.start(key, host, remotePort, pending);
        try {
            return await pending.promise;
        }
        finally {
            if (this.pending.get(key) === pending)
                this.pending.delete(key);
        }
    }
    async start(key, host, remotePort, pending) {
        // No listener unless the verified SSH transport can actually reach the
        // remote loopback Web port. An unavailable Web Host is not a success.
        const connection = await this.manager.connection(host);
        let probe;
        try {
            probe = await connection.forwardLoopback(remotePort);
        }
        catch (cause) {
            throw new RemoteSshError('SSH_CONNECT_FAILED', 'Remote DSH Web is unavailable at 127.0.0.1:' + remotePort +
                '; start dsh --profile web on Linux and ensure SSH TCP forwarding is allowed: ' +
                (cause instanceof Error ? cause.message : String(cause)));
        }
        probe.destroy();
        if (this.disposed || pending.cancelled)
            throw new RemoteSshError('SSH_FEATURE_UNSUPPORTED', 'DSH Web tunnel was closed during connection');
        const sockets = new Set();
        const server = net.createServer(socket => {
            sockets.add(socket);
            socket.setNoDelay(true);
            socket.pause();
            let channel;
            const cleanup = () => { sockets.delete(socket); channel?.destroy?.(); };
            socket.once('close', cleanup);
            socket.on('error', () => socket.destroy());
            void this.manager.connection(host)
                .then(ssh => ssh.forwardLoopback(remotePort))
                .then(remote => {
                if (socket.destroyed) {
                    remote.destroy?.();
                    return;
                }
                channel = remote;
                remote.on('error', () => socket.destroy());
                remote.once('close', () => socket.destroy());
                socket.pipe(remote).pipe(socket);
                socket.resume();
            }).catch(() => socket.destroy());
        });
        try {
            await new Promise((resolve, reject) => {
                const fail = (err) => { server.off('listening', ready); reject(err); };
                const ready = () => { server.off('error', fail); resolve(); };
                server.once('error', fail);
                server.once('listening', ready);
                // 127.0.0.1 only; kernel chooses a free port. Never bind 0.0.0.0.
                server.listen(0, '127.0.0.1');
            });
            if (this.disposed || pending.cancelled)
                throw new RemoteSshError('SSH_FEATURE_UNSUPPORTED', 'DSH Web tunnel was closed during binding');
            const address = server.address();
            if (!address || typeof address === 'string')
                throw new Error('local tunnel did not bind a TCP port');
            const tunnel = { server, sockets, localPort: address.port, remotePort, host, key };
            this.tunnels.set(key, tunnel);
            return this.describe(key, tunnel);
        }
        catch (cause) {
            try {
                server.close();
            }
            catch { /* listener may have failed before bind */ }
            for (const socket of sockets)
                socket.destroy();
            throw cause;
        }
    }
    close(key) {
        const pending = this.pending.get(key);
        if (pending) {
            pending.cancelled = true;
            this.pending.delete(key);
        }
        const tunnel = this.tunnels.get(key);
        if (!tunnel)
            return !!pending;
        this.tunnels.delete(key);
        for (const socket of tunnel.sockets)
            socket.destroy();
        tunnel.server.close();
        return true;
    }
    /** Close every tunnel that belongs to one SSH Host, including scoped ones. */
    closeAllFor(host) {
        let removed = 0;
        for (const [key, pending] of [...this.pending.entries()]) {
            if (pending.host === host && this.close(key))
                removed += 1;
        }
        for (const [key, tunnel] of [...this.tunnels.entries()]) {
            if (tunnel.host === host || key === host) {
                this.close(key);
                removed += 1;
            }
        }
        return removed;
    }
    closeAll() {
        this.disposed = true;
        for (const pending of this.pending.values())
            pending.cancelled = true;
        this.pending.clear();
        for (const key of [...this.tunnels.keys()])
            this.close(key);
    }
}
//# sourceMappingURL=dsh-web-tunnel.js.map