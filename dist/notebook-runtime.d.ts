import type { RemoteSshManager } from './manager.js';
export declare function attachNotebookManager(manager: RemoteSshManager): () => void;
export declare function getNotebookManager(): RemoteSshManager | undefined;
