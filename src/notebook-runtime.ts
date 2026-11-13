import type { RemoteSshManager } from './manager.js';

// Runtime-only bridge between the SSH Core and the optional Notebook Viewer
// Cordis component. Both imports refer to the same installed package instance.
let active: RemoteSshManager | undefined;

export function attachNotebookManager(manager: RemoteSshManager): () => void {
  active = manager;
  return () => { if (active === manager) active = undefined; };
}

export function getNotebookManager(): RemoteSshManager | undefined {
  return active;
}
