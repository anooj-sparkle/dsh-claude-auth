/**
 * Plugin configuration. Every tunable a deployment may want to set
 * differently is a field here, with defaults on the schema.
 * @module dsh-llm-claude-code/config
 */

import Schema from '@deepseek-ai/schemastery'

/** One model this route advertises to selectors. */
export interface ModelConfig {
  /** Model id or alias passed to `claude --model` (e.g. `sonnet`, `opus`, `claude-sonnet-5-5`). */
  id: string
  /** Display name for selectors. */
  name?: string
  /** Optional one-line distinction shown beside the name. */
  description?: string
  /** Context window the harness budgets compaction against. */
  contextWindow?: number
  /** Selectable `--effort` levels for this model; falls back to the route-wide list. */
  efforts?: string[]
  /** Effort materialized when the caller selects none; falls back to the route-wide default. */
  defaultEffort?: string
}

export interface Config {
  /** Provider route key the adapter registers (`provider:` in model selections). */
  provider: string
  /** Human-readable provider name for selectors. */
  displayName: string
  /** Claude Code executable: a command on PATH or an absolute path. */
  command: string
  /** Models advertised to selectors. Unlisted ids still route to the CLI. */
  models: ModelConfig[]
  /** Route-wide selectable `--effort` levels, least to greatest. Empty hides the selector. */
  efforts: string[]
  /** Route-wide default effort; unset leaves Claude Code's own default. */
  defaultEffort?: string
  /** Default context window for models that do not declare one. */
  contextWindow: number
  /**
   * Working directory for the Claude Code processes. Unset uses a private
   * empty temporary directory so no project CLAUDE.md, settings, or hooks
   * leak into the request. All file work happens through the harness tools.
   */
  cwd?: string
  /** Value for `--setting-sources`; empty omits the flag. */
  settingSources: string
  /**
   * Strip ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN from the child environment
   * so Claude Code authenticates with the Claude subscription you signed in
   * with (`claude` → `/login`) instead of silently billing an API key.
   */
  subscriptionOnly: boolean
  /** Stop Claude Code from injecting CLAUDE.md files and auto-memory; the harness owns context. */
  isolateContext: boolean
  /** Extra arguments appended to every `claude` invocation. */
  extraArgs: string[]
  /** Extra environment variables for every `claude` invocation. */
  env: Record<string, string>
  /** Close a conversation's Claude Code process after this much inactivity. */
  idleTimeoutMs: number
  /** How long Claude Code waits for the harness to finish one tool call. */
  toolResultTimeoutMs: number
  /** Upper bound on concurrently kept Claude Code processes (least recently used closes first). */
  maxLiveProcesses: number
  /** How long to wait for the trailing `result` event of a finished turn before restarting. */
  drainTimeoutMs: number
  /** MCP server name the harness tools are exposed under (tool names become `mcp__<name>__<tool>`). */
  mcpServerName: string
  /** Fallback system prompt when a request carries none. */
  defaultSystemPrompt: string
}

const ModelConfig: Schema<ModelConfig> = Schema.object({
  id: Schema.string().required(),
  name: Schema.string(),
  description: Schema.string(),
  contextWindow: Schema.natural(),
  efforts: Schema.array(Schema.string()),
  defaultEffort: Schema.string(),
})

export const DEFAULT_MODELS: ModelConfig[] = [
  { id: 'opus', name: 'Claude Opus', description: 'Latest Opus via Claude Code' },
  { id: 'sonnet', name: 'Claude Sonnet', description: 'Latest Sonnet via Claude Code' },
  { id: 'haiku', name: 'Claude Haiku', description: 'Latest Haiku via Claude Code' },
]

export const DEFAULT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

export const Config: Schema<Config> = Schema.object({
  provider: Schema.string().default('claude-code'),
  displayName: Schema.string().default('Claude (Claude Code subscription)'),
  command: Schema.string().default('claude'),
  models: Schema.array(ModelConfig).default(DEFAULT_MODELS),
  efforts: Schema.array(Schema.string()).default(DEFAULT_EFFORTS),
  defaultEffort: Schema.string(),
  contextWindow: Schema.natural().min(1).default(200_000),
  cwd: Schema.string(),
  settingSources: Schema.string().default('project'),
  subscriptionOnly: Schema.boolean().default(true),
  isolateContext: Schema.boolean().default(true),
  extraArgs: Schema.array(Schema.string()).default([]),
  env: Schema.dict(Schema.string()).default({}),
  idleTimeoutMs: Schema.natural().min(1000).default(15 * 60_000),
  toolResultTimeoutMs: Schema.natural().min(1000).default(24 * 60 * 60_000),
  maxLiveProcesses: Schema.natural().min(1).default(8),
  drainTimeoutMs: Schema.natural().min(100).default(30_000),
  mcpServerName: Schema.string().pattern(/^[a-zA-Z0-9_-]{1,32}$/).default('dsh'),
  defaultSystemPrompt: Schema.string().default('You are a helpful assistant.'),
}) as Schema<Config>
