/**
 * DeepSeek Harness plugin: route model calls to Claude through the official
 * Claude Code CLI, signed in with your own Claude subscription.
 *
 * ```yaml
 * - id: llm-claude-code
 *   name: dsh-llm-claude-code
 *   config:
 *     provider: claude-code
 *     models:
 *       - id: opus
 *       - id: sonnet
 * ```
 *
 * The plugin never reads, stores, or forwards Claude credentials. It starts
 * the unmodified `claude` binary, which authenticates with whatever account
 * you signed into through Claude Code's own `/login` flow.
 *
 * @module dsh-llm-claude-code
 */
import type { Context } from '@deepseek-ai/cordis';
import { Config } from './config.js';
export { ClaudeCodeAdapter } from './adapter.js';
export type { ClaudeCodeAdapterOptions } from './adapter.js';
export { Config, DEFAULT_EFFORTS, DEFAULT_MODELS } from './config.js';
export type { ModelConfig } from './config.js';
export { classify } from './session.js';
export declare const name = "llm-claude-code";
export declare const inject: string[];
export declare function apply(ctx: Context, config: Config): void;
