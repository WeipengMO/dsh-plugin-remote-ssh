import type { RemoteSshManager } from './manager.js';
export interface RemoteCommit {
    hash: string;
    date: string;
    subject: string;
}
export interface RemoteGitSnapshot {
    directory: string;
    isRepository: boolean;
    status: string;
    history: RemoteCommit[];
    diffStat: string;
    stagedDiffStat: string;
    error?: string;
}
/**
 * Authenticated manager.connection() is already Host-key verified; requests
 * execute in the real Linux cwd and can never inspect the Windows placeholder.
 * No caller-supplied Git arguments are accepted.
 */
export declare function inspectRemoteGit(manager: Pick<RemoteSshManager, 'connection'>, hostId: string, directory: string, count?: number): Promise<RemoteGitSnapshot>;
