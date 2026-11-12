/**
 * Bridge DSH Forge's read-only native subprocess Git inspection over SSH.
 * Never create or read a fake Git checkout inside the local placeholder.
 */
import { RemoteSshError } from './errors.js';
import { looksVirtual, shellQuote } from './paths.js';
import type { RemoteSshManager } from './manager.js';

interface CollectMode { maxBytes: number }
interface SpawnSpec {
  argv: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  stdio: { stdin: unknown; stdout: unknown; stderr: unknown };
}
interface SpawnProvider { spawn(spec: SpawnSpec): unknown }
interface StreamReader { readFrom(offset: number): { text: string; nextOffset: number; lossy: boolean } }

const READ_ONLY = new Set([
  'rev-parse', 'for-each-ref', 'show-ref', 'status', 'diff', 'ls-files',
  'cat-file', 'check-ignore', 'merge-base', 'rev-list', 'log', 'show',
  'diff-tree', 'ls-tree', 'describe',
]);
const FORBIDDEN = /^(?:--(?:output|exec|ext-diff|textconv|no-index|git-dir|work-tree|config-env)(?:=|$)|-o$)/;
const GIT_UNSET = 'GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CONFIG GIT_CONFIG_PARAMETERS GIT_CEILING_DIRECTORIES GIT_PREFIX GIT_SHALLOW_FILE GIT_GRAFT_FILE GIT_REPLACE_REF_BASE GIT_ATTR_SOURCE';

/**
 * `-c key=value` pairs that may be forwarded to the SSH host. Only settings
 * that cannot spawn helpers, include files or point git at another repository
 * are listed. A value such as `core.fsmonitor=!cmd` would run a command on the
 * remote host, so unknown keys and unexpected values are rejected.
 */
const SAFE_CONFIG: ReadonlyArray<readonly [string, RegExp]> = [
  ['core.hooksPath', /^\/dev\/null$/],
  ['core.fsmonitor', /^false$/],
  ['core.quotepath', /^(?:false|true)$/],
  ['core.autocrlf', /^(?:false|true|input)$/],
  ['core.safecrlf', /^(?:false|true|warn)$/],
  ['core.pager', /^cat$/],
  ['core.abbrev', /^\d{1,2}$/],
  ['log.showSignature', /^false$/],
  ['diff.noprefix', /^(?:false|true)$/],
  ['diff.mnemonicPrefix', /^(?:false|true)$/],
  ['status.branch', /^(?:false|true)$/],
  ['status.showUntrackedFiles', /^(?:no|normal|all)$/],
  ['color.ui', /^(?:false|never|auto|always)$/],
  ['color.diff', /^(?:false|never|auto|always)$/],
  ['color.status', /^(?:false|never|auto|always)$/],
  ['advice.detachedHead', /^false$/],
  ['i18n.logOutputEncoding', /^UTF-8$/],
];

/** Valueless global switches that never change where git looks for a repo. */
const SAFE_GLOBAL_FLAGS = new Set([
  '--no-optional-locks', '--literal-pathspecs', '--no-replace-objects',
]);

function safeConfigValue(value: string): boolean {
  const eq = value.indexOf('=');
  if (eq < 1 || value.includes('\0')) return false;
  const key = value.slice(0, eq);
  const setting = value.slice(eq + 1);
  return SAFE_CONFIG.some(([name, pattern]) => name === key && pattern.test(setting));
}

/**
 * Only native Forge's safety-prefixed, non-mutating Git probe shape is allowed.
 *
 * DSH releases differ in how many global options they prepend and in what order
 * (extra `-c` pairs, `-ccore.quotepath=false`, `--literal-pathspecs`, ...), so
 * validate the *kind* of each leading option instead of a fixed five-argument
 * prefix. At least one safety marker is still required -- a bare `git status`
 * must never be routed to the SSH host. `-C <dir>` is refused on purpose: the
 * remote command already `cd`s into the mapped repository, and a local/virtual
 * path would point git somewhere meaningless (or outside the workspace).
 */
export function forgeGitQuery(argv: readonly string[]): readonly string[] | null {
  // A local sandbox wrapper may precede the executable; ignore the wrapper
  // only for the exact read-only Forge invocation validated below.
  const gitIndex = argv.findIndex(arg => /^(?:git|git\.exe)$/i.test(arg.split(/[\\/]/).pop() || ''));
  if (gitIndex < 0) return null;
  const args = argv.slice(gitIndex + 1);
  let i = 0;
  let safetyPrefixed = false;
  while (i < args.length) {
    const arg = args[i];
    if (arg === undefined) return null;
    if (arg === '-c') {
      const value = args[i + 1];
      if (value === undefined || !safeConfigValue(value)) return null;
      safetyPrefixed = true;
      i += 2;
      continue;
    }
    if (arg.startsWith('-c') && arg.length > 2) {
      if (!safeConfigValue(arg.slice(2))) return null;
      safetyPrefixed = true;
      i += 1;
      continue;
    }
    if (SAFE_GLOBAL_FLAGS.has(arg)) {
      if (arg === '--no-optional-locks') safetyPrefixed = true;
      i += 1;
      continue;
    }
    break;
  }
  if (!safetyPrefixed) return null;
  const command = args[i];
  if (!command || command.startsWith('-')) return null;
  const rest = args.slice(i + 1);
  if (rest.some(arg => arg.includes('\0') || FORBIDDEN.test(arg) || arg === '-c' || arg === '-C')) return null;
  if (command === 'remote') {
    if (rest.length === 1 && rest[0] === '-v') return args;
    if (rest.length === 2 && rest[0] === 'get-url') return args;
    return null;
  }
  if (command === 'worktree') {
    // Only list worktrees; add/remove/prune/repair/move are mutating.
    return rest.length >= 1 && rest[0] === 'list'
      && rest.slice(1).every(arg => arg === '--porcelain' || arg === '--verbose' || arg === '-z')
      ? args : null;
  }
  if (command === 'branch') {
    // Display-only flags; never forward branch create/delete/rename.
    return rest.length > 0 && rest.some(arg => arg === '--list' || arg === '-l')
      && rest.every(arg => arg === '--list' || arg === '-l' || arg === '-a'
        || arg === '-r' || arg.startsWith('--format=') || arg.startsWith('--sort='))
      ? args : null;
  }
  if (command === 'symbolic-ref') {
    return rest.length >= 1 && rest.length <= 3 &&
      rest.includes('HEAD') &&
      rest.every(arg => arg === '--quiet' || arg === '--short' || arg === 'HEAD') ? args : null;
  }
  return READ_ONLY.has(command) ? args : null;
}

function reader(content: () => string, lossy: () => boolean): StreamReader {
  return {
    readFrom(offset: number) {
      const bytes = Buffer.from(content(), 'utf8');
      const from = Number.isFinite(offset) && offset > 0 ? Math.min(bytes.length, Math.floor(offset)) : 0;
      return { text: bytes.subarray(from).toString('utf8'), nextOffset: bytes.length, lossy: lossy() };
    },
  };
}

export function installNativeGitRouter(
  subprocess: SpawnProvider,
  manager: Pick<RemoteSshManager, 'routeFor' | 'connection'>,
  logger?: { info(message: string): void; warn?(message: string): void },
): { dispose(): void } {
  const original = subprocess.spawn;
  if (typeof original !== 'function') throw new Error('DSH subprocess.spawn is unavailable');
  subprocess.spawn = (spec: SpawnSpec) => {
    if (!looksVirtual(spec.cwd)) return original.call(subprocess, spec);
    const route = manager.routeFor(spec.cwd, spec.cwd);
    if (!route) throw new RemoteSshError('SSH_WORKSPACE_UNKNOWN', 'Unknown SSH workspace for native Git query');
    const args = forgeGitQuery(spec.argv);
    if (!args) {
      // Log the exact shape so a new DSH/Forge release can be whitelisted
      // deliberately instead of guessing. The argv is local diagnostic data.
      const message = 'remote-ssh: rejected native Git query (unsupported shape): ' +
        JSON.stringify(spec.argv).slice(0, 600);
      if (logger?.warn) logger.warn(message); else logger?.info(message);
      throw new RemoteSshError('SSH_FEATURE_UNSUPPORTED',
        'Remote subprocess is not an authorized read-only Git query; use the Agent shell for remote commands');
    }
    if (spec.stdio.stdin !== 'ignore' ||
        typeof spec.stdio.stdout !== 'object' || spec.stdio.stdout === null ||
        typeof spec.stdio.stderr !== 'object' || spec.stdio.stderr === null) {
      throw new RemoteSshError('SSH_FEATURE_UNSUPPORTED', 'Remote Git inspection requires collected output and no stdin');
    }
    const stdoutCap = (spec.stdio.stdout as CollectMode).maxBytes;
    const stderrCap = (spec.stdio.stderr as CollectMode).maxBytes;
    if (!Number.isSafeInteger(stdoutCap) || stdoutCap <= 0 ||
        !Number.isSafeInteger(stderrCap) || stderrCap <= 0) {
      throw new RemoteSshError('SSH_FEATURE_UNSUPPORTED', 'Remote Git output limits must be positive integers');
    }
    const maxBytes = Math.min(Math.max(stdoutCap, stderrCap), 4 * 1024 * 1024);
    const controller = new AbortController();
    const onAbort = () => controller.abort(spec.signal?.reason);
    spec.signal?.addEventListener('abort', onAbort, { once: true });
    if (spec.signal?.aborted) onAbort();
    let stdout = '', stderr = '', truncated = false;
    // Scrub inherited repository selectors; no host env, credentials or
    // user config overrides are copied to the SSH host.
    const command = 'cd -- ' + shellQuote(route.remotePath) +
      ' && unset ' + GIT_UNSET +
      ' && exec env GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 GIT_NO_LAZY_FETCH=1 LC_ALL=C GIT_PAGER=cat GIT_CONFIG_COUNT=0 git ' +
      args.map(shellQuote).join(' ');
    logger?.info('remote-ssh: native Git inspection routed to ' + route.workspace.token);
    const done = (async () => {
      const connection = await manager.connection(route.workspace.connectionId);
      const output = await connection.exec(command, { signal: controller.signal, maxBytes, timeoutMs: 10000 });
      stdout = output.stdout; stderr = output.stderr;
      truncated = output.truncated ||
        Buffer.byteLength(stdout, 'utf8') > stdoutCap ||
        Buffer.byteLength(stderr, 'utf8') > stderrCap;
      return { exitCode: output.code, signal: output.signal as NodeJS.Signals | null };
    })().finally(() => spec.signal?.removeEventListener('abort', onAbort));
    void done.catch(() => {});
    return {
      stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
      collected: { stdout: reader(() => stdout, () => truncated), stderr: reader(() => stderr, () => truncated) },
      done,
      terminate() { controller.abort(); },
      async waitForExit(signal?: AbortSignal) {
        if (signal?.aborted) return false;
        if (!signal) { await done.catch(() => {}); return true; }
        return await new Promise<boolean>(resolve => {
          const abort = () => resolve(false);
          signal.addEventListener('abort', abort, { once: true });
          void done.finally(() => { signal.removeEventListener('abort', abort); resolve(!signal.aborted); }).catch(() => {});
        });
      },
    };
  };
  return { dispose() { subprocess.spawn = original; } };
}
