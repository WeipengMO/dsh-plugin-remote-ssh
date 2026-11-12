import type { ShellRequest, ShellSpec } from './shell-router.js';
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
        resolve(request: ShellRequest): ShellSpec;
        execute(spec: ShellSpec): Promise<{
            result(): Promise<{
                exitCode?: number | null;
                stdout?: { text?: string };
                stderr?: { text?: string };
                aborted?: boolean;
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
/** A remote-only shell hint avoids wasting tokens on local DSH sessions. */
export declare function remoteWorkspaceShellGuidance(cwd: string): string;
/** Register the model-facing remote Linux Bash tool for SSH Agent sessions only. */
export declare function registerRemoteBashTool(ctx: ToolContext, manager: RemoteSshManager): void;
/** Hide native Windows pwsh in remote Agent scopes; restore it on local workspace switch. */
export declare function installRemoteShellScope(ctx: ToolContext): () => void;
export {};
