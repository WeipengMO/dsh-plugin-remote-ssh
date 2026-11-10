import type { SFTPWrapper } from 'ssh2';
import { RemoteSshError } from './errors.js';
import type { HostKeyStore, HostKeyVerification } from './known-hosts.js';
import { type EffectiveSshConfig } from './ssh-config.js';
import type { ConnectionState, ConnectionStatus } from './types.js';
export interface LoggerLike {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}
export interface ExecOptions {
    signal?: AbortSignal;
    maxBytes?: number;
    timeoutMs?: number;
}
export interface ExecResult {
    stdout: string;
    stderr: string;
    code: number | null;
    signal: string | null;
    truncated: boolean;
}
/**
 * One SSH transport with strict host-key verification, keepalive, lazy
 * reconnect, and SFTP helpers. The connection object is shared by all sessions
 * and serializes reconnects.
 */
export declare class SshConnection {
    readonly id: string;
    readonly label: string;
    readonly config: EffectiveSshConfig;
    readonly hostKeys: HostKeyStore;
    private readonly logger;
    private client;
    private sftpWrapper;
    private connectPromise;
    private homePromise;
    private verification;
    private stateValue;
    private lastErrorValue;
    private connectedAtValue;
    private reconnectCountValue;
    constructor(id: string, label: string, config: EffectiveSshConfig, hostKeys: HostKeyStore, logger: LoggerLike);
    get state(): ConnectionState;
    get sftp(): SFTPWrapper;
    verifiedHostKey(): HostKeyVerification | undefined;
    status(): ConnectionStatus;
    /** Ensure a live transport. Concurrent callers share one connect attempt. */
    ensure(): Promise<void>;
    private authCandidates;
    private open;
    private mapConnectError;
    /** Mark a broken transport and force the next ensure() to reconnect. */
    invalidate(error?: unknown): void;
    reconnect(): Promise<void>;
    /** Run a one-shot remote command over ssh2 (used by diagnostics and search). */
    exec(command: string, options?: ExecOptions): Promise<ExecResult>;
    remoteHome(): Promise<string>;
    mapSftpError(error: {
        code?: number | string;
        message: string;
    }, verb: string): RemoteSshError;
    close(): void;
    /** True when an error means the transport, not the operation, failed. */
    static connectionLost(error: unknown): boolean;
}
