import type { RemoteSshManager } from './manager.js';
interface SpawnSpec {
    argv: readonly string[];
    cwd: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    stdio: {
        stdin: unknown;
        stdout: unknown;
        stderr: unknown;
    };
}
interface SpawnProvider {
    spawn(spec: SpawnSpec): unknown;
}
/**
 * Only native Forge's safety-prefixed, non-mutating Git probe shape is allowed.
 *
 * DSH releases differ in how many global options they prepend and in what order
 * (extra `-c` pairs, `-ccore.quotepath=false`, `--literal-pathspecs`, ...), so
 * validate the *kind* of each leading option instead of a fixed five-argument
 * prefix. At least one safety marker is still required -- a bare `git status`
 * must never be routed to the SSH host. `-C <dir>` is refused on purpose: the
 * remote command already `cd`s into the mapped repository, and a local/virtual
 * path would point git somewhere meaningless (or outside the workspace).
 */
export declare function forgeGitQuery(argv: readonly string[]): readonly string[] | null;
export declare function installNativeGitRouter(subprocess: SpawnProvider, manager: Pick<RemoteSshManager, 'routeFor' | 'connection'>, logger?: {
    info(message: string): void;
    warn?(message: string): void;
}): {
    dispose(): void;
};
export {};
