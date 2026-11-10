import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
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

/** Real local directories are required by the DSH project/workspace registry.
 * These contain NO copies of remote files; they only identify an SSH route.
 * Stable across plugin upgrades and DSH restarts. Keep outside repo/project trees.
 */
export function workspacePlaceholderRoot(): string {
  return path.join(os.homedir(), '.dsh', 'remote-ssh-workspaces');
}
export function workspacePlaceholderPath(token: string): string {
  if (!TOKEN_RE.test(token)) throw new RemoteSshError('SSH_PATH_INVALID', 'invalid workspace token');
  return path.join(workspacePlaceholderRoot(), token);
}
export function parseWorkspacePlaceholder(value: string | undefined | null): ParsedVirtualPath | null {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return null;
  const rel = path.relative(workspacePlaceholderRoot(), path.resolve(value));
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return null;
  const [token, ...rest] = rel.split(path.sep);
  if (!TOKEN_RE.test(token)) return null;
  return { workspaceToken: token, remotePath: path.posix.normalize('/' + rest.join('/')), placeholder: true };
}

export interface ParsedVirtualPath {
  workspaceToken: string;
  /** Absolute POSIX path on the remote host. */
  remotePath: string;
  /** Local, existing DSH workspace directory under our private placeholder root. */
  placeholder?: boolean;
}

/** Deterministic workspace token: same host identity + same root reuses the mapping. */
export function workspaceToken(connectionId: string, remoteRoot: string): string {
  const digest = createHash('sha256').update(`${connectionId}\0${remoteRoot}`, 'utf8').digest('hex');
  return `w${digest.slice(0, 16)}`;
}

function validateRemotePath(remotePath: string): string {
  if (remotePath.length === 0) throw new RemoteSshError('SSH_PATH_INVALID', 'remote path must not be empty');
  if (remotePath.includes('\0')) throw new RemoteSshError('SSH_PATH_INVALID', 'remote path must not contain NUL');
  if (!remotePath.startsWith('/')) throw new RemoteSshError('SSH_PATH_INVALID', `remote path must be absolute: ${remotePath}`);
  return remotePath;
}

/** Convert an absolute remote POSIX path into the host-absolute virtual spelling. */
export function encodeVirtualPath(token: string, remotePath: string): string {
  const normalized = path.posix.normalize(validateRemotePath(remotePath));
  if (!TOKEN_RE.test(token)) throw new RemoteSshError('SSH_PATH_INVALID', `invalid remote workspace token: ${token}`);
  const suffix = normalized.replace(/^\/+/, '').split('/').filter((part) => part.length > 0);
  if (IS_WINDOWS) {
    for (const part of suffix) {
      if (/[:*?"<>|]/.test(part)) {
        throw new RemoteSshError(
          'SSH_PATH_UNREPRESENTABLE',
          `remote path segment ${JSON.stringify(part)} cannot be represented in a Windows virtual path; rename it on the remote host or use a POSIX DSH host`,
        );
      }
    }
    return suffix.length === 0 ? `${WIN_PREFIX}${token}` : `${WIN_PREFIX}${token}\\${suffix.join('\\')}`;
  }
  return `${POSIX_PREFIX}${token}/${suffix.join('/')}`;
}

/** Parse a virtual path; returns null when the path is an ordinary host path. */
export function parseVirtualPath(value: string | undefined | null): ParsedVirtualPath | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const placeholder = parseWorkspacePlaceholder(value);
  if (placeholder) return placeholder;
  let rest: string | undefined;
  if (value.startsWith(WIN_PREFIX)) rest = value.slice(WIN_PREFIX.length);
  else if (value.startsWith(POSIX_PREFIX)) rest = value.slice(POSIX_PREFIX.length);
  else if (value.startsWith(`//${VIRTUAL_NAMESPACE}/`)) rest = value.slice(VIRTUAL_NAMESPACE.length + 3);
  if (rest === undefined) return null;
  const segments = rest.replaceAll('\\', '/').split('/').filter((part) => part.length > 0);
  const token = segments.shift();
  if (token === undefined || !TOKEN_RE.test(token)) {
    throw new RemoteSshError('SSH_WORKSPACE_UNKNOWN', `virtual path has no valid remote workspace token: ${value}`);
  }
  return { workspaceToken: token, remotePath: path.posix.normalize(`/${segments.join('/')}`) };
}

/** True when the value claims to be in the reserved remote namespace. */
export function looksVirtual(value: string | undefined | null): boolean {
  if (typeof value !== 'string') return false;
  return !!parseWorkspacePlaceholder(value) || value.startsWith(WIN_PREFIX) || value.startsWith(POSIX_PREFIX) || value.startsWith(`//${VIRTUAL_NAMESPACE}/`);
}

/** Expand `~` and `~/...` against the remote home. `~user` needs a remote user lookup and is left unchanged. */
export function expandRemoteTilde(value: string, homeDir: string): string {
  if (value === '~') return homeDir;
  if (value.startsWith('~/')) return path.posix.join(homeDir, value.slice(2));
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
export function resolveRemotePath(input: string, cwdRemote: string, homeDir: string, workspaceTokenValue: string): string {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new RemoteSshError('FS_NOT_FOUND', 'file_path must be a non-empty string');
  }
  if (input.includes('\0')) throw new RemoteSshError('SSH_PATH_INVALID', 'path contains NUL');
  const parsed = parseVirtualPath(input);
  if (parsed !== null) {
    if (parsed.workspaceToken !== workspaceTokenValue) {
      throw new RemoteSshError(
        'SSH_PATH_INVALID',
        `path belongs to a different remote workspace (${parsed.workspaceToken}); use a path from the current workspace or reopen it`,
      );
    }
    return path.posix.normalize(parsed.remotePath);
  }
  if (/^[A-Za-z]:[\\/]/.test(input)) {
    throw new RemoteSshError(
      'SSH_PATH_INVALID',
      `Windows path ${input} is not valid in a remote POSIX workspace; use a relative path or the remote absolute path`,
    );
  }
  const expanded = expandRemoteTilde(input, homeDir);
  if (expanded.startsWith('/')) return path.posix.normalize(expanded);
  return path.posix.normalize(path.posix.join(cwdRemote, expanded));
}

/** Parent path in the virtual namespace, used for file watching and listings. */
export function virtualDirname(value: string): string {
  const parsed = parseVirtualPath(value);
  if (parsed === null) return path.dirname(value);
  return encodeVirtualPath(parsed.workspaceToken, path.posix.dirname(parsed.remotePath));
}

/** True when `child` is the root itself or lexically below `root` on POSIX. */
export function remoteContains(root: string, child: string): boolean {
  const normalizedRoot = path.posix.normalize(root);
  const normalizedChild = path.posix.normalize(child);
  if (normalizedChild === normalizedRoot) return true;
  const prefix = normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`;
  return normalizedChild.startsWith(prefix);
}

/**
 * Escape one argument for a POSIX shell using single quotes. Newlines are
 * allowed inside single quotes; single quotes are closed and escaped.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Validate an environment name so it cannot inject shell syntax. */
export function isValidEnvName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/** Encode environment assignments for the remote shell. */
export function encodeRemoteEnv(env: Record<string, string | undefined> | undefined): string {
  if (env === undefined) return '';
  const parts: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (!isValidEnvName(name)) continue;
    parts.push(`${name}=${shellQuote(value)}`);
  }
  return parts.join(' ');
}
