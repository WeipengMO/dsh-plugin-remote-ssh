/**
 * Native (React, not WebView) multi-Host Session transport for Desktop.
 *
 * A physical DSH Host is launched on Linux, but its official /api/session/*
 * Connection RPC protocol is consumed from the Windows plugin Host over the
 * already authenticated SSH loopback tunnel.  No browser cookie, launch token,
 * raw Session id, or arbitrary RPC endpoint is exposed to the renderer.
 *
 * This is a deliberately narrow Session domain bridge: Core's root Client
 * Session/Workspace services are not monkey-patched or replaced.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { RemoteSshManager } from './manager.js';
import type { RemoteHostRuntimePool } from './remote-host-runtime.js';
import type { RemoteDshWebTunnelPool } from './dsh-web-tunnel.js';

type Ready = { phase: 'ready'; origin: string; token: string; port: number };
type Starting = { phase: 'starting' | 'failed'; message?: string };
type Endpoint = 'session/list' | 'session/create' | 'session/events' | 'session/prompt' | 'session/cancel';
type Json = Record<string, unknown>;
type Binding = { host: string; sessionId: string; remoteRoot: string; revision: string };
type Dependency = {
  manager: Pick<RemoteSshManager, 'getHost' | 'openWorkspace'>;
  runtime: Pick<RemoteHostRuntimePool, 'ensureWeb'>;
  tunnels: Pick<RemoteDshWebTunnelPool, 'list' | 'close' | 'openScoped'>;
};
const MAX_RESPONSE = 2 * 1024 * 1024;
const MAX_PROMPT = 12000;

function fail(message: string, status = 502): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}
function record(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function mandatory(value: unknown, name: string, max = 512): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
    throw fail('Invalid ' + name, 400);
  }
  return value.trim();
}
function revisionOf(manager: Dependency['manager'], host: string): string {
  const details = manager.getHost(host) as { updatedAt?: string };
  return details.updatedAt ?? '';
}
function contentText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.filter(part => record(part) && part.type === 'text' && typeof part.text === 'string')
    .map(part => String(part.text)).join('').slice(0, 100_000);
}

/**
 * One Host has one private authenticated Core HTTP carrier. Different Hosts
 * never share cookies, RPC identity, cached sessions, or SSH tunnel keys.
 */
export class NativeHostSessions {
  private readonly bindings = new Map<string, Binding>();
  private readonly refBySession = new Map<string, string>();
  private readonly cookies = new Map<string, { origin: string; cookie: string }>();
  private disposed = false;

  constructor(private readonly deps: Dependency) {}

  clear(host: string): void {
    this.cookies.delete(host);
    for (const [ref, item] of this.bindings) {
      if (item.host === host) {
        this.bindings.delete(ref);
        this.refBySession.delete(JSON.stringify([item.host, item.sessionId]));
      }
    }
  }
  dispose(): void {
    this.disposed = true;
    this.bindings.clear();
    this.refBySession.clear();
    this.cookies.clear();
  }
  private checkHost(host: string): string {
    if (this.disposed) throw fail('Native Host session service stopped', 503);
    mandatory(host, 'SSH Host', 256);
    return revisionOf(this.deps.manager, host);
  }
  private async ready(host: string, remoteRoot: string): Promise<Ready | Starting> {
    this.checkHost(host);
    const remote = await this.deps.runtime.ensureWeb(host, remoteRoot, true);
    if (remote.phase === 'failed') return { phase:'failed', message:'Remote DSH Host failed to start' };
    if (remote.phase !== 'ready' || !remote.url) return { phase:'starting' };
    let url: URL;
    try { url = new URL(remote.url); } catch { throw fail('Malformed remote Host URL'); }
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)
      || url.username || url.password || Number(url.port) !== remote.port
      || !url.searchParams.get('token')) throw fail('Untrusted DSH Host authentication URL');
    const key = 'web:host:' + host;
    const old = this.deps.tunnels.list().find(item => item.key === key);
    if (old && old.remotePort !== remote.port) {
      this.deps.tunnels.close(key);
      this.cookies.delete(host);
    }
    const tunnel = await this.deps.tunnels.openScoped(key, host, remote.port);
    const origin = new URL(tunnel.localUrl);
    if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1'
      || Number(origin.port) !== tunnel.localPort || origin.username || origin.password) {
      throw fail('Untrusted Windows SSH tunnel listener');
    }
    return { phase:'ready', origin:origin.origin, token:url.searchParams.get('token')!, port:remote.port };
  }

  private async authenticate(host: string, ready: Ready): Promise<string> {
    const saved = this.cookies.get(host);
    if (saved?.origin === ready.origin) return saved.cookie;
    // BrowserAuth's documented GET / token exchange returns 303 and an
    // authority-bound signed cookie. Keep it in Node memory only.
    const login = await fetch(ready.origin + '/?token=' + encodeURIComponent(ready.token), {
      method:'GET', redirect:'manual', signal:AbortSignal.timeout(12000),
      headers:{ 'accept':'text/html' },
    });
    const setCookie = login.headers.get('set-cookie');
    const cookie = setCookie?.split(';', 1)[0];
    if (login.status !== 303 || !cookie || !/^dsh-auth-[A-Za-z0-9_-]+=[A-Za-z0-9_-]+$/.test(cookie)) {
      throw fail('Remote DSH Host refused native Session authentication', 401);
    }
    this.cookies.set(host, { origin:ready.origin, cookie });
    return cookie;
  }

  private async call(host: string, remoteRoot: string, endpoint: Endpoint, request: Json): Promise<unknown | Starting> {
    const info = await this.ready(host, remoteRoot);
    if (info.phase !== 'ready') return info;
    const cookie = await this.authenticate(host, info);
    const rpcId = randomUUID();
    const response = await fetch(info.origin + '/api/' + endpoint, {
      method:'POST',
      headers:{ 'cookie':cookie, 'content-type':'application/json', 'accept':'application/json' },
      body:JSON.stringify({ type:'client-request', rpcId, method:endpoint, payload:{ args:{ request } } }),
      redirect:'manual',
      signal:AbortSignal.timeout(20000),
    });
    if (response.status === 401 || response.status === 403) {
      this.cookies.delete(host);
      throw fail('Remote DSH Core authentication lost; reconnect this Host', 401);
    }
    if (response.status !== 200 || !response.headers.get('content-type')?.startsWith('application/json')) {
      throw fail('Remote DSH Core rejected ' + endpoint + ' (HTTP ' + response.status + ')');
    }
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > MAX_RESPONSE) throw fail('Remote DSH Core response too large', 413);
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_RESPONSE) throw fail('Remote DSH Core response too large', 413);
    let reply: unknown;
    try { reply = JSON.parse(Buffer.from(buffer).toString('utf8')); }
    catch { throw fail('Remote DSH Core response is not valid JSON'); }
    if (!record(reply) || reply.type !== 'server-response' || reply.rpcId !== rpcId
      || !record(reply.result) || typeof reply.result.ok !== 'boolean') {
      throw fail('Remote DSH Core RPC correlation or response validation failed');
    }
    if (reply.result.ok !== true) {
      const code = record(reply.result.error) ? reply.result.error.code : 'unknown';
      const message = record(reply.result.error) ? reply.result.error.message : '';
      throw fail('Remote DSH Core ' + String(code) + ': ' + String(message).slice(0, 500), 409);
    }
    return reply.result.value;
  }

  private bind(host: string, sessionId: string, remoteRoot: string): string {
    const key = JSON.stringify([host, sessionId]);
    const prior = this.refBySession.get(key);
    if (prior) {
      const current = this.bindings.get(prior);
      if (current && current.revision === this.checkHost(host)) return prior;
      this.bindings.delete(prior);
    }
    const ref = randomUUID();
    this.bindings.set(ref, { host, sessionId, remoteRoot, revision:this.checkHost(host) });
    this.refBySession.set(key, ref);
    return ref;
  }
  private bound(ref: unknown): Binding {
    const item = this.bindings.get(mandatory(ref, 'Session reference', 128));
    if (!item || item.revision !== this.checkHost(item.host)) {
      throw fail('Remote Session binding has expired; reload its Host list', 409);
    }
    return item;
  }

  async list(host: string, chosenPath: string): Promise<unknown> {
    this.checkHost(host);
    const workspace = await this.deps.manager.openWorkspace(host, chosenPath);
    const remoteRoot = workspace.workspace.remoteRoot;
    const result = await this.call(host, remoteRoot, 'session/list', {});
    if (record(result) && result.phase) return result;
    if (!record(result) || !Array.isArray(result.items)) throw fail('Malformed remote Session list');
    return {
      phase:'ready', host, remoteRoot,
      sessions:result.items.filter(record).filter(x=>typeof x.sessionId === 'string' && x.origin !== 'subagent')
        .map(x=>({
          ref:this.bind(host, x.sessionId as string, typeof x.cwd === 'string' && x.cwd.startsWith('/') ? x.cwd : remoteRoot),
          title:typeof x.title === 'string' ? x.title : typeof x.cwd === 'string' ? path.posix.basename(x.cwd) : x.sessionId,
          cwd:typeof x.cwd === 'string' ? x.cwd : '',
          running:x.running === true,
          blank:x.blank === true,
          updatedAt:typeof x.updatedAt === 'number' ? x.updatedAt : 0,
        })),
    };
  }

  async create(host: string, chosenPath: string): Promise<unknown> {
    this.checkHost(host);
    const workspace = await this.deps.manager.openWorkspace(host, chosenPath);
    const remoteRoot = workspace.workspace.remoteRoot;
    const result = await this.call(host, remoteRoot, 'session/create', { cwd:remoteRoot });
    if (record(result) && result.phase) return result;
    if (!record(result) || typeof result.sessionId !== 'string') throw fail('Malformed remote Session create receipt');
    return {phase:'ready', host, remoteRoot, ref:this.bind(host,result.sessionId,remoteRoot)};
  }

  async events(ref: string): Promise<unknown> {
    const bound = this.bound(ref);
    const result = await this.call(bound.host, bound.remoteRoot, 'session/events', {
      address:{kind:'session',sessionId:bound.sessionId}, maxMessages:50,
    });
    if (record(result) && result.phase) return result;
    if (!record(result) || !Array.isArray(result.records)) throw fail('Malformed remote Session history');
    const entries = result.records.filter(record).map(entry => record(entry.event) ? entry.event : undefined)
      .filter(record).filter(event => event.type === 'user/message' || event.type === 'assistant/message')
      .map(event => {
        const data = record(event.data) ? event.data : {};
        const body = event.type === 'assistant/message' && record(data.message) ? data.message.content : data.content;
        return {
          seq:typeof event.seq === 'number' ? event.seq : 0,
          role:event.type === 'user/message' ? 'user' : 'assistant',
          text:contentText(body),
        };
      }).filter(message => message.text);
    return {phase:'ready', host:bound.host, ref, messages:entries, hasMore:result.hasMore === true};
  }

  async prompt(ref: string, message: string): Promise<unknown> {
    const bound = this.bound(ref);
    const text = mandatory(message, 'prompt', MAX_PROMPT);
    const result = await this.call(bound.host, bound.remoteRoot, 'session/prompt', {
      requestId:randomUUID(), sessionId:bound.sessionId,
      mode:'queue', content:[{type:'text', text}],
    });
    if (record(result) && result.phase) return result;
    if (!record(result) || result.accepted !== true) throw fail('Remote DSH did not accept the prompt');
    return {phase:'ready', accepted:true, ref};
  }

  async cancel(ref: string): Promise<unknown> {
    const bound = this.bound(ref);
    const result = await this.call(bound.host, bound.remoteRoot, 'session/cancel', {sessionId:bound.sessionId});
    if (record(result) && result.phase) return result;
    return {phase:'ready', cancelled:true, ref};
  }
}
