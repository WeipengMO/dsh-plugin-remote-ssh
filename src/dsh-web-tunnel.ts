/**
 * Private browser path to an independently running DSH Web Host.
 *
 * Windows desktop DSH keeps SSH credentials and this listener. The remote
 * DSH owns its own Sessions, Agent, Git, filesystem and terminal: we never
 * pretend that a local placeholder directory is the remote Git repository.
 */
import net, { type Server, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { RemoteSshError } from './errors.js';

export const DEFAULT_DSH_WEB_PORT = 3080;
interface RemoteForward { forwardLoopback(port: number): Promise<Duplex> }
interface ManagerLike { connection(host: string): Promise<RemoteForward> }
interface Tunnel { server: Server; sockets: Set<Socket>; localPort: number; remotePort: number }
export interface TunnelView {
  host: string;
  remotePort: number;
  localPort: number;
  localUrl: string;
}

/** Per-Host local loopback forwarder. No public bind or upstream HTTP parsing. */
export class RemoteDshWebTunnelPool {
  private readonly tunnels = new Map<string, Tunnel>();
  private readonly pending = new Map<string, Promise<TunnelView>>();
  private disposed = false;
  constructor(private readonly manager: ManagerLike) {}

  list(): TunnelView[] {
    return [...this.tunnels.entries()].map(([host, tunnel]) => this.describe(host, tunnel));
  }

  private describe(host: string, tunnel: Tunnel): TunnelView {
    return { host, remotePort: tunnel.remotePort, localPort: tunnel.localPort,
      localUrl: 'http://127.0.0.1:' + tunnel.localPort };
  }

  async open(host: string, remotePort = DEFAULT_DSH_WEB_PORT): Promise<TunnelView> {
    if (this.disposed) throw new RemoteSshError('SSH_FEATURE_UNSUPPORTED', 'DSH Web tunnel pool is disposed');
    if (!Number.isSafeInteger(remotePort) || remotePort < 1024 || remotePort > 65535) {
      throw new RemoteSshError('SSH_PATH_INVALID', 'DSH Web remote port must be in 1024–65535');
    }
    const existing = this.tunnels.get(host);
    if (existing) {
      if (existing.remotePort !== remotePort) {
        throw new RemoteSshError('SSH_FEATURE_UNSUPPORTED', 'Close the existing DSH Web tunnel before changing ports');
      }
      return this.describe(host, existing);
    }
    const opening = this.pending.get(host);
    if (opening) return await opening;
    const task = this.start(host, remotePort);
    this.pending.set(host, task);
    try { return await task; }
    finally { this.pending.delete(host); }
  }

  private async start(host: string, remotePort: number): Promise<TunnelView> {
    // No listener unless the verified SSH transport can actually reach the
    // remote loopback Web port. An unavailable Web Host is not a success.
    const connection = await this.manager.connection(host);
    let probe: Duplex;
    try { probe = await connection.forwardLoopback(remotePort); }
    catch (cause) {
      throw new RemoteSshError('SSH_CONNECT_FAILED',
        'Remote DSH Web is unavailable at 127.0.0.1:' + remotePort +
        '; start dsh --profile web on Linux and ensure SSH TCP forwarding is allowed: ' +
        (cause instanceof Error ? cause.message : String(cause)));
    }
    probe.destroy();
    if (this.disposed) throw new RemoteSshError('SSH_FEATURE_UNSUPPORTED', 'DSH Web tunnel pool was disposed during connection');
    const sockets = new Set<Socket>();
    const server = net.createServer(socket => {
      sockets.add(socket);
      socket.setNoDelay(true);
      socket.pause();
      let channel: Duplex | undefined;
      const cleanup = () => { sockets.delete(socket); channel?.destroy?.(); };
      socket.once('close', cleanup);
      socket.on('error', () => socket.destroy());
      void this.manager.connection(host)
        .then(ssh => ssh.forwardLoopback(remotePort))
        .then(remote => {
          if (socket.destroyed) { remote.destroy?.(); return; }
          channel = remote;
          remote.on('error', () => socket.destroy());
          remote.once('close', () => socket.destroy());
          socket.pipe(remote).pipe(socket);
          socket.resume();
        }).catch(() => socket.destroy());
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const fail = (err: Error) => { server.off('listening', ready); reject(err); };
        const ready = () => { server.off('error', fail); resolve(); };
        server.once('error', fail);
        server.once('listening', ready);
        // 127.0.0.1 only; kernel chooses a free port. Never bind 0.0.0.0.
        server.listen(0, '127.0.0.1');
      });
      if (this.disposed) throw new RemoteSshError('SSH_FEATURE_UNSUPPORTED', 'DSH Web tunnel pool was disposed during binding');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('local tunnel did not bind a TCP port');
      const tunnel = { server, sockets, localPort: address.port, remotePort };
      this.tunnels.set(host, tunnel);
      return this.describe(host, tunnel);
    } catch (cause) {
      try { server.close(); } catch { /* listener may have failed before bind */ }
      for (const socket of sockets) socket.destroy();
      throw cause;
    }
  }

  close(host: string): boolean {
    const tunnel = this.tunnels.get(host);
    if (!tunnel) return false;
    this.tunnels.delete(host);
    for (const socket of tunnel.sockets) socket.destroy();
    tunnel.server.close();
    return true;
  }

  closeAll(): void {
    this.disposed = true;
    for (const host of [...this.tunnels.keys()]) this.close(host);
  }
}
