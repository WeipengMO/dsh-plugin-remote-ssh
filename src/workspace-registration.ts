import fs from 'node:fs';
import path from 'node:path';
import { workspacePlaceholderPath, workspacePlaceholderRoot } from './paths.js';
import type { RemoteSshManager } from './manager.js';
import { RemoteSshError } from './errors.js';

export interface WorkspaceRegistry {
  create(localPath: string, title?: string): Promise<unknown> | unknown;
  list?(): Array<{ id: string; path: string }>;
}
export interface PreparedWorkspace {
  localPath: string;
  remoteRoot: string;
  hostId: string;
  title: string;
  token: string;
  registered: boolean;
  /** DSH Host's *local* Workspace id, never a remote Linux DSH Session id. */
  workspaceId?: string;
}

/**
 * Make the remote path acceptable to DSH's normal project picker and workspace
 * registry: a stable REAL local folder whose contents are NOT copied from SSH.
 * Subsequent filesystem and shell calls are intercepted by the SSH routing layer.
 * This is the same adapter shape used by @dsh-ssh/dsh-ssh.
 */
export async function prepareRemoteWorkspace(
  manager: RemoteSshManager,
  hostId: string,
  remotePath: string,
  registry?: WorkspaceRegistry,
): Promise<PreparedWorkspace> {
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
  let workspaceId: string | undefined;
  if (registry && typeof registry.create === 'function') {
    // DSH's registry.create is idempotent and publishes the native Sidebar
    // Workspace list through its durable WorkspaceController feed.
    const created = await registry.create(localPath, title);
    if (typeof created === 'object' && created !== null && 'id' in created
      && typeof created.id === 'string') workspaceId = created.id;
    registered = true;
  }
  return {
    localPath, remoteRoot: opened.workspace.remoteRoot,
    hostId, title, token: opened.workspace.token, registered,
    ...(workspaceId === undefined ? {} : { workspaceId }),
  };
}
