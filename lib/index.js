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
import { execFile } from 'node:child_process';
import { offloadedImageText, resolveImageAttachmentAccess, textOnlyImageText, } from '@deepseek-ai/dsh-llm';
import { ClaudeCodeAdapter } from './adapter.js';
export { ClaudeCodeAdapter } from './adapter.js';
export { Config, DEFAULT_EFFORTS, DEFAULT_MODELS } from './config.js';
export { classify } from './session.js';
export const name = 'llm-claude-code';
export const inject = ['llm'];
export function apply(ctx, config) {
    const loose = ctx;
    const imageText = (block) => {
        try {
            const attachments = loose.get('attachments');
            const fs = loose.get('fs');
            if (attachments !== undefined) {
                const access = resolveImageAttachmentAccess(attachments, hostPath => fs?.processPathFromHostPath(hostPath), block.attachment);
                if (access !== undefined)
                    return offloadedImageText(block.attachment, access);
            }
        }
        catch {
            // Fall through to the path-less placeholder.
        }
        return textOnlyImageText(block.attachment);
    };
    const adapter = new ClaudeCodeAdapter({
        config: () => config,
        imageText,
        logger: ctx.logger,
    });
    ctx.llm.registerAdapter([config.provider], adapter);
    ctx.effect(() => () => { void adapter.dispose(); });
    checkSignIn(ctx, config);
}
/** Warn early, without failing the mount, when Claude Code is missing or signed out. */
function checkSignIn(ctx, config) {
    execFile(config.command, ['auth', 'status'], { timeout: 20_000, env: { ...process.env, ...config.env } }, (error, stdout) => {
        if (error !== null && error.code === 'ENOENT') {
            ctx.logger.warn('llm-claude-code: Claude Code CLI "%s" not found. Install it (npm install -g @anthropic-ai/claude-code),'
                + ' then run `claude` and `/login` with your Claude subscription.', config.command);
            return;
        }
        try {
            const status = JSON.parse(stdout);
            if (status.loggedIn === false) {
                ctx.logger.warn('llm-claude-code: Claude Code is not signed in. Run `claude`, then `/login`, and choose your Claude subscription.');
            }
        }
        catch {
            // Older CLIs print plain text here; the first request reports problems.
        }
    });
}
