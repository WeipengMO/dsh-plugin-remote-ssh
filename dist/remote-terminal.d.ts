import type { RemoteSshManager } from './manager.js';
/**
 * Browser-facing remote interactive shell. A genuine SSH PTY, independent from
 * DSH's built-in *local* terminalController. Output is polled over the existing
 * authenticated HTTP API (no second unauthenticated socket/server).
 */
export declare class RemoteTerminalPool {
    private readonly manager;
    private terminals;
    constructor(manager: RemoteSshManager);
    open(hostId: string, remotePath: string): Promise<{
        id: string;
        hostId: string;
        remoteRoot: string;
    }>;
    read(id: string, cursor: number): {
        output: string;
        cursor: number;
        closed: boolean;
        truncated: boolean;
    };
    write(id: string, input: string): void;
    resize(id: string, cols: number, rows: number): void;
    close(id: string): void;
    closeAll(): void;
    private get;
}
