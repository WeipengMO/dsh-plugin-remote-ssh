import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RemoteSshError } from './errors.js';
import { validateCloudflaredCommand } from './proxy-command.js';
const DEFAULT_KEYS = ['id_ed25519', 'id_ecdsa', 'id_rsa'];
const HOME = os.homedir();
/** Expand `~`, `$VAR`, and `${VAR}` in SSH config paths. */
export function expandUserPath(value) {
    let expanded = value;
    if (expanded === '~')
        expanded = HOME;
    else if (expanded.startsWith('~/') || expanded.startsWith('~\\'))
        expanded = path.join(HOME, expanded.slice(2));
    expanded = expanded.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_all, a, b) => process.env[a ?? b] ?? '');
    return path.normalize(expanded);
}
/** Split one config line into tokens, honoring double/single quotes and comments. */
function splitConfigLine(raw) {
    const tokens = [];
    let current = '';
    let quote;
    for (let i = 0; i < raw.length; i += 1) {
        const char = raw[i];
        if (quote !== undefined) {
            if (char === quote)
                quote = undefined;
            else if (char === '\\' && quote === '"' && i + 1 < raw.length && (raw[i + 1] === '"' || raw[i + 1] === '\\')) {
                i += 1;
                current += raw[i];
            }
            else
                current += char;
            continue;
        }
        if (char === '#' && current.trim().length === 0)
            break;
        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }
        if (char === '=' && current.trim().length > 0) {
            tokens.push(current.trim());
            current = '';
            continue;
        }
        if (/\s/.test(char)) {
            if (current.length > 0) {
                tokens.push(current);
                current = '';
            }
            continue;
        }
        current += char;
    }
    if (current.length > 0)
        tokens.push(current);
    return tokens;
}
/** OpenSSH-style Host pattern match, including `!` negation and `*`/`?`. */
export function hostPatternMatches(alias, pattern) {
    let matched = false;
    for (const rawToken of pattern.split(/[\s,]+/)) {
        if (rawToken.length === 0)
            continue;
        const negated = rawToken.startsWith('!');
        const token = negated ? rawToken.slice(1) : rawToken;
        const escaped = token.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
        const hit = new RegExp(`^${escaped}$`, 'i').test(alias);
        if (negated && hit)
            return false;
        if (!negated && hit)
            matched = true;
    }
    return matched;
}
function expandInclude(value) {
    const expanded = expandUserPath(value);
    const base = path.isAbsolute(expanded) ? expanded : path.join(HOME, '.ssh', expanded);
    if (!/[*?]/.test(base))
        return [base];
    try {
        const globSync = fs.globSync;
        if (typeof globSync === 'function')
            return globSync(base);
        return [];
    }
    catch {
        return [];
    }
}
/** Parse a config file into ordered Host blocks, following Include recursively. */
function parseConfigFile(file, seen, depth) {
    if (depth > 8)
        return [];
    let real;
    try {
        real = fs.realpathSync(file);
    }
    catch {
        return [];
    }
    if (seen.has(real))
        return [];
    seen.add(real);
    let text;
    try {
        text = fs.readFileSync(real, 'utf8');
    }
    catch {
        return [];
    }
    const blocks = [];
    let current;
    for (const line of text.split(/\r?\n/)) {
        const tokens = splitConfigLine(line);
        if (tokens.length === 0)
            continue;
        const keyword = tokens[0].toLowerCase();
        if (keyword === 'host') {
            current = { patterns: tokens.slice(1), values: new Map() };
            blocks.push(current);
            continue;
        }
        if (keyword === 'match') {
            // We do not evaluate Match predicates; such a block never applies.
            current = { patterns: [], values: new Map() };
            blocks.push(current);
            continue;
        }
        if (keyword === 'include') {
            for (const include of tokens.slice(1)) {
                for (const included of expandInclude(include))
                    blocks.push(...parseConfigFile(included, seen, depth + 1));
            }
            continue;
        }
        if (current === undefined)
            continue;
        const value = tokens.slice(1).join(' ');
        if (value.length === 0)
            continue;
        const list = current.values.get(keyword) ?? [];
        current.values.set(keyword, [...list, value]);
    }
    return blocks;
}
/**
 * Resolve the effective SSH parameters for a stored host. Stored values win
 * over ~/.ssh/config, mirroring command-line options. A stored `host` that is
 * an alias resolves HostName/User/Port from the config.
 */
export function resolveSshConfig(stored) {
    let alias = stored.host.trim();
    if (alias.length === 0)
        throw new RemoteSshError('SSH_CONFIG_INVALID', 'host must not be empty');
    let explicitUser = stored.user;
    if (alias.includes('@')) {
        const at = alias.lastIndexOf('@');
        explicitUser = explicitUser ?? alias.slice(0, at);
        alias = alias.slice(at + 1);
    }
    if (alias.length === 0)
        throw new RemoteSshError('SSH_CONFIG_INVALID', 'host must not be empty');
    if (alias.startsWith('-'))
        throw new RemoteSshError('SSH_CONFIG_INVALID', 'host must not start with "-"');
    const useSshConfig = stored.useSshConfig !== false;
    const configFile = stored.configFile !== undefined ? expandUserPath(stored.configFile) : path.join(HOME, '.ssh', 'config');
    const blocks = useSshConfig ? parseConfigFile(configFile, new Set(), 0) : [];
    const configFound = useSshConfig && fs.existsSync(configFile);
    const matchedHostConfig = blocks.some((block) => block.patterns.length > 0 && hostPatternMatches(alias, block.patterns.join(' ')));
    const collected = new Map();
    const identityFileValues = [];
    for (const block of blocks) {
        if (block.patterns.length === 0)
            continue;
        // OpenSSH evaluates all patterns on a Host line together: a negated
        // pattern (`!name`) vetoes the block even when another pattern matches.
        // Testing them with `.some()` would let `Host prod-* !prod-db` wrongly
        // apply to prod-db, so join them into one pattern expression instead.
        const applies = hostPatternMatches(alias, block.patterns.join(' '));
        if (!applies)
            continue;
        for (const [key, values] of block.values) {
            // OpenSSH IdentityFile is additive (unlike scalar options, where first wins).
            if (key === 'identityfile')
                identityFileValues.push(...values);
            else if (!collected.has(key))
                collected.set(key, values[0]);
        }
    }
    const rawHostName = collected.get('hostname') ?? alias;
    const hostName = rawHostName.replace(/%h/g, alias);
    const user = explicitUser ?? collected.get('user') ?? process.env.USER ?? process.env.USERNAME ?? os.userInfo().username;
    const portText = stored.port !== undefined ? String(stored.port) : collected.get('port') ?? '22';
    const port = Number(portText);
    if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
        throw new RemoteSshError('SSH_CONFIG_INVALID', `invalid SSH port: ${portText}`);
    }
    const configuredKeys = [];
    if (stored.identityFile !== undefined)
        configuredKeys.push(expandUserPath(stored.identityFile));
    for (const identityValue of identityFileValues) {
        for (const token of [identityValue]) {
            configuredKeys.push(expandUserPath(token
                .replace(/%d/g, HOME)
                .replace(/%h/g, hostName)
                .replace(/%n/g, alias)
                .replace(/%r/g, user)
                .replace(/%u/g, process.env.USER ?? os.userInfo().username)));
        }
    }
    const identityFiles = [...new Set(configuredKeys)];
    const identitiesOnly = stored.identityFile !== undefined || (collected.get('identitiesonly') ?? '').toLowerCase() === 'yes';
    let identityAgent = stored.identityAgent ?? collected.get('identityagent');
    if (identityAgent !== undefined) {
        const trimmed = identityAgent.trim();
        if (trimmed.toLowerCase() === 'none')
            identityAgent = undefined;
        else if (trimmed.toLowerCase() !== 'ssh_auth_sock')
            identityAgent = expandUserPath(trimmed);
    }
    if (identityAgent === undefined && process.env.SSH_AUTH_SOCK !== undefined)
        identityAgent = process.env.SSH_AUTH_SOCK;
    const proxyJump = collected.get('proxyjump');
    const proxyCommand = collected.get('proxycommand');
    if (proxyJump !== undefined && proxyJump.toLowerCase() !== 'none') {
        throw new RemoteSshError('SSH_PROXY_UNSUPPORTED', `ProxyJump is configured for "${alias}" but is not supported by the SFTP transport; connect through a direct host or ask the operator to use a port-forwarded alias`);
    }
    // ProxyCommand is validated and executed by a strict, no-shell allowlist in proxy-command.ts.
    // Unsupported commands must never be silently bypassed and connected directly.
    if (proxyCommand !== undefined && proxyCommand.toLowerCase() !== 'none') {
        validateCloudflaredCommand(proxyCommand);
    }
    const knownHostsText = collected.get('userknownhostsfile');
    const userKnownHostsFiles = knownHostsText !== undefined
        ? splitConfigLine(knownHostsText).map(expandUserPath)
        : [path.join(HOME, '.ssh', 'known_hosts'), path.join(HOME, '.ssh', 'known_hosts2')];
    return {
        alias,
        hostName,
        port,
        user,
        identityFiles,
        identitiesOnly,
        // Stored `useAgent` wins; absent means enabled. On Windows the named pipe
        // exists even when SSH_AUTH_SOCK is unset, so the default is usable there.
        useAgent: stored.useAgent ?? true,
        identityAgent,
        proxyJump,
        proxyCommand,
        userKnownHostsFiles,
        hostKeyAlias: stored.hostKeyAlias ?? collected.get('hostkeyalias'),
        connectTimeoutSec: Number(collected.get('connecttimeout') ?? '15') || 15,
        serverAliveIntervalSec: Number(collected.get('serveraliveinterval') ?? '15') || 15,
        serverAliveCountMax: Number(collected.get('serveralivecountmax') ?? '3') || 3,
        configPath: useSshConfig ? configFile : undefined,
        configFound, matchedHostConfig,
    };
}
/** Candidate default private keys, in ssh preference order. */
export function defaultIdentityFiles() {
    return DEFAULT_KEYS.map((name) => path.join(HOME, '.ssh', name)).filter((file) => {
        try {
            return fs.statSync(file).isFile();
        }
        catch {
            return false;
        }
    });
}
/** List concrete Host aliases from config and its Includes, not wildcard patterns. */
export function listSshConfigAliases(configFile = path.join(HOME, '.ssh', 'config')) {
    const blocks = parseConfigFile(expandUserPath(configFile), new Set(), 0);
    const aliases = new Set();
    for (const block of blocks)
        for (const alias of block.patterns) {
            if (alias && !/[*!?]/.test(alias) && !alias.startsWith('-') && !/[\s\0]/.test(alias))
                aliases.add(alias);
        }
    return [...aliases].sort((a, b) => a.localeCompare(b)).slice(0, 200);
}
//# sourceMappingURL=ssh-config.js.map