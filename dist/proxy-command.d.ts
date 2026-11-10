import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Duplex } from 'node:stream';
/** Supported OpenSSH ProxyCommand: cloudflared access ssh --hostname %h.
 * No arbitrary shell commands or redirect/pipeline expansion. */
export declare function validateCloudflaredCommand(value: string): string[];
export declare function cloudflaredProxy(command: string, hostname: string): {
    stream: Duplex;
    child: ChildProcessWithoutNullStreams;
};
