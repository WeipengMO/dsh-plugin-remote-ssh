import type { RemoteSshManager } from './manager.js';
import { RemoteFileSystem } from './remote-fs.js';
interface ToolContext {
    tools: {
        register(definition: unknown): unknown;
    };
    workingDirectory: {
        get(session: unknown): string;
        set(agent: unknown, path: string, signal?: AbortSignal): Promise<string>;
        ensure(agent: unknown, signal?: AbortSignal): Promise<string>;
    };
    systemPrompt?: {
        section(definition: {
            name: string;
            order: number;
            text: string;
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
export {};
