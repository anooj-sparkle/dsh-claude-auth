/**
 * Translation of the harness's provider-neutral request history into what a
 * Claude Code process consumes: fingerprints for continuity checks, user
 * message content, MCP tool results, and a replay transcript for the cases
 * where a fresh process has to pick a conversation up mid-way.
 * @module dsh-llm-claude-code/history
 */
import type { ContentBlock, GenerateOptions, ImageBlock, RequestMessage, ToolSchema } from '@deepseek-ai/dsh-llm';
/** Renders an image block the CLI cannot receive natively into model-visible text. */
export type ImageText = (block: ImageBlock) => string;
/** A model-visible turn: every request message except system and developer roles. */
export type Turn = RequestMessage;
/** Content block shape accepted by Claude Code's stream-json user input. */
export interface CliTextBlock {
    type: 'text';
    text: string;
}
/** Result handed back to Claude Code for one MCP tool call. */
export interface McpToolResult {
    content: CliTextBlock[];
    isError?: boolean;
}
/** The parts of one request the bridge reads. */
export interface RequestView {
    /** Effective system prompt ('' when the request carries none). */
    system: string;
    /** Conversation turns after the system prompt, developer messages removed. */
    turns: Turn[];
}
/**
 * Split a request into its system prompt and model-visible turns.
 * Developer messages only carry tool additions/removals, which this route
 * does not opt into (every request declares its complete tool list).
 */
export declare function viewOf(options: Pick<GenerateOptions, 'messages' | 'system'>): RequestView;
/** Plain text of text blocks only. */
export declare function textOf(content: readonly ContentBlock[]): string;
/** Tool calls an assistant turn requested. */
export declare function toolCallsOf(content: readonly ContentBlock[]): Extract<ContentBlock, {
    type: 'tool-call';
}>[];
/**
 * Identity of one turn for continuity checks. Assistant turns are identified
 * by their visible text and tool-call ids only, because that is all this
 * adapter emitted for them; reasoning text and harness-side bookkeeping must
 * not make an otherwise identical history look different.
 */
export declare function fingerprint(turn: Turn): string;
/** Fingerprint of an assistant response as this adapter streamed it. */
export declare function emittedFingerprint(text: string, toolCallIds: readonly string[]): string;
/** Render one content block as text for a model that only receives text here. */
export declare function blockText(block: ContentBlock, imageText: ImageText): string | undefined;
/** User turns rendered as stream-json text blocks. */
export declare function userBlocks(turns: readonly Turn[], imageText: ImageText): CliTextBlock[];
/** One harness tool-result turn as an MCP `tools/call` result. */
export declare function toolResultOf(turn: Extract<Turn, {
    role: 'tool';
}>, imageText: ImageText): McpToolResult;
/**
 * Replay a conversation into a single user message for a fresh process.
 * Used when no live process holds this conversation (first contact after a
 * restart, after harness-side compaction, or after a configuration change).
 * @param turns - every model-visible turn of the request.
 */
export declare function transcriptBlocks(turns: readonly Turn[], imageText: ImageText): CliTextBlock[];
/** Process-launch identity: anything that is fixed for a process's lifetime. */
export declare function launchKey(input: {
    model: string;
    effort?: string;
    system: string;
    tools: readonly ToolSchema[];
}): string;
