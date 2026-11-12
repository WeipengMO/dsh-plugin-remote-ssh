/**
 * Read-only Git status/history for a Linux Workspace over an existing SSH
 * connection. No DSH CLI, repository mirror, or local Git subprocess.
 */
import path from 'node:path';
import type { RemoteSshManager } from './manager.js';
import { RemoteSshError } from './errors.js';
import { shellQuote } from './paths.js';

export interface RemoteCommit { hash: string; date: string; subject: string }
export interface RemoteGitSnapshot {
  directory: string;
  isRepository: boolean;
  status: string;
  history: RemoteCommit[];
  diffStat: string;
  stagedDiffStat: string;
  error?: string;
}

const UNSET_GIT = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CEILING_DIRECTORIES',
  'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE',
  'GIT_REPLACE_REF_BASE', 'GIT_ATTR_SOURCE',
].join(' ');

const GIT_PREFIX = [
  'git', '--no-optional-locks',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'log.showSignature=false',
  '-c', 'color.ui=false',
] as const;

function gitCommand(directory: string, argv: readonly string[]): string {
  return 'cd -- ' + shellQuote(directory)
    + ' && unset ' + UNSET_GIT
    + ' && exec env GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0'
    + ' GIT_NO_LAZY_FETCH=1 GIT_CONFIG_COUNT=0'
    + ' GIT_PAGER=cat PAGER=cat LC_ALL=C '
    + [...GIT_PREFIX, ...argv].map(shellQuote).join(' ');
}
function checkDirectory(directory: string): string {
  if (!directory || directory.includes('\0') || !directory.startsWith('/')) {
    throw new RemoteSshError('SSH_PATH_INVALID', 'Remote Git requires an absolute Linux directory');
  }
  return path.posix.normalize(directory);
}
function limitCount(count: number): number {
  if (!Number.isSafeInteger(count) || count < 1 || count > 50) {
    throw new RemoteSshError('SSH_PATH_INVALID', 'Git history limit must be between 1 and 50');
  }
  return count;
}
function parseHistory(value: string): RemoteCommit[] {
  return value.split(/\r?\n/).filter(Boolean).map(line => {
    const [hash, date, ...subject] = line.split('\t');
    return { hash:hash || '', date:date || '', subject:subject.join('\t') };
  }).filter(entry => /^[0-9a-f]{4,40}$/i.test(entry.hash) && /^\d{4}-\d{2}-\d{2}$/.test(entry.date));
}

/**
 * Authenticated manager.connection() is already Host-key verified; requests
 * execute in the real Linux cwd and can never inspect the Windows placeholder.
 * No caller-supplied Git arguments are accepted.
 */
export async function inspectRemoteGit(
  manager: Pick<RemoteSshManager, 'connection'>,
  hostId: string,
  directory: string,
  count = 20,
): Promise<RemoteGitSnapshot> {
  const cwd = checkDirectory(directory);
  const limit = limitCount(count);
  const conn = await manager.connection(hostId);
  const run = (args: readonly string[]) => conn.exec(gitCommand(cwd, args), {
    timeoutMs: 15000, maxBytes: 192 * 1024,
  });
  const status = await run(['status', '--short', '--branch', '--untracked-files=normal']);
  if (status.code !== 0) {
    if (/not a git repository|not inside a git repository/i.test(status.stderr)) {
      return { directory:cwd, isRepository:false, status:'', history:[], diffStat:'', stagedDiffStat:'' };
    }
    throw new RemoteSshError('SSH_REMOTE_SHELL_FAILED',
      'Remote Git status failed: '+status.stderr.trim().slice(0, 600));
  }
  if (status.truncated) {
    throw new RemoteSshError('SSH_FEATURE_UNSUPPORTED',
      'Remote Git status exceeds the read-only output limit');
  }
  const [log, diff, staged] = await Promise.all([
    run(['log', '--max-count='+limit, '--date=short', '--format=%h%x09%cs%x09%s']),
    run(['diff', '--no-ext-diff', '--no-textconv', '--stat']),
    run(['diff', '--cached', '--no-ext-diff', '--no-textconv', '--stat']),
  ]);
  if (log.truncated || diff.truncated || staged.truncated) {
    throw new RemoteSshError('SSH_FEATURE_UNSUPPORTED',
      'Remote Git history or diff exceeds the read-only output limit');
  }
  // An unborn Git repository has a valid status, but no HEAD to log.
  const missingHead = log.code !== 0 && /does not have any commits yet|your current branch .* does not have any commits|ambiguous argument 'HEAD'/i.test(log.stderr);
  if (log.code !== 0 && !missingHead) {
    throw new RemoteSshError('SSH_REMOTE_SHELL_FAILED',
      'Remote Git log failed: '+log.stderr.trim().slice(0, 600));
  }
  if (diff.code !== 0 || staged.code !== 0) {
    throw new RemoteSshError('SSH_REMOTE_SHELL_FAILED',
      'Remote Git diff failed: '+(diff.code !== 0 ? diff.stderr : staged.stderr).trim().slice(0, 600));
  }
  return {
    directory:cwd,
    isRepository:true,
    status:status.stdout.slice(0, 192*1024),
    history:missingHead?[]:parseHistory(log.stdout),
    diffStat:diff.stdout.slice(0, 192*1024),
    stagedDiffStat:staged.stdout.slice(0, 192*1024),
  };
}
