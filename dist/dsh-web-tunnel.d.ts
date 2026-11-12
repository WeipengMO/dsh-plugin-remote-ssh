import type { Duplex } from 'node:stream';
export declare const DEFAULT_DSH_WEB_PORT = 3080;
interface RemoteForward {
    forwardLoopback(port: number): Promise<Duplex>;
}
interface ManagerLike {
    connection(host: string): Promise<RemoteForward>;
}
export interface TunnelView {
    key: string;
    host: string;
    remotePort: number;
    localPort: number;
    localUrl: string;
}
/** Per-Host local loopback forwarder. No public bind or upstream HTTP parsing. */
export declare class RemoteDshWebTunnelPool {
    private readonly manager;
    private readonly tunnels;
    private readonly pending;
    private disposed;
    constructor(manager: ManagerLike);
    list(): TunnelView[];
    private describe;
    /** Open one tunnel per SSH Host (legacy single-Web mode). */
    open(host: string, remotePort?: number): Promise<TunnelView>;
    /**
     * Open a tunnel keyed by a stable remote DSH Host id. One SSH Host may carry
     * several Linux DSH Web instances, each with its own remote port; keys keep
     * them independent without closing a sibling's listener.
     */
    openScoped(key: string, host: string, remotePort?: number): Promise<TunnelView>;
    private start;
    close(key: string): boolean;
    /** Close every tunnel that belongs to one SSH Host, including scoped ones. */
    closeAllFor(host: string): number;
    closeAll(): void;
}
export {};
