export interface EffectiveSshConfig {
    /** Original destination spelling (alias, hostname or user@host). */
    alias: string;
    hostName: string;
    port: number;
    user: string;
    identityFiles: string[];
    identitiesOnly: boolean;
    /** Whether ssh-agent may be offered as an authentication method. */
    useAgent: boolean;
    identityAgent?: string;
    proxyJump?: string;
    proxyCommand?: string;
    userKnownHostsFiles: string[];
    hostKeyAlias?: string;
    connectTimeoutSec: number;
    serverAliveIntervalSec: number;
    serverAliveCountMax: number;
    configPath?: string;
    configFound: boolean;
    matchedHostConfig: boolean;
}
/** Expand `~`, `$VAR`, and `${VAR}` in SSH config paths. */
export declare function expandUserPath(value: string): string;
/** OpenSSH-style Host pattern match, including `!` negation and `*`/`?`. */
export declare function hostPatternMatches(alias: string, pattern: string): boolean;
export interface HostRecordForConfig {
    host: string;
    sshAlias?: string;
    port?: number;
    user?: string;
    identityFile?: string;
    useAgent?: boolean;
    identityAgent?: string;
    useSshConfig?: boolean;
    configFile?: string;
    hostKeyAlias?: string;
}
/**
 * Resolve the effective SSH parameters for a stored host. Stored values win
 * over ~/.ssh/config, mirroring command-line options. A stored `host` that is
 * an alias resolves HostName/User/Port from the config.
 */
export declare function resolveSshConfig(stored: HostRecordForConfig): EffectiveSshConfig;
/** Candidate default private keys, in ssh preference order. */
export declare function defaultIdentityFiles(): string[];
/** List concrete Host aliases from config and its Includes, not wildcard patterns. */
export declare function listSshConfigAliases(configFile?: string): string[];
