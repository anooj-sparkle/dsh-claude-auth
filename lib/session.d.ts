/**
 * One live `claude -p` process holding one harness conversation.
 *
 * The process runs with stream-json input and output, every built-in Claude
 * Code tool disabled, and the harness's tools mounted through the local MCP
 * bridge. A harness model step maps onto one Anthropic message the process
 * produces:
 *
 *  - a user turn is written to stdin, and the step streams the reply;
 *  - when the reply stops for `tool_use`, the step ends with `tool-calls`
 *    while Claude Code's MCP calls stay parked on the bridge;
 *  - the next harness request carries the tool results, which release the
 *    parked calls, and Claude Code issues the follow-up API call itself.
 *
 * Authentication is entirely Claude Code's: this module never sees a token.
 * @module dsh-llm-claude-code/session
 */
import { LlmError, type StreamChunk, type ToolSchema } from '@deepseek-ai/dsh-llm';
import type { Config } from './config.js';
import { type EmittedToolCall } from './events.js';
import { type CliTextBlock, type McpToolResult } from './history.js';
import type { McpBridgeServer } from './mcp-server.js';
/** Lifecycle of one process, as seen by the adapter. */
export type SessionState = 
/** Waiting for the next user turn. */
'idle'
/** A step is streaming. */
 | 'busy'
/** The last step ended with tool calls whose results are still owed. */
 | 'awaiting-tools'
/** The last step ended normally; the trailing `result` line is not read yet. */
 | 'draining' | 'closed';
/** Everything fixed for one process's lifetime. */
export interface SessionSpec {
    launchKey: string;
    model: string;
    effort?: string;
    system: string;
    tools: readonly ToolSchema[];
    maxTokens?: number;
}
/** Shared services every session uses. */
export interface SessionEnvironment {
    config: () => Config;
    mcp: McpBridgeServer;
    /** Working directory for the CLI. */
    cwd: () => string;
    /** Directory for per-process prompt files. */
    scratch: string;
    /** Called once the session closes, for registry bookkeeping. */
    onClosed: (session: ClaudeCodeSession) => void;
}
export declare class ClaudeCodeSession {
    readonly spec: SessionSpec;
    private readonly env;
    state: SessionState;
    /** Fingerprints of every turn this process has seen, in order. */
    consumed: string[];
    /** Tool calls of the last step whose results are owed. */
    awaiting: EmittedToolCall[];
    /** Tool calls of the most recent tool step, kept for pairing id-less MCP calls. */
    private pairing;
    lastUsed: number;
    readonly id: string;
    private readonly events;
    private readonly parked;
    private readonly unmatched;
    private readonly early;
    private readonly claimed;
    private child;
    private stderrTail;
    private disposeEndpoint;
    private promptFile;
    private idleTimer;
    private exitError;
    private constructor();
    /** Start a process for `spec`. Spawn failures surface on the first step. */
    static start(spec: SessionSpec, env: SessionEnvironment): Promise<ClaudeCodeSession>;
    get toolPrefix(): string;
    get alive(): boolean;
    private launch;
    /** Write one user turn. */
    sendUser(blocks: CliTextBlock[]): void;
    /** Release the parked MCP calls of the last step with the harness's results. */
    deliverToolResults(results: ReadonlyMap<string, McpToolResult>): void;
    /**
     * Wait for the trailing `result` line of a finished turn.
     * @returns false when the process went on producing model output instead,
     *   meaning its history no longer matches the harness's.
     */
    drain(signal?: AbortSignal): Promise<boolean>;
    /**
     * Stream one model step. Ends after the first complete Anthropic message.
     * @param signal - the request's abort signal; aborting closes the process.
     */
    runStep(signal?: AbortSignal): AsyncGenerator<StreamChunk>;
    /** Stop the process and fail everything waiting on it. */
    close(): void;
    private onToolCall;
    private write;
    private touch;
}
/**
 * Map Claude Code's error text onto the harness's stable failure codes, so
 * retry and compaction policies treat it like any other provider.
 */
export declare function classify(text: string, fallback: string): LlmError;
