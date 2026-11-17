import type { IncomingMessage, ServerResponse } from 'node:http';
import { getNotebookManager } from './notebook-runtime.js';
export declare const name = "remote-ssh-notebook";
export declare const inject: string[];
export declare const MAX_NOTEBOOK_BYTES: number;
interface NotebookHost {
    get(name: string): unknown;
    logger: {
        info(message: string): void;
    };
    effect(fn: () => (() => void) | void): unknown;
}
interface NotebookDeps {
    manager: () => ReturnType<typeof getNotebookManager>;
    requestRejection(req: IncomingMessage): number | undefined;
}
export declare function createNotebookHttpHandler(deps: NotebookDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
export declare function apply(ctx: NotebookHost): void;
export {};
