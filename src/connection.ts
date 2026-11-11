import fs from 'node:fs';
import { shellQuote } from './paths.js';
import { createRequire } from 'node:module';
// The ssh2 1.17.0 pure-JS runtime is vendored to avoid pnpm's strict native build approval.
// This still provides the full SSH protocol, including SFTP and host-key checking.
const { Client } = createRequire(import.meta.url)('../vendor/ssh2/lib/index.js') as typeof import('ssh2');
import type { AuthMethod, ConnectConfig, FileEntry, PublicKeyAuthMethod, SFTPWrapper, Stats } from 'ssh2';
import { errorMessage, redactSecrets, RemoteSshError } from './errors.js';
import type { HostKeyStore, HostKeyVerification } from './known-hosts.js';
import { defaultIdentityFiles, type EffectiveSshConfig } from './ssh-config.js';
import { cloudflaredProxy } from './proxy-command.js';
import type { ConnectionState, ConnectionStatus } from './types.js';

export interface LoggerLike {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface ExecOptions {
  signal?: AbortSignal;
  maxBytes?: number;
  timeoutMs?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: string | null;
  truncated: boolean;
}

interface AuthCandidate {
  label: string;
  method: AuthMethod;
}

function isConnectionLevelError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no response from server|channel closed|connection lost|socket hang up|ECONNRESET|EPIPE|not connected|client is not connected/i.test(message);
}

/**
 * One SSH transport with strict host-key verification, keepalive, lazy
 * reconnect, and SFTP helpers. The connection object is shared by all sessions
 * and serializes reconnects.
 */
export class SshConnection {
  readonly id: string;
  readonly label: string;
  readonly config: EffectiveSshConfig;
  readonly hostKeys: HostKeyStore;
  private readonly logger: LoggerLike;
  private client: InstanceType<typeof Client> | undefined;
  private sftpWrapper: SFTPWrapper | undefined;
  private connectPromise: Promise<void> | undefined;
  private homePromise: Promise<string> | undefined;
  private verification: HostKeyVerification | undefined;
  private stateValue: ConnectionState = 'idle';
  private lastErrorValue: string | undefined;
  private connectedAtValue: string | undefined;
  private reconnectCountValue = 0;

  constructor(id: string, label: string, config: EffectiveSshConfig, hostKeys: HostKeyStore, logger: LoggerLike) {
    this.id = id;
    this.label = label;
    this.config = config;
    this.hostKeys = hostKeys;
    this.logger = logger;
  }

  get state(): ConnectionState {
    return this.stateValue;
  }

  get sftp(): SFTPWrapper {
    if (this.sftpWrapper === undefined) throw new RemoteSshError('SSH_CONNECTION_LOST', `SFTP is not open for ${this.label}`);
    return this.sftpWrapper;
  }

  verifiedHostKey(): HostKeyVerification | undefined {
    return this.verification?.trusted === true ? this.verification : undefined;
  }

  status(): ConnectionStatus {
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
  async ensure(): Promise<void> {
    if (this.stateValue === 'ready' && this.client !== undefined && this.sftpWrapper !== undefined) {
      const client = this.client;
      if (!(client as unknown as { destroyed?: boolean }).destroyed) return;
    }
    if (this.connectPromise !== undefined) return this.connectPromise;
    this.connectPromise = this.open().finally(() => {
      this.connectPromise = undefined;
    });
    return this.connectPromise;
  }

  private authCandidates(): AuthCandidate[] {
    const candidates: AuthCandidate[] = [];
    const keys = [...this.config.identityFiles, ...(this.config.identitiesOnly ? [] : defaultIdentityFiles())];
    for (const file of [...new Set(keys)]) {
      try {
        const key = fs.readFileSync(file);
        candidates.push({ label: file, method: { type: 'publickey', username: this.config.user, key } as PublicKeyAuthMethod });
      } catch {
        // Missing key files are not fatal: another configured method may work.
      }
    }
    // Offer the agent LAST. ssh2 treats an unreachable agent socket as a fatal
    // client error rather than a recoverable auth failure, so trying keys first
    // lets a working key succeed without ever touching a dead agent.
    if (this.config.useAgent) {
      const agentPath =
        this.config.identityAgent ??
        (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : process.env.SSH_AUTH_SOCK);
      // ssh2 requires an explicit agent source for an agent auth method. When
      // no agent socket is configured (POSIX without SSH_AUTH_SOCK) there is
      // nothing to offer.
      if (agentPath !== undefined) {
        // @types/ssh2 declares authHandler as AuthMethod[] (the base interface)
        // even though ssh2's agent strategy adds an `agent` field at runtime.
        const method = { type: 'agent', username: this.config.user, agent: agentPath } as unknown as AuthMethod;
        candidates.push({ label: 'ssh-agent', method });
      }
    }
    if (candidates.length === 0) {
      throw new RemoteSshError(
        'SSH_AUTH_UNAVAILABLE',
        `no SSH authentication method is available for ${this.config.user}@${this.config.hostName}: enable ssh-agent (useAgent) or configure IdentityFile in ~/.ssh/config`,
      );
    }
    return candidates;
  }

  private async open(): Promise<void> {
    this.stateValue = 'connecting';
    this.lastErrorValue = undefined;
    const candidates = this.authCandidates();
    const connectConfig: ConnectConfig = {
      host: this.config.hostName,
      port: this.config.port,
      username: this.config.user,
      readyTimeout: Math.max(1000, this.config.connectTimeoutSec * 1000),
      keepaliveInterval: Math.max(0, this.config.serverAliveIntervalSec * 1000),
      keepaliveCountMax: this.config.serverAliveCountMax,
      tryKeyboard: false,
      authHandler: candidates.map((candidate) => candidate.method),
      hostVerifier: (key: Buffer): boolean => {
        const lookupHost = this.config.hostKeyAlias ?? this.config.hostName;
        const result = this.hostKeys.verify(lookupHost, this.config.port, key);
        this.verification = result;
        return result.trusted;
      },
    };

    const client = new Client();
    this.client = client;
    let proxy: ReturnType<typeof cloudflaredProxy> | undefined;
    try {
      if (this.config.proxyCommand && this.config.proxyCommand.toLowerCase() !== 'none') {
        proxy = cloudflaredProxy(this.config.proxyCommand, this.config.hostName);
        connectConfig.sock = proxy.stream;
        // Close the proxy subprocess when the SSH connection closes, including failed auth.
        client.once('close', () => proxy?.stream.destroy());
      }
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const settle = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          fn();
        };
        client.once('ready', () => settle(resolve));
        client.once('error', (error) => settle(() => reject(this.mapConnectError(error))));
        client.once('close', () => {
          if (this.stateValue === 'ready') this.stateValue = 'closed';
          this.sftpWrapper = undefined;
          settle(() => reject(new RemoteSshError('SSH_CONNECTION_LOST', `SSH connection to ${this.label} closed during setup`)));
        });
        client.connect(connectConfig);
      });
    } catch (error) {
      this.stateValue = 'failed';
      this.lastErrorValue = errorMessage(error);
      proxy?.stream.destroy();
      try {
        client.end();
      } catch {
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
      if (this.stateValue === 'ready') this.stateValue = 'closed';
      this.sftpWrapper = undefined;
      this.homePromise = undefined;
    });

    try {
      this.sftpWrapper = await new Promise<SFTPWrapper>((resolve, reject) => {
        client.sftp((error, sftp) => {
          if (error) reject(new RemoteSshError('SSH_CHANNEL_FAILED', `cannot open SFTP on ${this.label}: ${error.message}`));
          else resolve(sftp);
        });
      });
      this.stateValue = 'ready';
      this.connectedAtValue = new Date().toISOString();
      if (this.reconnectCountValue > 0) this.reconnectCountValue += 1;
      this.verification = this.verification ?? undefined;
      this.logger.info(`remote-ssh: connected to ${this.config.user}@${this.config.hostName}:${this.config.port} (${this.label})`);
    } catch (error) {
      this.stateValue = 'failed';
      this.lastErrorValue = errorMessage(error);
      client.end();
      this.client = undefined;
      throw error;
    }
  }

  private mapConnectError(error: Error): Error {
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
        return new RemoteSshError(
          'SSH_HOST_KEY_MISMATCH',
          `HOST KEY MISMATCH for ${verification.host}:${verification.port}: presented ${verification.fingerprint} (${verification.keyType}); known ${verification.knownFingerprints.join(', ') || 'different key'}. Refusing to connect.`,
          details,
        );
      }
      if (verification.status === 'revoked') {
        return new RemoteSshError(
          'SSH_HOST_KEY_REVOKED',
          `host key for ${verification.host}:${verification.port} is marked @revoked in known_hosts; refusing to connect`,
          details,
        );
      }
      return new RemoteSshError(
        'SSH_HOST_KEY_UNKNOWN',
        `unknown host key for ${verification.host}:${verification.port}: ${verification.fingerprint} (${verification.keyType}). Verify the fingerprint with the server operator, then trust it explicitly.`,
        details,
      );
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
  invalidate(error?: unknown): void {
    if (error !== undefined) this.lastErrorValue = errorMessage(error);
    this.sftpWrapper = undefined;
    this.homePromise = undefined;
    const client = this.client;
    this.client = undefined;
    this.stateValue = 'closed';
    try {
      client?.end();
    } catch {
      // ignore
    }
  }

  async reconnect(): Promise<void> {
    this.invalidate();
    this.reconnectCountValue += 1;
    await this.ensure();
  }

  /** Run a one-shot remote command over ssh2 (used by diagnostics and search). */
  /**
   * Open a real interactive SSH PTY on the already authenticated, host-key-
   * verified connection. This is separate from DSH's local terminalController.
   */
  /**
   * Native DSH terminal: open one SSH PTY with the remote working directory
   * selected *before* the interactive shell starts. Unlike shell(), this does
   * not expose the initial local cwd nor echo a synthetic 'cd' command.
   */
  async terminalInDirectory(
    remoteCwd: string, columns = 90, rows = 25, terminalType = 'xterm-256color',
  ): Promise<import('ssh2').ClientChannel> {
    await this.ensure();
    const client = this.client;
    if (!client) throw new RemoteSshError('SSH_CONNECTION_LOST', 'SSH channel is not connected');
    if (!remoteCwd.startsWith('/') || remoteCwd.includes(String.fromCharCode(0))) {
      throw new RemoteSshError('SSH_PATH_INVALID', 'terminal cwd must be an absolute Linux path');
    }
    // DECSCUSR 6: steady vertical bar cursor in DSH's native xterm.
    // Emit it from the remote PTY before the interactive shell starts.
    const command = 'cd -- ' + shellQuote(remoteCwd) +
      ' && printf \'\\033[6 q\' && exec "${SHELL:-/bin/sh}" -i';
    return await new Promise((resolve, reject) => {
      client.exec(command, {
        pty: { term: terminalType, cols: Math.max(20, Math.min(500, columns)),
          rows: Math.max(5, Math.min(200, rows)) },
      }, (err, channel) => {
        if (err) reject(new RemoteSshError('SSH_CHANNEL_FAILED', 'cannot start SSH terminal: ' + err.message));
        else resolve(channel);
      });
    });
  }

  async shell(columns = 90, rows = 25): Promise<import('ssh2').ClientChannel> {
    await this.ensure();
    const client = this.client;
    if (!client) throw new RemoteSshError('SSH_CONNECTION_LOST', 'SSH channel is not connected');
    return await new Promise((resolve, reject) => {
      client.shell({ term: 'xterm-256color', cols: Math.min(250, Math.max(20, columns)),
        rows: Math.min(100, Math.max(5, rows)) }, (err, channel) => {
        if (err) reject(new RemoteSshError('SSH_CHANNEL_FAILED', 'failed to open SSH terminal: ' + err.message));
        else resolve(channel);
      });
    });
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    await this.ensure();
    const client = this.client;
    if (client === undefined) throw new RemoteSshError('SSH_CONNECTION_LOST', `not connected to ${this.label}`);
    const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
    return await new Promise<ExecResult>((resolve, reject) => {
      let settled = false;
      let stdout = '';
      let stderr = '';
      let truncated = false;
      let channel: { close(): void } | undefined;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };
      const closeChannel = (): void => {
        try {
          channel?.close();
        } catch {
          // ignore
        }
      };
      const onAbort = (): void => {
        closeChannel();
        finish(() => reject(new RemoteSshError('FS_ABORTED', `${command} aborted`)));
      };
      const timeout =
        options.timeoutMs !== undefined
          ? setTimeout(() => {
              closeChannel();
              finish(() => reject(new RemoteSshError('SSH_CONNECTION_TIMEOUT', `remote command timed out after ${options.timeoutMs}ms`)));
            }, options.timeoutMs)
          : undefined;
      const cleanup = (): void => {
        if (timeout !== undefined) clearTimeout(timeout);
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
        newChannel.on('data', (chunk: Buffer) => {
          if (stdout.length + chunk.length > maxBytes) {
            truncated = true;
            stdout += chunk.subarray(0, Math.max(0, maxBytes - stdout.length)).toString('utf8');
          } else stdout += chunk.toString('utf8');
        });
        newChannel.stderr.on('data', (chunk: Buffer) => {
          if (stderr.length + chunk.length > maxBytes) {
            truncated = true;
            stderr += chunk.subarray(0, Math.max(0, maxBytes - stderr.length)).toString('utf8');
          } else stderr += chunk.toString('utf8');
        });
        newChannel.on('exit', (code: number | null, signal: string | null) => {
          finish(() => resolve({ stdout, stderr, code, signal, truncated }));
        });
        newChannel.on('close', () => {
          finish(() => resolve({ stdout, stderr, code: null, signal: null, truncated }));
        });
        newChannel.on('error', (channelError: Error) => {
          finish(() => reject(new RemoteSshError('SSH_CHANNEL_FAILED', `remote command failed: ${channelError.message}`)));
        });
        if (options.signal?.aborted === true) {
          try {
            newChannel.close();
          } catch {
            // ignore
          }
        }
      });
      void stream;
    });
  }

  async remoteHome(): Promise<string> {
    if (this.homePromise === undefined) {
      this.homePromise = this.ensure()
        .then(
          () =>
            new Promise<string>((resolve, reject) => {
              this.sftp.realpath('.', (error, absolute) => {
                if (error) reject(this.mapSftpError(error, 'resolve remote home directory'));
                else resolve(absolute);
              });
            }),
        )
        .catch((error) => {
          this.homePromise = undefined;
          throw error;
        });
    }
    return this.homePromise;
  }

  mapSftpError(error: { code?: number | string; message: string }, verb: string): RemoteSshError {
    const code = typeof error.code === 'number' ? error.code : undefined;
    if (code === 2 || code === 10) return new RemoteSshError('FS_NOT_FOUND', `${verb}: not found`);
    if (code === 3) return new RemoteSshError('FS_PERMISSION_DENIED', `${verb}: permission denied`);
    if (code === 11) return new RemoteSshError('FS_ALREADY_EXISTS', `${verb}: destination already exists`);
    if (code === 4) return new RemoteSshError('SSH_IO_ERROR', `${verb}: ${error.message}`);
    return new RemoteSshError('SSH_IO_ERROR', `${verb}: ${error.message}`);
  }

  close(): void {
    this.invalidate();
    this.stateValue = 'closed';
  }

  /** True when an error means the transport, not the operation, failed. */
  static connectionLost(error: unknown): boolean {
    return isConnectionLevelError(error);
  }
}
