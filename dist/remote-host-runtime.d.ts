import type { RemoteSshManager } from './manager.js';
export declare const REMOTE_RUNTIME_PROTOCOL = 1;
export declare const REMOTE_HELPER_SHA256: string;
type RuntimeManager = Pick<RemoteSshManager, 'connection'>;
export interface RuntimeInfo {
    host: string;
    protocol: number;
    helperHash: string;
    helperPath: string;
    node: string;
    platform: string;
    arch: string;
    verified: true;
}
export interface WebHostStatus {
    phase: 'starting' | 'ready' | 'failed';
    cwd: string;
    port: number;
    /** Sensitive process-scoped browser credential. Do not log or persist this value. */
    url?: string;
    installation?: string;
    message?: string;
}
export interface RemoteGitInfo {
    cwd: string;
    git: {
        available: boolean;
        message?: string;
        root?: string;
        branch?: string | null;
        head?: string | null;
        status?: string;
        worktrees?: string;
        diffStat?: string;
        truncated?: boolean;
    };
}
export declare class RemoteHostRuntimePool {
    private readonly manager;
    private readonly active;
    private readonly pending;
    private readonly generations;
    private disposed;
    constructor(manager: RuntimeManager);
    list(): RuntimeInfo[];
    clear(host: string): void;
    closeAll(): void;
    connect(host: string): Promise<RuntimeInfo>;
    private setup;
    private invoke;
    inspect(host: string, remoteRoot: string): Promise<RemoteGitInfo>;
    ensureWeb(host: string, remoteRoot: string, installIfMissing?: boolean): Promise<WebHostStatus>;
    dshVersion(host: string): Promise<{
        installed: boolean;
        version?: string;
    }>;
}
export {};
