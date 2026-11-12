import path from 'node:path';
import crypto from 'node:crypto';
import { applyHunks } from '@deepseek-ai/dsh-fs-patch';
import { SshConnection } from './connection.js';
import { RemoteSshError, throwIfAborted } from './errors.js';
import { encodeVirtualPath, remoteContains } from './paths.js';
const DIFF_BASIS_MAX_BYTES = 10 * 1024 * 1024;
const TEXT_MAX_BYTES = 32 * 1024 * 1024;
function normalizeLineEndings(content) {
    return content.replaceAll('\r\n', '\n');
}
function detectLineEndings(raw) {
    const sample = raw.slice(0, 4096);
    const crlfCount = sample.split('\r\n').length - 1;
    return crlfCount > sample.split('\n').length - 1 - crlfCount ? 'CRLF' : 'LF';
}
function restoreLineEndings(content, lineEndings) {
    return lineEndings === 'LF' ? content : normalizeLineEndings(content).split('\n').join('\r\n');
}
function countOccurrences(content, needle) {
    let count = 0;
    let index = 0;
    while (true) {
        const found = content.indexOf(needle, index);
        if (found === -1)
            return count;
        count += 1;
        index = found + needle.length;
    }
}
function applyLiteralEdit(content, oldString, newString, replaceAll, displayPath) {
    const oldNorm = normalizeLineEndings(oldString);
    if (oldNorm.length === 0)
        throw new RemoteSshError('FS_EDIT_NOT_FOUND', 'old_string must be a non-empty string');
    const newNorm = normalizeLineEndings(newString);
    const replacements = countOccurrences(content, oldNorm);
    if (replacements === 0)
        throw new RemoteSshError('FS_EDIT_NOT_FOUND', `old_string was not found in "${displayPath}"`);
    if (!replaceAll && replacements > 1) {
        throw new RemoteSshError('FS_AMBIGUOUS_EDIT', `old_string matched ${replacements} times in "${displayPath}"; provide a more specific old_string or set replace_all to true`);
    }
    return { content: content.split(oldNorm).join(newNorm), replacements };
}
function isSftpError(error) {
    return error instanceof Error && typeof error.code === 'number';
}
/**
 * SFTP implementation of the {@link import('@deepseek-ai/dsh-fs').FileSystem}
 * surface for virtual remote targets. Every mutation is version guarded,
 * locked per remote path, and checked against the session sandbox policy using
 * the remote workspace root (not the local workspaceRoot).
 */
export class RemoteFileSystem {
    manager;
    locks = new Map();
    seq = new Map();
    constructor(manager) {
        this.manager = manager;
    }
    async resolve(pathValue, opts) {
        throwIfAborted(opts?.signal, 'resolve');
        const route = await this.manager.resolveRoute(pathValue, opts?.cwd);
        if (route === null)
            throw new RemoteSshError('SSH_PATH_INVALID', `not a remote workspace path: ${pathValue}`);
        return await this.targetFor(route, pathValue, opts?.signal);
    }
    async targetFor(route, requested, signal) {
        const requestedRemote = route.remotePath;
        const canonical = await this.canonicalize(route.connection, requestedRemote, signal);
        return {
            targetKey: `ssh:${route.workspace.token}:${canonical}`,
            displayPath: encodeVirtualPath(route.workspace.token, requestedRemote),
            workspaceToken: route.workspace.token,
            connectionId: route.workspace.connectionId,
            remotePath: canonical,
            requestedRemotePath: requestedRemote,
        };
    }
    async sftp(connection, operation, options = {}) {
        await connection.ensure();
        try {
            return await operation(connection.sftp);
        }
        catch (error) {
            if (options.retry !== false && SshConnection.connectionLost(error)) {
                connection.invalidate(error);
                await connection.ensure();
                return await operation(connection.sftp);
            }
            throw error;
        }
    }
    mapError(error, connection, verb) {
        if (error instanceof RemoteSshError)
            return error;
        if (SshConnection.connectionLost(error)) {
            connection.invalidate(error);
            return new RemoteSshError('SSH_CONNECTION_LOST', `${verb}: connection lost; retry the operation`);
        }
        if (isSftpError(error))
            return connection.mapSftpError(error, verb);
        return new RemoteSshError('SSH_IO_ERROR', `${verb}: ${error instanceof Error ? error.message : String(error)}`);
    }
    async statRaw(connection, remotePath) {
        try {
            return await this.sftp(connection, (sftp) => new Promise((resolve, reject) => sftp.stat(remotePath, (error, stats) => (error ? reject(error) : resolve(stats)))));
        }
        catch (error) {
            if (isSftpError(error) && error.code === 2)
                return undefined;
            throw this.mapError(error, connection, `cannot stat ${remotePath}`);
        }
    }
    async lstatRaw(connection, remotePath) {
        try {
            return await this.sftp(connection, (sftp) => new Promise((resolve, reject) => sftp.lstat(remotePath, (error, stats) => (error ? reject(error) : resolve(stats)))));
        }
        catch (error) {
            if (isSftpError(error) && error.code === 2)
                return undefined;
            throw this.mapError(error, connection, `cannot lstat ${remotePath}`);
        }
    }
    typeOf(stats, follow) {
        if (follow && stats.isSymbolicLink())
            return 'symlink';
        if (stats.isFile())
            return 'file';
        if (stats.isDirectory())
            return 'directory';
        if (stats.isSymbolicLink())
            return 'symlink';
        return 'other';
    }
    baseVersion(remotePath, stats) {
        const mode = typeof stats.mode === 'number' ? stats.mode & 0o777 : 0;
        return `${stats.mtime}:${stats.size}:${mode}:${typeof stats.uid === 'number' ? stats.uid : 0}:${typeof stats.gid === 'number' ? stats.gid : 0}`;
    }
    versionOf(remotePath, stats) {
        return `${this.baseVersion(remotePath, stats)}:${this.seq.get(remotePath) ?? 0}`;
    }
    bump(remotePath) {
        this.seq.set(remotePath, (this.seq.get(remotePath) ?? 0) + 1);
    }
    statInfo(remotePath, stats, follow) {
        return {
            version: this.versionOf(remotePath, stats),
            type: this.typeOf(stats, follow),
            size: Number(stats.size),
            mode: typeof stats.mode === 'number' ? stats.mode & 0o777 : undefined,
            mtime: stats.mtime,
        };
    }
    async targetRoute(target) {
        const workspace = this.manager.workspaceByToken(target.workspaceToken);
        const connection = await this.manager.connection(workspace.connectionId);
        const remotePath = target.remotePath;
        if (!path.posix.isAbsolute(remotePath))
            throw new RemoteSshError('SSH_PATH_INVALID', `remote target is not absolute: ${remotePath}`);
        const route = {
            workspace,
            remotePath,
            virtualPath: target.displayPath,
            targetKey: target.targetKey,
            connection,
            homeDir: workspace.remoteHome,
        };
        return { route, connection };
    }
    /** Resolve the canonical path, including for a not-yet-existing file. */
    async canonicalize(connection, remotePath, signal) {
        throwIfAborted(signal, 'resolve');
        const normalized = path.posix.normalize(remotePath);
        try {
            const real = await this.sftp(connection, (sftp) => new Promise((resolve, reject) => sftp.realpath(normalized, (error, resolved) => (error ? reject(error) : resolve(resolved)))));
            return real;
        }
        catch (error) {
            if (!isSftpError(error) || error.code !== 2)
                throw this.mapError(error, connection, `cannot resolve ${normalized}`);
        }
        let ancestor = path.posix.dirname(normalized);
        const missing = [path.posix.basename(normalized)];
        while (true) {
            throwIfAborted(signal, 'resolve');
            try {
                const real = await this.sftp(connection, (sftp) => new Promise((resolve, reject) => sftp.realpath(ancestor, (error, resolved) => (error ? reject(error) : resolve(resolved)))));
                const info = await this.statRaw(connection, real);
                if (info === undefined || !info.isDirectory()) {
                    throw new RemoteSshError('FS_NOT_FOUND', `cannot resolve ${normalized}: a parent path segment is not a directory`);
                }
                return path.posix.join(real, ...missing);
            }
            catch (error) {
                if (!isSftpError(error) || error.code !== 2) {
                    if (error instanceof RemoteSshError)
                        throw error;
                    throw this.mapError(error, connection, `cannot resolve ${normalized}`);
                }
                const parent = path.posix.dirname(ancestor);
                if (parent === ancestor)
                    return path.posix.join('/', ...missing);
                missing.unshift(path.posix.basename(ancestor));
                ancestor = parent;
            }
        }
    }
    async info(target) {
        const { connection } = await this.targetRoute(target);
        const raw = await this.statRaw(connection, target.remotePath);
        return { connection, info: raw === undefined ? undefined : this.statInfo(target.remotePath, raw, true), ...(raw !== undefined ? { raw } : {}) };
    }
    async checkWrite(target, policy) {
        // Containment is never optional: even a direct caller that forgets to pass
        // a sandbox policy must not be able to write outside the opened workspace.
        // `danger-full-access` relaxes the DSH sandbox but still cannot escape the
        // remote root, because the remote host has no equivalent DSH policy.
        const workspace = this.manager.workspaceByToken(target.workspaceToken);
        if (!remoteContains(workspace.remoteRoot, target.remotePath)) {
            throw new RemoteSshError('FS_PERMISSION_DENIED', `cannot modify "${target.displayPath}": outside the remote workspace ${workspace.remoteRoot}; reopen a workspace at an ancestor directory`);
        }
        if (policy === undefined)
            return;
        if (policy.mode === 'read-only') {
            throw new RemoteSshError('FS_PERMISSION_DENIED', `cannot modify "${target.displayPath}": session is read-only`);
        }
    }
    withLock(key, operation) {
        const previous = this.locks.get(key) ?? Promise.resolve();
        const run = previous.then(operation, operation);
        const tail = run.then(() => undefined, () => undefined);
        this.locks.set(key, tail);
        return run.finally(() => {
            if (this.locks.get(key) === tail)
                this.locks.delete(key);
        });
    }
    async stat(target, signal) {
        throwIfAborted(signal, 'stat');
        const { info } = await this.info(target);
        return info;
    }
    async lstat(pathValue, opts, signal) {
        throwIfAborted(signal ?? opts?.signal, 'lstat');
        const resolved = await this.resolve(pathValue, opts);
        const { connection } = await this.targetRoute(resolved);
        const raw = await this.lstatRaw(connection, resolved.remotePath);
        if (raw === undefined)
            return undefined;
        return this.statInfo(resolved.remotePath, raw, false);
    }
    async readText(target, signal) {
        const buffer = await this.readWholeBytes(target, signal, TEXT_MAX_BYTES);
        if (buffer.includes(0))
            throw new RemoteSshError('FS_NOT_TEXT', `cannot read "${target.displayPath}": binary file`);
        try {
            return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
        }
        catch {
            throw new RemoteSshError('FS_NOT_TEXT', `cannot read "${target.displayPath}": invalid UTF-8 text`);
        }
    }
    async *streamTextGenerator(target, signal) {
        throwIfAborted(signal, 'read');
        const { connection, info } = await this.info(target);
        if (info === undefined)
            throw new RemoteSshError('FS_NOT_FOUND', `cannot read "${target.displayPath}": not found`);
        if (info.type !== 'file')
            throw new RemoteSshError('FS_NOT_REGULAR_FILE', `cannot read "${target.displayPath}": not a regular file`);
        const sftp = connection.sftp;
        const stream = sftp.createReadStream(target.remotePath);
        const decoder = new TextDecoder('utf-8', { fatal: true });
        let sampled = 0;
        const onAbort = () => {
            stream.destroy(new Error('aborted'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
            for await (const chunk of stream) {
                throwIfAborted(signal, 'read');
                if (sampled < 8192) {
                    const sample = chunk.subarray(0, Math.min(chunk.length, 8192 - sampled));
                    if (sample.includes(0))
                        throw new RemoteSshError('FS_NOT_TEXT', `cannot read "${target.displayPath}": binary file`);
                    sampled += sample.length;
                }
                try {
                    const text = decoder.decode(chunk, { stream: true });
                    if (text.length > 0)
                        yield text;
                }
                catch {
                    throw new RemoteSshError('FS_NOT_TEXT', `cannot read "${target.displayPath}": invalid UTF-8 text`);
                }
            }
            try {
                const final = decoder.decode();
                if (final.length > 0)
                    yield final;
            }
            catch {
                throw new RemoteSshError('FS_NOT_TEXT', `cannot read "${target.displayPath}": invalid UTF-8 text`);
            }
        }
        finally {
            signal?.removeEventListener('abort', onAbort);
            try {
                stream.destroy();
            }
            catch {
                // ignore
            }
            if (signal?.aborted === true)
                throw new RemoteSshError('FS_ABORTED', 'read aborted');
        }
    }
    streamText(target, signal) {
        return Promise.resolve(this.streamTextGenerator(target, signal));
    }
    async readWholeBytes(target, signal, maxBytes = 64 * 1024 * 1024) {
        throwIfAborted(signal, 'read');
        const { connection, info } = await this.info(target);
        if (info === undefined)
            throw new RemoteSshError('FS_NOT_FOUND', `cannot read "${target.displayPath}": not found`);
        if (info.type !== 'file')
            throw new RemoteSshError('FS_NOT_REGULAR_FILE', `cannot read "${target.displayPath}": not a regular file`);
        if (info.size > maxBytes) {
            throw new RemoteSshError('FS_TOO_LARGE', `cannot read "${target.displayPath}": ${info.size} bytes exceeds the ${maxBytes}-byte limit`);
        }
        try {
            // readFile completes the SFTP request before resolving. A ReadStream that
            // is destroyed immediately after its last chunk can race the CLOSE request
            // and surface as "No response from server" during teardown.
            const buffer = await new Promise((resolve, reject) => {
                connection.sftp.readFile(target.remotePath, (error, data) => {
                    if (error)
                        reject(this.mapError(error, connection, `cannot read ${target.remotePath}`));
                    else
                        resolve(data);
                });
            });
            throwIfAborted(signal, 'read');
            if (buffer.length > maxBytes) {
                throw new RemoteSshError('FS_TOO_LARGE', `cannot read "${target.displayPath}": content exceeds the ${maxBytes}-byte limit`);
            }
            return buffer;
        }
        catch (error) {
            if (signal?.aborted === true)
                throw new RemoteSshError('FS_ABORTED', 'read aborted');
            if (SshConnection.connectionLost(error))
                throw this.mapError(error, connection, 'read');
            throw error;
        }
    }
    async readBytes(target, signal, maxBytes) {
        return await this.readWholeBytes(target, signal, maxBytes ?? 64 * 1024 * 1024);
    }
    async readByteRange(target, range, signal) {
        throwIfAborted(signal, 'read');
        if (range.length === 0)
            return new Uint8Array(0);
        const { connection, info } = await this.info(target);
        if (info === undefined)
            throw new RemoteSshError('FS_NOT_FOUND', `cannot read "${target.displayPath}": not found`);
        if (info.type !== 'file')
            throw new RemoteSshError('FS_NOT_REGULAR_FILE', `cannot read "${target.displayPath}": not a regular file`);
        const stream = connection.sftp.createReadStream(target.remotePath, {
            start: range.offset,
            end: range.offset + range.length - 1,
        });
        const chunks = [];
        let total = 0;
        const onAbort = () => {
            stream.destroy(new Error('aborted'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
            for await (const chunk of stream) {
                throwIfAborted(signal, 'read');
                chunks.push(chunk);
                total += chunk.length;
            }
        }
        catch (error) {
            if (signal?.aborted === true)
                throw new RemoteSshError('FS_ABORTED', 'read aborted');
            if (SshConnection.connectionLost(error))
                throw this.mapError(error, connection, 'read');
            throw error;
        }
        finally {
            signal?.removeEventListener('abort', onAbort);
            try {
                stream.destroy();
            }
            catch {
                // ignore
            }
        }
        return Buffer.concat(chunks, total);
    }
    async listDir(target, signal) {
        throwIfAborted(signal, 'list');
        const { connection, info } = await this.info(target);
        if (info === undefined)
            throw new RemoteSshError('FS_NOT_FOUND', `cannot list "${target.displayPath}": not found`);
        if (info.type !== 'directory')
            throw new RemoteSshError('FS_NOT_DIRECTORY', `cannot list "${target.displayPath}": not a directory`);
        const entries = await this.sftp(connection, (sftp) => new Promise((resolve, reject) => sftp.readdir(target.remotePath, (error, list) => (error ? reject(error) : resolve(list))))).catch((error) => {
            throw this.mapError(error, connection, `cannot list "${target.displayPath}"`);
        });
        const result = [];
        for (const entry of entries.sort((left, right) => left.filename.localeCompare(right.filename))) {
            throwIfAborted(signal, 'list');
            const childRemote = path.posix.join(target.remotePath, entry.filename);
            let childCanonical = childRemote;
            let childType = entry.attrs.isDirectory() ? 'directory' : entry.attrs.isFile() ? 'file' : 'other';
            let childStats = entry.attrs;
            if (entry.attrs.isSymbolicLink()) {
                try {
                    childCanonical = await this.canonicalize(connection, childRemote, signal);
                    const followed = await this.statRaw(connection, childCanonical);
                    if (followed !== undefined) {
                        childStats = followed;
                        childType = this.typeOf(followed, true);
                    }
                    else
                        childType = 'symlink';
                }
                catch {
                    childType = 'symlink';
                }
            }
            result.push({
                name: entry.filename,
                type: childType,
                target: {
                    targetKey: `ssh:${target.workspaceToken}:${childCanonical}`,
                    displayPath: encodeVirtualPath(target.workspaceToken, childRemote),
                    workspaceToken: target.workspaceToken,
                    remotePath: childCanonical,
                    requestedRemotePath: childRemote,
                },
                ...(childStats !== undefined ? { version: this.versionOf(childCanonical, childStats) } : {}),
                ...(childType === 'file' && childStats !== undefined ? { size: Number(childStats.size) } : {}),
            });
        }
        return result;
    }
    async writeStream(connection, remotePath, content, mode, signal) {
        await new Promise((resolve, reject) => {
            let settled = false;
            let stream;
            const finish = (fn) => {
                if (settled)
                    return;
                settled = true;
                signal?.removeEventListener('abort', onAbort);
                fn();
            };
            const onAbort = () => {
                try {
                    stream?.destroy(new Error('aborted'));
                }
                catch {
                    // ignore
                }
                finish(() => reject(new RemoteSshError('FS_ABORTED', 'write aborted')));
            };
            try {
                stream = connection.sftp.createWriteStream(remotePath, { mode });
            }
            catch (error) {
                finish(() => reject(error));
                return;
            }
            if (stream === undefined) {
                finish(() => reject(new RemoteSshError('SSH_IO_ERROR', `cannot open a write stream for ${remotePath}`)));
                return;
            }
            stream.on('error', (error) => finish(() => reject(error)));
            stream.on('close', () => finish(resolve));
            signal?.addEventListener('abort', onAbort, { once: true });
            if (signal?.aborted === true) {
                onAbort();
                return;
            }
            stream.end(content);
        }).catch((error) => {
            throw this.mapError(error, connection, `cannot write ${remotePath}`);
        });
    }
    async rename(connection, from, to) {
        const sftp = connection.sftp;
        const posixRename = sftp.ext_openssh_rename;
        if (typeof posixRename === 'function') {
            try {
                await new Promise((resolve, reject) => posixRename.call(sftp, from, to, (error) => (error ? reject(error) : resolve())));
                return;
            }
            catch {
                // Fall through to the standard rename.
            }
        }
        await new Promise((resolve, reject) => sftp.rename(from, to, (error) => (error ? reject(error) : resolve())));
    }
    async writeAtomic(connection, remotePath, content, mode, signal) {
        const dir = path.posix.dirname(remotePath);
        const temp = path.posix.join(dir, `.dsh-remote-${crypto.randomUUID()}.tmp`);
        try {
            await this.writeStream(connection, temp, content, mode, signal);
            await new Promise((resolve, reject) => connection.sftp.chmod(temp, mode, (error) => (error ? reject(error) : resolve())));
            await this.rename(connection, temp, remotePath);
        }
        catch (error) {
            try {
                await new Promise((resolve) => connection.sftp.unlink(temp, () => resolve()));
            }
            catch {
                // ignore
            }
            throw this.mapError(error, connection, `cannot write ${remotePath}`);
        }
    }
    async writeTarget(target, expected) {
        const { connection, info, raw } = await this.info(target);
        if (info !== undefined && info.type !== 'file') {
            throw new RemoteSshError('FS_NOT_REGULAR_FILE', `cannot write "${target.displayPath}": not a regular file`);
        }
        if (expected?.kind === 'replaceIfVersion') {
            if (info === undefined)
                throw new RemoteSshError('FS_STALE_VERSION', `cannot write "${target.displayPath}": file no longer exists`);
            if (info.version !== expected.version)
                throw new RemoteSshError('FS_STALE_VERSION', `cannot write "${target.displayPath}": file changed since it was read`);
        }
        else if (expected?.kind === 'createIfAbsent' && info !== undefined) {
            throw new RemoteSshError('FS_NOT_OBSERVED', `cannot overwrite existing "${target.displayPath}" without reading it first`);
        }
        return { ...(info !== undefined ? { info } : {}), ...(raw !== undefined ? { raw } : {}), connection };
    }
    async writeText(target, content, expected, signal, policy) {
        await this.checkWrite(target, policy);
        return await this.withLock(target.targetKey, async () => {
            throwIfAborted(signal, 'write');
            const { info, raw, connection } = await this.writeTarget(target, expected);
            const before = info !== undefined && raw !== undefined && Buffer.byteLength(content, 'utf8') < DIFF_BASIS_MAX_BYTES
                ? await this.diffBasis(target, connection, signal)
                : null;
            const mode = info?.mode ?? 0o644;
            await this.writeAtomic(connection, target.remotePath, content, mode, signal);
            this.bump(target.remotePath);
            const afterInfo = await this.statRaw(connection, target.remotePath);
            return {
                operation: info === undefined ? 'create' : 'update',
                version: afterInfo !== undefined ? this.versionOf(target.remotePath, afterInfo) : `missing:${target.remotePath}:${Date.now()}`,
                before,
                after: normalizeLineEndings(content),
            };
        });
    }
    async diffBasis(target, connection, signal) {
        try {
            const buffer = await this.readWholeBytes(target, signal, DIFF_BASIS_MAX_BYTES);
            if (buffer.includes(0))
                return null;
            return normalizeLineEndings(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
        }
        catch {
            return null;
        }
    }
    async editText(target, edit, expected, signal, policy) {
        await this.checkWrite(target, policy);
        return await this.withLock(target.targetKey, async () => {
            throwIfAborted(signal, 'edit');
            const { connection, info } = await this.info(target);
            if (info === undefined)
                throw new RemoteSshError('FS_STALE_VERSION', `cannot edit "${target.displayPath}": file changed since it was read`);
            if (info.type !== 'file')
                throw new RemoteSshError('FS_NOT_REGULAR_FILE', `cannot edit "${target.displayPath}": not a regular file`);
            if (expected?.version !== undefined && info.version !== expected.version) {
                throw new RemoteSshError('FS_STALE_VERSION', `cannot edit "${target.displayPath}": file changed since it was read`);
            }
            const buffer = await this.readWholeBytes(target, signal, DIFF_BASIS_MAX_BYTES);
            if (buffer.includes(0))
                throw new RemoteSshError('FS_NOT_TEXT', `cannot edit "${target.displayPath}": binary file`);
            const raw = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
            const lineEndings = detectLineEndings(raw);
            const normalized = normalizeLineEndings(raw);
            const edited = applyLiteralEdit(normalized, edit.oldString, edit.newString, edit.replaceAll === true, target.displayPath);
            await this.writeAtomic(connection, target.remotePath, restoreLineEndings(edited.content, lineEndings), info.mode ?? 0o644, signal);
            this.bump(target.remotePath);
            const afterInfo = await this.statRaw(connection, target.remotePath);
            return {
                version: afterInfo !== undefined ? this.versionOf(target.remotePath, afterInfo) : `missing:${target.remotePath}:${Date.now()}`,
                before: normalized,
                after: edited.content,
            };
        });
    }
    async patchText(target, hunks, expected, signal, policy) {
        await this.checkWrite(target, policy);
        return await this.withLock(target.targetKey, async () => {
            throwIfAborted(signal, 'patch');
            const { connection, info } = await this.info(target);
            if (info === undefined)
                throw new RemoteSshError('FS_STALE_VERSION', `cannot patch "${target.displayPath}": file changed since it was read`);
            if (info.type !== 'file')
                throw new RemoteSshError('FS_NOT_REGULAR_FILE', `cannot patch "${target.displayPath}": not a regular file`);
            if (expected?.version !== undefined && info.version !== expected.version) {
                throw new RemoteSshError('FS_STALE_VERSION', `cannot patch "${target.displayPath}": file changed since it was read`);
            }
            const buffer = await this.readWholeBytes(target, signal, DIFF_BASIS_MAX_BYTES);
            if (buffer.includes(0))
                throw new RemoteSshError('FS_NOT_TEXT', `cannot patch "${target.displayPath}": binary file`);
            const raw = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
            const lineEndings = detectLineEndings(raw);
            const normalized = normalizeLineEndings(raw);
            const result = applyHunks(normalized, hunks);
            if (!result.ok) {
                throw new RemoteSshError('FS_PATCH_MISMATCH', `cannot patch "${target.displayPath}": hunk at patch line ${result.failure.hunkLineNumber} (${result.failure.stage}) does not match`);
            }
            await this.writeAtomic(connection, target.remotePath, restoreLineEndings(result.after, lineEndings), info.mode ?? 0o644, signal);
            this.bump(target.remotePath);
            const afterInfo = await this.statRaw(connection, target.remotePath);
            return {
                version: afterInfo !== undefined ? this.versionOf(target.remotePath, afterInfo) : `missing:${target.remotePath}:${Date.now()}`,
                before: normalized,
                after: result.after,
            };
        });
    }
    async deleteFile(target, expected, signal, policy) {
        await this.checkWrite(target, policy);
        return await this.withLock(target.targetKey, async () => {
            throwIfAborted(signal, 'delete');
            const { connection, info } = await this.info(target);
            if (info === undefined)
                throw new RemoteSshError('FS_STALE_VERSION', `cannot delete "${target.displayPath}": file changed since it was read`);
            if (info.type !== 'file')
                throw new RemoteSshError('FS_NOT_REGULAR_FILE', `cannot delete "${target.displayPath}": not a regular file`);
            if (expected?.version !== undefined && info.version !== expected.version) {
                throw new RemoteSshError('FS_STALE_VERSION', `cannot delete "${target.displayPath}": file changed since it was read`);
            }
            const before = await this.diffBasis(target, connection, signal);
            await this.sftp(connection, (sftp) => new Promise((resolve, reject) => sftp.unlink(target.remotePath, (error) => (error ? reject(error) : resolve()))), { retry: false }).catch((error) => {
                throw this.mapError(error, connection, `cannot delete "${target.displayPath}"`);
            });
            this.bump(target.remotePath);
            return { before };
        });
    }
    async moveFile(source, destination, options, signal, policy) {
        if (source.workspaceToken !== destination.workspaceToken) {
            throw new RemoteSshError('SSH_FEATURE_UNSUPPORTED', 'moving between different remote workspaces is not supported; move within one workspace or use the remote shell');
        }
        if (source.targetKey === destination.targetKey)
            throw new RemoteSshError('FS_SAME_TARGET', `cannot move "${source.displayPath}" to itself`);
        await this.checkWrite(source, policy);
        await this.checkWrite(destination, policy);
        return await this.withLock(source.targetKey, async () => this.withLock(destination.targetKey, async () => {
            throwIfAborted(signal, 'move');
            const { connection, info: sourceInfo } = await this.info(source);
            if (sourceInfo === undefined)
                throw new RemoteSshError('FS_STALE_VERSION', `cannot move "${source.displayPath}": file changed since it was read`);
            if (sourceInfo.type !== 'file')
                throw new RemoteSshError('FS_NOT_REGULAR_FILE', `cannot move "${source.displayPath}": not a regular file`);
            if (options.expectedSource?.version !== undefined && sourceInfo.version !== options.expectedSource.version) {
                throw new RemoteSshError('FS_STALE_VERSION', `cannot move "${source.displayPath}": file changed since it was read`);
            }
            const existingDest = await this.info(destination);
            if (options.expectedDestination?.kind === 'replaceIfVersion') {
                if (existingDest.info === undefined)
                    throw new RemoteSshError('FS_STALE_VERSION', `cannot move to "${destination.displayPath}": file no longer exists`);
                if (existingDest.info.version !== options.expectedDestination.version) {
                    throw new RemoteSshError('FS_STALE_VERSION', `cannot move to "${destination.displayPath}": file changed since it was read`);
                }
            }
            else if (options.expectedDestination?.kind === 'createIfAbsent' && existingDest.info !== undefined) {
                throw new RemoteSshError('FS_NOT_OBSERVED', `cannot overwrite existing "${destination.displayPath}" without reading it first`);
            }
            const buffer = await this.readWholeBytes(source, signal, DIFF_BASIS_MAX_BYTES);
            if (buffer.includes(0))
                throw new RemoteSshError('FS_NOT_TEXT', `cannot move "${source.displayPath}": binary file`);
            const raw = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
            const lineEndings = detectLineEndings(raw);
            const normalized = normalizeLineEndings(raw);
            let after = normalized;
            if (options.hunks !== undefined) {
                const applied = applyHunks(normalized, options.hunks);
                if (!applied.ok) {
                    throw new RemoteSshError('FS_PATCH_MISMATCH', `cannot move "${source.displayPath}": a patch hunk did not match`);
                }
                after = applied.after;
            }
            const content = restoreLineEndings(after, lineEndings);
            const before = existingDest.info !== undefined && Buffer.byteLength(content, 'utf8') < DIFF_BASIS_MAX_BYTES
                ? await this.diffBasis(destination, existingDest.connection, signal)
                : null;
            await this.writeAtomic(existingDest.connection, destination.remotePath, content, sourceInfo.mode ?? 0o644, signal);
            this.bump(destination.remotePath);
            const destInfo = await this.statRaw(existingDest.connection, destination.remotePath);
            const outcome = {
                operation: existingDest.info === undefined ? 'create' : 'update',
                version: destInfo !== undefined ? this.versionOf(destination.remotePath, destInfo) : `missing:${destination.remotePath}:${Date.now()}`,
                before,
                after: normalized,
            };
            const sourceBefore = Buffer.byteLength(normalized, 'utf8') < DIFF_BASIS_MAX_BYTES ? normalized : null;
            try {
                await this.sftp(connection, (sftp) => new Promise((resolve, reject) => sftp.unlink(source.remotePath, (error) => (error ? reject(error) : resolve()))), { retry: false });
                this.bump(source.remotePath);
                return { sourceBefore, destination: outcome, sourceDeleted: true };
            }
            catch (error) {
                const mapped = this.mapError(error, connection, `cannot delete source "${source.displayPath}"`);
                return {
                    sourceBefore,
                    destination: outcome,
                    sourceDeleted: false,
                    sourceFailure: { code: mapped.code, message: mapped.message },
                };
            }
        }));
    }
    /** Remote directory watching is intentionally unsupported; never fall back to a local watcher. */
    async watch() {
        throw new RemoteSshError('SSH_FEATURE_UNSUPPORTED', 'remote filesystem watching is not implemented; re-read the file or refresh the listing after external changes');
    }
    /** Session policy containment in the remote coordinate space. */
    contains(parent, child) {
        if (parent.workspaceToken !== child.workspaceToken)
            return false;
        return remoteContains(parent.remotePath, child.remotePath);
    }
    fileUrl(target) {
        return `remote-ssh://${target.workspaceToken}${target.remotePath}`;
    }
}
//# sourceMappingURL=remote-fs.js.map