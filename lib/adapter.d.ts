/**
 * `LlmAdapter` that serves a harness provider route through Claude Code.
 *
 * Conversations are pinned to long-lived `claude -p` processes, so Claude
 * Code keeps the exact native history (tool_use / tool_result pairs, prompt
 * caching) between harness steps. Whenever the harness's history and a
 * process's history stop matching — first contact, harness-side compaction,
 * an edited prompt, a changed model or tool set, a crashed process — the
 * adapter retires the process and starts a new one primed with a transcript
 * of the conversation so far.
 * @module dsh-llm-claude-code/adapter
 */
import { LlmAdapter, type GenerateOptions, type LlmModelInfo, type LlmProviderInfo, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm';
import type { Config } from './config.js';
import { type ImageText } from './history.js';
export interface ClaudeCodeAdapterOptions {
    /** Live configuration; read on every request. */
    config: () => Config;
    /** Text shown in place of an image block. */
    imageText: ImageText;
    /** Diagnostics sink. */
    logger?: {
        debug?: (...args: unknown[]) => void;
        warn: (...args: unknown[]) => void;
    };
}
export declare class ClaudeCodeAdapter extends LlmAdapter {
    private readonly options;
    private readonly sessions;
    private readonly loose;
    private readonly mcp;
    private readonly base;
    private readonly env;
    private disposed;
    constructor(options: ClaudeCodeAdapterOptions);
    providerInfo(provider: string): LlmProviderInfo;
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    /** Close every process and the MCP listener. */
    dispose(): Promise<void>;
    /** Live process count, for diagnostics and tests. */
    get liveProcesses(): number;
    /**
     * Decide whether the turns the harness added since the process last spoke
     * can be fed to it natively.
     */
    private continuation;
    private evict;
    private forget;
    private modelConfig;
}
