import fs from 'node:fs';
import path from 'node:path';
import { workspacePlaceholderRoot } from './paths.js';
/**
 * Track DSH workspace ID -> remote placeholder token across host restarts.
 * Workspace deletion events only carry an ID, not the deleted record's path.
 * Do not recursively remove anything: the placeholder must be empty, a direct
 * child of the plugin's reserved directory, and not a symlink.
 */
export function installWorkspaceCleanup(ctx, manager, storageDir, logger, options = {}) {
    const root = path.resolve(options.root ?? workspacePlaceholderRoot());
    const stateFile = path.join(storageDir, 'placeholder-workspace-ids.json');
    const byId = new Map();
    const tokenRegex = /^w[0-9a-f]{16}$/i;
    const managedPath = (candidate) => {
        const absolute = path.resolve(candidate);
        const relative = path.relative(root, absolute);
        if (!tokenRegex.test(relative) || relative.includes(path.sep))
            return null;
        return { token: relative, absolute };
    };
    const save = () => {
        try {
            fs.mkdirSync(storageDir, { recursive: true, mode: 0o700 });
            const temp = stateFile + '.' + process.pid + '.tmp';
            fs.writeFileSync(temp, JSON.stringify(Object.fromEntries(byId), null, 2) + '\n', { mode: 0o600 });
            fs.renameSync(temp, stateFile);
        }
        catch (err) {
            logger.warn('remote-ssh: failed to save placeholder map: ' + String(err));
        }
    };
    try {
        const json = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (json && typeof json === 'object' && !Array.isArray(json)) {
            for (const [id, value] of Object.entries(json)) {
                if (typeof value === 'string' && id && managedPath(value))
                    byId.set(id, value);
            }
        }
    }
    catch { /* A fresh install has no map. */ }
    // Rebuild mappings for workspaces created before this cleanup feature or
    // across a restart. The DSH registry remains the source of active ownership.
    if (options.registered) {
        try {
            for (const item of options.registered()) {
                if (typeof item.id !== 'string' || typeof item.path !== 'string')
                    continue;
                const valid = managedPath(item.path);
                if (!valid)
                    continue;
                try {
                    manager.workspaceByToken(valid.token);
                }
                catch {
                    continue;
                }
                byId.set(item.id, valid.absolute);
            }
            save();
        }
        catch (err) {
            logger.warn('remote-ssh: could not reconcile workspace registry: ' + String(err));
        }
    }
    const removeEmpty = options.unlinkEmpty ?? (file => fs.rmdirSync(file));
    const handle = (input) => {
        const raw = input && typeof input === 'object' && 'change' in input
            ? input.change : input;
        if (!raw || typeof raw !== 'object')
            return;
        const event = raw;
        if (event.domain !== 'workspace' || event.table !== 'workspaces')
            return;
        const id = typeof event.key === 'string' ? event.key : typeof event.id === 'string' ? event.id : '';
        if (!id)
            return;
        if (event.operation === 'put' || event.operation === 'create') {
            const outer = event.value ?? event.record;
            const candidate = outer && typeof outer === 'object' && 'value' in outer
                ? outer.value : outer;
            const target = candidate && typeof candidate === 'object' && 'path' in candidate
                ? candidate.path : undefined;
            if (typeof target !== 'string')
                return;
            const valid = managedPath(target);
            if (!valid)
                return;
            try {
                manager.workspaceByToken(valid.token);
            }
            catch {
                return;
            }
            byId.set(id, valid.absolute);
            save();
            return;
        }
        if (event.operation !== 'delete' && event.operation !== 'deleted')
            return;
        const target = byId.get(id);
        if (!target)
            return;
        byId.delete(id);
        save();
        const valid = managedPath(target);
        if (!valid || [...byId.values()].some(other => path.resolve(other) === valid.absolute))
            return;
        try {
            const st = fs.lstatSync(valid.absolute);
            if (!st.isDirectory() || st.isSymbolicLink()) {
                logger.warn('remote-ssh: refusing to clean non-directory placeholder ' + valid.absolute);
                return;
            }
            if (fs.readdirSync(valid.absolute).length !== 0) {
                logger.warn('remote-ssh: placeholder is not empty; keeping user data at ' + valid.absolute);
                return;
            }
            // Canonicalize and verify again before removing, to avoid deleting via
            // a replaced symlink while processing a workspace event.
            if (fs.realpathSync(valid.absolute) !== valid.absolute)
                return;
            removeEmpty(valid.absolute);
            manager.forgetWorkspace(valid.token);
        }
        catch (err) {
            if (err.code !== 'ENOENT') {
                logger.warn('remote-ssh: could not remove empty placeholder ' + valid.absolute + ': ' + String(err));
            }
            else
                manager.forgetWorkspace(valid.token);
        }
    };
    const maybeDispose = ctx.on('domain/changed', handle, { global: true });
    return { dispose: () => { if (typeof maybeDispose === 'function')
            maybeDispose(); }, mappings: () => new Map(byId) };
}
//# sourceMappingURL=workspace-cleanup.js.map