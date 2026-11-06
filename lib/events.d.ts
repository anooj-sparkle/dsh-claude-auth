/**
 * Translation of Claude Code's `stream-json` output into harness stream
 * chunks. With `--include-partial-messages`, Claude Code forwards the raw
 * Anthropic Messages streaming events of every API call as `stream_event`
 * lines, so one harness model step is exactly one Anthropic message:
 * `message_start` … `message_stop`.
 * @module dsh-llm-claude-code/events
 */
import { type FinishReason, type StreamChunk } from '@deepseek-ai/dsh-llm';
/** One parsed line of `claude -p --output-format stream-json`. */
export interface CliEvent {
    type: string;
    subtype?: string;
    event?: AnthropicStreamEvent;
    parent_tool_use_id?: string | null;
    is_error?: boolean;
    result?: string;
    stop_reason?: string | null;
    message?: {
        model?: string;
        content?: unknown[];
    };
    error?: string;
    [key: string]: unknown;
}
/** The subset of Anthropic streaming events this translator reads. */
export interface AnthropicStreamEvent {
    type: string;
    index?: number;
    message?: {
        id?: string;
        usage?: AnthropicUsage;
    };
    content_block?: {
        type: string;
        id?: string;
        name?: string;
        input?: unknown;
        text?: string;
        thinking?: string;
    };
    delta?: {
        type?: string;
        text?: string;
        thinking?: string;
        partial_json?: string;
        stop_reason?: string | null;
    };
    usage?: AnthropicUsage;
}
interface AnthropicUsage {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
}
/** A tool call emitted during one step. */
export interface EmittedToolCall {
    id: string;
    name: string;
    arguments: string;
}
/**
 * Stateful translator for one Anthropic message. Feed it `stream_event`
 * payloads; it returns the harness chunks each one produces.
 */
export declare class StepTranslator {
    private readonly toolPrefix;
    private readonly open;
    private nextIndex;
    private usage;
    private stop;
    /** Whether `message_start` was seen. */
    started: boolean;
    /** Whether `message_stop` was seen. */
    done: boolean;
    /** Concatenated visible text, for continuity fingerprints. */
    text: string;
    readonly toolCalls: EmittedToolCall[];
    /**
     * @param toolPrefix - prefix Claude Code puts on MCP tool names (`mcp__dsh__`).
     */
    constructor(toolPrefix: string);
    handle(event: AnthropicStreamEvent): StreamChunk[];
    /** Native Anthropic stop reason, once known. */
    get stopReason(): string | null | undefined;
    /** Usage chunk for the message so far, or undefined before `message_start`. */
    usageChunk(): StreamChunk | undefined;
    /** Finish reason for a completed message. */
    finishReason(): FinishReason;
    private mergeUsage;
    private start;
    private delta;
    private end;
    private finishBlock;
    private closeDangling;
    private stripPrefix;
}
export {};
