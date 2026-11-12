import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RemoteSshManager } from './manager.js';
import { type WorkspaceRegistry } from './workspace-registration.js';
import type { RemoteTerminalPool } from './remote-terminal.js';
export interface AgentRef {
    id: string;
    session: {
        id?: string;
        header?: {
            id?: string;
            cwd?: string;
        };
    };
}
export interface WorkingDirectoryService {
    get(session: AgentRef['session']): string;
    set(agent: AgentRef, value: string, signal?: AbortSignal): Promise<string>;
}
export interface NativeApiDeps {
    manager: RemoteSshManager;
    workingDirectory: WorkingDirectoryService;
    /** Active agent instances, populated via the global agent/created hook. */
    agents: Map<string, AgentRef>;
    /** Local directory from before the first remote activation per session. */
    previousCwd: Map<string, string>;
    /** Native DSH project registry; optional when only the built-in project picker is available. */
    workspaceRegistry?: WorkspaceRegistry | (() => WorkspaceRegistry | undefined);
    remoteTerminals?: RemoteTerminalPool;
    /** DSH Connection's signed-cookie and Host/Origin admission, fail closed. */
    requestRejection(req: IncomingMessage): number | undefined;
}
/** DSH emits agent/created as {agent}; older hooks may provide the agent directly. */
export declare function agentFromCreatedEvent(event: unknown): AgentRef | undefined;
export declare function createNativeHttpHandler(deps: NativeApiDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
