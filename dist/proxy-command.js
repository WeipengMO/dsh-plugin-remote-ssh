import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';
import path from 'node:path';
import { RemoteSshError } from './errors.js';
/** Supported OpenSSH ProxyCommand: cloudflared access ssh --hostname %h.
 * No arbitrary shell commands or redirect/pipeline expansion. */
export function validateCloudflaredCommand(value) {
    const pieces = value.trim().split(/\s+/);
    const executable = path.win32.basename(pieces[0] ?? '').toLowerCase();
    if (!['cloudflared', 'cloudflared.exe'].includes(executable) || pieces.length !== 5 ||
        pieces[1] !== 'access' || pieces[2] !== 'ssh' || pieces[3] !== '--hostname' ||
        !/^[A-Za-z0-9._%:-]+$/.test(pieces[4] ?? '')) {
        throw new RemoteSshError('SSH_PROXY_UNSUPPORTED', 'ProxyCommand is not supported. Supported syntax: cloudflared access ssh --hostname %h (no shell, no arbitrary commands)');
    }
    return pieces;
}
export function cloudflaredProxy(command, hostname) {
    const [exe, , , , target] = validateCloudflaredCommand(command);
    const expanded = target.replace(/%h/g, hostname).replace(/%%/g, '%');
    if (!/^[A-Za-z0-9._:-]+$/.test(expanded))
        throw new RemoteSshError('SSH_PROXY_UNSUPPORTED', 'invalid proxy hostname');
    const child = spawn(exe, ['access', 'ssh', '--hostname', expanded], {
        shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-1500); });
    child.once('error', (err) => {
        stream.destroy(new RemoteSshError('SSH_PROXY_FAILED', `cloudflared could not start: ${err.message}. Install cloudflared on the machine running DSH.`));
    });
    child.once('exit', (code, signal) => {
        if (code !== 0 && !stream.destroyed)
            stream.destroy(new RemoteSshError('SSH_PROXY_FAILED', `cloudflared exited (${code ?? signal ?? 'unknown'}): ${stderr.trim() || 'no diagnostic text'}`));
    });
    stream.once('close', () => { if (child.exitCode === null && !child.killed)
        child.kill(); });
    return { stream, child };
}
//# sourceMappingURL=proxy-command.js.map