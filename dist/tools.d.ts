import { type ShellRequest, type ShellSpec } from './shell-router.js';
import type { RemoteSshManager } from './manager.js';
import { RemoteFileSystem } from './remote-fs.js';
interface ToolContext {
    tools: {
        register(definition: unknown, options?: {
            when?: (selection: {
                agent?: {
                    session?: unknown;
                };
            }) => boolean;
        }): unknown;
    };
    workingDirectory: {
        get(session: unknown): string;
        set(agent: unknown, path: string, signal?: AbortSignal): Promise<string>;
        ensure(agent: unknown, signal?: AbortSignal): Promise<string>;
    };
    shell?: {
        sandboxMode?: string;
        resolve(request: ShellRequest): ShellSpec;
        execute(spec: ShellSpec): Promise<{
            result(): Promise<{
                exitCode?: number | null;
                stdout?: {
                    text?: string;
                    truncated?: boolean;
                };
                stderr?: {
                    text?: string;
                    truncated?: boolean;
                };
                aborted?: boolean;
                timedOut?: boolean;
            }>;
        }>;
    };
    systemPrompt?: {
        section(definition: {
            name: string;
            order: number;
            text: string | ((context: {
                agent?: {
                    session?: unknown;
                };
            }) => string);
        }): unknown;
    };
    logger?: {
        warn(message: string): void;
        info?(message: string): void;
    };
    get?(name: string): unknown;
    on?(event: string, listener: (payload: unknown) => unknown, options?: {
        global?: boolean;
    }): unknown;
}
/**
 * Register the remote workspace management surface. These tools are the
 * explicit entry points for host setup, diagnostics, workspace switching and
 * directory browsing; the native read/write/edit/glob/grep/bash tools then work
 * transparently against the selected virtual cwd.
 */
export declare function registerManagementTools(ctx: ToolContext, manager: RemoteSshManager, remoteFs: RemoteFileSystem): void;
/** Remote-only metadata supplied by the resolved workspace, not by the model. */
export interface RemoteWorkspaceGuidance {
    remoteCwd: string;
    remoteRoot: string;
    remoteHome: string;
}
/** A remote-only shell hint avoids wasting tokens on local DSH sessions. */
export declare function remoteWorkspaceShellGuidance(cwd: string, paths?: RemoteWorkspaceGuidance): string;
/**
 * A model-facing Bash tool for remote SSH workspaces.
 *
 * The local DSH shell sandbox confines the local SSH client process, NOT
 * the remote Bash process. Rather than pretend that the remote program is
 * locally sandboxed, require explicit consent to the unrestricted SSH
 * capability (once per Agent/workspace by default) and fail closed when
 * the effective DSH session policy is read-only.
 */
export type RemoteBashApprovalMode = 'session' | 'command' | 'off';
export declare function registerRemoteBashTool(ctx: ToolContext, manager: RemoteSshManager, approvalMode?: RemoteBashApprovalMode): void;
/**
 * Hide native bash (macOS/Linux) and pwsh (Windows) for remote Agents only.
 * Local Agent shells are restored on cwd changes; execution stays fail-closed
 * on older hosts without Agent-scoped tool restriction support.
 */
export declare function installRemoteShellScope(ctx: ToolContext): () => void;
export {};
