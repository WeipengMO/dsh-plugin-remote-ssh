/**
 * Optional Cordis Notebook Viewer host component.
 * Read-only .ipynb over the existing verified SSH/SFTP connection. This
 * endpoint never starts a kernel, runs Python, or executes notebook cells.
 */
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getNotebookManager } from './notebook-runtime.js';

export const name = 'remote-ssh-notebook';
export const inject = ['webServer', 'connection'];

export const MAX_NOTEBOOK_BYTES = 12 * 1024 * 1024;
const PREFIX = '/api/remote-ssh-notebook';

interface NotebookHost {
  get(name: string): unknown;
  logger: { info(message: string): void };
  effect(fn: () => (() => void) | void): unknown;
}
interface NotebookDeps {
  manager: () => ReturnType<typeof getNotebookManager>;
  requestRejection(req: IncomingMessage): number | undefined;
}

function failure(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

function send(res: ServerResponse, status: number, data: unknown): void {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(payload);
}

function checkSameOrigin(req: IncomingMessage): void {
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') throw failure(403, 'cross-site request denied');
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin && host) {
    let parsed: URL;
    try { parsed = new URL(origin); } catch { throw failure(403, 'invalid request origin'); }
    if (parsed.host.toLowerCase() !== host.toLowerCase()) throw failure(403, 'origin mismatch');
  }
}

function param(input: string | null, name: string, max = 4096): string {
  if (typeof input !== 'string' || !input.trim() || input.length > max || input.includes('\0')) {
    throw failure(400, 'invalid ' + name);
  }
  return input.trim();
}

function validateNotebook(value: unknown): asserts value is { nbformat: number; cells: unknown[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure(422, 'not a Jupyter notebook');
  const notebook = value as Record<string, unknown>;
  if (notebook.nbformat !== 4 || !Array.isArray(notebook.cells) || notebook.cells.length > 2000) {
    throw failure(422, 'only Jupyter nbformat 4 notebooks with up to 2000 cells are supported');
  }
  for (const cell of notebook.cells) {
    if (!cell || typeof cell !== 'object' || Array.isArray(cell)
        || !['code', 'markdown', 'raw'].includes((cell as { cell_type?: string }).cell_type ?? '')) {
      throw failure(422, 'invalid notebook cell');
    }
  }
}

function sftpCall<T>(sftp: object, action: 'realpath' | 'stat' | 'readFile', file: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const fn = (sftp as Record<string, (name: string, callback: (error: Error | undefined, value: T) => void) => void>)[action];
    if (typeof fn !== 'function') return reject(failure(501, 'SFTP ' + action + ' unavailable'));
    fn.call(sftp, file, (error, value) => error ? reject(error) : resolve(value));
  });
}

export function createNotebookHttpHandler(deps: NotebookDeps) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const rejected = deps.requestRejection(req);
      if (rejected !== undefined) return send(res, rejected, { ok: false, error: 'browser session not authorized' });
      checkSameOrigin(req);
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== PREFIX + '/read' || req.method !== 'GET') {
        throw failure(404, 'Notebook Viewer route not found');
      }
      const hostId = param(url.searchParams.get('host'), 'host', 128);
      const requested = param(url.searchParams.get('path'), 'path');
      if (!/\.ipynb$/i.test(path.posix.basename(requested))) throw failure(400, 'only .ipynb files can be opened');
      if (requested.includes('\\') || /^[A-Za-z]:/.test(requested)) throw failure(400, 'SSH paths must use POSIX syntax');

      const manager = deps.manager();
      if (!manager) throw failure(503, 'Remote SSH Core is unavailable; enable that component first');
      manager.getHost(hostId); // Only configured SSH hosts can be accessed.
      const connection = await manager.connection(hostId);
      const home = await connection.remoteHome();
      const candidate = requested === '~' ? home
        : requested.startsWith('~/') ? path.posix.join(home, requested.slice(2))
        : path.posix.isAbsolute(requested) ? requested : path.posix.join(home, requested);
      const canonical = await sftpCall<string>(connection.sftp, 'realpath', path.posix.normalize(candidate));
      if (!/\.ipynb$/i.test(path.posix.basename(canonical))) throw failure(400, 'resolved file must be .ipynb');
      const stat = await sftpCall<{ size?: number; isFile(): boolean }>(connection.sftp, 'stat', canonical);
      if (!stat.isFile()) throw failure(400, 'notebook path is not a regular file');
      if (typeof stat.size !== 'number' || stat.size < 0 || stat.size > MAX_NOTEBOOK_BYTES) {
        throw failure(413, 'notebook exceeds 12 MiB preview limit');
      }
      const bytes = await sftpCall<Buffer | string>(connection.sftp, 'readFile', canonical);
      const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      if (buffer.length > MAX_NOTEBOOK_BYTES) throw failure(413, 'notebook exceeds 12 MiB preview limit');
      let notebook: unknown;
      try { notebook = JSON.parse(buffer.toString('utf8')); }
      catch { throw failure(422, 'invalid notebook JSON'); }
      validateNotebook(notebook);
      return send(res, 200, { ok: true, path: canonical, notebook });
    } catch (error) {
      const value = error as Error & { status?: number };
      const status = typeof value.status === 'number' && value.status >= 400 && value.status <= 599 ? value.status : 500;
      send(res, status, { ok: false, error: status === 500 ? 'unable to read remote notebook: ' + (value.message || 'unknown error') : value.message });
    }
  };
}

export function apply(ctx: NotebookHost): void {
  const webServer = ctx.get('webServer') as
    | { register(options: { kind: 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }): () => void }
    | undefined;
  const connection = ctx.get('connection') as
    | { requestRejection(req: IncomingMessage): number | undefined }
    | undefined;
  if (!webServer?.register || !connection?.requestRejection) {
    throw failure(501, 'Notebook Viewer requires DSH webServer and signed-cookie connection services');
  }
  ctx.effect(() => {
    const dispose = webServer.register({
      kind: 'prefix',
      path: PREFIX,
      handler: createNotebookHttpHandler({
        manager: getNotebookManager,
        requestRejection: req => connection.requestRejection(req),
      }),
    });
    ctx.logger.info('remote-ssh-notebook: read-only SFTP notebook preview enabled');
    return () => dispose?.();
  });
}
