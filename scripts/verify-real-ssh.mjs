#!/usr/bin/env node
/**
 * Real-SSH acceptance harness for the Linux DSH Host.
 *
 * OPT-IN ONLY: does nothing unless DSH_REMOTE_SSH_E2E=1 is set. It never
 * prints private key material, the launch token or the session cookie. It
 * verifies the SSH host key fingerprint against the operator's trusted_hosts
 * file, deploys the SHA-256-verified helper, reuses the running Linux DSH
 * Web, exchanges the launch token through an SSH loopback tunnel and proves
 * that the real Linux DSH CLI answers a DSH `session/list` RPC.
 *
 * Overrides: DSH_SSH_HOST_ID, DSH_SSH_REMOTE_PATH.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { RemoteSshManager } from '../dist/manager.js'
import { RemoteHostRuntimePool } from '../dist/remote-host-runtime.js'
import { RemoteDshWebTunnelPool } from '../dist/dsh-web-tunnel.js'
import { createNativeHttpHandler } from '../dist/http-api.js'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const STEP_TIMEOUT_MS = 30_000

if (process.env.DSH_REMOTE_SSH_E2E !== '1') {
  console.log('verify-real-ssh: dry run. Set DSH_REMOTE_SSH_E2E=1 to run against the saved Linux SSH host.')
  process.exit(0)
}

const logger = {
  info: (message) => console.log(`[info] ${message}`),
  warn: (message) => console.warn(`[warn] ${message}`),
  error: (message) => console.error(`[error] ${message}`),
}
const storage = path.join(os.homedir(), '.dsh', 'remote-ssh')
const hosts = JSON.parse(fs.readFileSync(path.join(storage, 'hosts.json'), 'utf8'))
const trusted = JSON.parse(fs.readFileSync(path.join(storage, 'trusted_hosts.json'), 'utf8'))
const hostId = process.env.DSH_SSH_HOST_ID || hosts.hosts[0]?.id
const remotePath = process.env.DSH_SSH_REMOTE_PATH || '/data/user/mowp/test/dsh_test'
const host = hosts.hosts.find((item) => item.id === hostId)
if (!host) throw new Error(`saved SSH host ${String(hostId)} not found in hosts.json`)
if (!host.identityFile || !fs.existsSync(host.identityFile)) {
  throw new Error(`identity file for ${host.label} is missing`)
}

/** Copy the read-only config into a workspace-local temp dir for the manager. */
const scratch = path.join(root, '.verify-ssh-tmp')
fs.mkdirSync(scratch, { recursive: true })
for (const name of ['hosts.json', 'trusted_hosts.json', 'known_hosts', 'workspaces.json']) {
  const source = path.join(storage, name)
  if (fs.existsSync(source)) fs.copyFileSync(source, path.join(scratch, name))
}

const privateKey = fs.readFileSync(host.identityFile)
const trust = trusted.entries.find((entry) => entry.host === host.host && entry.port === (host.port ?? 22))
if (!trust) throw new Error(`no trusted host key for ${host.host}:${String(host.port ?? 22)}`)
const expectedFingerprint = crypto.createHash('sha256')
  .update(Buffer.from(trust.key, 'base64')).digest('base64')

const { Client } = require('../vendor/ssh2/lib/index.js')
let manager
let runtime
let relay
const openSockets = new Set()

function withTimeout(promise, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => { timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${STEP_TIMEOUT_MS}ms`)),
      STEP_TIMEOUT_MS,
    ) }),
  ]).finally(() => clearTimeout(timer))
}

/** Independent strict host-key + environment probe over the vendored ssh2. */
async function probeEnvironment() {
  return await withTimeout(new Promise((resolve, reject) => {
    const connection = new Client()
    let done = false
    const settle = (fn, value) => { if (!done) { done = true; fn(value); } }
    connection.on('error', (cause) => settle(reject, cause))
    connection.on('ready', () => {
      connection.exec(
        "printf 'BEGIN\\n'; uname -srm; node --version 2>&1 || true; dsh --version 2>&1 || true; git --version 2>&1 || true; printf 'END\\n'",
        (error, stream) => {
          if (error) { connection.end(); settle(reject, error); return }
          const chunks = []
          stream.on('data', (chunk) => chunks.push(chunk))
          stream.on('close', (code) => {
            connection.end()
            if (code !== 0) { settle(reject, new Error(`probe exited ${String(code)}`)); return }
            settle(resolve, Buffer.concat(chunks).toString('utf8'))
          })
        },
      )
    })
    connection.connect({
      host: host.host,
      port: host.port ?? 22,
      username: host.user,
      privateKey,
      readyTimeout: 15_000,
      hostVerifier: (key) => {
        const fingerprint = crypto.createHash('sha256').update(key).digest('base64')
        if (fingerprint !== expectedFingerprint) {
          logger.error('SSH host key fingerprint mismatch — refusing to connect')
          return false
        }
        return true
      },
    })
  }), 'SSH environment probe')
}

/** Bind a private loopback relay and pipe each socket through an SSH channel. */
async function openRelay(port, connection) {
  const server = net.createServer((client) => {
    openSockets.add(client)
    client.on('close', () => openSockets.delete(client))
    client.on('error', () => client.destroy())
    void connection.forwardLoopback(port).then((channel) => {
      if (client.destroyed) { channel.destroy(); return }
      openSockets.add(channel)
      channel.on('close', () => { openSockets.delete(channel); client.destroy() })
      channel.on('error', () => client.destroy())
      client.pipe(channel).pipe(client)
    }).catch(() => client.destroy())
  })
  await withTimeout(new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  }), 'local relay bind')
  relay = server
  return server.address().port
}

function closeRelay() {
  return new Promise((resolve) => {
    for (const item of openSockets) item.destroy()
    openSockets.clear()
    if (!relay) { resolve(); return }
    const server = relay
    relay = undefined
    server.close(() => resolve())
  })
}

/** Exchange the launch token for a cookie; the cookie never leaves this process. */
async function authenticate(port, launchUrl) {
  const localPort = await openRelay(port, await manager.connection(hostId))
  const base = `http://127.0.0.1:${localPort}`
  const launch = new URL(launchUrl)
  const auth = await withTimeout(fetch(new URL(launch.pathname + launch.search, base),
    { redirect: 'manual' }), 'launch token exchange')
  const cookies = typeof auth.headers.getSetCookie === 'function'
    ? auth.headers.getSetCookie() : [auth.headers.get('set-cookie') ?? '']
  await auth.body?.cancel()
  const cookie = cookies.map((value) => value.split(';')[0]?.trim())
    .filter((value) => value && value.includes('=')).join('; ')
  if (!cookie) throw new Error('Linux DSH Web did not issue an authentication cookie')
  logger.info(`token exchanged (HTTP ${auth.status}, cookie pairs ${String(cookies.length)})`)
  return { base, cookie }
}

/** Call one real Gateway unary RPC on the Linux DSH CLI. */
async function remoteRpc(auth, endpoint, args) {
  const response = await withTimeout(fetch(new URL(`/api/${endpoint}`, auth.base), {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: auth.cookie },
    body: JSON.stringify({
      type: 'client-request', rpcId: crypto.randomUUID(),
      method: endpoint, payload: { args },
    }),
  }), `DSH ${endpoint} RPC`)
  const body = await response.json()
  if (response.status !== 200 || body.type !== 'server-response' || body.result?.ok !== true) {
    throw new Error(`Linux DSH rejected ${endpoint}: HTTP ${response.status} ${JSON.stringify(body).slice(0, 240)}`)
  }
  return body.result.value
}

/** Prove that real Linux DSH Sessions are created and owned by that Host. */
async function exerciseRemoteRpc(port, launchUrl, createSession) {
  const auth = await authenticate(port, launchUrl)
  try {
    // session/create's wire parameter is `request` (session/list uses
    // `_request`); both come from the generated Typert descriptor.
    let value = await remoteRpc(auth, 'session/list', { _request: {} })
    let items = Array.isArray(value?.items) ? value.items : []
    if (createSession && items.length === 0) {
      // Create only one verifier Session per Host so repeated acceptance runs
      // do not accumulate test Sessions on the operator's Linux DSH.
      const created = await remoteRpc(auth, 'session/create', { request: { cwd: remotePath } })
      logger.info(`Linux DSH created Session ${String(created?.sessionId ?? 'unknown')} in ${remotePath}`)
      value = await remoteRpc(auth, 'session/list', { _request: {} })
      items = Array.isArray(value?.items) ? value.items : []
    } else if (createSession) {
      logger.info('Linux DSH already has Sessions; reusing them for the acceptance run')
    }
    logger.info(`Linux DSH answered session/list with ${String(items.length)} real Session(s)`)
    // Git writes, worktrees, sandbox, PTY, LSP and file watching all use this
    // same authenticated Linux DSH carrier (the /api/remote.mux stream).
    return items
  } finally { await closeRelay() }
}

/** Exercise the same authenticated API and scoped tunnel used by Desktop. */
async function verifyDesktopOpen() {
  const tunnels = new RemoteDshWebTunnelPool(manager)
  const handler = createNativeHttpHandler({ manager, remoteRuntime: runtime, dshWebTunnels: tunnels,
    desktopProfile: true, agents: new Map(), previousCwd: new Map(), requestRejection() {} })
  const server = http.createServer(handler)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/remote-ssh/runtime/web/open`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-remote-ssh': '1' },
      body: JSON.stringify({ host: hostId, path: remotePath, installIfMissing: false }),
    })
    const opened = await response.json()
    if (!response.ok || opened.phase !== 'ready') throw new Error(`Desktop open failed: ${opened.error || opened.phase}`)
    const login = await fetch(opened.url, { redirect: 'manual' })
    const cookie = login.headers.get('set-cookie')?.split(';')[0]
    await login.body?.cancel()
    if (login.status !== 303 || !cookie) throw new Error('Desktop tunnel authentication failed')
    const auth = { base: new URL(opened.url).origin, cookie }
    const sessions = await remoteRpc(auth, 'session/list', { _request: {} })
    if (!Array.isArray(sessions?.items)) throw new Error('Desktop tunnel returned an invalid Session list')
    logger.info(`Desktop open API and scoped tunnel returned ${sessions.items.length} real Session(s)`)
    console.log('DESKTOP_OPEN_CHAIN_OK')
  } finally {
    tunnels.closeAll()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}

async function main() {
  const output = await probeEnvironment()
  console.log(output.trim())
  if (!/^Linux /m.test(output)) throw new Error('remote platform is not Linux')
  const node = /v(\d+)\.(\d+)\.(\d+)/.exec(output)
  if (!node || Number(node[1]) < 24 || (Number(node[1]) === 24 && Number(node[2]) < 9)) {
    throw new Error('remote Node.js must be >= 24.9')
  }
  if (!/dsh|0\.2\./.test(output)) throw new Error('remote dsh CLI is not available')
  if (!/git version/.test(output)) throw new Error('remote git is not available')

  manager = new RemoteSshManager({ storageDir: scratch, maxRecent: 20 }, logger)
  runtime = new RemoteHostRuntimePool(manager)
  const info = await withTimeout(runtime.connect(hostId), 'helper bootstrap')
  logger.info(`helper verified (digest ${info.helperHash.slice(0, 16)}, Node ${info.node}, ${info.platform})`)

  let status = await runtime.ensureWeb(hostId, remotePath, false)
  for (let attempt = 0; status.phase === 'starting' && attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000))
    status = await runtime.ensureWeb(hostId, remotePath, false)
  }
  if (status.phase !== 'ready' || !status.url) {
    throw new Error(`remote DSH Web did not become ready: ${status.phase} ${status.message ?? ''}`)
  }
  logger.info(`Linux DSH Web ready on remote port ${String(status.port)} (${status.installation ?? 'unknown'})`)
  // Never print the launch URL: it contains the process-scoped token.
  const inspection = await runtime.inspect(hostId, remotePath)
  const git = inspection.git
  logger.info(git.available
    ? `real Git: root=${git.root ?? 'n/a'} branch=${git.branch ?? 'n/a'} head=${String(git.head ?? 'n/a').slice(0, 12)}`
    : `real Git: directory is not a Git repository (${git.message ?? 'no root'}) — Git writes belong to the Linux DSH Host`)

  const first = await exerciseRemoteRpc(status.port, status.url, true)
  // Reuse: the same remote port must answer again after the tunnel is torn down.
  const reused = await runtime.ensureWeb(hostId, remotePath, false)
  if (reused.phase !== 'ready' || reused.port !== status.port || !reused.url) {
    throw new Error('remote DSH Web was not reusable after a disconnect')
  }
  logger.info('remote DSH Web reused with the same port after tunnel teardown')
  const recovered = await exerciseRemoteRpc(reused.port, reused.url, false)
  if (first.length > 0 && recovered.length < first.length) {
    throw new Error('remote Sessions were lost across the reconnect')
  }
  logger.info('remote Sessions survived the reconnect (ownership preserved)')
  await verifyDesktopOpen()
  console.log('REAL_SSH_E2E_OK')
}

try {
  await main()
} catch (error) {
  logger.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
} finally {
  await closeRelay()
  runtime?.closeAll()
  manager?.closeAll()
  fs.rmSync(scratch, { recursive: true, force: true })
}
