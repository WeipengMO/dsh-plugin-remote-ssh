#!/usr/bin/env node
/**
 * DSH Remote SSH helper protocol v1.
 *
 * Runs ONLY as a one-shot SSH exec command. No listening socket, credentials,
 * shell command endpoint, update endpoint, or background process.
 * The parent plugin deploys the SHA-256-verified file over an authenticated SSH
 * connection. All code execution is via fixed, allowlisted argv.
 */
import { readFile, realpath, stat } from 'node:fs/promises';
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
