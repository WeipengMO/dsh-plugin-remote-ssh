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
 * Accept only non-mutating Git commands after validating every global option
 * and subcommand. Earlier versions demanded a --no-optional-locks / -c safety
 * prefix, but not every installed Forge build supplies the same prefix. This
 * incorrectly rejected even plain "git rev-parse" and "git status" reads.
 *
 * Crucially, we NEVER execute the supplied argv: the SSH runner rebuilds a
 * command with our own fixed read-only environment, hooks/fsmonitor disabled,
 * and the authenticated Linux working directory. A missing caller prefix
 * therefore cannot weaken these remote execution protections.
 *
 * DSH may wrap its executable using the native Windows ACL runner:
 * [node.exe, runner.js, ..., '--', 'C:\\...\\git.exe', ...].
 * Identify only a standalone Git executable token, not a substring in a
 * wrapper option or a project directory. -C and alternate repository root
 * selectors remain forbidden to keep reads scoped to the selected Workspace.
 */
export declare function forgeGitQuery(argv: readonly string[]): readonly string[] | null;
export declare function installNativeGitRouter(subprocess: SpawnProvider, manager: Pick<RemoteSshManager, 'routeFor' | 'connection'>, logger?: {
    info(message: string): void;
    warn?(message: string): void;
}): {
    dispose(): void;
};
export {};
