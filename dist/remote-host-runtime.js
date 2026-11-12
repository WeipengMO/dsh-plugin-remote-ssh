/**
 * SSH-authenticated, per-host remote helper lifecycle.
 * Not a DSH Core transport: the parent Desktop still owns its Sessions.
 * This is the bootstrap/control-plane substrate for the future Remote Host.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RemoteSshError } from './errors.js';
import { shellQuote } from './paths.js';
export const REMOTE_RUNTIME_PROTOCOL = 1;
const agentBytes = fs.readFileSync(new URL('../runtime/agent.mjs', import.meta.url));
export const REMOTE_HELPER_SHA256 = crypto.createHash('sha256').update(agentBytes).digest('hex');
const PREFIX = 'dsh-remote-ssh/agents/v1';
const REMOTE_TIMEOUT = 15_000;
const MAX_RESULT_BYTES = 300_000;
async function sftpCall(connection, name, ...args) {
    await connection.ensure();
    return await new Promise((resolve, reject) => {
        const method = connection.sftp[name];
        if (typeof method !== 'function')
            return reject(new Error('SFTP method not available: ' + name));
        method.call(connection.sftp, ...args, (err, value) => err ? reject(err) : resolve(value));
    });
}
function isNotFound(err) {
    return err?.code === 2 ||
        err?.code === 'ENOENT' ||
        /no such file/i.test(err instanceof Error ? err.message : String(err));
}
async function secureDirectory(connection, dirname) {
    let stat;
    try {
        stat = await sftpCall(connection, 'lstat', dirname);
    }
    catch (err) {
        if (!isNotFound(err))
            throw err;
        try {
            await sftpCall(connection, 'mkdir', dirname, { mode: 0o700 });
        }
        catch (creationError) {
            // Concurrent SSH clients may create the same directory; re-check.
            if (isNotFound(creationError))
                throw creationError;
        }
        stat = await sftpCall(connection, 'lstat', dirname);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) {
        throw new RemoteSshError('SSH_PERMISSION_DENIED', 'remote helper directory must be a private, non-symlinked directory: ' + dirname);
    }
}
function validatedHome(home) {
    if (!path.posix.isAbsolute(home) || home.includes('\0') || home === '/') {
        throw new RemoteSshError('SSH_PATH_INVALID', 'remote home is not a usable Linux user directory');
    }
    return path.posix.normalize(home);
}
async function install(connection) {
    const home = validatedHome(await connection.remoteHome());
    const levels = [path.posix.join(home, '.cache'),
        path.posix.join(home, '.cache', 'dsh-remote-ssh'),
        path.posix.join(home, '.cache', 'dsh-remote-ssh', 'agents'),
        path.posix.join(home, '.cache', 'dsh-remote-ssh', 'agents', 'v1'),
        path.posix.join(home, '.cache', PREFIX, REMOTE_HELPER_SHA256)];
    // ~/.cache may be shared with other tools but must not be group/other writable.
    for (const dir of levels)
        await secureDirectory(connection, dir);
    const target = path.posix.join(levels[levels.length - 1], 'agent.mjs');
    let bytes;
    try {
        bytes = await sftpCall(connection, 'readFile', target);
    }
    catch (err) {
        if (!isNotFound(err))
            throw err;
    }
    if (bytes === undefined) {
        const temp = target + '.tmp-' + crypto.randomBytes(8).toString('hex');
        try {
            await sftpCall(connection, 'writeFile', temp, agentBytes, { mode: 0o600 });
            await sftpCall(connection, 'rename', temp, target);
        }
        finally {
            await sftpCall(connection, 'unlink', temp).catch(() => undefined);
        }
        bytes = await sftpCall(connection, 'readFile', target);
    }
    const actual = crypto.createHash('sha256').update(bytes).digest('hex');
    if (actual !== REMOTE_HELPER_SHA256) {
        throw new RemoteSshError('SSH_PERMISSION_DENIED', 'remote helper checksum mismatch; refusing to execute');
    }
    const metadata = await sftpCall(connection, 'lstat', target);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o022) !== 0) {
        throw new RemoteSshError('SSH_PERMISSION_DENIED', 'remote helper file permissions or type are unsafe');
    }
    return target;
}
export class RemoteHostRuntimePool {
    manager;
    active = new Map();
    pending = new Map();
    generations = new Map();
    disposed = false;
    constructor(manager) {
        this.manager = manager;
    }
    list() { return [...this.active.values()]; }
    clear(host) {
        this.generations.set(host, (this.generations.get(host) ?? 0) + 1);
        this.active.delete(host);
        this.pending.delete(host);
    }
    closeAll() { this.disposed = true; this.active.clear(); this.pending.clear(); this.generations.clear(); }
    async connect(host) {
        if (this.disposed)
            throw new RemoteSshError('SSH_FEATURE_UNSUPPORTED', 'remote runtime pool is disposed');
        const cached = this.active.get(host);
        if (cached)
            return cached;
        const pending = this.pending.get(host);
        if (pending)
            return await pending;
        const generation = this.generations.get(host) ?? 0;
        const task = this.setup(host, generation);
        this.pending.set(host, task);
        try {
            return await task;
        }
        finally {
            if (this.pending.get(host) === task)
                this.pending.delete(host);
        }
    }
    async setup(host, generation) {
        const connection = await this.manager.connection(host);
        const platform = await connection.exec('uname -s', { timeoutMs: 5000, maxBytes: 256 });
        if (platform.code !== 0 || platform.stdout.trim() !== 'Linux') {
            throw new RemoteSshError('SSH_FEATURE_UNSUPPORTED', 'remote helper requires Linux; detected ' + platform.stdout.trim().slice(0, 100));
        }
        const node = await connection.exec('node --version', { timeoutMs: 5000, maxBytes: 256 });
        if (node.code !== 0 || !/^v(?:2[0-9]|[3-9][0-9])\./.test(node.stdout.trim())) {
            throw new RemoteSshError('SSH_FEATURE_UNSUPPORTED', 'remote helper needs Node.js >=20 on Linux (not installed or too old)');
        }
        const helperPath = await install(connection);
        const response = await this.invoke(host, helperPath, 'hello', {});
        const r = response;
        if (r.protocol !== REMOTE_RUNTIME_PROTOCOL || r.digest !== REMOTE_HELPER_SHA256 ||
            r.platform !== 'linux' || typeof r.node !== 'string' || typeof r.arch !== 'string') {
            throw new RemoteSshError('SSH_FEATURE_UNSUPPORTED', 'remote helper protocol or checksum mismatch');
        }
        if (this.disposed || (this.generations.get(host) ?? 0) !== generation) {
            throw new RemoteSshError('SSH_FEATURE_UNSUPPORTED', 'remote host configuration changed or runtime was disposed during setup');
        }
        const view = { host, protocol: REMOTE_RUNTIME_PROTOCOL, helperHash: REMOTE_HELPER_SHA256,
            helperPath, node: r.node, platform: 'linux', arch: r.arch, verified: true };
        this.active.set(host, view);
        return view;
    }
    async invoke(host, script, method, extras) {
        const id = crypto.randomUUID();
        const request = Buffer.from(JSON.stringify({ protocol: REMOTE_RUNTIME_PROTOCOL, id, method, ...extras }), 'utf8').toString('base64url');
        const command = 'node ' + shellQuote(script) + ' ' + shellQuote(request);
        const connection = await this.manager.connection(host);
        const reply = await connection.exec(command, { timeoutMs: REMOTE_TIMEOUT, maxBytes: MAX_RESULT_BYTES });
        if (reply.code !== 0 || reply.truncated)
            throw new RemoteSshError('SSH_REMOTE_SHELL_FAILED', 'remote helper failed or output was truncated: ' + reply.stderr.slice(0, 250));
        let decoded;
        try {
            decoded = JSON.parse(reply.stdout.trim());
        }
        catch {
            throw new RemoteSshError('SSH_REMOTE_SHELL_FAILED', 'invalid remote helper response');
        }
        const record = decoded;
        if (record?.protocol !== REMOTE_RUNTIME_PROTOCOL || record.id !== id) {
            throw new RemoteSshError('SSH_REMOTE_SHELL_FAILED', 'remote helper response identity mismatch');
        }
        if (!record.ok)
            throw new RemoteSshError('SSH_REMOTE_SHELL_FAILED', 'remote helper request failed: ' + (record.error?.message || 'unknown error'));
        return record.result;
    }
    async inspect(host, remoteRoot) {
        if (!remoteRoot.startsWith('/') || remoteRoot.includes('\0')) {
            throw new RemoteSshError('SSH_PATH_INVALID', 'remote runtime cwd must be absolute');
        }
        const runtime = await this.connect(host);
        return await this.invoke(host, runtime.helperPath, 'inspect', { cwd: remoteRoot });
    }
    async ensureWeb(host, remoteRoot, installIfMissing = true) {
        if (!remoteRoot.startsWith('/') || remoteRoot.includes('\0')) {
            throw new RemoteSshError('SSH_PATH_INVALID', 'remote Web workspace must be absolute');
        }
        const runtime = await this.connect(host);
        const result = await this.invoke(host, runtime.helperPath, 'web.ensure', { cwd: remoteRoot, installIfMissing });
        if (!result || !['starting', 'ready', 'failed'].includes(result.phase)
            || !Number.isSafeInteger(result.port) || result.port < 1024 || result.port > 65535
            || result.cwd !== remoteRoot) {
            throw new RemoteSshError('SSH_REMOTE_SHELL_FAILED', 'malformed Web Host status from SSH helper');
        }
        if (result.phase === 'ready') {
            let url;
            try {
                url = new URL(result.url ?? '');
            }
            catch {
                throw new RemoteSshError('SSH_REMOTE_SHELL_FAILED', 'missing authenticated remote Web URL');
            }
            if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)
                || Number(url.port) !== result.port || !url.searchParams.has('token')) {
                throw new RemoteSshError('SSH_REMOTE_SHELL_FAILED', 'remote Web URL authority or token is untrusted');
            }
        }
        return result;
    }
    async dshVersion(host) {
        const runtime = await this.connect(host);
        return await this.invoke(host, runtime.helperPath, 'dsh.version', {});
    }
}
//# sourceMappingURL=remote-host-runtime.js.map