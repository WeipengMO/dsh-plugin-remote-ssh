import type { RemoteSshManager } from './manager.js';
export interface WorkspaceRegistry {
    create(localPath: string, title?: string): Promise<unknown> | unknown;
}
export interface PreparedWorkspace {
    localPath: string;
    remoteRoot: string;
    hostId: string;
    title: string;
    token: string;
    registered: boolean;
}
/**
 * Make the remote path acceptable to DSH's normal project picker and workspace
 * registry: a stable REAL local folder whose contents are NOT copied from SSH.
 * Subsequent filesystem and shell calls are intercepted by the SSH routing layer.
 * This is the same adapter shape used by @dsh-ssh/dsh-ssh.
 */
export declare function prepareRemoteWorkspace(manager: RemoteSshManager, hostId: string, remotePath: string, registry?: WorkspaceRegistry): Promise<PreparedWorkspace>;
