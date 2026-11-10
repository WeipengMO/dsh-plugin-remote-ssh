import { createHash } from 'node:crypto';
import path from 'node:path';
import { RemoteSshError } from './errors.js';
/**
 * Remote workspaces are exposed to DSH as absolute *virtual* paths.  They must
 * be absolute for session-cwd validation and must not collide with real host
 * paths, hence the reserved `dsh-ssh` namespace.
 *
 *   Windows: \\dsh-ssh\<workspaceToken>\home\user\project
 *   POSIX:   /dsh-ssh/<workspaceToken>/home/user/project
 */
export const VIRTUAL_NAMESPACE = 'dsh-ssh';
export const IS_WINDOWS = process.platform === 'win32';
const WIN_PREFIX = `\\\\${VIRTUAL_NAMESPACE}\\`;
const POSIX_PREFIX = `/${VIRTUAL_NAMESPACE}/`;
const TOKEN_RE = /^w[0-9a-f]{16}$/i;
/** Deterministic workspace token: same host identity + same root reuses the mapping. */
export function workspaceToken(connectionId, remoteRoot) {
    const digest = createHash('sha256').update(`${connectionId}\0${remoteRoot}`, 'utf8').digest('hex');
    return `w${digest.slice(0, 16)}`;
}
function validateRemotePath(remotePath) {
    if (remotePath.length === 0)
        throw new RemoteSshError('SSH_PATH_INVALID', 'remote path must not be empty');
    if (remotePath.includes('\0'))
        throw new RemoteSshError('SSH_PATH_INVALID', 'remote path must not contain NUL');
    if (!remotePath.startsWith('/'))
        throw new RemoteSshError('SSH_PATH_INVALID', `remote path must be absolute: ${remotePath}`);
    return remotePath;
}
/** Convert an absolute remote POSIX path into the host-absolute virtual spelling. */
export function encodeVirtualPath(token, remotePath) {
    const normalized = path.posix.normalize(validateRemotePath(remotePath));
    if (!TOKEN_RE.test(token))
        throw new RemoteSshError('SSH_PATH_INVALID', `invalid remote workspace token: ${token}`);
    const suffix = normalized.replace(/^\/+/, '').split('/').filter((part) => part.length > 0);
    if (IS_WINDOWS) {
        for (const part of suffix) {
            if (/[:*?"<>|]/.test(part)) {
                throw new RemoteSshError('SSH_PATH_UNREPRESENTABLE', `remote path segment ${JSON.stringify(part)} cannot be represented in a Windows virtual path; rename it on the remote host or use a POSIX DSH host`);
            }
        }
        return suffix.length === 0 ? `${WIN_PREFIX}${token}` : `${WIN_PREFIX}${token}\\${suffix.join('\\')}`;
    }
    return `${POSIX_PREFIX}${token}/${suffix.join('/')}`;
}
/** Parse a virtual path; returns null when the path is an ordinary host path. */
export function parseVirtualPath(value) {
    if (typeof value !== 'string' || value.length === 0)
        return null;
    let rest;
    if (value.startsWith(WIN_PREFIX))
        rest = value.slice(WIN_PREFIX.length);
    else if (value.startsWith(POSIX_PREFIX))
        rest = value.slice(POSIX_PREFIX.length);
    else if (value.startsWith(`//${VIRTUAL_NAMESPACE}/`))
        rest = value.slice(VIRTUAL_NAMESPACE.length + 3);
    if (rest === undefined)
        return null;
    const segments = rest.replaceAll('\\', '/').split('/').filter((part) => part.length > 0);
    const token = segments.shift();
    if (token === undefined || !TOKEN_RE.test(token)) {
        throw new RemoteSshError('SSH_WORKSPACE_UNKNOWN', `virtual path has no valid remote workspace token: ${value}`);
    }
    return { workspaceToken: token, remotePath: path.posix.normalize(`/${segments.join('/')}`) };
}
/** True when the value claims to be in the reserved remote namespace. */
export function looksVirtual(value) {
    if (typeof value !== 'string')
        return false;
    return value.startsWith(WIN_PREFIX) || value.startsWith(POSIX_PREFIX) || value.startsWith(`//${VIRTUAL_NAMESPACE}/`);
}
/** Expand `~` and `~/...` against the remote home. `~user` needs a remote user lookup and is left unchanged. */
export function expandRemoteTilde(value, homeDir) {
    if (value === '~')
        return homeDir;
    if (value.startsWith('~/'))
        return path.posix.join(homeDir, value.slice(2));
    return value;
}
/**
 * Resolve a caller path inside a remote workspace. Supports:
 *  - virtual absolute paths (must belong to the same workspace)
 *  - remote absolute POSIX paths
 *  - relative paths against the current remote cwd
 *  - `~` / `~/...`
 *  - Windows spellings while the session is remote are rejected instead of
 *    silently falling back to the local disk.
 */
export function resolveRemotePath(input, cwdRemote, homeDir, workspaceTokenValue) {
    if (typeof input !== 'string' || input.trim().length === 0) {
        throw new RemoteSshError('FS_NOT_FOUND', 'file_path must be a non-empty string');
    }
    if (input.includes('\0'))
        throw new RemoteSshError('SSH_PATH_INVALID', 'path contains NUL');
    const parsed = parseVirtualPath(input);
    if (parsed !== null) {
        if (parsed.workspaceToken !== workspaceTokenValue) {
            throw new RemoteSshError('SSH_PATH_INVALID', `path belongs to a different remote workspace (${parsed.workspaceToken}); use a path from the current workspace or reopen it`);
        }
        return path.posix.normalize(parsed.remotePath);
    }
    if (/^[A-Za-z]:[\\/]/.test(input)) {
        throw new RemoteSshError('SSH_PATH_INVALID', `Windows path ${input} is not valid in a remote POSIX workspace; use a relative path or the remote absolute path`);
    }
    const expanded = expandRemoteTilde(input, homeDir);
    if (expanded.startsWith('/'))
        return path.posix.normalize(expanded);
    return path.posix.normalize(path.posix.join(cwdRemote, expanded));
}
/** Parent path in the virtual namespace, used for file watching and listings. */
export function virtualDirname(value) {
    const parsed = parseVirtualPath(value);
    if (parsed === null)
        return path.dirname(value);
    return encodeVirtualPath(parsed.workspaceToken, path.posix.dirname(parsed.remotePath));
}
/** True when `child` is the root itself or lexically below `root` on POSIX. */
export function remoteContains(root, child) {
    const normalizedRoot = path.posix.normalize(root);
    const normalizedChild = path.posix.normalize(child);
    if (normalizedChild === normalizedRoot)
        return true;
    const prefix = normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`;
    return normalizedChild.startsWith(prefix);
}
/**
 * Escape one argument for a POSIX shell using single quotes. Newlines are
 * allowed inside single quotes; single quotes are closed and escaped.
 */
export function shellQuote(value) {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}
/** Validate an environment name so it cannot inject shell syntax. */
export function isValidEnvName(name) {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}
/** Encode environment assignments for the remote shell. */
export function encodeRemoteEnv(env) {
    if (env === undefined)
        return '';
    const parts = [];
    for (const [name, value] of Object.entries(env)) {
        if (value === undefined)
            continue;
        if (!isValidEnvName(name))
            continue;
        parts.push(`${name}=${shellQuote(value)}`);
    }
    return parts.join(' ');
}
//# sourceMappingURL=paths.js.map