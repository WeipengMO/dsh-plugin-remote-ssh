import fs from 'node:fs';
import path from 'node:path';
import { workspacePlaceholderPath, workspacePlaceholderRoot } from './paths.js';
import { RemoteSshError } from './errors.js';
/**
 * Make the remote path acceptable to DSH's normal project picker and workspace
 * registry: a stable REAL local folder whose contents are NOT copied from SSH.
 * Subsequent filesystem and shell calls are intercepted by the SSH routing layer.
 * This is the same adapter shape used by @dsh-ssh/dsh-ssh.
 */
export async function prepareRemoteWorkspace(manager, hostId, remotePath, registry) {
    const opened = await manager.openWorkspace(hostId, remotePath);
    const localPath = workspacePlaceholderPath(opened.workspace.token);
    fs.mkdirSync(workspacePlaceholderRoot(), { recursive: true, mode: 0o700 });
    fs.mkdirSync(localPath, { recursive: true, mode: 0o700 });
    const actual = fs.realpathSync(localPath);
    // A user-created symlink in our reserved tree must never create a workspace
    // that points into arbitrary local data.
    if (path.normalize(actual).toLowerCase() !== path.normalize(localPath).toLowerCase()) {
        throw new RemoteSshError('SSH_PATH_INVALID', 'remote workspace placeholder must not be a symlink');
    }
    const basename = path.posix.basename(opened.workspace.remoteRoot) || '/';
    const title = `${opened.workspace.hostLabel} · ${basename}`;
    let registered = false;
    if (registry && typeof registry.create === 'function') {
        // DSH's registry.create is idempotent when this path already exists.
        await registry.create(localPath, title);
        registered = true;
    }
    return {
        localPath, remoteRoot: opened.workspace.remoteRoot,
        hostId, title, token: opened.workspace.token, registered,
    };
}
//# sourceMappingURL=workspace-registration.js.map