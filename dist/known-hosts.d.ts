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
interface TrustedEntry {
    host: string;
    port: number;
    keyType: string;
    key: string;
    addedAt: string;
}
/** Parse the SSH wire-format key type from a public key blob. */
export declare function keyTypeOf(blob: Buffer): string;
/** OpenSSH-style SHA256 fingerprint, without padding. */
export declare function sha256Fingerprint(blob: Buffer): string;
/** Convert a public key blob to a known_hosts line for the given host/port. */
export declare function knownHostsLine(host: string, port: number, blob: Buffer): string;
/**
 * Strict host-key verifier. There is deliberately no "accept everything"
 * path: unknown keys fail with the key material so the caller can ask the
 * user, and changed keys fail closed.
 */
export declare class HostKeyStore {
    readonly storageDir: string;
    readonly knownHostsPath: string;
    private readonly trustPath;
    private userKnownHostsFiles;
    private entries;
    constructor(storageDir: string, userKnownHostsFiles: string[]);
    private load;
    private save;
    /** Verify a server key blob against user known_hosts and the plugin store. */
    verify(host: string, port: number, blob: Buffer): HostKeyVerification;
    /** Explicitly trust one key; the fingerprint must match the supplied key. */
    trust(host: string, port: number, blob: Buffer, expectedFingerprint: string): TrustedEntry;
    private remember;
    /** Materialize all trusted keys in a stable file used by system ssh. */
    writeKnownHostsFile(): void;
    setUserKnownHostsFiles(files: string[]): void;
    list(): TrustedEntry[];
    remove(host: string, port?: number): number;
}
export {};
