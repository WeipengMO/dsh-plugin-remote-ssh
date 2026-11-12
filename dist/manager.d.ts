import { SshConnection, type LoggerLike } from './connection.js';
import { type HostKeyVerification } from './known-hosts.js';
import { type EffectiveSshConfig } from './ssh-config.js';
import type { ConnectionStatus, HostRecord, RecentWorkspace, WorkspaceRecord } from './types.js';
export interface ManagerConfig {
    storageDir: string;
    maxRecent?: number;
}
export interface FsRoute {
    workspace: WorkspaceRecord;
    remotePath: string;
    virtualPath: string;
    targetKey: string;
}
export interface ResolvedRoute extends FsRoute {
    connection: SshConnection;
    homeDir: string;
}
export interface OpenResult {
    workspace: WorkspaceRecord;
    virtualPath: string;
    status: ConnectionStatus;
}
export interface TestResult {
    ok: boolean;
    code?: string;
    message?: string;
    status?: ConnectionStatus;
    details?: Record<string, unknown>;
}
/**
 * Persisted host/workspace registry and per-host connection pool.
 *
 * No field here ever contains a password, passphrase, or private key: only a
 * key path and the public host key (which is safe to display).
 */
export declare class RemoteSshManager {
    readonly storageDir: string;
    readonly hostsFile: string;
    readonly workspacesFile: string;
    readonly knownHostsPath: string;
    private readonly maxRecent;
    private readonly logger;
    private hostsValue;
    private workspacesValue;
    private readonly connections;
    private readonly stores;
    private readonly connecting;
    constructor(config: ManagerConfig, logger: LoggerLike);
    hosts(): HostRecord[];
    getHost(id: string): HostRecord;
    private saveHosts;
    addHost(input: Partial<HostRecord> & {
        host: string;
    }): HostRecord;
    updateHost(id: string, patch: Partial<HostRecord>): HostRecord;
    removeHost(id: string): void;
    private validateHost;
    /** Effective config for a stored host; throws without connecting. */
    effectiveConfig(id: string): EffectiveSshConfig;
    private hostKeyStore;
    connection(id: string): Promise<SshConnection>;
    connectionIfReady(id: string): SshConnection | undefined;
    disconnect(id: string): void;
    closeAll(): void;
    statuses(): ConnectionStatus[];
    test(id: string): Promise<TestResult>;
    trustHostKey(id: string, hostKeyBase64: string, fingerprint: string): {
        host: string;
        port: number;
        fingerprint: string;
    };
    untrustHostKey(id: string): number;
    knownHostKey(id: string): HostKeyVerification | undefined;
    private loadWorkspaces;
    private saveWorkspaces;
    workspaces(): WorkspaceRecord[];
    recent(): RecentWorkspace[];
    /**
     * Clear only the recent-folder navigation history. Registered SSH/DSH
     * workspaces, their placeholder directories and remote files stay intact.
     */
    clearRecentHistory(): number;
    workspaceByToken(token: string): WorkspaceRecord;
    /** Called after DSH has deleted a workspace and its owned empty placeholder. */
    forgetWorkspace(token: string): void;
    private rememberWorkspace;
    openWorkspace(hostId: string, inputPath: string | undefined): Promise<OpenResult>;
    /**
     * DSH project cwd is an existing local placeholder; the actual files remain
     * remote. A placeholder root corresponds to workspace.remoteRoot, not '/'.
     * Never mistake a normal local path for a remote one.
     */
    routeFor(pathValue: string, cwd: string | undefined): FsRoute | null;
    resolveRoute(pathValue: string, cwd: string | undefined): Promise<ResolvedRoute | null>;
    ensureKnownHostsFile(connection: SshConnection): Promise<string>;
}
