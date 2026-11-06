/**
 * Plugin configuration. Every tunable a deployment may want to set
 * differently is a field here, with defaults on the schema.
 * @module dsh-llm-claude-code/config
 */
import Schema from '@deepseek-ai/schemastery';
const ModelConfig = Schema.object({
    id: Schema.string().required(),
    name: Schema.string(),
    description: Schema.string(),
    contextWindow: Schema.natural(),
    efforts: Schema.array(Schema.string()),
    defaultEffort: Schema.string(),
});
export const DEFAULT_MODELS = [
    { id: 'opus', name: 'Claude Opus', description: 'Latest Opus via Claude Code' },
    { id: 'sonnet', name: 'Claude Sonnet', description: 'Latest Sonnet via Claude Code' },
    { id: 'haiku', name: 'Claude Haiku', description: 'Latest Haiku via Claude Code' },
];
export const DEFAULT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const Config = Schema.object({
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
});
