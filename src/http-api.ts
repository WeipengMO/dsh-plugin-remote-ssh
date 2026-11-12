/**
 * Native DSH Web host API: one manager and one connection pool shared with the
 * agent tools. Never starts a second localhost server, stores credentials or
 * pretends a workspace was activated merely because it was saved.
 */
import path from 'node:path';
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RemoteSshManager } from './manager.js';
import { prepareRemoteWorkspace, type WorkspaceRegistry } from './workspace-registration.js';
import type { RemoteTerminalPool } from './remote-terminal.js';
import { DEFAULT_DSH_WEB_PORT, type RemoteDshWebTunnelPool } from './dsh-web-tunnel.js';
import type { RemoteHostRuntimePool } from './remote-host-runtime.js';
import { errorMessage } from './errors.js';
import { looksVirtual, shellQuote, workspaceToken } from './paths.js';
import type { HostRecord } from './types.js';
import { listSshConfigAliases, resolveSshConfig } from './ssh-config.js';

export interface AgentRef {
  id: string;
  session: { id?: string; header?: { id?: string; cwd?: string } };
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
  dshWebTunnels?: RemoteDshWebTunnelPool;
  remoteRuntime?: RemoteHostRuntimePool;
  /** Loopback tunnels can only be opened by the desktop Host on the browser machine. */
  desktopProfile?: boolean;
  /** DSH Connection's signed-cookie and Host/Origin admission, fail closed. */
  requestRejection(req: IncomingMessage): number | undefined;
}

type JsonObject = Record<string, unknown>;
const PREFIX = '/api/remote-ssh';
const HOST_FIELDS = ['host', 'sshAlias', 'label', 'port', 'user', 'identityFile', 'identityAgent', 'useAgent', 'useSshConfig', 'configFile', 'hostKeyAlias'] as const;

/**
 * Build stamp published on /state. A running DSH process keeps host plugin
 * modules in its ESM cache, so `dsh plugin add` updates files on disk without
 * reloading the handler. The client compares this with its own build version
 * and can tell the operator to restart instead of showing a bare 405.
 */
const PACKAGE_VERSION: string = (() => {
  try {
    const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    return typeof manifest.version === 'string' && manifest.version.length > 0 ? manifest.version : 'unknown';
  } catch { return 'unknown'; }
})();

function error(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}
function object(input: unknown): input is JsonObject {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
function text(input: unknown, label: string, max = 4096): string {
  if (typeof input !== 'string' || !input.trim() || input.length > max || input.includes('\0')) {
    throw error(400, `${label} must be a non-empty string up to ${max} characters`);
  }
  return input.trim();
}
function hostPatch(input: JsonObject): Partial<HostRecord> {
  const patch: JsonObject = {};
  for (const field of HOST_FIELDS) if (Object.hasOwn(input, field)) patch[field] = input[field];
  if ('host' in patch) patch.host = text(patch.host, 'host', 253);
  if ('port' in patch && patch.port !== null && (!Number.isInteger(patch.port) || Number(patch.port) < 1 || Number(patch.port) > 65535)) throw error(400, 'port must be 1–65535');
  for (const key of ['label', 'sshAlias', 'user', 'identityFile', 'identityAgent', 'configFile', 'hostKeyAlias']) {
    if (key in patch && patch[key] !== null && typeof patch[key] !== 'string') throw error(400, `${key} must be a string`);
  }
  for (const key of ['useAgent', 'useSshConfig']) if (key in patch && typeof patch[key] !== 'boolean') throw error(400, `${key} must be boolean`);
  return patch as Partial<HostRecord>;
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
async function readBody(req: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 16 * 1024) throw error(413, 'request too large');
    chunks.push(buffer);
  }
  try {
    const decoded: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!object(decoded)) throw new Error('expected object');
    return decoded;
  } catch { throw error(400, 'invalid JSON object'); }
}
/** Required for every mutating request, to prevent drive-by localhost CSRF. */
function validateRequest(req: IncomingMessage): void {
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') throw error(403, 'cross-site access denied');
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin && host) {
    let parsed: URL;
    try { parsed = new URL(origin); } catch { throw error(403, 'invalid origin'); }
    if (parsed.host.toLowerCase() !== host.toLowerCase()) throw error(403, 'origin mismatch');
  }
  if (req.method !== 'GET') {
    if (req.headers['x-dsh-remote-ssh'] !== '1') throw error(403, 'missing DSH plugin request header');
    if (!req.headers['content-type']?.startsWith('application/json')) throw error(415, 'JSON required');
  }
}
function sftp<T>(connection: { sftp: object }, action: string, ...args: unknown[]): Promise<T> {
  return new Promise((resolve, reject) => {
    const fn = (connection.sftp as Record<string, (...args: any[]) => unknown>)[action];
    if (typeof fn !== 'function') return reject(error(501, `SFTP ${action} unavailable`));
    fn.call(connection.sftp, ...args, (err: Error | undefined, result: T) => err ? reject(err) : resolve(result));
  });
}
function remotePath(input: string, home: string): string {
  const expanded = input === '~' ? home : input.startsWith('~/') ? path.posix.join(home, input.slice(2)) : input;
  if (/^[A-Za-z]:[\\/]/.test(expanded)) throw error(400, 'remote path must use POSIX syntax');
  return path.posix.normalize(expanded.startsWith('/') ? expanded : path.posix.join(home, expanded));
}
/** DSH emits agent/created as {agent}; older hooks may provide the agent directly. */
export function agentFromCreatedEvent(event: unknown): AgentRef | undefined {
  if (!object(event)) return undefined;
  const candidate = object(event.agent) ? event.agent : event;
  if (!object(candidate) || !object(candidate.session)) return undefined;
  const session = candidate.session;
  if (typeof session.id !== 'string' && !(object(session.header) && typeof session.header.id === 'string')) return undefined;
  return candidate as unknown as AgentRef;
}

function sessionId(agent: AgentRef): string | undefined {
  const candidate = agent.session?.id ?? agent.session?.header?.id;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}
function resolveSession(deps: NativeApiDeps, value: unknown): { id: string; agent: AgentRef } {
  // The settings panel cannot always name the browser current Session. When
  // sessionId is omitted (or is auto), use the most recently announced Agent,
  // which is normally the session the operator is looking at.
  if (value === undefined || value === null || value === '' || value === 'auto' || value === 'current') {
    const entries = [...deps.agents.entries()];
    const latest = entries[entries.length - 1];
    if (latest === undefined) throw error(409, 'This session has no live Agent. Send a message in that DSH session first, then refresh. No workspace was changed.');
    return { id: latest[0], agent: latest[1] };
  }
  const id = text(value, 'sessionId', 256);
  const agent = deps.agents.get(id);
  if (!agent) throw error(409, 'This session has no live Agent. Send a message in that DSH session first, then refresh. No workspace was changed.');
  return { id, agent };
}

export function createNativeHttpHandler(deps: NativeApiDeps) {
  const { manager } = deps;
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const authFailure = deps.requestRejection(req);
      if (authFailure !== undefined) {
        return send(res, authFailure, { ok: false, error: 'DSH browser session not authorized' });
      }
      validateRequest(req);
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (!(url.pathname === PREFIX || url.pathname.startsWith(`${PREFIX}/`))) throw error(404, 'unknown plugin path');
      const route = url.pathname.slice(PREFIX.length) || '/';
      if (req.method === 'GET' && route === '/state') {
        const hosts = manager.hosts();
        const effective: Record<string, { identityFiles: string[]; proxyCommand?: string }> = {};
        for (const host of hosts) {
          try { const config = manager.effectiveConfig(host.id);
            effective[host.id] = { identityFiles: config.identityFiles, proxyCommand: config.proxyCommand }; }
          catch { /* bad config is reflected in statuses() */ }
        }
        const agentEntries = [...deps.agents.entries()];
        const sessions = agentEntries.map(([id, agent], index) => ({
          id, agentId: agent.id, cwd: deps.workingDirectory.get(agent.session),
          remote: looksVirtual(deps.workingDirectory.get(agent.session)),
          latest: index === agentEntries.length - 1,
        }));
        return send(res, 200, { ok: true, version: PACKAGE_VERSION, hosts, effective, statuses: manager.statuses(),
          recent: manager.recent(), sessions, aliases: listSshConfigAliases(),
          remoteDsh: { desktopProfile: deps.desktopProfile === true, tunnels: deps.dshWebTunnels?.list() ?? [] },
          remoteRuntime: { phase: 'bootstrap-v1', connected: deps.remoteRuntime?.list() ?? [] } });
      }
      // Accept GET (current client) and POST (older clients) so a stale UI never
      // turns config preview into an opaque 405 while the host build catches up.
      if (route === '/config/resolve' && (req.method === 'GET' || req.method === 'POST')) {
        const input: unknown = req.method === 'GET' ? url.searchParams.get('alias') : (await readBody(req)).alias;
        const alias = text(input, 'alias', 253);
        if (/[\s\0]/.test(alias) || alias.startsWith('-')) throw error(400, 'invalid SSH alias');
        const effective = resolveSshConfig({ host: alias });
        // Never send private key bytes; only key *paths* and resolved public connection settings.
        return send(res, 200, { ok: true, effective: {
          alias: effective.alias, hostName: effective.hostName, port: effective.port, user: effective.user,
          identityFiles: effective.identityFiles,
          missingIdentityFiles: effective.identityFiles.filter(file => !fs.existsSync(file)),
          proxyCommand: effective.proxyCommand,
          configFound: effective.configFound, matchedHostConfig: effective.matchedHostConfig,
          serverAliveIntervalSec: effective.serverAliveIntervalSec, serverAliveCountMax: effective.serverAliveCountMax,
        } });
      }
      if (req.method === 'GET' && route === '/browse') {
        const hostId = text(url.searchParams.get('host'), 'host');
        manager.getHost(hostId);
        const conn = await manager.connection(hostId);
        const home = await conn.remoteHome();
        const requestPath = text(url.searchParams.get('path') || '~', 'path');
        const canonical = await sftp<string>(conn, 'realpath', remotePath(requestPath, home));
        const list = await sftp<Array<{ filename: string; attrs: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean; size?: number } }>>(conn, 'readdir', canonical);
        const entries = list.slice(0, 1000).map(entry => ({
          name: entry.filename, type: entry.attrs.isSymbolicLink() ? 'symlink' : entry.attrs.isDirectory() ? 'directory' : entry.attrs.isFile() ? 'file' : 'other',
          ...(entry.attrs.isFile() ? { size: entry.attrs.size ?? 0 } : {}),
        })).sort((a, b) => (a.type === 'directory' ? 0 : 1) - (b.type === 'directory' ? 0 : 1) || a.name.localeCompare(b.name));
        return send(res, 200, { ok: true, path: canonical, parent: path.posix.dirname(canonical), home, entries, truncated: list.length > 1000 });
      }
      if (req.method !== 'POST') {
        throw error(405, `method not allowed: ${req.method} ${route.slice(0, 120)} — the running DSH host plugin build is older than this UI; fully restart the DSH client to reload it`);
      }
      const body = await readBody(req);
      if (route === '/runtime/connect') {
        if (!deps.remoteRuntime) throw error(503, 'remote runtime is not installed in this DSH Host');
        const host = text(body.host, 'host');
        manager.getHost(host);
        const runtime = await deps.remoteRuntime.connect(host);
        const remoteDsh = await deps.remoteRuntime.dshVersion(host);
        return send(res, 200, { ok: true, runtime, remoteDsh });
      }
      if (route === '/runtime/inspect') {
        if (!deps.remoteRuntime) throw error(503, 'remote runtime is unavailable');
        const token = text(body.token, 'workspace token', 64);
        // Never accept an arbitrary cwd from a browser; use only an already
        // registered SSH workspace's canonical Linux root.
        const workspace = manager.workspaceByToken(token);
        const inspection = await deps.remoteRuntime.inspect(workspace.connectionId, workspace.remoteRoot);
        return send(res, 200, { ok: true, inspection, host: workspace.connectionId, token });
      }
      if (route === '/runtime/web/open') {
        // This is a Desktop-owned SSH loopback connection. A Web profile Host
        // cannot assume the browser shares its 127.0.0.1.
        if (deps.desktopProfile !== true || !deps.remoteRuntime || !deps.dshWebTunnels) {
          throw error(409, 'Embedded Remote DSH requires the Windows Desktop Host and native WebView');
        }
        const host = text(body.host, 'host');
        const requestedPath = text(body.path ?? '~', 'path');
        manager.getHost(host);
        const opened = await manager.openWorkspace(host, requestedPath);
        // User chose "Connect remote DSH"; this authorizes fetching the pinned
        // official CLI with npx if there is no existing dsh executable.
        const remote = await deps.remoteRuntime.ensureWeb(host, opened.workspace.remoteRoot,
          body.installIfMissing !== false);
        if (remote.phase === 'failed') {
          return send(res, 200, {ok:true, phase:'failed', host,
            message:remote.message || 'remote DSH failed to start'});
        }
        if (remote.phase !== 'ready' || !remote.url) {
          return send(res, 200, { ok:true, phase:'starting', host,
            path:opened.workspace.remoteRoot, installation:remote.installation || 'unknown' });
        }
        const from = new URL(remote.url);
        if (from.protocol !== 'http:' || !['127.0.0.1','localhost'].includes(from.hostname)
            || from.username || from.password || Number(from.port) !== remote.port || !from.searchParams.has('token')) {
          throw error(502, 'remote DSH Web authentication URL is not trusted');
        }
        const key = `web:host:${host}`;
        const existing = deps.dshWebTunnels.list().find(t => t.key === key);
        if (existing && existing.remotePort !== remote.port) deps.dshWebTunnels.close(key);
        const tunnel = await deps.dshWebTunnels.openScoped(key, host, remote.port);
        const to = new URL(tunnel.localUrl);
        to.pathname = from.pathname;
        to.search = from.search;
        to.hash = from.hash;
        // The URL contains a process launch credential. Never log, persist,
        // include in GET /state, or pass through Session/Agent messages.
        return send(res, 200, {
          ok:true, phase:'ready', host, path:opened.workspace.remoteRoot,
          url:to.href, installation:remote.installation || 'existing',
        });
      }
      if (route === '/dsh/check') {
        const host = text(body.host, 'host');
        const connection = await manager.connection(host);
        // All fields are fixed literals, never model/user-supplied code.
        const script = "printf 'DSH_ENV_START\\n'; uname -s; node --version 2>&1 || true; command -v dsh || true; git --version 2>&1 || true; command -v gh || true; printf 'DSH_ENV_END\\n'";
        const result = await connection.exec(script, { timeoutMs: 12000, maxBytes: 12000 });
        return send(res, 200, { ok: true, code: result.code,
          output: result.stdout.slice(0, 10000), stderr: result.stderr.slice(0, 1000),
          truncated: result.truncated });
      }
      if (route.startsWith('/dsh/tunnel/')) {
        if (deps.desktopProfile !== true || !deps.dshWebTunnels) {
          throw error(409, 'Managed local tunnels require DSH Desktop on the same computer as the browser; use manual ssh -L for remote Web profiles');
        }
        const host = text(body.host, 'host');
        manager.getHost(host);
        const tunnels = deps.dshWebTunnels;
        if (route === '/dsh/tunnel/open') {
          const port = body.port === undefined ? DEFAULT_DSH_WEB_PORT : Number(body.port);
          if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw error(400, 'invalid DSH Web remote port');
          return send(res, 200, { ok: true, tunnel: await tunnels.open(host, port) });
        }
        if (route === '/dsh/tunnel/close') {
          return send(res, 200, { ok: true, closed: tunnels.close(host) });
        }
        throw error(404, 'unknown DSH Web tunnel operation');
      }
      if (route === '/recent/clear') {
        // Deleting history is an explicit action, independent of deleting any
        // DSH workspace or its server-side folder. Use the authenticated
        // state-changing API with a user-confirmation flag.
        if (body.confirmed !== true) throw error(400, 'confirm clearing recent SSH directories');
        const removed = manager.clearRecentHistory();
        return send(res, 200, { ok: true, removed });
      }
      if (route === '/host/quick-add') {
        // Auto-import only an exact Host listed by the operator's OpenSSH config.
        // Registering an alias never trusts an unknown SSH host key.
        const alias = text(body.alias, 'alias', 253);
        if (alias.startsWith('-') || /[\s\0*?]/.test(alias) || !listSshConfigAliases().includes(alias)) {
          throw error(400, 'alias must match a concrete ~/.ssh/config Host');
        }
        const existing = manager.hosts().find(host => host.host === alias || host.sshAlias === alias);
        const host = existing ?? manager.addHost({ host: alias, label: alias, useSshConfig: true, useAgent: true });
        return send(res, 200, { ok: true, host });
      }
      if (route === '/host/add') {
        const patch = hostPatch(body);
        const host = manager.addHost({ ...patch, host: text(patch.host, 'host') });
        return send(res, 200, { ok: true, host });
      }
      if (route === '/host/update') {
        const id = text(body.id, 'id');
        deps.dshWebTunnels?.closeAllFor(id);
        deps.remoteRuntime?.clear(id);
        return send(res, 200, { ok: true, host: manager.updateHost(id, hostPatch(body)) });
      }
      if (route === '/host/remove') {
        const id = text(body.id, 'id');
        deps.dshWebTunnels?.closeAllFor(id);
        deps.remoteRuntime?.clear(id);
        manager.removeHost(id);
        return send(res, 200, { ok: true });
      }
      if (route === '/test') {
        const id = text(body.host, 'host');
        return send(res, 200, { ok: true, probe: await manager.test(id) });
      }
      if (route === '/trust') {
        const id = text(body.host, 'host');
        const fingerprint = text(body.fingerprint, 'fingerprint', 128);
        // Client must require full fingerprint re-entry and an explicit checkbox.
        if (body.confirmed !== true) throw error(400, 'out-of-band fingerprint verification must be explicitly confirmed');
        const probe = await manager.test(id);
        const presented = probe.details?.fingerprint;
        const hostKey = probe.details?.hostKey;
        if (probe.code !== 'SSH_HOST_KEY_UNKNOWN' || typeof presented !== 'string' || typeof hostKey !== 'string') {
          throw error(409, `refusing trust when host key is not new (${probe.code ?? 'already trusted'})`);
        }
        if (fingerprint !== presented) throw error(409, 'fingerprint mismatch — host remains untrusted');
        const verified = manager.trustHostKey(id, hostKey, fingerprint);
        const reconnect = await manager.test(id);
        return send(res, 200, { ok: true, fingerprint: verified.fingerprint, connected: reconnect.ok, probe: reconnect });
      }
      // Native project creation flow: return a *real* local placeholder dir.
      // DSH's own workspace/project picker calls onPicked(localPath), then uses
      // the standard project registry and session creation path.
      if (route === '/workspace/prepare') {
        const hostId = text(body.host, 'host');
        const remote = text(body.path ?? '~', 'path');
        const registry = typeof deps.workspaceRegistry === 'function' ? deps.workspaceRegistry() : deps.workspaceRegistry;
        const prepared = await prepareRemoteWorkspace(manager, hostId, remote, registry);
        // Automatically stage the version-verified helper on the same SSH
        // connection. A Node-less host may still use the legacy SFTP bridge;
        // failures are explicit, never silently interpreted as a remote DSH
        // Agent Session or full Forge availability.
        let runtime: { state: string; protocol?: number; git?: unknown; message?: string };
        if (!deps.remoteRuntime) runtime = { state: 'unavailable', message: 'helper runtime not registered' };
        else {
          try {
            const info = await deps.remoteRuntime.connect(hostId);
            const inspection = await deps.remoteRuntime.inspect(hostId, prepared.remoteRoot);
            runtime = { state: 'verified-helper', protocol: info.protocol, git: inspection.git };
          } catch (err) {
            runtime = { state: 'unavailable', message: errorMessage(err).slice(0, 300) };
          }
        }
        return send(res, 200, { ok: true, ...prepared, runtime });
      }
      if (route === '/workspace/open') {
        const { id, agent } = resolveSession(deps, body.sessionId);
        const hostId = text(body.host, 'host');
        const selectedPath = text(body.path ?? '~', 'path');
        const original = deps.workingDirectory.get(agent.session);
        const opened = await manager.openWorkspace(hostId, selectedPath);
        const cwd = await deps.workingDirectory.set(agent, opened.virtualPath);
        if (!looksVirtual(original) && !deps.previousCwd.has(id)) deps.previousCwd.set(id, original);
        return send(res, 200, { ok: true, cwd, remoteRoot: opened.workspace.remoteRoot, sessionId: id, hostId });
      }
      if (route === '/workspace/close') {
        const { id, agent } = resolveSession(deps, body.sessionId);
        const original = deps.workingDirectory.get(agent.session);
        if (!looksVirtual(original)) return send(res, 200, { ok: true, changed: false, cwd: original });
        const target = deps.previousCwd.get(id) ?? agent.session.header?.cwd;
        if (!target || looksVirtual(target)) throw error(409, 'cannot safely restore local directory');
        const cwd = await deps.workingDirectory.set(agent, target);
        deps.previousCwd.delete(id);
        return send(res, 200, { ok: true, changed: true, cwd });
      }
      // A user-initiated SSH PTY, separate from DSH's built-in local terminal.
      // All commands run over the already authenticated browser session.
      if (route.startsWith('/terminal/')) {
        const terminals = deps.remoteTerminals;
        if (!terminals) throw error(503, 'SSH interactive terminal is not available');
        if (route === '/terminal/open') {
          const host = text(body.host, 'host');
          const remote = text(body.path ?? '~', 'path');
          return send(res, 200, { ok: true, terminal: await terminals.open(host, remote) });
        }
        const id = text(body.id, 'terminal id', 100);
        if (route === '/terminal/read') {
          const cursor = typeof body.cursor === 'number' && Number.isSafeInteger(body.cursor) && body.cursor >= 0
            ? body.cursor : 0;
          return send(res, 200, { ok: true, ...terminals.read(id, cursor) });
        }
        if (route === '/terminal/write') {
          const input = typeof body.input === 'string' ? body.input : '';
          terminals.write(id, input);
          return send(res, 200, { ok: true });
        }
        if (route === '/terminal/resize') {
          const cols = Number(body.cols), rows = Number(body.rows);
          if (!Number.isInteger(cols) || !Number.isInteger(rows)) throw error(400, 'invalid terminal size');
          terminals.resize(id, cols, rows);
          return send(res, 200, { ok: true });
        }
        if (route === '/terminal/close') {
          terminals.close(id);
          return send(res, 200, { ok: true });
        }
        throw error(404, 'unknown terminal operation');
      }
      if (route === '/exec') {
        const hostId = text(body.host, 'host');
        const cwd = text(body.path ?? '~', 'path');
        const command = text(body.command, 'command', 3000);
        const conn = await manager.connection(hostId);
        const home = await conn.remoteHome();
        const resolved = remotePath(cwd, home);
        const result = await conn.exec(`cd -- ${shellQuote(resolved)} && ${command}`, { timeoutMs: 30000, maxBytes: 200000 });
        return send(res, 200, { ok: true, code: result.code, stdout: result.stdout, stderr: result.stderr, truncated: result.truncated });
      }
      throw error(404, 'unknown remote SSH operation');
    } catch (cause) {
      const details = cause as { status?: number; code?: string; message?: string };
      const code = details.code ?? 'SSH_API_ERROR';
      const status = details.status ?? (code === 'SSH_HOST_NOT_FOUND' ? 404 : 500);
      // Never echo request bodies, private keys or environment to the client.
      send(res, status, { ok: false, code, error: details.message ?? 'Remote SSH request failed' });
    }
  };
}
