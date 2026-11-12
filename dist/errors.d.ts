/** Stable error codes surfaced to the model and logs. Never include secrets. */
export type RemoteSshErrorCode = 'SSH_CONFIG_INVALID' | 'SSH_HOST_NOT_FOUND' | 'SSH_HOST_KEY_UNKNOWN' | 'SSH_HOST_KEY_MISMATCH' | 'SSH_HOST_KEY_REVOKED' | 'SSH_AUTH_FAILED' | 'SSH_AUTH_UNAVAILABLE' | 'SSH_CONNECT_FAILED' | 'SSH_CONNECT_TIMEOUT' | 'SSH_CONNECTION_TIMEOUT' | 'SSH_CONNECTION_LOST' | 'SSH_CHANNEL_FAILED' | 'SSH_PROXY_UNSUPPORTED' | 'SSH_PROXY_FAILED' | 'SSH_WORKSPACE_UNKNOWN' | 'SSH_PATH_INVALID' | 'SSH_PATH_UNREPRESENTABLE' | 'SSH_NOT_DIRECTORY' | 'SSH_NOT_FOUND' | 'SSH_PERMISSION_DENIED' | 'SSH_IO_ERROR' | 'SSH_REMOTE_SHELL_FAILED' | 'SSH_FEATURE_UNSUPPORTED' | 'SSH_SEARCH_LIMIT' | 'SSH_SEARCH_INVALID_PATTERN' | 'SSH_APPROVAL_DENIED' | 'FS_NOT_FOUND' | 'FS_ALREADY_EXISTS' | 'FS_PERMISSION_DENIED' | 'FS_NOT_DIRECTORY' | 'FS_NOT_REGULAR_FILE' | 'FS_NOT_TEXT' | 'FS_TOO_LARGE' | 'FS_NOT_OBSERVED' | 'FS_STALE_VERSION' | 'FS_EDIT_NOT_FOUND' | 'FS_AMBIGUOUS_EDIT' | 'FS_PATCH_MISMATCH' | 'FS_SAME_TARGET' | 'FS_ABORTED' | 'FS_IO_ERROR';
/** Error type shared by connection, filesystem and tool code. */
export declare class RemoteSshError extends Error {
    readonly code: RemoteSshErrorCode;
    readonly details?: Record<string, unknown>;
    constructor(code: RemoteSshErrorCode, message: string, details?: Record<string, unknown>);
}
export declare function isRemoteSshError(error: unknown): error is RemoteSshError;
/** Abort helper: every long operation checks this and raises a stable FS_ABORTED. */
export declare function throwIfAborted(signal: AbortSignal | undefined, verb: string): void;
/** Strip private-key-looking material from an error string before logging. */
export declare function redactSecrets(value: string): string;
/** Normalize an unknown thrown value into a message without leaking stack details. */
export declare function errorMessage(error: unknown): string;
