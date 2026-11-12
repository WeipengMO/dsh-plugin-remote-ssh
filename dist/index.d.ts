export declare const name = "remote-ssh";
/** The plugin needs the native tool seams before it can route remote work. */
export declare const inject: string[];
export interface Config {
    storageDir?: string;
    maxRecent?: number;
}
interface PluginContext {
    fs: Record<string, unknown>;
    shell: Record<string, unknown>;
    tools: Record<string, unknown>;
    workingDirectory: {
        get(session: unknown): string;
        set(agent: unknown, path: string, signal?: AbortSignal): Promise<string>;
        ensure(agent: unknown, signal?: AbortSignal): Promise<string>;
    };
    systemPrompt: Record<string, unknown>;
    logger: {
        info(message: string): void;
        warn(message: string): void;
        error(message: string): void;
    };
    effect(fn: () => () => void): unknown;
    on(event: string, listener: (payload: unknown) => unknown, opts?: {
        global?: boolean;
    }): unknown;
    get(name: string): unknown;
}
/**
 * Fail closed when an SSH workspace is temporarily unavailable. Never change
 * the session to a Windows LOCAL cwd without an explicit user request.
 *
 * DSH calls workingDirectory.ensure() while constructing agent prompts.
 * Throwing would strand those prompts, so return the unchanged virtual cwd;
 * subsequent remote file/process calls will surface the SSH failure.
 */
export declare function guardWorkingDirectory(ctx: PluginContext): () => void;
export declare function apply(ctx: PluginContext, config?: Config): void;
export {};
