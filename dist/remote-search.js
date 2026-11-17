import path from 'node:path';
import { minimatch } from 'minimatch';
import { RemoteSshError, errorMessage, throwIfAborted } from './errors.js';
import { looksVirtual } from './paths.js';
const VCS_DIRECTORIES = new Set(['.git', '.svn', '.hg', '.bzr', '.jj', '.sl']);
const MAX_WALK_ENTRIES = 200_000;
const MAX_GREP_FILES = 20_000;
const MAX_GREP_BYTES = 8 * 1024 * 1024;
const MAX_GREP_MATCHES = 5_000;
const MAX_LINE_CHARS = 4_000;
// Native glob has a 30s timeout. Return an actionable error before that limit.
const GLOB_BUDGET_MS = 20_000;
const MAX_GLOB_WALK_ENTRIES = 50_000;
function checkSearchBudget(options) {
    throwIfAborted(options.signal, 'search');
    if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) {
        throw new RemoteSshError('SSH_SEARCH_TIMEOUT', 'remote glob exceeded its 20s budget; narrow the path or pattern');
    }
}
/** SFTP cannot cancel a readdir already sent; settle the caller on timeout or
 * abort and ignore a late SFTP reply without resuming the traversal. */
function rawList(connection, directory, options) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let timer;
        const cleanup = () => {
            if (timer !== undefined)
                clearTimeout(timer);
            options.signal?.removeEventListener('abort', onAbort);
        };
        const finish = (error, entries) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            if (error !== undefined)
                reject(error);
            else
                resolve(entries ?? []);
        };
        const onAbort = () => finish(new RemoteSshError('FS_ABORTED', 'remote search cancelled during SFTP directory listing'));
        if (options.signal?.aborted) {
            onAbort();
            return;
        }
        options.signal?.addEventListener('abort', onAbort, { once: true });
        if (options.deadlineAt !== undefined) {
            const remaining = options.deadlineAt - Date.now();
            if (remaining <= 0) {
                finish(new RemoteSshError('SSH_SEARCH_TIMEOUT', 'remote glob 20s budget exhausted; narrow the path'));
                return;
            }
            timer = setTimeout(() => finish(new RemoteSshError('SSH_SEARCH_TIMEOUT', 'remote glob 20s budget exhausted during SFTP listing; narrow the path or pattern')), remaining);
        }
        try {
            connection.sftp.readdir(directory, (error, entries) => {
                if (error)
                    finish(connection.mapSftpError(error, 'cannot list ' + directory));
                else
                    finish(undefined, entries);
            });
        }
        catch (error) {
            finish(error);
        }
    });
}
async function walk(connection, root, options) {
    const files = [];
    let frontier = [{ directory: root, depth: 1 }];
    let visited = 0;
    // Cancel other directory workers after the first error. Remote SFTP calls
    // are read-only; pending callbacks are ignored once the local wait aborts.
    const internalAbort = new AbortController();
    const signal = options.signal
        ? AbortSignal.any([options.signal, internalAbort.signal])
        : internalAbort.signal;
    const scoped = { ...options, signal };
    const workerCount = Math.max(1, Math.min(8, options.concurrency ?? 1));
    while (frontier.length > 0) {
        checkSearchBudget(scoped);
        const batch = frontier;
        const next = [];
        let cursor = 0;
        const worker = async () => {
            while (true) {
                checkSearchBudget(scoped);
                const index = cursor++;
                if (index >= batch.length)
                    return;
                const { directory, depth } = batch[index];
                let entries;
                try {
                    entries = await rawList(connection, directory, scoped);
                }
                catch (error) {
                    if (error instanceof RemoteSshError && error.code === 'FS_NOT_FOUND')
                        continue;
                    throw error;
                }
                for (const entry of entries) {
                    checkSearchBudget(scoped);
                    visited += 1;
                    const maxEntries = options.maxEntries ?? MAX_WALK_ENTRIES;
                    if (visited > maxEntries) {
                        throw new RemoteSshError('SSH_SEARCH_LIMIT', 'remote search visited more than ' + maxEntries + ' entries; narrow the path or pattern');
                    }
                    if (entry.attrs.isSymbolicLink())
                        continue;
                    const remote = path.posix.join(directory, entry.filename);
                    const rel = path.posix.relative(root, remote);
                    if (rel.startsWith('..') || rel.length === 0)
                        continue;
                    if (VCS_DIRECTORIES.has(entry.filename))
                        continue;
                    if (!options.includeHidden && entry.filename.startsWith('.'))
                        continue;
                    if (entry.attrs.isDirectory()) {
                        if (options.maxDepth !== undefined && depth >= options.maxDepth)
                            continue;
                        // Skip branches that cannot possibly satisfy a literal leading
                        // path prefix, e.g. ignore other/ for glob src/**/*.py.
                        const prefix = options.literalPrefix ?? [];
                        const parts = rel.split('/');
                        if (prefix.length > 0 && parts.length <= prefix.length &&
                            parts.some((segment, i) => segment !== prefix[i]))
                            continue;
                        next.push({ directory: remote, depth: depth + 1 });
                    }
                    else if (entry.attrs.isFile()) {
                        files.push({ remote, rel, size: Number(entry.attrs.size), mtime: entry.attrs.mtime });
                    }
                }
            }
        };
        const workers = Array.from({ length: Math.min(workerCount, batch.length) }, () => worker());
        try {
            await Promise.all(workers);
        }
        catch (error) {
            internalAbort.abort();
            await Promise.allSettled(workers);
            throw error;
        }
        frontier = next;
    }
    return files;
}
/**
 * Native grep accepts a search path pointing either to a directory or to one
 * specific file. The old implementation always passed it to readdir(), which
 * silently produced zero matches for existing files. An explicitly selected
 * hidden file is searched; directory recursion still skips hidden entries.
 */
async function filesForGrep(connection, root, signal) {
    throwIfAborted(signal, 'grep');
    const info = await new Promise((resolve, reject) => {
        connection.sftp.stat(root, (error, stats) => {
            if (error)
                reject(connection.mapSftpError(error, `cannot stat ${root}`));
            else
                resolve(stats);
        });
    });
    if (info.isFile()) {
        return [{ remote: root, rel: path.posix.basename(root), size: Number(info.size), mtime: info.mtime }];
    }
    if (info.isDirectory())
        return await walk(connection, root, { includeHidden: false, signal });
    throw new RemoteSshError('SSH_SEARCH_INVALID_PATTERN', `grep path must be a regular file or directory: ${root}`);
}
/** Convert a DSH placeholder/virtual cwd into the real Linux remote cwd. */
function remoteWorkdir(manager, cwd) {
    const route = manager.routeFor(cwd, cwd);
    if (!route)
        throw new RemoteSshError('SSH_PATH_INVALID', 'remote search requires a registered SSH workspace');
    return route.remotePath;
}
function matchesAny(rel, full, pattern) {
    const normalized = pattern.replaceAll('\\', '/').replace(/^\.\//, '');
    const options = {
        dot: true,
        nocomment: true,
        nocase: false,
        matchBase: !normalized.includes('/'),
    };
    return minimatch(rel, normalized, options) || minimatch(full, normalized, options);
}
function workdirRelative(workdir, remote) {
    const rel = path.posix.relative(workdir, remote);
    return rel.length === 0 ? '.' : rel;
}
async function resolveSearchRoot(search, cwd, inputPath, signal) {
    const target = await search.remoteFs.resolve(inputPath ?? '.', { cwd, signal });
    const workspace = search.manager.workspaceByToken(target.workspaceToken);
    const connection = await search.manager.connection(workspace.connectionId);
    return { target, workdir: cwd, connection };
}
async function remoteGlob(search, args, exec) {
    const pattern = typeof args.pattern === 'string' ? args.pattern : '';
    if (pattern.trim().length === 0)
        throw new RemoteSshError('SSH_SEARCH_INVALID_PATTERN', 'pattern must be a non-empty string');
    const pathArg = typeof args.path === 'string' ? args.path : undefined;
    if (pathArg !== undefined && pathArg.trim().length === 0)
        throw new RemoteSshError('SSH_SEARCH_INVALID_PATTERN', 'path must be a non-empty string when given');
    const cwd = await search.ctx.workingDirectory.ensure(exec.agent, exec.signal);
    if (!looksVirtual(cwd))
        throw new RemoteSshError('SSH_PATH_INVALID', 'glob is not running in a remote workspace');
    const { target, connection } = await resolveSearchRoot(search, cwd, pathArg, exec.signal);
    const rootCwd = remoteWorkdir(search.manager, cwd);
    // A plain basename glob searches only the selected directory; use **/*.ext
    // for recursive matching. Directory-qualified patterns scan bounded depth.
    const normalized = pattern.replaceAll('\\', '/').replace(/^\.\//, '');
    const segments = normalized.split('/').filter(Boolean);
    const recursive = segments.includes('**');
    const literalPrefix = [];
    for (const segment of segments.slice(0, -1)) {
        if (/[?*\[\]{}()+!@]/.test(segment))
            break;
        literalPrefix.push(segment);
    }
    let files;
    try {
        files = await walk(connection, target.remotePath, {
            includeHidden: true,
            signal: exec.signal,
            maxDepth: recursive ? undefined : Math.max(1, segments.length),
            deadlineAt: Date.now() + GLOB_BUDGET_MS,
            maxEntries: MAX_GLOB_WALK_ENTRIES,
            concurrency: recursive ? 8 : 1,
            literalPrefix,
        });
    }
    catch (error) {
        // DSH can wrap RemoteSshError in ToolCallError and strip its .code.
        // Keep a stable machine-searchable marker in the human-readable message.
        if (error instanceof RemoteSshError &&
            (error.code === 'SSH_SEARCH_TIMEOUT' || error.code === 'SSH_SEARCH_LIMIT')) {
            throw new RemoteSshError(error.code, error.code + ': ' + error.message, {
                searchPattern: normalized, searchedRoot: pathArg ?? '.',
            });
        }
        throw error;
    }
    const hits = [];
    for (const file of files) {
        throwIfAborted(exec.signal, 'glob');
        const full = path.posix.relative(rootCwd, file.remote);
        if (!matchesAny(file.rel, full, pattern))
            continue;
        hits.push({ display: full, mtime: file.mtime });
    }
    hits.sort((left, right) => right.mtime - left.mtime || left.display.localeCompare(right.display));
    return { root: pathArg === undefined ? '.' : workdirRelative(rootCwd, target.remotePath), paths: hits.slice(0, 5_000).map((hit) => hit.display) };
}
async function readFileForGrep(search, target, signal) {
    return await search.remoteFs.readWholeBytes(target, signal, MAX_GREP_BYTES);
}
async function remoteGrep(search, args, exec) {
    const pattern = typeof args.pattern === 'string' ? args.pattern : '';
    if (pattern.length === 0)
        throw new RemoteSshError('SSH_SEARCH_INVALID_PATTERN', 'pattern must be a non-empty string');
    let regex;
    try {
        regex = new RegExp(pattern);
    }
    catch (error) {
        throw new RemoteSshError('SSH_SEARCH_INVALID_PATTERN', `invalid regular expression: ${errorMessage(error)}`);
    }
    const pathArg = typeof args.path === 'string' ? args.path : undefined;
    const include = typeof args.include === 'string' ? args.include : undefined;
    if (pathArg !== undefined && pathArg.trim().length === 0)
        throw new RemoteSshError('SSH_SEARCH_INVALID_PATTERN', 'path must be a non-empty string when given');
    if (include !== undefined && include.trim().length === 0)
        throw new RemoteSshError('SSH_SEARCH_INVALID_PATTERN', 'include must be a non-empty string when given');
    const cwd = await search.ctx.workingDirectory.ensure(exec.agent, exec.signal);
    if (!looksVirtual(cwd))
        throw new RemoteSshError('SSH_PATH_INVALID', 'grep is not running in a remote workspace');
    const { target, connection } = await resolveSearchRoot(search, cwd, pathArg, exec.signal);
    const rootCwd = remoteWorkdir(search.manager, cwd);
    const files = await filesForGrep(connection, target.remotePath, exec.signal);
    const matches = [];
    const selected = files.filter((file) => {
        if (file.size > MAX_GREP_BYTES)
            return false;
        const full = path.posix.relative(rootCwd, file.remote);
        return include === undefined || matchesAny(file.rel, full, include);
    });
    if (selected.length > MAX_GREP_FILES) {
        throw new RemoteSshError('SSH_SEARCH_LIMIT', `remote search selected more than ${MAX_GREP_FILES} files; narrow the path or include filter`);
    }
    let cursor = 0;
    const worker = async () => {
        while (true) {
            throwIfAborted(exec.signal, 'grep');
            const index = cursor++;
            if (index >= selected.length || matches.length >= MAX_GREP_MATCHES)
                return;
            const file = selected[index];
            const child = {
                targetKey: `ssh:${target.workspaceToken}:${file.remote}`,
                displayPath: file.remote,
                workspaceToken: target.workspaceToken,
                remotePath: file.remote,
            };
            let buffer;
            try {
                buffer = await readFileForGrep(search, child, exec.signal);
            }
            catch {
                continue;
            }
            if (buffer.subarray(0, 8192).includes(0))
                continue;
            let text;
            try {
                text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
            }
            catch {
                continue;
            }
            const lines = text.split(/\r?\n/);
            for (let index = 0; index < lines.length; index += 1) {
                const line = lines[index];
                if (!regex.test(line))
                    continue;
                matches.push({
                    path: path.posix.relative(rootCwd, file.remote),
                    lineNumber: index + 1,
                    line: line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) : line,
                });
                if (matches.length >= MAX_GREP_MATCHES)
                    return;
            }
        }
    };
    await Promise.all(Array.from({ length: 6 }, () => worker()));
    matches.sort((left, right) => left.path.localeCompare(right.path) || left.lineNumber - right.lineNumber);
    return { matches };
}
export function installRemoteSearchShadow(ctx, manager, remoteFs) {
    const tools = ctx.tools;
    const originalView = typeof tools.view === 'function' ? tools.view.bind(tools) : undefined;
    const search = { ctx, manager, remoteFs };
    if (originalView === undefined) {
        ctx.logger?.warn('remote-ssh: tools.view() unavailable; remote glob/grep routing disabled');
        return () => { };
    }
    const shadows = new WeakMap();
    const remoteScope = (scope) => {
        const session = scope?.session;
        if (session === undefined)
            return false;
        try {
            return looksVirtual(ctx.workingDirectory.get(session));
        }
        catch {
            return false;
        }
    };
    const shadowOf = (native, name) => {
        const cached = shadows.get(native);
        if (cached !== undefined)
            return cached;
        const shadow = {
            ...native,
            __dshRemoteSshShadow: true,
            execute: async (args, exec) => {
                const execution = exec;
                if (execution.agent === undefined)
                    return await native.execute(args, exec);
                let cwd;
                try {
                    cwd = await ctx.workingDirectory.ensure(execution.agent, execution.signal);
                }
                catch {
                    return await native.execute(args, exec);
                }
                if (!looksVirtual(cwd))
                    return await native.execute(args, exec);
                const call = execution;
                return name === 'glob'
                    ? await remoteGlob(search, args, call)
                    : await remoteGrep(search, args, call);
            },
        };
        shadows.set(native, shadow);
        return shadow;
    };
    tools.view = (scope) => {
        const view = originalView(scope);
        if (!(view.visible instanceof Map) || !remoteScope(scope))
            return view;
        let visible;
        for (const name of ['glob', 'grep']) {
            const native = view.visible.get(name);
            if (native === undefined || typeof native.execute !== 'function')
                continue;
            if (native.__dshRemoteSshShadow === true)
                continue;
            visible ??= new Map(view.visible);
            visible.set(name, shadowOf(native, name));
        }
        return visible === undefined ? view : { ...view, visible };
    };
    return () => {
        tools.view = originalView;
    };
}
//# sourceMappingURL=remote-search.js.map