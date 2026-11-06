/**
 * Plugin configuration. Every tunable a deployment may want to set
 * differently is a field here, with defaults on the schema.
 * @module dsh-llm-claude-code/config
 */
import Schema from '@deepseek-ai/schemastery';
/** One model this route advertises to selectors. */
export interface ModelConfig {
    /** Model id or alias passed to `claude --model` (e.g. `sonnet`, `opus`, `claude-sonnet-5-5`). */
    id: string;
    /** Display name for selectors. */
    name?: string;
    /** Optional one-line distinction shown beside the name. */
    description?: string;
    /** Context window the harness budgets compaction against. */
    contextWindow?: number;
    /** Selectable `--effort` levels for this model; falls back to the route-wide list. */
    efforts?: string[];
    /** Effort materialized when the caller selects none; falls back to the route-wide default. */
    defaultEffort?: string;
}
export interface Config {
    /** Provider route key the adapter registers (`provider:` in model selections). */
    provider: string;
    /** Human-readable provider name for selectors. */
    displayName: string;
    /** Claude Code executable: a command on PATH or an absolute path. */
    command: string;
    /** Models advertised to selectors. Unlisted ids still route to the CLI. */
    models: ModelConfig[];
    /** Route-wide selectable `--effort` levels, least to greatest. Empty hides the selector. */
    efforts: string[];
    /** Route-wide default effort; unset leaves Claude Code's own default. */
    defaultEffort?: string;
    /** Default context window for models that do not declare one. */
    contextWindow: number;
    /**
     * Working directory for the Claude Code processes. Unset uses a private
     * empty temporary directory so no project CLAUDE.md, settings, or hooks
     * leak into the request. All file work happens through the harness tools.
     */
    cwd?: string;
    /** Value for `--setting-sources`; empty omits the flag. */
    settingSources: string;
    /**
     * Strip ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN from the child environment
     * so Claude Code authenticates with the Claude subscription you signed in
     * with (`claude` → `/login`) instead of silently billing an API key.
     */
    subscriptionOnly: boolean;
    /** Stop Claude Code from injecting CLAUDE.md files and auto-memory; the harness owns context. */
    isolateContext: boolean;
    /** Extra arguments appended to every `claude` invocation. */
    extraArgs: string[];
    /** Extra environment variables for every `claude` invocation. */
    env: Record<string, string>;
    /** Close a conversation's Claude Code process after this much inactivity. */
    idleTimeoutMs: number;
    /** How long Claude Code waits for the harness to finish one tool call. */
    toolResultTimeoutMs: number;
    /** Upper bound on concurrently kept Claude Code processes (least recently used closes first). */
    maxLiveProcesses: number;
    /** How long to wait for the trailing `result` event of a finished turn before restarting. */
    drainTimeoutMs: number;
    /** MCP server name the harness tools are exposed under (tool names become `mcp__<name>__<tool>`). */
    mcpServerName: string;
    /** Fallback system prompt when a request carries none. */
    defaultSystemPrompt: string;
}
export declare const DEFAULT_MODELS: ModelConfig[];
export declare const DEFAULT_EFFORTS: string[];
export declare const Config: Schema<Config>;
