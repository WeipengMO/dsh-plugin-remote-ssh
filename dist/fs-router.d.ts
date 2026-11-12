import type { RemoteSshManager } from './manager.js';
import { RemoteFileSystem, type RemoteTarget } from './remote-fs.js';
type AnyRecord = Record<string, unknown>;
/**
 * An absolute *host* path is never a remote path, even when the current cwd
 * is virtual. DSH workingDirectory.set() resolves every requested path with
 * a cwd option pointing at the current virtual directory; without this
 * escape hatch, local paths used by close/cd/recovery would be routed into
 * the SFTP resolver, which rejects Windows paths and makes a remote session
 * impossible to leave.
 */
export declare function isAbsoluteLocalPath(value: string, cwd?: string, platform?: string): boolean;
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
