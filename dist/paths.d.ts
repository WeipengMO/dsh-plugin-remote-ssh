/**
 * Remote workspaces are exposed to DSH as absolute *virtual* paths.  They must
 * be absolute for session-cwd validation and must not collide with real host
 * paths, hence the reserved `dsh-ssh` namespace.
 *
 *   Windows: \\dsh-ssh\<workspaceToken>\home\user\project
 *   POSIX:   /dsh-ssh/<workspaceToken>/home/user/project
 */
export declare const VIRTUAL_NAMESPACE = "dsh-ssh";
export declare const IS_WINDOWS: boolean;
export interface ParsedVirtualPath {
    workspaceToken: string;
    /** Absolute POSIX path on the remote host. */
    remotePath: string;
}
/** Deterministic workspace token: same host identity + same root reuses the mapping. */
export declare function workspaceToken(connectionId: string, remoteRoot: string): string;
/** Convert an absolute remote POSIX path into the host-absolute virtual spelling. */
export declare function encodeVirtualPath(token: string, remotePath: string): string;
/** Parse a virtual path; returns null when the path is an ordinary host path. */
export declare function parseVirtualPath(value: string | undefined | null): ParsedVirtualPath | null;
/** True when the value claims to be in the reserved remote namespace. */
export declare function looksVirtual(value: string | undefined | null): boolean;
/** Expand `~` and `~/...` against the remote home. `~user` needs a remote user lookup and is left unchanged. */
export declare function expandRemoteTilde(value: string, homeDir: string): string;
/**
 * Resolve a caller path inside a remote workspace. Supports:
 *  - virtual absolute paths (must belong to the same workspace)
 *  - remote absolute POSIX paths
 *  - relative paths against the current remote cwd
 *  - `~` / `~/...`
 *  - Windows spellings while the session is remote are rejected instead of
 *    silently falling back to the local disk.
 */
export declare function resolveRemotePath(input: string, cwdRemote: string, homeDir: string, workspaceTokenValue: string): string;
/** Parent path in the virtual namespace, used for file watching and listings. */
export declare function virtualDirname(value: string): string;
/** True when `child` is the root itself or lexically below `root` on POSIX. */
export declare function remoteContains(root: string, child: string): boolean;
/**
 * Escape one argument for a POSIX shell using single quotes. Newlines are
 * allowed inside single quotes; single quotes are closed and escaped.
 */
export declare function shellQuote(value: string): string;
/** Validate an environment name so it cannot inject shell syntax. */
export declare function isValidEnvName(name: string): boolean;
/** Encode environment assignments for the remote shell. */
export declare function encodeRemoteEnv(env: Record<string, string | undefined> | undefined): string;
