import type { ClientChannel } from 'ssh2';
import type { Readable } from 'node:stream';
import type { RemoteSshManager } from './manager.js';
/** The subset of DSH SubprocessTerminalSpawnSpec used by its native xterm UI. */
export interface NativeTerminalSpec {
    cwd: string;
    cols: number;
    rows: number;
    terminalType: string;
    graceMs?: number;
    signal?: AbortSignal;
    argv: readonly string[];
    env?: Record<string, string | undefined>;
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
    inspectActivity(): Promise<{
        state: 'unknown';
        revision: number;
    }>;
    signalForeground(signal: TerminalSignal): Promise<number>;
    terminate(): Promise<void>;
}
interface SubprocessProvider {
    spawnTerminal(spec: NativeTerminalSpec): Promise<NativeTerminalHandle>;
}
/**
 * Wrap an already authenticated ssh2 PTY in DSH's SubprocessTerminalHandle
 * contract. Native xterm receives the unmodified ANSI bytes, unlike the
 * old text-only popup that stripped VT escape sequences.
 */
export declare class SshNativeTerminal implements NativeTerminalHandle {
    readonly pid = 0;
    readonly output: Readable;
    readonly done: Promise<TerminalOutcome>;
    private readonly channel;
    private readonly abort?;
    private readonly abortHandler;
    private readonly grace;
    private revision;
    private ended;
    private termination?;
    constructor(channel: ClientChannel, options?: Pick<NativeTerminalSpec, 'graceMs' | 'signal'>);
    write(data: string): Promise<void>;
    resize(cols: number, rows: number): Promise<void>;
    inspectForeground(): Promise<undefined>;
    inspectActivity(): Promise<{
        state: 'unknown';
        revision: number;
    }>;
    signalForeground(signal: TerminalSignal): Promise<number>;
    terminate(): Promise<void>;
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
/**
 * The DSH terminal controller supplies `env.DSH_SESSION_ID` from the Agent.
 * Session ownership is independent of the *current* working directory:
 * a local session may retain an SSH placeholder cwd after a workspace switch.
 * Never start a remote shell merely because that cwd looks like our placeholder.
 */
export declare function installNativeTerminalRouter(runtime: SubprocessProvider, manager: Pick<RemoteSshManager, 'routeFor' | 'connection'>, logger?: {
    info(message: string): void;
    warn?(message: string): void;
}, sessionOrigin?: (sessionId: string) => string | undefined): {
    dispose(): void;
};
export {};
