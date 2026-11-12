import fs from 'node:fs';
import os from 'node:os';
import { RemoteSshError, errorMessage } from './errors.js';
import { encodeRemoteEnv, looksVirtual, shellQuote } from './paths.js';
/** Detect unmistakable PowerShell-only syntax before sending it to Linux. */
// Authorize only the exact resolved ShellSpec from a policy-gated remote_bash call.
const approvedRemoteSpecs = new WeakSet();
export function authorizeRemoteBashSpec(spec) {
  if (!looksVirtual(spec.workdir)) {
    throw new RemoteSshError('SSH_PATH_INVALID', 'cannot authorize a local command as remote_bash');
  }
  approvedRemoteSpecs.add(spec);
}

export function usesPowerShellSyntax(command) {
    return /\$env:[A-Za-z_]/i.test(command)
        || /(?:^|[;&|]\s*|\n\s*)(?:Get-ChildItem|Set-Location|Select-String|Get-Content|Set-Content|Out-File|Remove-Item|New-Item|Write-Output|Get-Location|Test-Path)(?=\s|$)/i.test(command);
}
/**
 * Build the exact non-interactive OpenSSH argv. `-F none` prevents user config
 * from re-introducing password prompts or a different host/port; all effective
 * values were already resolved by the plugin. Strict host-key checking uses
 * the plugin's known_hosts, which is populated only after a verified ssh2
 * handshake.
 */
export function buildSshArgv(connection, knownHostsPath, spec) {
    const config = connection.config;
    const args = [process.env.DSH_SSH_BIN ?? 'ssh'];
    const option = (value) => {
        args.push('-o', value);
    };
    args.push('-F', 'none');
    option('BatchMode=yes');
    option('StrictHostKeyChecking=yes');
    option(`UserKnownHostsFile=${knownHostsPath}`);
    option(`GlobalKnownHostsFile=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`);
    option('UpdateHostKeys=no');
    option('CheckHostIP=no');
    option('VerifyHostKeyDNS=no');
    option('PreferredAuthentications=publickey');
    option('PubkeyAuthentication=yes');
    option('PasswordAuthentication=no');
    option('KbdInteractiveAuthentication=no');
    option('ForwardAgent=no');
    option('ForwardX11=no');
    option('ClearAllForwardings=yes');
    option('PermitLocalCommand=no');
    option('RequestTTY=no');
    option('ControlMaster=no');
    option('ConnectionAttempts=1');
    option('LogLevel=ERROR');
    option(`ConnectTimeout=${Math.max(1, config.connectTimeoutSec)}`);
    option(`ServerAliveInterval=${Math.max(0, config.serverAliveIntervalSec)}`);
    option(`ServerAliveCountMax=${Math.max(1, config.serverAliveCountMax)}`);
    if (config.identityAgent !== undefined && config.identityAgent !== 'SSH_AUTH_SOCK') {
        option(`IdentityAgent=${config.identityAgent}`);
    }
    if (config.identitiesOnly)
        option('IdentitiesOnly=yes');
    // Validated restricted cloudflared ProxyCommand: OpenSSH CLI must use the
    // same tunnel as the ssh2/SFTP transport, not silently attempt direct TCP.
    if (config.proxyCommand && config.proxyCommand.toLowerCase() !== 'none')
        option(`ProxyCommand=${config.proxyCommand}`);
    args.push('-p', String(config.port), '-l', config.user);
    for (const key of config.identityFiles)
        args.push('-i', key);
    args.push(config.hostName);
    // The *local* Windows pwsh tool can supply host PowerShell variables such as
    // PATH/PSModulePath. Never forward them to the Linux execution environment:
    // they would override Linux binaries and make bash commands fail mysteriously.
    const remoteUserEnv = Object.fromEntries(Object.entries(spec.env ?? {}).filter(([key]) => !/^(?:PATH|PATHEXT|PSMODULEPATH|COMSPEC|SYSTEMROOT|WINDIR|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|TEMP|TMP|PWD|SHELL|HOME)$/i.test(key)));
    const remoteEnv = encodeRemoteEnv({
        ...remoteUserEnv,
        NO_COLOR: '1',
        TERM: 'dumb',
        PAGER: 'cat',
        GIT_PAGER: 'cat',
        DSH_REMOTE_PLATFORM: 'linux',
        DSH_REMOTE_SHELL: 'bash',
    });
    // A Windows pwsh tool's *command text* is dispatched using Linux Bash.
    // Do not let the Windows host shell setting select PowerShell remotely.
    const command = `${remoteEnv.length > 0 ? `env ${remoteEnv} ` : ''}bash -lc ${shellQuote(spec.command)}`;
    const remote = `cd -- ${shellQuote(spec.workdir)} && exec ${command}`;
    args.push(remote);
    return args;
}
function sshFailure(result) {
    if (result?.exitCode !== 255)
        return undefined;
    const stderr = result.stderr?.text ?? '';
    if (/Host key verification failed/i.test(stderr)) {
        return new RemoteSshError('SSH_HOST_KEY_MISMATCH', `system ssh rejected the remote host key: ${stderr.trim()}`);
    }
    if (/Permission denied|authentication failed/i.test(stderr)) {
        return new RemoteSshError('SSH_AUTH_FAILED', `system ssh authentication failed: ${stderr.trim()}`);
    }
    if (/Could not resolve hostname|Connection refused|Connection timed out|No route to host/i.test(stderr)) {
        return new RemoteSshError('SSH_CONNECT_FAILED', `system ssh could not connect: ${stderr.trim()}`);
    }
    return new RemoteSshError('SSH_REMOTE_SHELL_FAILED', `system ssh failed with exit 255: ${stderr.trim() || 'no stderr'}`);
}
/**
 * Wrap `ctx.shell` so a virtual workdir transparently executes over SSH while
 * every local command still uses the untouched local sandbox executor.
 */
export function installShellRouter(ctx, manager, options = {}) {
    const shell = ctx.shell;
    const originalResolve = shell.resolve.bind(shell);
    const originalExecute = shell.execute.bind(shell);
    if (typeof shell.executeArgv !== 'function') {
        throw new RemoteSshError('SSH_FEATURE_UNSUPPORTED', 'the active shell executor has no executeArgv() boundary; cannot route remote commands');
    }
    const executeArgv = shell.executeArgv.bind(shell);
    shell.resolve = (request) => originalResolve(request);
    shell.execute = async (spec) => {
        if (!looksVirtual(spec.workdir))
            return await originalExecute(spec);
        const route = manager.routeFor(spec.workdir, spec.workdir);
        if (route === null)
            throw new RemoteSshError('SSH_PATH_INVALID', `cannot route remote workdir: ${spec.workdir}`);
        if (spec.sandboxPolicy?.mode === 'read-only') {
            throw new RemoteSshError('SSH_APPROVAL_DENIED', 'remote Bash is disabled in a read-only DSH session');
        }
        if (!approvedRemoteSpecs.delete(spec) && options.allowLegacyRemoteShell !== true) {
            throw new RemoteSshError('SSH_APPROVAL_DENIED', 'unapproved native shell call to remote SSH was blocked; use the remote_bash tool (or explicitly enable legacy remote shell compatibility)');
        }
        if (usesPowerShellSyntax(spec.command)) {
            throw new RemoteSshError('SSH_REMOTE_SHELL_FAILED', 'Remote Linux workspace uses Bash, not PowerShell. Rewrite this command using Bash/POSIX syntax (ls, grep, $HOME), then retry.');
        }
        const connection = await manager.connection(route.workspace.connectionId);
        const knownHostsPath = await manager.ensureKnownHostsFile(connection);
        try {
            const stat = fs.statSync(knownHostsPath);
            if (stat.size === 0)
                throw new Error('empty known_hosts');
        }
        catch (error) {
            throw new RemoteSshError('SSH_HOST_KEY_UNKNOWN', `cannot use the verified host-key file ${knownHostsPath}: ${errorMessage(error)}; reconnect and trust the host key first`);
        }
        // The virtual path is a local routing token; the remote shell must cd to
        // the real remote directory, never to the token path.
        const argv = buildSshArgv(connection, knownHostsPath, { ...spec, workdir: route.remotePath });
        // The SSH child runs from a real local directory; the remote cd is part of
        // the command. The tool keeps the original spec (and its virtual cwd) for
        // result rendering.
        const localSpec = {
            ...spec,
            workdir: os.tmpdir(),
            env: {},
            dshEnv: {},
        };
        const handle = (await executeArgv(localSpec, argv));
        // Defer the mapping until the caller awaits result(): background jobs use
        // the same handle and must remain live until their own timeout/kill.
        const originalResult = handle.result.bind(handle);
        handle.result = async () => {
            const result = await originalResult();
            const failure = sshFailure(result);
            if (failure !== undefined)
                throw failure;
            return result;
        };
        return handle;
    };
    const dispose = () => {
        shell.resolve = originalResolve;
        shell.execute = originalExecute;
    };
    ctx.effect?.(() => dispose);
    return { dispose };
}
//# sourceMappingURL=shell-router.js.map