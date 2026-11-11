import crypto from 'node:crypto';
import { shellQuote } from './paths.js';
import { RemoteSshError } from './errors.js';
const MAX_OUTPUT_CHARS = 131_072;
const MAX_TERMINALS = 4;
/**
 * Browser-facing remote interactive shell. A genuine SSH PTY, independent from
 * DSH's built-in *local* terminalController. Output is polled over the existing
 * authenticated HTTP API (no second unauthenticated socket/server).
 */
export class RemoteTerminalPool {
    manager;
    terminals = new Map();
    constructor(manager) {
        this.manager = manager;
    }
    async open(hostId, remotePath) {
        if (this.terminals.size >= MAX_TERMINALS) {
            throw new RemoteSshError('SSH_CHANNEL_FAILED', 'close an existing SSH terminal before opening another');
        }
        const opened = await this.manager.openWorkspace(hostId, remotePath);
        const conn = await this.manager.connection(hostId);
        const channel = await conn.shell(100, 30);
        const term = { id: crypto.randomUUID(), hostId, remoteRoot: opened.workspace.remoteRoot,
            channel, output: '', offset: 0, closed: false, touched: Date.now() };
        const receive = (buffer) => {
            let out = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer);
            term.output += out;
            if (term.output.length > MAX_OUTPUT_CHARS) {
                const drop = term.output.length - MAX_OUTPUT_CHARS;
                term.output = term.output.slice(drop);
                term.offset += drop;
            }
            term.touched = Date.now();
        };
        channel.on('data', receive);
        channel.stderr?.on('data', receive);
        channel.on('close', () => { term.closed = true; });
        channel.on('error', (e) => { receive('\r\n[SSH channel error: ' + e.message + ']\r\n'); term.closed = true; });
        this.terminals.set(term.id, term);
        // The PTY initially starts in the SSH account's home. Move to the actual
        // workspace root before giving the user control. No arbitrary shell
        // interpolation: the canonical directory is single-quoted.
        channel.write('cd -- ' + shellQuote(term.remoteRoot) + '\n');
        return { id: term.id, hostId, remoteRoot: term.remoteRoot };
    }
    read(id, cursor) {
        const t = this.get(id);
        const from = Number.isSafeInteger(cursor) ? cursor : 0;
        const start = Math.max(t.offset, from);
        const out = t.output.slice(Math.max(0, start - t.offset));
        t.touched = Date.now();
        return { output: out, cursor: t.offset + t.output.length, closed: t.closed, truncated: from < t.offset };
    }
    write(id, input) {
        const t = this.get(id);
        if (t.closed)
            throw new RemoteSshError('SSH_CHANNEL_FAILED', 'SSH terminal is closed');
        if (Buffer.byteLength(input) > 8192)
            throw new RemoteSshError('SSH_PATH_INVALID', 'terminal input too large');
        t.channel.write(input);
        t.touched = Date.now();
    }
    resize(id, cols, rows) {
        const t = this.get(id);
        if (t.closed)
            return;
        t.channel.setWindow(Math.min(100, Math.max(5, rows)), Math.min(250, Math.max(20, cols)), 0, 0);
    }
    close(id) {
        const t = this.get(id);
        this.terminals.delete(id);
        t.closed = true;
        try {
            t.channel.close();
        }
        catch { /* already closed */ }
    }
    closeAll() {
        for (const id of [...this.terminals.keys()])
            this.close(id);
    }
    get(id) {
        const t = this.terminals.get(id);
        if (!t)
            throw new RemoteSshError('SSH_CHANNEL_FAILED', 'unknown SSH terminal; open a new terminal');
        return t;
    }
}
//# sourceMappingURL=remote-terminal.js.map