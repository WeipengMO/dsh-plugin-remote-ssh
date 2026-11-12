import type { RemoteSshManager } from './manager.js';
import { RemoteFileSystem } from './remote-fs.js';
interface AnyToolDefinition {
    name: string;
    execute(args: unknown, exec: unknown): Promise<unknown>;
    [key: string]: unknown;
}
/**
 * Wrap the host glob/grep definitions for agents whose cwd is remote.
 *
 * DSH's native search tools spawn a packaged ripgrep with the session cwd as
 * the child process cwd. A virtual UNC cwd is not a real directory on Windows,
 * so the spawn fails before execute() is ever reached. Registering a per-agent
 * variant through agent.ctx.tools proved unreliable (the agent context is not
 * guaranteed to expose the tools service at agent/created time), so patch the
 * shared ToolsService.view() in place -- the same seam the fs router uses for
 * ctx.fs. Shadow definitions are cached so ToolsService.resolve() keeps seeing
 * a stable object identity for the whole step.
 */
interface ToolsView {
    visible: Map<string, AnyToolDefinition>;
    registrations: Map<string, unknown>;
    knownNames: Set<string>;
    restrictableNames: Set<string>;
}
export declare function installRemoteSearchShadow(ctx: {
    tools: {
        get(name: string): unknown;
        view(scope?: unknown): ToolsView;
    };
    workingDirectory: {
        get(session: unknown): string;
        ensure(agent: unknown, signal?: AbortSignal): Promise<string>;
    };
    logger?: {
        warn(message: string): void;
    };
}, manager: RemoteSshManager, remoteFs: RemoteFileSystem): () => void;
export {};
