import path from 'node:path';
import { RemoteSshError } from './errors.js';
import { looksVirtual, parseVirtualPath } from './paths.js';
import { RemoteFileSystem } from './remote-fs.js';
function isRemoteTarget(target) {
    if (target === null || typeof target !== 'object')
        return false;
    const value = target;
    if (typeof value.workspaceToken === 'string' && typeof value.remotePath === 'string' && typeof value.displayPath === 'string')
        return true;
    return typeof value.targetKey === 'string' && value.targetKey.startsWith('ssh:');
}
function targetFromKey(target) {
    if (target === null || typeof target !== 'object')
        return null;
    const value = target;
    const targetKey = typeof value.targetKey === 'string' ? value.targetKey : undefined;
    if (targetKey === undefined || !targetKey.startsWith('ssh:'))
        return null;
    const rest = targetKey.slice(4);
    const colon = rest.indexOf(':');
    if (colon <= 0)
        return null;
    const workspaceToken = rest.slice(0, colon);
    const remotePath = rest.slice(colon + 1);
    const displayPath = typeof value.displayPath === 'string' ? value.displayPath : remotePath;
    return { targetKey, displayPath, workspaceToken, remotePath };
}
/**
 * An absolute *host* path is never a remote path, even when the current cwd
 * is virtual. DSH workingDirectory.set() resolves every requested path with
 * a cwd option pointing at the current virtual directory; without this
 * escape hatch, local paths used by close/cd/recovery would be routed into
 * the SFTP resolver, which rejects Windows paths and makes a remote session
 * impossible to leave.
 */
function isAbsoluteLocalPath(value) {
    return !looksVirtual(value) && path.isAbsolute(value);
}
/** Resolve a target object to its remote coordinates, or null for local targets. */
export function remoteTargetOf(target) {
    if (isRemoteTarget(target)) {
        return target;
    }
    return targetFromKey(target);
}
/**
 * Wrap the live `ctx.fs` service in place. Local calls go through the original
 * sandboxed provider untouched; remote targets are served by SFTP. Keeping one
 * provider preserves DSH's sandbox and approval behavior for local work while
 * making the native read/write/edit/glob/grep tools work against remote paths.
 */
export function installFsRouter(ctx, manager) {
    const fs = ctx.fs;
    const remoteFs = new RemoteFileSystem(manager);
    const originals = new Map();
    const save = (name) => {
        const value = fs[name];
        if (typeof value !== 'function')
            throw new RemoteSshError('SSH_FEATURE_UNSUPPORTED', `filesystem provider is missing ${name}()`);
        const bound = value.bind(fs);
        originals.set(name, bound);
        return bound;
    };
    const originalResolve = save('resolve');
    const originalStat = save('stat');
    const originalLstat = save('lstat');
    const originalReadText = save('readText');
    const originalStreamText = save('streamText');
    const originalReadBytes = save('readBytes');
    const originalReadByteRange = save('readByteRange');
    const originalListDir = save('listDir');
    const originalWriteText = save('writeText');
    const originalEditText = save('editText');
    const originalPatchText = save('patchText');
    const originalDeleteFile = save('deleteFile');
    const originalMoveFile = save('moveFile');
    const originalWatch = save('watch');
    const originalProcessPath = save('processPath');
    const originalProcessPathFromHostPath = save('processPathFromHostPath');
    const originalContains = save('contains');
    const originalFileUrl = save('fileUrl');
    fs.resolve = async (pathValue, opts) => {
        const value = typeof pathValue === 'string' ? pathValue : String(pathValue);
        // DSH's workingDirectory.set() always resolves with the current (possibly
        // virtual) cwd. A virtual path itself is remote; an absolute local path
        // must stay local; only a relative path follows a virtual cwd.
        if (looksVirtual(value))
            return await remoteFs.resolve(value, opts);
        if (isAbsoluteLocalPath(value))
            return await originalResolve(pathValue, opts);
        if (looksVirtual(opts?.cwd))
            return await remoteFs.resolve(value, opts);
        return await originalResolve(pathValue, opts);
    };
    fs.stat = async (target, signal) => {
        const remote = remoteTargetOf(target);
        if (remote !== null)
            return await remoteFs.stat(remote, signal);
        return await originalStat(target, signal);
    };
    fs.lstat = async (pathValue, opts, signal) => {
        const value = typeof pathValue === 'string' ? pathValue : String(pathValue);
        if (looksVirtual(value))
            return await remoteFs.lstat(value, opts, signal);
        if (isAbsoluteLocalPath(value))
            return await originalLstat(pathValue, opts, signal);
        if (looksVirtual(opts?.cwd))
            return await remoteFs.lstat(value, opts, signal);
        return await originalLstat(pathValue, opts, signal);
    };
    fs.readText = async (target, signal) => {
        const remote = remoteTargetOf(target);
        if (remote !== null)
            return await remoteFs.readText(remote, signal);
        return await originalReadText(target, signal);
    };
    fs.streamText = async (target, signal) => {
        const remote = remoteTargetOf(target);
        if (remote !== null)
            return await remoteFs.streamText(remote, signal);
        return await originalStreamText(target, signal);
    };
    fs.readBytes = async (target, signal, maxBytes) => {
        const remote = remoteTargetOf(target);
        if (remote !== null)
            return await remoteFs.readBytes(remote, signal, maxBytes);
        return await originalReadBytes(target, signal, maxBytes);
    };
    fs.readByteRange = async (target, range, signal) => {
        const remote = remoteTargetOf(target);
        if (remote !== null)
            return await remoteFs.readByteRange(remote, range, signal);
        return await originalReadByteRange(target, range, signal);
    };
    fs.listDir = async (target, signal) => {
        const remote = remoteTargetOf(target);
        if (remote !== null)
            return await remoteFs.listDir(remote, signal);
        return await originalListDir(target, signal);
    };
    fs.writeText = async (target, content, expected, signal, policy) => {
        const remote = remoteTargetOf(target);
        if (remote !== null)
            return await remoteFs.writeText(remote, content, expected, signal, policy);
        return await originalWriteText(target, content, expected, signal, policy);
    };
    fs.editText = async (target, edit, expected, signal, policy) => {
        const remote = remoteTargetOf(target);
        if (remote !== null)
            return await remoteFs.editText(remote, edit, expected, signal, policy);
        return await originalEditText(target, edit, expected, signal, policy);
    };
    fs.patchText = async (target, hunks, expected, signal, policy) => {
        const remote = remoteTargetOf(target);
        if (remote !== null)
            return await remoteFs.patchText(remote, hunks, expected, signal, policy);
        return await originalPatchText(target, hunks, expected, signal, policy);
    };
    fs.deleteFile = async (target, expected, signal, policy) => {
        const remote = remoteTargetOf(target);
        if (remote !== null)
            return await remoteFs.deleteFile(remote, expected, signal, policy);
        return await originalDeleteFile(target, expected, signal, policy);
    };
    fs.moveFile = async (source, destination, options, signal, policy) => {
        const sourceRemote = remoteTargetOf(source);
        const destinationRemote = remoteTargetOf(destination);
        if (sourceRemote !== null || destinationRemote !== null) {
            if (sourceRemote === null || destinationRemote === null) {
                throw new RemoteSshError('SSH_FEATURE_UNSUPPORTED', 'cross-provider move between local and remote files is not supported');
            }
            return await remoteFs.moveFile(sourceRemote, destinationRemote, options, signal, policy);
        }
        return await originalMoveFile(source, destination, options, signal, policy);
    };
    fs.watch = async (target, changed, signal) => {
        const remote = remoteTargetOf(target);
        if (remote !== null)
            return await remoteFs.watch();
        return await originalWatch(target, changed, signal);
    };
    fs.processPath = (target) => {
        const remote = remoteTargetOf(target);
        if (remote !== null)
            return remote.displayPath;
        return originalProcessPath(target);
    };
    fs.processPathFromHostPath = (hostPath) => {
        const value = typeof hostPath === 'string' ? hostPath : String(hostPath);
        const parsed = parseVirtualPath(value);
        if (parsed !== null)
            return value;
        return originalProcessPathFromHostPath(hostPath);
    };
    fs.contains = (parent, child) => {
        const parentRemote = remoteTargetOf(parent);
        const childRemote = remoteTargetOf(child);
        if (parentRemote !== null || childRemote !== null) {
            if (parentRemote === null || childRemote === null)
                return false;
            return remoteFs.contains(parentRemote, childRemote);
        }
        return originalContains(parent, child);
    };
    fs.fileUrl = (target) => {
        const remote = remoteTargetOf(target);
        if (remote !== null)
            return remoteFs.fileUrl(remote);
        return originalFileUrl(target);
    };
    const dispose = () => {
        for (const [name, original] of originals)
            fs[name] = original;
        originals.clear();
    };
    ctx.effect?.(() => dispose);
    return { dispose, remoteFs };
}
//# sourceMappingURL=fs-router.js.map