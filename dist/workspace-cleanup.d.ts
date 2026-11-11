import type { RemoteSshManager } from './manager.js';
type Logger = {
    warn(message: string): void;
};
type HostContext = {
    on(event: string, listener: (payload: unknown) => void, opts?: {
        global?: boolean;
    }): unknown;
};
/**
 * Track DSH workspace ID -> remote placeholder token across host restarts.
 * Workspace deletion events only carry an ID, not the deleted record's path.
 * Do not recursively remove anything: the placeholder must be empty, a direct
 * child of the plugin's reserved directory, and not a symlink.
 */
export declare function installWorkspaceCleanup(ctx: HostContext, manager: Pick<RemoteSshManager, 'workspaceByToken' | 'forgetWorkspace'>, storageDir: string, logger: Logger, options?: {
    root?: string;
    unlinkEmpty?: (p: string) => void;
    registered?: () => Array<{
        id: string;
        path: string;
    }>;
}): {
    dispose(): void;
    mappings(): Map<string, string>;
};
export {};
