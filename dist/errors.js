/** Error type shared by connection, filesystem and tool code. */
export class RemoteSshError extends Error {
    code;
    details;
    constructor(code, message, details) {
        super(message);
        this.name = code.startsWith('FS_') ? 'FsError' : 'RemoteSshError';
        this.code = code;
        this.details = details;
    }
}
export function isRemoteSshError(error) {
    return error instanceof RemoteSshError;
}
/** Abort helper: every long operation checks this and raises a stable FS_ABORTED. */
export function throwIfAborted(signal, verb) {
    if (signal?.aborted)
        throw new RemoteSshError('FS_ABORTED', `${verb} aborted`);
}
/** Strip private-key-looking material from an error string before logging. */
export function redactSecrets(value) {
    return value
        .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[redacted private key]')
        .replace(/\b(password|passphrase)\s*[=:]\s*\S+/gi, '$1=[redacted]');
}
/** Normalize an unknown thrown value into a message without leaking stack details. */
export function errorMessage(error) {
    if (error instanceof Error)
        return redactSecrets(error.message);
    return redactSecrets(String(error));
}
//# sourceMappingURL=errors.js.map