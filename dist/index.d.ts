export declare const name = "remote-ssh";
/** The plugin needs the native tool seams before it can route remote work. */
export declare const inject: string[];
export interface Config {
    storageDir?: string;
    maxRecent?: number;
    remoteBashApproval?: 'session' | 'command' | 'off';
    allowLegacyRemoteShell?: boolean;
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
export declare function apply(ctx: PluginContext, config?: Config): void;
export {};
