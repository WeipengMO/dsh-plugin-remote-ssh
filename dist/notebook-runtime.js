// Runtime-only bridge between the SSH Core and the optional Notebook Viewer
// Cordis component. Both imports refer to the same installed package instance.
let active;
export function attachNotebookManager(manager) {
    active = manager;
    return () => { if (active === manager)
        active = undefined; };
}
export function getNotebookManager() {
    return active;
}
//# sourceMappingURL=notebook-runtime.js.map