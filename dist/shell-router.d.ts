import type { SshConnection } from './connection.js';
import type { RemoteSshManager } from './manager.js';
type AnyRecord = Record<string, unknown>;
export interface ShellRequest {
    command: string;
    workdir?: string;
    timeoutMs?: number;
    onExpiry?: string;
    stdoutMaxBytes?: number;
    signal?: AbortSignal;
    stdin?: string;
    env?: Record<string, string>;
    dshEnv?: Record<string, string>;
    sandboxPolicy?: unknown;
}
export interface ShellSpec extends ShellRequest {
    workdir: string;
    timeoutMs: number;
    onExpiry: 'kill' | 'none';
    stdoutMaxBytes: number;
}
export interface ShellRouterHandle {
    dispose(): void;
}
export interface ShellRouterOptions {
    allowLegacyRemoteShell?: boolean;
}
export declare function authorizeRemoteBashSpec(spec: ShellSpec): void;
/** Detect unmistakable PowerShell-only syntax before sending it to Linux. */
export declare function usesPowerShellSyntax(command: string): boolean;
/**
 * Build the exact non-interactive OpenSSH argv. `-F none` prevents user config
 * from re-introducing password prompts or a different host/port; all effective
 * values were already resolved by the plugin. Strict host-key checking uses
 * the plugin's known_hosts, which is populated only after a verified ssh2
 * handshake.
 */
export declare function buildSshArgv(connection: SshConnection, knownHostsPath: string, spec: ShellSpec): string[];
/**
 * Wrap `ctx.shell` so a virtual workdir transparently executes over SSH while
 * every local command still uses the untouched local sandbox executor.
 */
export declare function installShellRouter(ctx: {
    shell: AnyRecord;
    effect?: (fn: () => () => void) => void;
}, manager: RemoteSshManager, options?: ShellRouterOptions): ShellRouterHandle;
export {};
