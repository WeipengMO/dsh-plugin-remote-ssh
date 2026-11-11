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
]);
const FORBIDDEN = /^(?:--(?:output|exec|ext-diff|textconv|no-index|git-dir|work-tree|config-env)(?:=|$)|-o$)/;
const GIT_UNSET = 'GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CONFIG_PARAMETERS GIT_CEILING_DIRECTORIES GIT_PREFIX GIT_SHALLOW_FILE GIT_GRAFT_FILE GIT_REPLACE_REF_BASE';

/** Only native Forge's safety-prefixed, non-mutating Git probe shape is allowed. */
export function forgeGitQuery(argv: readonly string[]): readonly string[] | null {
  // A local sandbox wrapper may precede the executable; ignore the wrapper
  // only for the exact read-only Forge invocation validated below.
  const gitIndex = argv.findIndex(arg => /^(?:git|git\.exe)$/i.test(arg.split(/[\\/]/).pop() || ''));
  if (gitIndex < 0) return null;
  const args = argv.slice(gitIndex + 1);
  if (args[0] !== '--no-optional-locks' ||
      args[1] !== '-c' || args[2] !== 'core.hooksPath=/dev/null' ||
      args[3] !== '-c' || args[4] !== 'core.fsmonitor=false') return null;
  const command = args[5];
  if (!command) return null;
  const rest = args.slice(6);
  if (rest.some(arg => arg.includes('\0') || FORBIDDEN.test(arg))) return null;
  if (command === 'remote') return rest.length === 1 && rest[0] === '-v' ? args : null;
  if (command === 'symbolic-ref') {
    return rest.length === 3 && rest[0] === '--quiet' && rest[1] === '--short' && rest[2] === 'HEAD' ? args : null;
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
  logger?: { info(message: string): void },
): { dispose(): void } {
  const original = subprocess.spawn;
  if (typeof original !== 'function') throw new Error('DSH subprocess.spawn is unavailable');
  subprocess.spawn = (spec: SpawnSpec) => {
    if (!looksVirtual(spec.cwd)) return original.call(subprocess, spec);
    const route = manager.routeFor(spec.cwd, spec.cwd);
    if (!route) throw new RemoteSshError('SSH_WORKSPACE_UNKNOWN', 'Unknown SSH workspace for native Git query');
    const args = forgeGitQuery(spec.argv);
    if (!args) throw new RemoteSshError('SSH_FEATURE_UNSUPPORTED',
      'Remote subprocess is not an authorized read-only Git query; use the Agent shell for remote commands');
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
