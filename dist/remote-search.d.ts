import type { RemoteSshManager } from './manager.js';
import { RemoteFileSystem } from './remote-fs.js';
interface AnyToolDefinition {
    name: string;
    execute(args: unknown, exec: unknown): Promise<unknown>;
    [key: string]: unknown;
}
/**
 * Register per-agent `glob`/`grep` shadows. Local calls delegate to the native
 * definition unchanged; remote calls use SFTP walking so the remote host needs
 * neither ripgrep nor a special shell. This is the only reliable seam because
 * the native search tools spawn a host-packaged ripgrep directly.
 */
export declare function installRemoteSearchShadow(ctx: {
    tools: {
        get(name: string): unknown;
        register(definition: AnyToolDefinition, options?: unknown): unknown;
    };
    workingDirectory: {
        ensure(agent: unknown, signal?: AbortSignal): Promise<string>;
    };
    on(event: string, listener: (payload: {
        agent: any;
    }) => unknown, options?: {
        global?: boolean;
    }): unknown;
    logger?: {
        warn(message: string): void;
    };
}, manager: RemoteSshManager, remoteFs: RemoteFileSystem): () => void;
export {};
