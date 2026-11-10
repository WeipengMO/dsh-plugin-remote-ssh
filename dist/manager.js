import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SshConnection } from './connection.js';
import { RemoteSshError, errorMessage } from './errors.js';
import { HostKeyStore, sha256Fingerprint } from './known-hosts.js';
import { encodeVirtualPath, expandRemoteTilde, looksVirtual, parseVirtualPath, resolveRemotePath, workspaceToken, } from './paths.js';
import { resolveSshConfig } from './ssh-config.js';
function atomicWrite(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    try {
        fs.chmodSync(tmp, 0o600);
    }
    catch {
        // Windows best effort.
    }
    fs.renameSync(tmp, file);
}
function readJson(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    catch {
        return fallback;
    }
}
function sanitizeHost(host) {
    const trimmed = host.trim();
    if (trimmed.length === 0)
        throw new RemoteSshError('SSH_CONFIG_INVALID', 'host must not be empty');
    if (/[\s\0]/.test(trimmed))
        throw new RemoteSshError('SSH_CONFIG_INVALID', 'host must not contain whitespace or NUL');
    if (trimmed.startsWith('-'))
        throw new RemoteSshError('SSH_CONFIG_INVALID', 'host must not start with "-"');
    return trimmed;
}
/**
 * Persisted host/workspace registry and per-host connection pool.
 *
 * No field here ever contains a password, passphrase, or private key: only a
 * key path and the public host key (which is safe to display).
 */
export class RemoteSshManager {
    storageDir;
    hostsFile;
    workspacesFile;
    knownHostsPath;
    maxRecent;
    logger;
    hostsValue;
    workspacesValue;
    connections = new Map();
    stores = new Map();
    connecting = new Map();
    constructor(config, logger) {
        this.storageDir = path.resolve(config.storageDir);
        this.maxRecent = config.maxRecent ?? 20;
        this.logger = logger;
        this.hostsFile = path.join(this.storageDir, 'hosts.json');
        this.workspacesFile = path.join(this.storageDir, 'workspaces.json');
        this.knownHostsPath = path.join(this.storageDir, 'known_hosts');
        fs.mkdirSync(this.storageDir, { recursive: true, mode: 0o700 });
        this.hostsValue = undefined;
        this.workspacesValue = undefined;
    }
    hosts() {
        if (this.hostsValue === undefined) {
            const parsed = readJson(this.hostsFile, { version: 1, hosts: [] });
            this.hostsValue = Array.isArray(parsed.hosts) ? parsed.hosts : [];
        }
        return [...this.hostsValue];
    }
    getHost(id) {
        const host = this.hosts().find((entry) => entry.id === id);
        if (host === undefined)
            throw new RemoteSshError('SSH_HOST_NOT_FOUND', `unknown SSH host id: ${id}`);
        return host;
    }
    saveHosts() {
        atomicWrite(this.hostsFile, `${JSON.stringify({ version: 1, hosts: this.hosts() }, null, 2)}\n`);
    }
    addHost(input) {
        const now = new Date().toISOString();
        const host = {
            id: `h-${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`,
            label: (input.label ?? input.host).trim() || input.host,
            host: sanitizeHost(input.host),
            ...(input.port !== undefined ? { port: input.port } : {}),
            ...(input.user !== undefined ? { user: input.user } : {}),
            ...(input.identityFile !== undefined ? { identityFile: input.identityFile } : {}),
            ...(input.identityAgent !== undefined ? { identityAgent: input.identityAgent } : {}),
            ...(input.useAgent !== undefined ? { useAgent: input.useAgent } : {}),
            ...(input.useSshConfig !== undefined ? { useSshConfig: input.useSshConfig } : {}),
            ...(input.configFile !== undefined ? { configFile: input.configFile } : {}),
            ...(input.hostKeyAlias !== undefined ? { hostKeyAlias: input.hostKeyAlias } : {}),
            createdAt: now,
            updatedAt: now,
        };
        this.validateHost(host);
        this.hostsValue = [...this.hosts(), host];
        this.saveHosts();
        return host;
    }
    updateHost(id, patch) {
        const current = this.getHost(id);
        const next = {
            ...current,
            ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined && value !== null)),
            id: current.id,
            createdAt: current.createdAt,
            updatedAt: new Date().toISOString(),
        };
        for (const [key, value] of Object.entries(patch)) {
            if (value === null && key !== 'host' && key !== 'label')
                delete next[key];
        }
        next.host = sanitizeHost(next.host);
        this.validateHost(next);
        this.hostsValue = this.hosts().map((entry) => (entry.id === id ? next : entry));
        this.saveHosts();
        this.disconnect(id);
        return next;
    }
    removeHost(id) {
        this.getHost(id);
        this.disconnect(id);
        this.hostsValue = this.hosts().filter((entry) => entry.id !== id);
        this.saveHosts();
        const workspaces = this.loadWorkspaces();
        workspaces.workspaces = workspaces.workspaces.filter((entry) => entry.connectionId !== id);
        this.saveWorkspaces(workspaces);
    }
    validateHost(host) {
        if (host.port !== undefined && (!Number.isSafeInteger(host.port) || host.port <= 0 || host.port > 65535)) {
            throw new RemoteSshError('SSH_CONFIG_INVALID', `invalid port: ${host.port}`);
        }
        if (host.user !== undefined && !/^[^\s@]+$/.test(host.user)) {
            throw new RemoteSshError('SSH_CONFIG_INVALID', `invalid SSH user: ${host.user}`);
        }
        if (host.identityFile !== undefined && host.identityFile.trim().length === 0) {
            throw new RemoteSshError('SSH_CONFIG_INVALID', 'identityFile must not be empty');
        }
        // Validate config semantics now rather than at first use.
        resolveSshConfig(host);
    }
    /** Effective config for a stored host; throws without connecting. */
    effectiveConfig(id) {
        const host = this.getHost(id);
        return resolveSshConfig(host);
    }
    hostKeyStore(id, config) {
        const existing = this.stores.get(id);
        if (existing !== undefined) {
            existing.setUserKnownHostsFiles(config.userKnownHostsFiles);
            return existing;
        }
        const store = new HostKeyStore(this.storageDir, config.userKnownHostsFiles);
        this.stores.set(id, store);
        return store;
    }
    async connection(id) {
        const ready = this.connections.get(id);
        if (ready !== undefined && ready.state === 'ready')
            return ready;
        const pending = this.connecting.get(id);
        if (pending !== undefined)
            return pending;
        const promise = (async () => {
            const host = this.getHost(id);
            const config = resolveSshConfig(host);
            const existing = this.connections.get(id);
            const connection = existing !== undefined && existing.config.hostName === config.hostName && existing.config.port === config.port
                ? existing
                : new SshConnection(id, host.label, config, this.hostKeyStore(id, config), this.logger);
            this.connections.set(id, connection);
            await connection.ensure();
            return connection;
        })().finally(() => {
            this.connecting.delete(id);
        });
        this.connecting.set(id, promise);
        return promise;
    }
    connectionIfReady(id) {
        const connection = this.connections.get(id);
        return connection !== undefined && connection.state === 'ready' ? connection : undefined;
    }
    disconnect(id) {
        this.connections.get(id)?.close();
        this.connections.delete(id);
    }
    closeAll() {
        for (const connection of this.connections.values())
            connection.close();
        this.connections.clear();
        this.connecting.clear();
    }
    statuses() {
        return this.hosts().map((host) => {
            const connection = this.connections.get(host.id);
            if (connection !== undefined)
                return connection.status();
            try {
                const config = resolveSshConfig(host);
                return {
                    id: host.id,
                    label: host.label,
                    state: 'idle',
                    hostName: config.hostName,
                    port: config.port,
                    user: config.user,
                    reconnectCount: 0,
                };
            }
            catch (error) {
                return {
                    id: host.id,
                    label: host.label,
                    state: 'failed',
                    hostName: host.host,
                    port: host.port ?? 22,
                    user: host.user ?? '',
                    lastError: errorMessage(error),
                    reconnectCount: 0,
                };
            }
        });
    }
    async test(id) {
        try {
            const connection = await this.connection(id);
            const result = await connection.exec("printf 'remote-ssh-ok\\n'; pwd; uname -s 2>/dev/null || true", { timeoutMs: 15000 });
            if (result.code !== 0) {
                return {
                    ok: false,
                    code: 'SSH_REMOTE_SHELL_FAILED',
                    message: result.stderr.trim() || `remote command exited with ${result.code ?? 'unknown'}`,
                    status: connection.status(),
                };
            }
            return { ok: true, status: connection.status(), details: { output: result.stdout.trim() } };
        }
        catch (error) {
            return {
                ok: false,
                code: error.code ?? 'SSH_CONNECT_FAILED',
                message: errorMessage(error),
                details: error.details,
                ...(this.connections.get(id) !== undefined ? { status: this.connections.get(id).status() } : {}),
            };
        }
    }
    trustHostKey(id, hostKeyBase64, fingerprint) {
        const host = this.getHost(id);
        const config = resolveSshConfig(host);
        const store = this.hostKeyStore(id, config);
        const blob = Buffer.from(hostKeyBase64, 'base64');
        if (blob.length === 0)
            throw new RemoteSshError('SSH_HOST_KEY_UNKNOWN', 'hostKey must be a base64 SSH public key blob');
        const computed = sha256Fingerprint(blob);
        if (computed !== fingerprint) {
            throw new RemoteSshError('SSH_HOST_KEY_MISMATCH', `fingerprint mismatch: presented key is ${computed}, expected ${fingerprint}`);
        }
        store.trust(config.hostKeyAlias ?? config.hostName, config.port, blob, fingerprint);
        return { host: config.hostKeyAlias ?? config.hostName, port: config.port, fingerprint };
    }
    untrustHostKey(id) {
        const host = this.getHost(id);
        const config = resolveSshConfig(host);
        return this.hostKeyStore(id, config).remove(config.hostKeyAlias ?? config.hostName, config.port);
    }
    knownHostKey(id) {
        return this.connectionIfReady(id)?.verifiedHostKey();
    }
    loadWorkspaces() {
        if (this.workspacesValue === undefined) {
            const parsed = readJson(this.workspacesFile, { version: 1, workspaces: [], recent: [] });
            this.workspacesValue = {
                version: 1,
                workspaces: Array.isArray(parsed.workspaces) ? parsed.workspaces : [],
                recent: Array.isArray(parsed.recent) ? parsed.recent : [],
            };
        }
        return this.workspacesValue;
    }
    saveWorkspaces(value) {
        this.workspacesValue = value;
        atomicWrite(this.workspacesFile, `${JSON.stringify(value, null, 2)}\n`);
    }
    workspaces() {
        return [...this.loadWorkspaces().workspaces];
    }
    recent() {
        return [...this.loadWorkspaces().recent];
    }
    workspaceByToken(token) {
        const workspace = this.loadWorkspaces().workspaces.find((entry) => entry.token === token);
        if (workspace === undefined) {
            throw new RemoteSshError('SSH_WORKSPACE_UNKNOWN', `remote workspace ${token} is not registered; reopen it with remote_workspace_open (this is not a local path)`);
        }
        return workspace;
    }
    rememberWorkspace(workspace) {
        const file = this.loadWorkspaces();
        const workspaces = file.workspaces.filter((entry) => entry.token !== workspace.token);
        workspaces.push(workspace);
        const recent = [
            { connectionId: workspace.connectionId, hostLabel: workspace.hostLabel, remoteRoot: workspace.remoteRoot, openedAt: new Date().toISOString() },
            ...file.recent.filter((entry) => !(entry.connectionId === workspace.connectionId && entry.remoteRoot === workspace.remoteRoot)),
        ].slice(0, this.maxRecent);
        this.saveWorkspaces({ version: 1, workspaces, recent });
    }
    async openWorkspace(hostId, inputPath) {
        const host = this.getHost(hostId);
        const connection = await this.connection(hostId);
        const homeDir = await connection.remoteHome();
        const requested = inputPath === undefined || inputPath.trim().length === 0 ? homeDir : inputPath.trim();
        const expanded = expandRemoteTilde(requested, homeDir);
        if (/^[A-Za-z]:[\\/]/.test(expanded)) {
            throw new RemoteSshError('SSH_PATH_INVALID', `Windows path ${expanded} is not valid on the remote host; use a POSIX path`);
        }
        const remotePath = expanded.startsWith('/') ? path.posix.normalize(expanded) : path.posix.normalize(path.posix.join(homeDir, expanded));
        const info = await new Promise((resolve, reject) => {
            connection.sftp.stat(remotePath, (error, stats) => {
                if (error)
                    reject(connection.mapSftpError(error, `cannot open ${remotePath}`));
                else
                    resolve(stats);
            });
        });
        if (!info.isDirectory())
            throw new RemoteSshError('SSH_NOT_DIRECTORY', `${remotePath} is not a directory on ${host.label}`);
        const canonicalRoot = await new Promise((resolve, reject) => {
            connection.sftp.realpath(remotePath, (error, resolved) => {
                if (error)
                    reject(connection.mapSftpError(error, `cannot resolve ${remotePath}`));
                else
                    resolve(resolved);
            });
        });
        const token = workspaceToken(host.id, canonicalRoot);
        const now = new Date().toISOString();
        const workspace = {
            token,
            connectionId: host.id,
            hostLabel: host.label,
            remoteRoot: canonicalRoot,
            remoteHome: homeDir,
            createdAt: this.loadWorkspaces().workspaces.find((entry) => entry.token === token)?.createdAt ?? now,
            lastOpenedAt: now,
        };
        this.rememberWorkspace(workspace);
        return { workspace, virtualPath: encodeVirtualPath(token, canonicalRoot), status: connection.status() };
    }
    /** Synchronously identify the workspace for an fs request without touching the network. */
    routeFor(pathValue, cwd) {
        const parsedPath = parseVirtualPath(pathValue);
        if (parsedPath !== null) {
            const workspace = this.workspaceByToken(parsedPath.workspaceToken);
            const virtualPath = encodeVirtualPath(workspace.token, parsedPath.remotePath);
            return { workspace, remotePath: parsedPath.remotePath, virtualPath, targetKey: `ssh:${workspace.token}:${parsedPath.remotePath}` };
        }
        if (!looksVirtual(cwd))
            return null;
        const parsedCwd = parseVirtualPath(cwd);
        if (parsedCwd === null)
            return null;
        const workspace = this.workspaceByToken(parsedCwd.workspaceToken);
        const remotePath = resolveRemotePath(pathValue, parsedCwd.remotePath, workspace.remoteHome, workspace.token);
        const virtualPath = encodeVirtualPath(workspace.token, remotePath);
        return { workspace, remotePath, virtualPath, targetKey: `ssh:${workspace.token}:${remotePath}` };
    }
    async resolveRoute(pathValue, cwd) {
        const route = this.routeFor(pathValue, cwd);
        if (route === null)
            return null;
        const connection = await this.connection(route.workspace.connectionId);
        return { ...route, connection, homeDir: route.workspace.remoteHome };
    }
    async ensureKnownHostsFile(connection) {
        try {
            fs.accessSync(this.knownHostsPath, fs.constants.R_OK);
        }
        catch {
            connection.hostKeys.writeKnownHostsFile();
        }
        return this.knownHostsPath;
    }
}
//# sourceMappingURL=manager.js.map