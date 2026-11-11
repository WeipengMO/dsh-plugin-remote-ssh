#!/usr/bin/env node
/**
 * DSH Remote SSH helper protocol v1.
 *
 * Runs requests over verified SSH exec. The Web orchestration method can
 * start a separate, loopback-only official DSH Web process on explicit user action.
 * No arbitrary shell-command endpoint or network-facing helper listener exists.
 * The parent plugin deploys the SHA-256-verified file over an authenticated SSH
 * connection. All code execution is via fixed, allowlisted argv.
 */
import { readFile, realpath, stat, mkdir, writeFile, lstat, rm, open } from 'node:fs/promises';
import { createServer, connect as connectSocket } from 'node:net';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PROTOCOL = 1;
const MAX_REQUEST = 16 * 1024;
const MAX_OUTPUT = 64 * 1024;

function fail(code, message) {
  return { ok: false, error: { code, message: String(message).slice(0, 400) } };
}
function safeString(value, max = 4096) {
  if (typeof value !== 'string' || value.length === 0 ||
      value.length > max || value.includes('\0')) throw new Error('invalid request field');
  return value;
}
function run(file, args, cwd, maxBytes = MAX_OUTPUT) {
  return new Promise((resolve, reject) => {
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), overflow = false;
    const env = {
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      HOME: process.env.HOME || '', LANG: 'C', LC_ALL: 'C',
      GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0',
      GIT_NO_LAZY_FETCH: '1', GIT_PAGER: 'cat', GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_COUNT: '0',
    };
    const child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true });
    const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
    child.once('error', err => { clearTimeout(timer); reject(err); });
    const append = (which, chunk) => {
      const prior = which === 'out' ? stdout : stderr;
      const len = Math.min(chunk.length, Math.max(0, maxBytes - prior.length));
      if (len < chunk.length) overflow = true;
      if (which === 'out') stdout = Buffer.concat([prior, chunk.subarray(0, len)]);
      else stderr = Buffer.concat([prior, chunk.subarray(0, len)]);
    };
    child.stdout.on('data', c => append('out', c));
    child.stderr.on('data', c => append('err', c));
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'), truncated: overflow });
    });
  });
}
async function git(cwd, args, maxBytes) {
  return run('git', ['--no-optional-locks',
    '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
    ...args], cwd, maxBytes);
}
async function inspect(cwd) {
  if (!cwd.startsWith('/')) throw new Error('cwd must be an absolute Linux path');
  const canonical = await realpath(cwd);
  if (!(await stat(canonical)).isDirectory()) throw new Error('cwd is not a directory');
  const root = await git(canonical, ['rev-parse', '--show-toplevel']);
  if (root.code !== 0) return {
    cwd: canonical, git: { available: false, message: root.stderr.trim().slice(0, 200) },
  };
  const gitRoot = root.stdout.trim();
  const [branch, status, worktrees, diffStat, head] = await Promise.all([
    git(canonical, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    git(canonical, ['status', '--porcelain=v1', '--branch', '--untracked-files=normal']),
    git(canonical, ['worktree', 'list', '--porcelain']),
    git(canonical, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--stat', '--']),
    git(canonical, ['rev-parse', '--verify', 'HEAD']),
  ]);
  return {
    cwd: canonical,
    git: { available: true, root: gitRoot, branch: branch.code === 0 ? branch.stdout.trim() : null,
      head: head.code === 0 ? head.stdout.trim() : null,
      status: status.stdout, worktrees: worktrees.stdout, diffStat: diffStat.stdout,
      truncated: [root, branch, status, worktrees, diffStat, head].some(x => x.truncated),
    },
  };
}

/**
 * Per-workspace private launch registry. No Web token is put in the registry:
 * DSH's own one-time URL line remains in a mode-0600 log file.
 */
const OFFICIAL_DSH_VERSION = '0.2.2-rc.1';
async function secureDir(directory, strict = false) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const details = await lstat(directory);
  if (!details.isDirectory() || details.isSymbolicLink() || (details.mode & (strict ? 0o077 : 0o022)) !== 0) {
    throw new Error('remote DSH state directory is not private');
  }
}
function isAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function localPort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => port >= 1024 ? resolve(port) : reject(new Error('failed to find private Web port')));
    });
  });
}
async function accepting(port) {
  return await new Promise(resolve => {
    const socket = connectSocket({ host: '127.0.0.1', port });
    const done = result => { socket.destroy(); resolve(result); };
    socket.setTimeout(450);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}
function fromLog(content, port) {
  const line = content.match(/(?:^|\n)dsh web:\s*(https?:\/\/[^\s]+)/);
  if (!line) return null;
  try {
    const uri = new URL(line[1]);
    if (uri.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(uri.hostname) ||
        Number(uri.port) !== port || uri.username || uri.password || !uri.searchParams.has('token')) return null;
    return uri.href;
  } catch { return null; }
}
function webRootFor(cwd) {
  const home = process.env.HOME;
  if (!home || !home.startsWith('/') || home === '/') throw new Error('private Linux home directory unavailable');
  return join(home, '.cache', 'dsh-remote-ssh', 'web', 'v1', createHash('sha256').update(cwd).digest('hex'));
}
async function webEnsure(cwdValue, installIfMissing) {
  const major = Number(process.versions.node.split('.')[0] || 0);
  const minor = Number(process.versions.node.split('.')[1] || 0);
  if (major < 24 || (major === 24 && minor < 9)) {
    throw new Error('Full DSH Web requires Node.js >=24.9; selected Linux Node is ' + process.version);
  }
  const cwd = await realpath(cwdValue);
  if (!(await stat(cwd)).isDirectory()) throw new Error('remote DSH cwd is not a directory');
  const root = webRootFor(cwd);
  const home = process.env.HOME;
  for(const directory of [
    join(home,'.cache'),join(home,'.cache','dsh-remote-ssh'),
    join(home,'.cache','dsh-remote-ssh','web'),
    join(home,'.cache','dsh-remote-ssh','web','v1'),root
  ]) await secureDir(directory, directory.includes('/web/'));
  const metadataPath = join(root, 'state.json');
  const logPath = join(root, 'output.log');
  let previous;
  try {
    const details = await lstat(metadataPath);
    if (!details.isFile() || details.isSymbolicLink() || (details.mode & 0o077) !== 0)
      throw new Error('remote DSH registry has unsafe file permissions');
    previous = JSON.parse(await readFile(metadataPath, 'utf8'));
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (previous?.cwd === cwd && Number.isSafeInteger(previous.port) &&
      previous.port >= 1024 && previous.port <= 65535 && isAlive(previous.pid)) {
    let log = '';
    try {
      const meta = await lstat(logPath);
      if (!meta.isFile() || meta.isSymbolicLink() || (meta.mode & 0o077) !== 0)
        throw new Error('remote DSH log has unsafe permissions');
      // Only the startup prefix contains the token; never read unbounded
      // long-running DSH logs into each one-shot helper invocation.
      const file = await open(logPath,'r');
      try {
        const head = Buffer.alloc(256 * 1024);
        const { bytesRead } = await file.read(head,0,head.length,0);
        log = head.subarray(0, bytesRead).toString('utf8');
      } finally { await file.close(); }
    } catch(e) { if(e.code !== 'ENOENT') throw e; }
    const remoteUrl = fromLog(log, previous.port);
    if (remoteUrl && await accepting(previous.port)) {
      return { phase:'ready', cwd, port:previous.port, url:remoteUrl, managed:true, installation: previous.installation };
    }
    if (Number.isFinite(previous.startedAt) && Date.now() - previous.startedAt > 5 * 60_000) {
      return {phase:'failed', cwd, port:previous.port,
        message:'Remote DSH did not publish its ready URL within five minutes; check server npm/DSH logs'};
    }
    return { phase:'starting', cwd, port:previous.port, installation: previous.installation };
  }
  if (previous?.cwd === cwd && !isAlive(previous.pid)
      && Number.isFinite(previous.startedAt) && Date.now() - previous.startedAt < 45_000) {
    return { phase:'failed', cwd, port:previous.port,
      message:'Remote DSH exited during startup; check Node.js/npm and restart after the cooldown' };
  }
  // Never spawn two Web hosts for the same directory simultaneously.
  const lock = join(root, 'launch.lock');
  try { await mkdir(lock, { mode: 0o700 }); }
  catch(e) {
    if(e.code !== 'EEXIST') throw e;
    const lockMeta = await lstat(lock);
    if(!lockMeta.isDirectory() || lockMeta.isSymbolicLink()) throw new Error('unsafe remote DSH launch lock');
    if(Date.now() - lockMeta.mtimeMs > 45_000) await rm(lock, { recursive:true });
    return { phase:'starting', cwd, port:previous?.port ?? null };
  }
  try {
    // The user's explicit 'Connect with remote DSH' action authorizes
    // a pinned official npx install when no DSH executable is on PATH.
    const dsh = await run('sh', ['-c', 'command -v dsh'], cwd, 512);
    const installed = dsh.code === 0 && dsh.stdout.trim().startsWith('/');
    if (!installed && !installIfMissing) throw new Error('DSH CLI missing; installation was not approved');
    const port = await localPort();
    const launchArgs = ['web','--no-open','--host','127.0.0.1','--port',String(port)];
    const command = installed ? dsh.stdout.trim().split('\n')[0] : 'npx';
    const args = installed ? launchArgs : ['-y', '@deepseek-ai/dsh@' + OFFICIAL_DSH_VERSION, ...launchArgs];
    const file = await open(logPath, 'w', 0o600);
    let child;
    try {
      child = spawn(command,args,{
        cwd, detached:true, stdio:['ignore',file.fd,file.fd], shell:false,
        env:{...process.env, SSH_CONNECTION:process.env.SSH_CONNECTION || 'dsh-remote-ssh'}
      });
      await new Promise((resolve,reject)=>{ child.once('spawn',resolve); child.once('error',reject); });
      child.unref();
    } finally { await file.close(); }
    const registry = { cwd, port, pid:child.pid, startedAt:Date.now(),
      installation: installed?'existing':'official-npx-pinned', officialVersion:OFFICIAL_DSH_VERSION };
    await writeFile(metadataPath, JSON.stringify(registry), { mode:0o600 });
    return {phase:'starting',cwd,port,installation:registry.installation};
  } finally { await rm(lock, { recursive:true, force:true }); }
}

async function main() {
  let id = null;
  try {
    const encoded = process.argv[2];
    if (typeof encoded !== 'string' || encoded.length > MAX_REQUEST ||
        !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('invalid encoded request');
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
        parsed.protocol !== PROTOCOL) throw new Error('unsupported protocol');
    id = safeString(parsed.id, 128);
    const name = safeString(parsed.method, 32);
    const digest = createHash('sha256')
      .update(await readFile(fileURLToPath(import.meta.url))).digest('hex');
    let result;
    if (name === 'hello') {
      result = { protocol: PROTOCOL, digest, node: process.version,
        platform: process.platform, arch: process.arch, pid: process.pid };
    } else if (name === 'inspect') {
      result = await inspect(safeString(parsed.cwd));
    } else if (name === 'web.ensure') {
      result = await webEnsure(safeString(parsed.cwd), parsed.installIfMissing === true);
    } else if (name === 'dsh.version') {
      try {
        const version = await run('dsh', ['--version'], process.env.HOME || '/');
        result = { installed: version.code === 0, version: version.stdout.trim().slice(0, 200) };
      } catch { result = { installed: false }; }
    } else throw new Error('unsupported method');
    process.stdout.write(JSON.stringify({ protocol: PROTOCOL, id, ok: true, result }) + '\n');
  } catch (e) {
    process.stdout.write(JSON.stringify({ protocol: PROTOCOL, id, ...fail('REMOTE_HELPER_ERROR', e?.message || e) }) + '\n');
  }
}
await main();
