import type { RemoteSshManager } from './manager.js';
import { RemoteFileSystem, type RemoteTarget } from './remote-fs.js';
type AnyRecord = Record<string, unknown>;
/** Resolve a target object to its remote coordinates, or null for local targets. */
export declare function remoteTargetOf(target: unknown): RemoteTarget | null;
export interface FsRouterHandle {
    dispose(): void;
    remoteFs: RemoteFileSystem;
}
/**
 * Wrap the live `ctx.fs` service in place. Local calls go through the original
 * sandboxed provider untouched; remote targets are served by SFTP. Keeping one
 * provider preserves DSH's sandbox and approval behavior for local work while
 * making the native read/write/edit/glob/grep tools work against remote paths.
 */
export declare function installFsRouter(ctx: {
    fs: AnyRecord;
    effect?: (fn: () => () => void) => void;
}, manager: RemoteSshManager): FsRouterHandle;
export {};
