import { applyHunks } from '@deepseek-ai/dsh-fs-patch';
import { SshConnection } from './connection.js';
import type { RemoteSshManager, ResolvedRoute } from './manager.js';
export interface RemoteTarget {
    targetKey: string;
    displayPath: string;
    workspaceToken: string;
    connectionId?: string;
    remotePath: string;
    requestedRemotePath?: string;
}
export interface RemoteStat {
    version: string;
    type: 'file' | 'directory' | 'symlink' | 'other';
    size: number;
    mode?: number;
    mtime?: number;
}
export interface WritePolicy {
    mode?: string;
    sessionId?: string;
    workspaceRoot?: string;
    additionalWritableRoots?: string[];
}
/**
 * SFTP implementation of the {@link import('@deepseek-ai/dsh-fs').FileSystem}
 * surface for virtual remote targets. Every mutation is version guarded,
 * locked per remote path, and checked against the session sandbox policy using
 * the remote workspace root (not the local workspaceRoot).
 */
export declare class RemoteFileSystem {
    private readonly manager;
    private readonly locks;
    private readonly seq;
    constructor(manager: RemoteSshManager);
    resolve(pathValue: string, opts?: {
        cwd?: string;
        signal?: AbortSignal;
    }): Promise<RemoteTarget>;
    targetFor(route: ResolvedRoute, requested: string, signal?: AbortSignal): Promise<RemoteTarget>;
    private sftp;
    private mapError;
    private statRaw;
    private lstatRaw;
    private typeOf;
    private baseVersion;
    private versionOf;
    private bump;
    private statInfo;
    private targetRoute;
    /** Resolve the canonical path, including for a not-yet-existing file. */
    canonicalize(connection: SshConnection, remotePath: string, signal?: AbortSignal): Promise<string>;
    private info;
    private checkWrite;
    private withLock;
    stat(target: RemoteTarget, signal?: AbortSignal): Promise<RemoteStat | undefined>;
    lstat(pathValue: string, opts?: {
        cwd?: string;
        signal?: AbortSignal;
    }, signal?: AbortSignal): Promise<RemoteStat | undefined>;
    readText(target: RemoteTarget, signal?: AbortSignal): Promise<string>;
    streamTextGenerator(target: RemoteTarget, signal?: AbortSignal): AsyncGenerator<string>;
    streamText(target: RemoteTarget, signal?: AbortSignal): Promise<AsyncIterable<string>>;
    readWholeBytes(target: RemoteTarget, signal?: AbortSignal, maxBytes?: number): Promise<Buffer>;
    readBytes(target: RemoteTarget, signal?: AbortSignal, maxBytes?: number): Promise<Buffer>;
    readByteRange(target: RemoteTarget, range: {
        offset: number;
        length: number;
    }, signal?: AbortSignal): Promise<Uint8Array>;
    listDir(target: RemoteTarget, signal?: AbortSignal): Promise<Array<{
        name: string;
        type: RemoteStat['type'];
        target: RemoteTarget;
        version?: string;
        size?: number;
    }>>;
    private writeStream;
    private rename;
    private writeAtomic;
    private writeTarget;
    writeText(target: RemoteTarget, content: string, expected?: {
        kind?: string;
        version?: string;
    }, signal?: AbortSignal, policy?: WritePolicy): Promise<{
        operation: 'update' | 'create';
        version: string;
        before: string | null;
        after: string;
    }>;
    private diffBasis;
    editText(target: RemoteTarget, edit: {
        oldString: string;
        newString: string;
        replaceAll?: boolean;
    }, expected?: {
        kind?: string;
        version?: string;
    }, signal?: AbortSignal, policy?: WritePolicy): Promise<{
        version: string;
        before: string;
        after: string;
    }>;
    patchText(target: RemoteTarget, hunks: Parameters<typeof applyHunks>[1], expected?: {
        kind?: string;
        version?: string;
    }, signal?: AbortSignal, policy?: WritePolicy): Promise<{
        version: string;
        before: string;
        after: string;
    }>;
    deleteFile(target: RemoteTarget, expected?: {
        kind?: string;
        version?: string;
    }, signal?: AbortSignal, policy?: WritePolicy): Promise<{
        before: string | null;
    }>;
    moveFile(source: RemoteTarget, destination: RemoteTarget, options: {
        expectedSource?: {
            version?: string;
        };
        expectedDestination?: {
            kind?: string;
            version?: string;
        };
        hunks?: Parameters<typeof applyHunks>[1];
    }, signal?: AbortSignal, policy?: WritePolicy): Promise<{
        sourceBefore: string | null;
        destination: {
            operation: 'update' | 'create';
            version: string;
            before: string | null;
            after: string;
        };
        sourceDeleted: boolean;
        sourceFailure?: {
            code: string;
            message: string;
        };
    }>;
    /** Remote directory watching is intentionally unsupported; never fall back to a local watcher. */
    watch(): Promise<never>;
    /** Session policy containment in the remote coordinate space. */
    contains(parent: RemoteTarget, child: RemoteTarget): boolean;
    fileUrl(target: RemoteTarget): string;
}
