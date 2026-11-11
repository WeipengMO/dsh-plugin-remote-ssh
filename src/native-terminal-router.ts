import type { ClientChannel } from 'ssh2';
import type { Readable } from 'node:stream';
import type { RemoteSshManager } from './manager.js';
import { looksVirtual } from './paths.js';
import { RemoteSshError } from './errors.js';

/** The subset of DSH SubprocessTerminalSpawnSpec used by its native xterm UI. */
export interface NativeTerminalSpec {
  cwd: string;
  cols: number;
  rows: number;
  terminalType: string;
  graceMs?: number;
  signal?: AbortSignal;
  argv: readonly string[];
}

type TerminalSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'SIGTSTP' | 'SIGHUP';

interface TerminalOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface NativeTerminalHandle {
  readonly pid: number;
  readonly output: Readable;
  readonly done: Promise<TerminalOutcome>;
  write(data: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  inspectForeground(): Promise<undefined>;
  inspectActivity(): Promise<{ state: 'unknown'; revision: number }>;
  signalForeground(signal: TerminalSignal): Promise<number>;
  terminate(): Promise<void>;
}

interface SubprocessProvider {
  spawnTerminal(spec: NativeTerminalSpec): Promise<NativeTerminalHandle>;
}

function bounded(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/**
 * Wrap an already authenticated ssh2 PTY in DSH's SubprocessTerminalHandle
 * contract. Native xterm receives the unmodified ANSI bytes, unlike the
 * old text-only popup that stripped VT escape sequences.
 */
export class SshNativeTerminal implements NativeTerminalHandle {
  readonly pid = 0; // SSH exec does not report a verifiable remote PID.
  readonly output: Readable;
  readonly done: Promise<TerminalOutcome>;
  private readonly channel: ClientChannel;
  private readonly abort?: AbortSignal;
  private readonly abortHandler: () => void;
  private readonly grace: number;
  private revision = 0;
  private ended = false;
  private termination?: Promise<void>;

  constructor(channel: ClientChannel, options: Pick<NativeTerminalSpec, 'graceMs' | 'signal'> = {}) {
    this.channel = channel;
    this.output = channel;
    this.grace = bounded(options.graceMs ?? 1500, 200, 10_000);
    this.abort = options.signal;
    this.abortHandler = () => { void this.terminate().catch(() => {}); };
    this.done = new Promise<TerminalOutcome>((resolve, reject) => {
      channel.once('close', (code: number | null | undefined, remoteSignal: string | undefined) => {
        this.ended = true;
        this.abort?.removeEventListener('abort', this.abortHandler);
        resolve({ exitCode: typeof code === 'number' ? code : null,
          signal: remoteSignal ? (remoteSignal.startsWith('SIG') ? remoteSignal : 'SIG' + remoteSignal) as NodeJS.Signals : null });
      });
      channel.once('error', (cause: Error) => {
        this.ended = true;
        this.abort?.removeEventListener('abort', this.abortHandler);
        reject(cause);
      });
    });
    void this.done.catch(() => {}); // keep transport loss observable to consumers
    // Do not attach a 'data' listener here: that would switch the Readable
    // into flowing mode and could discard the remote shell banner before
    // DSH's native xterm consumer is attached.
    this.abort?.addEventListener('abort', this.abortHandler, { once: true });
    if (this.abort?.aborted) this.abortHandler();
  }

  async write(data: string): Promise<void> {
    if (this.ended) throw new RemoteSshError('SSH_CHANNEL_FAILED', 'SSH terminal is closed');
    this.revision++;
    await new Promise<void>((resolve, reject) => {
      this.channel.write(data, (error?: Error | null) => error ? reject(error) : resolve());
    });
  }

  async resize(cols: number, rows: number): Promise<void> {
    if (this.ended) return;
    this.channel.setWindow(bounded(rows, 1, 200), bounded(cols, 2, 500), 0, 0);
    this.revision++;
  }

  async inspectForeground(): Promise<undefined> {
    // ssh2 does not expose the remote kernel's foreground process-group ID.
    return undefined;
  }
  async inspectActivity(): Promise<{ state: 'unknown'; revision: number }> {
    // Silence is not proof of remote idleness. Never fabricate a status.
    return { state: 'unknown', revision: this.revision };
  }
  async signalForeground(signal: TerminalSignal): Promise<number> {
    // Native xterm Ctrl-C/Ctrl-Z enter as raw PTY input and work normally.
    // DSH's foreground-signal API requires the *actual* remote PGID, which the
    // plain SSH2 protocol does not provide; failing explicitly is safer.
    throw new RemoteSshError('SSH_FEATURE_UNSUPPORTED',
      'Cannot confirm remote foreground process-group ID for ' + signal + '; use terminal Ctrl+C / Ctrl+Z');
  }

  async terminate(): Promise<void> {
    if (this.termination) return await this.termination;
    if (this.ended) return;
    this.termination = (async () => {
      try { this.channel.signal('HUP'); } catch { /* closing channel also ends the SSH PTY */ }
      try { this.channel.close(); } catch { /* channel already closed */ }
      await Promise.race([
        this.done.then(() => {}, () => {}),
        new Promise<void>((_resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new RemoteSshError('SSH_CHANNEL_FAILED',
              'SSH PTY channel did not close within the cleanup deadline'));
          }, this.grace);
          void this.done.finally(() => clearTimeout(timer)).catch(() => {});
        }),
      ]);
    })();
    return await this.termination;
  }
}

/**
 * Route DSH's EXISTING right-sidebar terminalController -> subprocess
 * spawnTerminal primitive. This preserves the native xterm tab, terminal
 * retention and session identity: only the process execution location changes.
 *
 * Dispatch is deliberately based on the provider call's cwd, not on the last
 * selected host or a global toggle. Native Windows and WSL projects are
 * byte-for-byte delegated to the original subprocess provider.
 */
export function installNativeTerminalRouter(
  runtime: SubprocessProvider,
  manager: Pick<RemoteSshManager, 'routeFor' | 'connection'>,
): { dispose(): void } {
  const original = runtime.spawnTerminal;
  if (typeof original !== 'function') throw new Error('DSH subprocess.spawnTerminal is unavailable');
  const routed = async (spec: NativeTerminalSpec): Promise<NativeTerminalHandle> => {
    if (!looksVirtual(spec.cwd)) return await original.call(runtime, spec);
    spec.signal?.throwIfAborted();
    const route = manager.routeFor(spec.cwd, spec.cwd);
    if (!route) {
      throw new RemoteSshError('SSH_WORKSPACE_UNKNOWN',
        'Remote terminal cannot map this DSH workspace to an SSH host; refusing local fallback');
    }
    const conn = await manager.connection(route.workspace.connectionId);
    const channel = await conn.terminalInDirectory(
      route.remotePath, spec.cols, spec.rows, spec.terminalType || 'xterm-256color',
    );
    if (spec.signal?.aborted) {
      channel.close();
      spec.signal.throwIfAborted();
    }
    return new SshNativeTerminal(channel, spec);
  };
  runtime.spawnTerminal = routed;
  return { dispose() { if (runtime.spawnTerminal === routed) runtime.spawnTerminal = original; } };
}
