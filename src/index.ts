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

import { execFile } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import {
  offloadedImageText,
  resolveImageAttachmentAccess,
  textOnlyImageText,
  type ImageBlock,
} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm'
import { ClaudeCodeAdapter } from './adapter.js'
import { Config } from './config.js'

export { ClaudeCodeAdapter } from './adapter.js'
export type { ClaudeCodeAdapterOptions } from './adapter.js'
export { Config, DEFAULT_EFFORTS, DEFAULT_MODELS } from './config.js'
export type { ModelConfig } from './config.js'
export { classify } from './session.js'

export const name = 'llm-claude-code'
export const inject = ['llm']

interface AttachmentsLike {
  // Opaque to this plugin; handed straight to resolveImageAttachmentAccess.
  readonly __attachments?: never
}

interface FsLike {
  processPathFromHostPath(hostPath: string): string | undefined
}

export function apply(ctx: Context, config: Config): void {
  const loose = ctx as unknown as { get(name: string): unknown }
  const imageText = (block: ImageBlock): string => {
    try {
      const attachments = loose.get('attachments') as AttachmentsLike | undefined
      const fs = loose.get('fs') as FsLike | undefined
      if (attachments !== undefined) {
        const access = resolveImageAttachmentAccess(
          attachments as never,
          hostPath => fs?.processPathFromHostPath(hostPath),
          block.attachment,
        )
        if (access !== undefined) return offloadedImageText(block.attachment, access)
      }
    } catch {
      // Fall through to the path-less placeholder.
    }
    return textOnlyImageText(block.attachment)
  }

  const adapter = new ClaudeCodeAdapter({
    config: () => config,
    imageText,
    logger: ctx.logger,
  })
  ctx.llm.registerAdapter([config.provider], adapter)
  ctx.effect(() => () => { void adapter.dispose() })

  checkSignIn(ctx, config)
}

/** Warn early, without failing the mount, when Claude Code is missing or signed out. */
function checkSignIn(ctx: Context, config: Config): void {
  execFile(config.command, ['auth', 'status'], { timeout: 20_000, env: { ...process.env, ...config.env } }, (error, stdout) => {
    if (error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      ctx.logger.warn(
        'llm-claude-code: Claude Code CLI "%s" not found. Install it (npm install -g @anthropic-ai/claude-code),'
        + ' then run `claude` and `/login` with your Claude subscription.',
        config.command,
      )
      return
    }
    try {
      const status = JSON.parse(stdout) as { loggedIn?: boolean }
      if (status.loggedIn === false) {
        ctx.logger.warn('llm-claude-code: Claude Code is not signed in. Run `claude`, then `/login`, and choose your Claude subscription.')
      }
    } catch {
      // Older CLIs print plain text here; the first request reports problems.
    }
  })
}
