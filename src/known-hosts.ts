import { createHmac } from 'node:crypto';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RemoteSshError } from './errors.js';

export type HostKeyStatus = 'trusted' | 'unknown' | 'mismatch' | 'revoked';

export interface HostKeyVerification {
  status: HostKeyStatus;
  trusted: boolean;
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
  /** Base64 public-key blob; safe to show and needed for explicit trust. */
  keyBase64: string;
  knownFingerprints: string[];
  source?: string;
}

interface KnownKey {
  type: string;
  base64: string;
  blob: Buffer;
  fingerprint: string;
  hostPattern: string;
  marker?: string;
  source: string;
}

interface TrustedEntry {
  host: string;
  port: number;
  keyType: string;
  key: string;
  addedAt: string;
}

interface TrustFile {
  version: 1;
  entries: TrustedEntry[];
}

/** Parse the SSH wire-format key type from a public key blob. */
export function keyTypeOf(blob: Buffer): string {
  if (blob.length < 4) return 'unknown';
  const length = blob.readUInt32BE(0);
  if (length <= 0 || length > blob.length - 4) return 'unknown';
  return blob.subarray(4, 4 + length).toString('ascii');
}

/** OpenSSH-style SHA256 fingerprint, without padding. */
export function sha256Fingerprint(blob: Buffer): string {
  return `SHA256:${crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

/** Convert a public key blob to a known_hosts line for the given host/port. */
export function knownHostsLine(host: string, port: number, blob: Buffer): string {
  const type = keyTypeOf(blob);
  const base64 = blob.toString('base64');
  const hostField = port === 22 ? host : `[${host}]:${port}`;
  return `${hostField} ${type} ${base64}`;
}

function hostField(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

function wildcardMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i').test(value);
}

function matchHostPattern(pattern: string, host: string, port: number): boolean {
  const field = hostField(host, port);
  let matched = false;
  for (const token of pattern.split(',')) {
    const trimmed = token.trim();
    if (trimmed.length === 0) continue;
    const negated = trimmed.startsWith('!');
    const body = negated ? trimmed.slice(1) : trimmed;
    let hit = false;
    if (body.startsWith('|1|')) {
      const parts = body.split('|');
      if (parts.length === 4) {
        const salt = Buffer.from(parts[2]!, 'base64');
        const expected = parts[3]!;
        const digest = createHmac('sha1', salt).update(field).digest('base64');
        hit = digest === expected;
      }
    } else {
      hit = wildcardMatch(body, field) || (port !== 22 && wildcardMatch(body, host));
    }
    if (negated && hit) return false;
    if (!negated && hit) matched = true;
  }
  return matched;
}

function readKnownKeys(files: string[]): KnownKey[] {
  const keys: KnownKey[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.length === 0 || line.startsWith('#')) continue;
      const fields = line.split(/\s+/);
      let marker: string | undefined;
      let index = 0;
      if (fields[0]?.startsWith('@')) {
        marker = fields[0];
        index = 1;
      }
      const pattern = fields[index];
      const type = fields[index + 1];
      const base64 = fields[index + 2];
      if (pattern === undefined || type === undefined || base64 === undefined) continue;
      let blob: Buffer;
      try {
        blob = Buffer.from(base64, 'base64');
      } catch {
        continue;
      }
      if (blob.length === 0) continue;
      keys.push({ hostPattern: pattern, type, base64, blob, fingerprint: sha256Fingerprint(blob), marker, source: file });
    }
  }
  return keys;
}

function parseTrustFile(file: string): TrustFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as TrustFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return { version: 1, entries: [] };
    return parsed;
  } catch {
    return { version: 1, entries: [] };
  }
}

function writePrivate(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/**
 * Strict host-key verifier. There is deliberately no "accept everything"
 * path: unknown keys fail with the key material so the caller can ask the
 * user, and changed keys fail closed.
 */
export class HostKeyStore {
  readonly storageDir: string;
  readonly knownHostsPath: string;
  private readonly trustPath: string;
  private userKnownHostsFiles: string[];
  private entries: TrustedEntry[] | undefined;

  constructor(storageDir: string, userKnownHostsFiles: string[]) {
    this.storageDir = storageDir;
    this.knownHostsPath = path.join(storageDir, 'known_hosts');
    this.trustPath = path.join(storageDir, 'trusted_hosts.json');
    this.userKnownHostsFiles = userKnownHostsFiles;
    try {
      fs.mkdirSync(storageDir, { recursive: true, mode: 0o700 });
    } catch {
      // A read-only home still allows an in-memory trust store; connections
      // that need system ssh will fail with an explicit error later.
    }
  }

  private load(): TrustedEntry[] {
    if (this.entries !== undefined) return this.entries;
    this.entries = parseTrustFile(this.trustPath).entries;
    return this.entries;
  }

  private save(): void {
    const payload: TrustFile = { version: 1, entries: this.load() };
    try {
      writePrivate(this.trustPath, `${JSON.stringify(payload, null, 2)}\n`);
    } catch (error) {
      throw new RemoteSshError('SSH_IO_ERROR', `cannot write host-key trust store: ${(error as Error).message}`);
    }
  }

  /** Verify a server key blob against user known_hosts and the plugin store. */
  verify(host: string, port: number, blob: Buffer): HostKeyVerification {
    const type = keyTypeOf(blob);
    const fingerprint = sha256Fingerprint(blob);
    const base64 = blob.toString('base64');
    const known = readKnownKeys([...this.userKnownHostsFiles, this.knownHostsPath]);
    const sameHost = known.filter((entry) => matchHostPattern(entry.hostPattern, host, port));
    const knownFingerprints = sameHost
      .filter((entry) => entry.type === type && entry.marker !== '@cert-authority')
      .map((entry) => entry.fingerprint);
    const revoked = sameHost.find((entry) => entry.marker === '@revoked' && entry.type === type && entry.base64 === base64);
    if (revoked !== undefined) {
      return { status: 'revoked', trusted: false, host, port, keyType: type, fingerprint, keyBase64: base64, knownFingerprints, source: revoked.source };
    }
    const exact = sameHost.find((entry) => entry.marker !== '@revoked' && entry.type === type && entry.base64 === base64);
    if (exact !== undefined) {
      // Cache a user-known key in the plugin store so the system-ssh shell
      // transport can also verify it without prompting.
      this.remember(host, port, type, base64);
      return { status: 'trusted', trusted: true, host, port, keyType: type, fingerprint, keyBase64: base64, knownFingerprints, source: exact.source };
    }
    const trusted = this.load().find((entry) => entry.host === host && entry.port === port && entry.keyType === type && entry.key === base64);
    if (trusted !== undefined) {
      return { status: 'trusted', trusted: true, host, port, keyType: type, fingerprint, keyBase64: base64, knownFingerprints, source: this.trustPath };
    }
    if (knownFingerprints.length > 0) {
      return { status: 'mismatch', trusted: false, host, port, keyType: type, fingerprint, keyBase64: base64, knownFingerprints };
    }
    return { status: 'unknown', trusted: false, host, port, keyType: type, fingerprint, keyBase64: base64, knownFingerprints };
  }

  /** Explicitly trust one key; the fingerprint must match the supplied key. */
  trust(host: string, port: number, blob: Buffer, expectedFingerprint: string): TrustedEntry {
    const type = keyTypeOf(blob);
    const fingerprint = sha256Fingerprint(blob);
    if (fingerprint !== expectedFingerprint) {
      throw new RemoteSshError(
        'SSH_HOST_KEY_MISMATCH',
        `host key fingerprint changed between inspection (${expectedFingerprint}) and trust (${fingerprint}); retry the connection`,
      );
    }
    const entry: TrustedEntry = { host, port, keyType: type, key: blob.toString('base64'), addedAt: new Date().toISOString() };
    this.remember(host, port, type, entry.key);
    return entry;
  }

  private remember(host: string, port: number, keyType: string, base64: string): void {
    const entries = this.load();
    if (entries.some((entry) => entry.host === host && entry.port === port && entry.keyType === keyType && entry.key === base64)) {
      this.writeKnownHostsFile();
      return;
    }
    entries.push({ host, port, keyType, key: base64, addedAt: new Date().toISOString() });
    this.save();
    this.writeKnownHostsFile();
  }

  /** Materialize all trusted keys in a stable file used by system ssh. */
  writeKnownHostsFile(): void {
    const lines = this.load().map((entry) => knownHostsLine(entry.host, entry.port, Buffer.from(entry.key, 'base64')));
    try {
      writePrivate(this.knownHostsPath, lines.length > 0 ? `${lines.join('\n')}\n` : '');
    } catch {
      // The shell wrapper checks readability and emits an explicit error.
    }
  }

  setUserKnownHostsFiles(files: string[]): void {
    this.userKnownHostsFiles = [...files];
  }

  list(): TrustedEntry[] {
    return [...this.load()];
  }

  remove(host: string, port?: number): number {
    const before = this.load().length;
    const entries = this.load().filter((entry) => entry.host !== host || (port !== undefined && entry.port !== port));
    this.entries = entries;
    this.save();
    this.writeKnownHostsFile();
    return before - entries.length;
  }
}
