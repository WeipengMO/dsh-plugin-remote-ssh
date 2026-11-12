import path from 'node:path';
import { minimatch } from 'minimatch';
import type { FileEntryWithStats } from 'ssh2';
import type { SshConnection } from './connection.js';
import { RemoteSshError, errorMessage, throwIfAborted } from './errors.js';
import type { RemoteSshManager } from './manager.js';
import { looksVirtual } from './paths.js';
import { RemoteFileSystem, type RemoteTarget } from './remote-fs.js';

const VCS_DIRECTORIES = new Set(['.git', '.svn', '.hg', '.bzr', '.jj', '.sl']);
const MAX_WALK_ENTRIES = 200_000;
const MAX_GREP_FILES = 20_000;
const MAX_GREP_BYTES = 8 * 1024 * 1024;
const MAX_GREP_MATCHES = 5_000;
const MAX_LINE_CHARS = 4_000;

interface SearchContext {
  ctx: {
    workingDirectory: { ensure(agent: unknown, signal?: AbortSignal): Promise<string> };
    logger?: { warn(message: string): void };
  };
  manager: RemoteSshManager;
  remoteFs: RemoteFileSystem;
}

interface WalkedFile {
  remote: string;
  rel: string;
  size: number;
  mtime: number;
}

interface AnyToolDefinition {
  name: string;
  execute(args: unknown, exec: unknown): Promise<unknown>;
  [key: string]: unknown;
}

function rawList(connection: SshConnection, directory: string): Promise<FileEntryWithStats[]> {
  return new Promise((resolve, reject) => {
    connection.sftp.readdir(directory, (error, entries) => {
      if (error) reject(connection.mapSftpError(error, `cannot list ${directory}`));
      else resolve(entries);
    });
  });
}

async function walk(
  connection: SshConnection,
  root: string,
  options: { includeHidden: boolean; signal?: AbortSignal },
): Promise<WalkedFile[]> {
  const files: WalkedFile[] = [];
  const queue = [root];
  let visited = 0;
  while (queue.length > 0) {
    throwIfAborted(options.signal, 'search');
    const directory = queue.pop() as string;
    let entries: FileEntryWithStats[];
    try {
      entries = await rawList(connection, directory);
    } catch (error) {
      if (error instanceof RemoteSshError && error.code === 'FS_NOT_FOUND') continue;
      throw error;
    }
    for (const entry of entries) {
      throwIfAborted(options.signal, 'search');
      visited += 1;
      if (visited > MAX_WALK_ENTRIES) {
        throw new RemoteSshError('SSH_SEARCH_LIMIT', `remote search visited more than ${MAX_WALK_ENTRIES} entries; narrow the path or pattern`);
      }
      if (entry.attrs.isSymbolicLink()) continue;
      const remote = path.posix.join(directory, entry.filename);
      const rel = path.posix.relative(root, remote);
      if (rel.startsWith('..') || rel.length === 0) continue;
      if (VCS_DIRECTORIES.has(entry.filename)) continue;
      if (!options.includeHidden && entry.filename.startsWith('.')) continue;
      if (entry.attrs.isDirectory()) {
        queue.push(remote);
      } else if (entry.attrs.isFile()) {
        files.push({ remote, rel, size: Number(entry.attrs.size), mtime: entry.attrs.mtime });
      }
    }
  }
  return files;
}

/**
 * Native grep accepts a search path pointing either to a directory or to one
 * specific file. The old implementation always passed it to readdir(), which
 * silently produced zero matches for existing files. An explicitly selected
 * hidden file is searched; directory recursion still skips hidden entries.
 */
async function filesForGrep(connection: SshConnection, root: string, signal?: AbortSignal): Promise<WalkedFile[]> {
  throwIfAborted(signal, 'grep');
  const info = await new Promise<{ isFile(): boolean; isDirectory(): boolean; size: number; mtime: number }>((resolve, reject) => {
    connection.sftp.stat(root, (error, stats) => {
      if (error) reject(connection.mapSftpError(error, `cannot stat ${root}`));
      else resolve(stats);
    });
  });
  if (info.isFile()) {
    return [{ remote: root, rel: path.posix.basename(root), size: Number(info.size), mtime: info.mtime }];
  }
  if (info.isDirectory()) return await walk(connection, root, { includeHidden: false, signal });
  throw new RemoteSshError('SSH_SEARCH_INVALID_PATTERN', `grep path must be a regular file or directory: ${root}`);
}

/** Convert a DSH placeholder/virtual cwd into the real Linux remote cwd. */
function remoteWorkdir(manager: RemoteSshManager, cwd: string): string {
  const route = manager.routeFor(cwd, cwd);
  if (!route) throw new RemoteSshError('SSH_PATH_INVALID', 'remote search requires a registered SSH workspace');
  return route.remotePath;
}

function matchesAny(rel: string, full: string, pattern: string): boolean {
  const normalized = pattern.replaceAll('\\', '/').replace(/^\.\//, '');
  const options = {
    dot: true,
    nocomment: true,
    nocase: false,
    matchBase: !normalized.includes('/'),
  };
  return minimatch(rel, normalized, options) || minimatch(full, normalized, options);
}

function workdirRelative(workdir: string, remote: string): string {
  const rel = path.posix.relative(workdir, remote);
  return rel.length === 0 ? '.' : rel;
}

async function resolveSearchRoot(search: SearchContext, cwd: string, inputPath: string | undefined, signal?: AbortSignal): Promise<{ target: RemoteTarget; workdir: string; connection: SshConnection }> {
  const target = await search.remoteFs.resolve(inputPath ?? '.', { cwd, signal });
  const workspace = search.manager.workspaceByToken(target.workspaceToken);
  const connection = await search.manager.connection(workspace.connectionId);
  return { target, workdir: cwd, connection };
}

async function remoteGlob(search: SearchContext, args: { pattern?: unknown; path?: unknown }, exec: { agent: unknown; signal?: AbortSignal }): Promise<{ root: string; paths: string[] }> {
  const pattern = typeof args.pattern === 'string' ? args.pattern : '';
  if (pattern.trim().length === 0) throw new RemoteSshError('SSH_SEARCH_INVALID_PATTERN', 'pattern must be a non-empty string');
  const pathArg = typeof args.path === 'string' ? args.path : undefined;
  if (pathArg !== undefined && pathArg.trim().length === 0) throw new RemoteSshError('SSH_SEARCH_INVALID_PATTERN', 'path must be a non-empty string when given');
  const cwd = await search.ctx.workingDirectory.ensure(exec.agent, exec.signal);
  if (!looksVirtual(cwd)) throw new RemoteSshError('SSH_PATH_INVALID', 'glob is not running in a remote workspace');
  const { target, connection } = await resolveSearchRoot(search, cwd, pathArg, exec.signal);
  const rootCwd = remoteWorkdir(search.manager, cwd);
  const files = await walk(connection, target.remotePath, { includeHidden: true, signal: exec.signal });
  const hits: Array<{ display: string; mtime: number }> = [];
  for (const file of files) {
    throwIfAborted(exec.signal, 'glob');
    const full = path.posix.relative(rootCwd, file.remote);
    if (!matchesAny(file.rel, full, pattern)) continue;
    hits.push({ display: full, mtime: file.mtime });
  }
  hits.sort((left, right) => right.mtime - left.mtime || left.display.localeCompare(right.display));
  return { root: pathArg === undefined ? '.' : workdirRelative(rootCwd, target.remotePath), paths: hits.slice(0, 5_000).map((hit) => hit.display) };
}

async function readFileForGrep(search: SearchContext, target: RemoteTarget, signal?: AbortSignal): Promise<Buffer> {
  return await search.remoteFs.readWholeBytes(target, signal, MAX_GREP_BYTES);
}

async function remoteGrep(
  search: SearchContext,
  args: { pattern?: unknown; path?: unknown; include?: unknown },
  exec: { agent: unknown; signal?: AbortSignal },
): Promise<{ matches: Array<{ path: string; lineNumber: number; line: string }> }> {
  const pattern = typeof args.pattern === 'string' ? args.pattern : '';
  if (pattern.length === 0) throw new RemoteSshError('SSH_SEARCH_INVALID_PATTERN', 'pattern must be a non-empty string');
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (error) {
    throw new RemoteSshError('SSH_SEARCH_INVALID_PATTERN', `invalid regular expression: ${errorMessage(error)}`);
  }
  const pathArg = typeof args.path === 'string' ? args.path : undefined;
  const include = typeof args.include === 'string' ? args.include : undefined;
  if (pathArg !== undefined && pathArg.trim().length === 0) throw new RemoteSshError('SSH_SEARCH_INVALID_PATTERN', 'path must be a non-empty string when given');
  if (include !== undefined && include.trim().length === 0) throw new RemoteSshError('SSH_SEARCH_INVALID_PATTERN', 'include must be a non-empty string when given');
  const cwd = await search.ctx.workingDirectory.ensure(exec.agent, exec.signal);
  if (!looksVirtual(cwd)) throw new RemoteSshError('SSH_PATH_INVALID', 'grep is not running in a remote workspace');
  const { target, connection } = await resolveSearchRoot(search, cwd, pathArg, exec.signal);
  const rootCwd = remoteWorkdir(search.manager, cwd);
  const files = await filesForGrep(connection, target.remotePath, exec.signal);
  const matches: Array<{ path: string; lineNumber: number; line: string }> = [];
  const selected = files.filter((file) => {
    if (file.size > MAX_GREP_BYTES) return false;
    const full = path.posix.relative(rootCwd, file.remote);
    return include === undefined || matchesAny(file.rel, full, include);
  });
  if (selected.length > MAX_GREP_FILES) {
    throw new RemoteSshError('SSH_SEARCH_LIMIT', `remote search selected more than ${MAX_GREP_FILES} files; narrow the path or include filter`);
  }
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      throwIfAborted(exec.signal, 'grep');
      const index = cursor++;
      if (index >= selected.length || matches.length >= MAX_GREP_MATCHES) return;
      const file = selected[index] as WalkedFile;
      const child: RemoteTarget = {
        targetKey: `ssh:${target.workspaceToken}:${file.remote}`,
        displayPath: file.remote,
        workspaceToken: target.workspaceToken,
        remotePath: file.remote,
      };
      let buffer: Buffer;
      try {
        buffer = await readFileForGrep(search, child, exec.signal);
      } catch {
        continue;
      }
      if (buffer.subarray(0, 8192).includes(0)) continue;
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] as string;
        if (!regex.test(line)) continue;
        matches.push({
          path: path.posix.relative(rootCwd, file.remote),
          lineNumber: index + 1,
          line: line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) : line,
        });
        if (matches.length >= MAX_GREP_MATCHES) return;
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, () => worker()));
  matches.sort((left, right) => left.path.localeCompare(right.path) || left.lineNumber - right.lineNumber);
  return { matches };
}

/**
 * Wrap the host glob/grep definitions for agents whose cwd is remote.
 *
 * DSH's native search tools spawn a packaged ripgrep with the session cwd as
 * the child process cwd. A virtual UNC cwd is not a real directory on Windows,
 * so the spawn fails before execute() is ever reached. Registering a per-agent
 * variant through agent.ctx.tools proved unreliable (the agent context is not
 * guaranteed to expose the tools service at agent/created time), so patch the
 * shared ToolsService.view() in place -- the same seam the fs router uses for
 * ctx.fs. Shadow definitions are cached so ToolsService.resolve() keeps seeing
 * a stable object identity for the whole step.
 */
interface ToolsView {
  visible: Map<string, AnyToolDefinition>;
  registrations: Map<string, unknown>;
  knownNames: Set<string>;
  restrictableNames: Set<string>;
}

export function installRemoteSearchShadow(ctx: {
  tools: { get(name: string): unknown; view(scope?: unknown): ToolsView };
  workingDirectory: {
    get(session: unknown): string;
    ensure(agent: unknown, signal?: AbortSignal): Promise<string>;
  };
  logger?: { warn(message: string): void };
}, manager: RemoteSshManager, remoteFs: RemoteFileSystem): () => void {
  const tools = ctx.tools as unknown as { view?: (scope?: unknown) => ToolsView };
  const originalView = typeof tools.view === 'function' ? tools.view.bind(tools) : undefined;
  const search: SearchContext = { ctx, manager, remoteFs };
  if (originalView === undefined) {
    ctx.logger?.warn('remote-ssh: tools.view() unavailable; remote glob/grep routing disabled');
    return () => {};
  }

  const shadows = new WeakMap<object, AnyToolDefinition>();
  const remoteScope = (scope: unknown): boolean => {
    const session = (scope as { session?: unknown } | undefined)?.session;
    if (session === undefined) return false;
    try {
      return looksVirtual(ctx.workingDirectory.get(session));
    } catch {
      return false;
    }
  };
  const shadowOf = (native: AnyToolDefinition, name: 'glob' | 'grep'): AnyToolDefinition => {
    const cached = shadows.get(native);
    if (cached !== undefined) return cached;
    const shadow: AnyToolDefinition = {
      ...native,
      __dshRemoteSshShadow: true,
      execute: async (args: unknown, exec: unknown) => {
        const execution = exec as { agent?: unknown; signal?: AbortSignal };
        if (execution.agent === undefined) return await native.execute(args, exec);
        let cwd: string;
        try {
          cwd = await ctx.workingDirectory.ensure(execution.agent, execution.signal);
        } catch {
          return await native.execute(args, exec);
        }
        if (!looksVirtual(cwd)) return await native.execute(args, exec);
        const call = execution as { agent: unknown; signal?: AbortSignal };
        return name === 'glob'
          ? await remoteGlob(search, args as { pattern?: unknown; path?: unknown }, call)
          : await remoteGrep(search, args as { pattern?: unknown; path?: unknown; include?: unknown }, call);
      },
    };
    shadows.set(native, shadow);
    return shadow;
  };

  tools.view = (scope?: unknown): ToolsView => {
    const view = originalView(scope);
    if (!(view.visible instanceof Map) || !remoteScope(scope)) return view;
    let visible: Map<string, AnyToolDefinition> | undefined;
    for (const name of ['glob', 'grep'] as const) {
      const native = view.visible.get(name);
      if (native === undefined || typeof native.execute !== 'function') continue;
      if ((native as Record<string, unknown>).__dshRemoteSshShadow === true) continue;
      visible ??= new Map(view.visible);
      visible.set(name, shadowOf(native, name));
    }
    return visible === undefined ? view : { ...view, visible };
  };
  return () => {
    tools.view = originalView;
  };
}
