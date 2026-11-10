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
function rawList(connection, directory) {
    return new Promise((resolve, reject) => {
        connection.sftp.readdir(directory, (error, entries) => {
            if (error)
                reject(connection.mapSftpError(error, `cannot list ${directory}`));
            else
                resolve(entries);
        });
    });
}
async function walk(connection, root, options) {
    const files = [];
    const queue = [root];
    let visited = 0;
    while (queue.length > 0) {
        throwIfAborted(options.signal, 'search');
        const directory = queue.pop();
        let entries;
        try {
            entries = await rawList(connection, directory);
        }
        catch (error) {
            if (error instanceof RemoteSshError && error.code === 'FS_NOT_FOUND')
                continue;
            throw error;
        }
        for (const entry of entries) {
            throwIfAborted(options.signal, 'search');
            visited += 1;
            if (visited > MAX_WALK_ENTRIES) {
                throw new RemoteSshError('SSH_SEARCH_LIMIT', `remote search visited more than ${MAX_WALK_ENTRIES} entries; narrow the path or pattern`);
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
                queue.push(remote);
            }
            else if (entry.attrs.isFile()) {
                files.push({ remote, rel, size: Number(entry.attrs.size), mtime: entry.attrs.mtime });
            }
        }
    }
    return files;
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
    const files = await walk(connection, target.remotePath, { includeHidden: true, signal: exec.signal });
    const hits = [];
    for (const file of files) {
        throwIfAborted(exec.signal, 'glob');
        const full = path.posix.relative(cwd, file.remote);
        if (!matchesAny(file.rel, full, pattern))
            continue;
        hits.push({ display: full, mtime: file.mtime });
    }
    hits.sort((left, right) => right.mtime - left.mtime || left.display.localeCompare(right.display));
    return { root: pathArg === undefined ? '.' : workdirRelative(cwd, target.remotePath), paths: hits.slice(0, 5_000).map((hit) => hit.display) };
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
    const files = await walk(connection, target.remotePath, { includeHidden: false, signal: exec.signal });
    const matches = [];
    const selected = files.filter((file) => {
        if (file.size > MAX_GREP_BYTES)
            return false;
        const full = path.posix.relative(cwd, file.remote);
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
                    path: path.posix.relative(cwd, file.remote),
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