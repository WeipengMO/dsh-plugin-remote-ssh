import fs from 'node:fs';
import { createRequire } from 'node:module';
// The ssh2 1.17.0 pure-JS runtime is vendored to avoid pnpm's strict native build approval.
// This still provides the full SSH protocol, including SFTP and host-key checking.
const { Client } = createRequire(import.meta.url)('../vendor/ssh2/lib/index.js');
import { errorMessage, redactSecrets, RemoteSshError } from './errors.js';
import { defaultIdentityFiles } from './ssh-config.js';
import { cloudflaredProxy } from './proxy-command.js';
function isConnectionLevelError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return /no response from server|channel closed|connection lost|socket hang up|ECONNRESET|EPIPE|not connected|client is not connected/i.test(message);
}
/**
 * One SSH transport with strict host-key verification, keepalive, lazy
 * reconnect, and SFTP helpers. The connection object is shared by all sessions
 * and serializes reconnects.
 */
export class SshConnection {
    id;
    label;
    config;
    hostKeys;
    logger;
    client;
    sftpWrapper;
    connectPromise;
    homePromise;
    verification;
    stateValue = 'idle';
    lastErrorValue;
    connectedAtValue;
    reconnectCountValue = 0;
    constructor(id, label, config, hostKeys, logger) {
        this.id = id;
        this.label = label;
        this.config = config;
        this.hostKeys = hostKeys;
        this.logger = logger;
    }
    get state() {
        return this.stateValue;
    }
    get sftp() {
        if (this.sftpWrapper === undefined)
            throw new RemoteSshError('SSH_CONNECTION_LOST', `SFTP is not open for ${this.label}`);
        return this.sftpWrapper;
    }
    verifiedHostKey() {
        return this.verification?.trusted === true ? this.verification : undefined;
    }
    status() {
        return {
            id: this.id,
            label: this.label,
            state: this.stateValue,
            hostName: this.config.hostName,
            port: this.config.port,
            user: this.config.user,
            ...(this.connectedAtValue !== undefined ? { connectedAt: this.connectedAtValue } : {}),
            ...(this.lastErrorValue !== undefined ? { lastError: this.lastErrorValue } : {}),
            reconnectCount: this.reconnectCountValue,
            ...(this.verification?.trusted === true ? { trustedFingerprint: this.verification.fingerprint } : {}),
        };
    }
    /** Ensure a live transport. Concurrent callers share one connect attempt. */
    async ensure() {
        if (this.stateValue === 'ready' && this.client !== undefined && this.sftpWrapper !== undefined) {
            const client = this.client;
            if (!client.destroyed)
                return;
        }
        if (this.connectPromise !== undefined)
            return this.connectPromise;
        this.connectPromise = this.open().finally(() => {
            this.connectPromise = undefined;
        });
        return this.connectPromise;
    }
    authCandidates() {
        const candidates = [];
        const keys = [...this.config.identityFiles, ...(this.config.identitiesOnly ? [] : defaultIdentityFiles())];
        for (const file of [...new Set(keys)]) {
            try {
                const key = fs.readFileSync(file);
                candidates.push({ label: file, method: { type: 'publickey', username: this.config.user, key } });
            }
            catch {
                // Missing key files are not fatal: another configured method may work.
            }
        }
        // Offer the agent LAST. ssh2 treats an unreachable agent socket as a fatal
        // client error rather than a recoverable auth failure, so trying keys first
        // lets a working key succeed without ever touching a dead agent.
        if (this.config.useAgent) {
            const agentPath = this.config.identityAgent ??
                (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : process.env.SSH_AUTH_SOCK);
            // ssh2 requires an explicit agent source for an agent auth method. When
            // no agent socket is configured (POSIX without SSH_AUTH_SOCK) there is
            // nothing to offer.
            if (agentPath !== undefined) {
                // @types/ssh2 declares authHandler as AuthMethod[] (the base interface)
                // even though ssh2's agent strategy adds an `agent` field at runtime.
                const method = { type: 'agent', username: this.config.user, agent: agentPath };
                candidates.push({ label: 'ssh-agent', method });
            }
        }
        if (candidates.length === 0) {
            throw new RemoteSshError('SSH_AUTH_UNAVAILABLE', `no SSH authentication method is available for ${this.config.user}@${this.config.hostName}: enable ssh-agent (useAgent) or configure IdentityFile in ~/.ssh/config`);
        }
        return candidates;
    }
    async open() {
        this.stateValue = 'connecting';
        this.lastErrorValue = undefined;
        const candidates = this.authCandidates();
        const connectConfig = {
            host: this.config.hostName,
            port: this.config.port,
            username: this.config.user,
            readyTimeout: Math.max(1000, this.config.connectTimeoutSec * 1000),
            keepaliveInterval: Math.max(0, this.config.serverAliveIntervalSec * 1000),
            keepaliveCountMax: this.config.serverAliveCountMax,
            tryKeyboard: false,
            authHandler: candidates.map((candidate) => candidate.method),
            hostVerifier: (key) => {
                const lookupHost = this.config.hostKeyAlias ?? this.config.hostName;
                const result = this.hostKeys.verify(lookupHost, this.config.port, key);
                this.verification = result;
                return result.trusted;
            },
        };
        const client = new Client();
        this.client = client;
        let proxy;
        try {
            if (this.config.proxyCommand && this.config.proxyCommand.toLowerCase() !== 'none') {
                proxy = cloudflaredProxy(this.config.proxyCommand, this.config.hostName);
                connectConfig.sock = proxy.stream;
                // Close the proxy subprocess when the SSH connection closes, including failed auth.
                client.once('close', () => proxy?.stream.destroy());
            }
            await new Promise((resolve, reject) => {
                let settled = false;
                const settle = (fn) => {
                    if (settled)
                        return;
                    settled = true;
                    fn();
                };
                client.once('ready', () => settle(resolve));
                client.once('error', (error) => settle(() => reject(this.mapConnectError(error))));
                client.once('close', () => {
                    if (this.stateValue === 'ready')
                        this.stateValue = 'closed';
                    this.sftpWrapper = undefined;
                    settle(() => reject(new RemoteSshError('SSH_CONNECTION_LOST', `SSH connection to ${this.label} closed during setup`)));
                });
                client.connect(connectConfig);
            });
        }
        catch (error) {
            this.stateValue = 'failed';
            this.lastErrorValue = errorMessage(error);
            proxy?.stream.destroy();
            try {
                client.end();
            }
            catch {
                // ignore
            }
            this.client = undefined;
            throw error;
        }
        client.on('error', (error) => {
            this.lastErrorValue = errorMessage(error);
            this.logger.warn(`remote-ssh: ${this.label}: ${this.lastErrorValue}`);
        });
        client.on('close', () => {
            if (this.stateValue === 'ready')
                this.stateValue = 'closed';
            this.sftpWrapper = undefined;
            this.homePromise = undefined;
        });
        try {
            this.sftpWrapper = await new Promise((resolve, reject) => {
                client.sftp((error, sftp) => {
                    if (error)
                        reject(new RemoteSshError('SSH_CHANNEL_FAILED', `cannot open SFTP on ${this.label}: ${error.message}`));
                    else
                        resolve(sftp);
                });
            });
            this.stateValue = 'ready';
            this.connectedAtValue = new Date().toISOString();
            if (this.reconnectCountValue > 0)
                this.reconnectCountValue += 1;
            this.verification = this.verification ?? undefined;
            this.logger.info(`remote-ssh: connected to ${this.config.user}@${this.config.hostName}:${this.config.port} (${this.label})`);
        }
        catch (error) {
            this.stateValue = 'failed';
            this.lastErrorValue = errorMessage(error);
            client.end();
            this.client = undefined;
            throw error;
        }
    }
    mapConnectError(error) {
        const verification = this.verification;
        if (verification !== undefined && !verification.trusted) {
            const details = {
                host: verification.host,
                port: verification.port,
                keyType: verification.keyType,
                fingerprint: verification.fingerprint,
                knownFingerprints: verification.knownFingerprints,
                hostKey: verification.keyBase64,
                hostKeyFile: this.hostKeys.knownHostsPath,
            };
            if (verification.status === 'mismatch') {
                return new RemoteSshError('SSH_HOST_KEY_MISMATCH', `HOST KEY MISMATCH for ${verification.host}:${verification.port}: presented ${verification.fingerprint} (${verification.keyType}); known ${verification.knownFingerprints.join(', ') || 'different key'}. Refusing to connect.`, details);
            }
            if (verification.status === 'revoked') {
                return new RemoteSshError('SSH_HOST_KEY_REVOKED', `host key for ${verification.host}:${verification.port} is marked @revoked in known_hosts; refusing to connect`, details);
            }
            return new RemoteSshError('SSH_HOST_KEY_UNKNOWN', `unknown host key for ${verification.host}:${verification.port}: ${verification.fingerprint} (${verification.keyType}). Verify the fingerprint with the server operator, then trust it explicitly.`, details);
        }
        const message = redactSecrets(error.message);
        if (/authentication methods failed|authentication failed|All configured authentication/i.test(message)) {
            return new RemoteSshError('SSH_AUTH_FAILED', `SSH authentication failed for ${this.config.user}@${this.config.hostName}: ${message}`);
        }
        if (/timed out|timeout/i.test(message)) {
            return new RemoteSshError('SSH_CONNECT_TIMEOUT', `SSH connection to ${this.config.hostName}:${this.config.port} timed out: ${message}`);
        }
        return new RemoteSshError('SSH_CONNECT_FAILED', `SSH connection to ${this.config.hostName}:${this.config.port} failed: ${message}`);
    }
    /** Mark a broken transport and force the next ensure() to reconnect. */
    invalidate(error) {
        if (error !== undefined)
            this.lastErrorValue = errorMessage(error);
        this.sftpWrapper = undefined;
        this.homePromise = undefined;
        const client = this.client;
        this.client = undefined;
        this.stateValue = 'closed';
        try {
            client?.end();
        }
        catch {
            // ignore
        }
    }
    async reconnect() {
        this.invalidate();
        this.reconnectCountValue += 1;
        await this.ensure();
    }
    /** Run a one-shot remote command over ssh2 (used by diagnostics and search). */
    async exec(command, options = {}) {
        await this.ensure();
        const client = this.client;
        if (client === undefined)
            throw new RemoteSshError('SSH_CONNECTION_LOST', `not connected to ${this.label}`);
        const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
        return await new Promise((resolve, reject) => {
            let settled = false;
            let stdout = '';
            let stderr = '';
            let truncated = false;
            let channel;
            const finish = (fn) => {
                if (settled)
                    return;
                settled = true;
                cleanup();
                fn();
            };
            const closeChannel = () => {
                try {
                    channel?.close();
                }
                catch {
                    // ignore
                }
            };
            const onAbort = () => {
                closeChannel();
                finish(() => reject(new RemoteSshError('FS_ABORTED', `${command} aborted`)));
            };
            const timeout = options.timeoutMs !== undefined
                ? setTimeout(() => {
                    closeChannel();
                    finish(() => reject(new RemoteSshError('SSH_CONNECTION_TIMEOUT', `remote command timed out after ${options.timeoutMs}ms`)));
                }, options.timeoutMs)
                : undefined;
            const cleanup = () => {
                if (timeout !== undefined)
                    clearTimeout(timeout);
                options.signal?.removeEventListener('abort', onAbort);
            };
            options.signal?.addEventListener('abort', onAbort, { once: true });
            if (options.signal?.aborted === true) {
                onAbort();
                return;
            }
            const stream = client.exec(command, { env: {} }, (error, newChannel) => {
                if (error) {
                    finish(() => reject(new RemoteSshError('SSH_CHANNEL_FAILED', `cannot exec on ${this.label}: ${error.message}`)));
                    return;
                }
                channel = newChannel;
                newChannel.on('data', (chunk) => {
                    if (stdout.length + chunk.length > maxBytes) {
                        truncated = true;
                        stdout += chunk.subarray(0, Math.max(0, maxBytes - stdout.length)).toString('utf8');
                    }
                    else
                        stdout += chunk.toString('utf8');
                });
                newChannel.stderr.on('data', (chunk) => {
                    if (stderr.length + chunk.length > maxBytes) {
                        truncated = true;
                        stderr += chunk.subarray(0, Math.max(0, maxBytes - stderr.length)).toString('utf8');
                    }
                    else
                        stderr += chunk.toString('utf8');
                });
                newChannel.on('exit', (code, signal) => {
                    finish(() => resolve({ stdout, stderr, code, signal, truncated }));
                });
                newChannel.on('close', () => {
                    finish(() => resolve({ stdout, stderr, code: null, signal: null, truncated }));
                });
                newChannel.on('error', (channelError) => {
                    finish(() => reject(new RemoteSshError('SSH_CHANNEL_FAILED', `remote command failed: ${channelError.message}`)));
                });
                if (options.signal?.aborted === true) {
                    try {
                        newChannel.close();
                    }
                    catch {
                        // ignore
                    }
                }
            });
            void stream;
        });
    }
    async remoteHome() {
        if (this.homePromise === undefined) {
            this.homePromise = this.ensure()
                .then(() => new Promise((resolve, reject) => {
                this.sftp.realpath('.', (error, absolute) => {
                    if (error)
                        reject(this.mapSftpError(error, 'resolve remote home directory'));
                    else
                        resolve(absolute);
                });
            }))
                .catch((error) => {
                this.homePromise = undefined;
                throw error;
            });
        }
        return this.homePromise;
    }
    mapSftpError(error, verb) {
        const code = typeof error.code === 'number' ? error.code : undefined;
        if (code === 2 || code === 10)
            return new RemoteSshError('FS_NOT_FOUND', `${verb}: not found`);
        if (code === 3)
            return new RemoteSshError('FS_PERMISSION_DENIED', `${verb}: permission denied`);
        if (code === 11)
            return new RemoteSshError('FS_ALREADY_EXISTS', `${verb}: destination already exists`);
        if (code === 4)
            return new RemoteSshError('SSH_IO_ERROR', `${verb}: ${error.message}`);
        return new RemoteSshError('SSH_IO_ERROR', `${verb}: ${error.message}`);
    }
    close() {
        this.invalidate();
        this.stateValue = 'closed';
    }
    /** True when an error means the transport, not the operation, failed. */
    static connectionLost(error) {
        return isConnectionLevelError(error);
    }
}
//# sourceMappingURL=connection.js.map