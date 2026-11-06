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

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { randomBytes } from 'node:crypto'
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  INVALID_CREDENTIAL_CODE,
  isContextWindowExceededError,
  LlmError,
  QUOTA_EXCEEDED_CODE,
  type StreamChunk,
  type ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type { Config } from './config.js'
import { StepTranslator, type CliEvent, type EmittedToolCall } from './events.js'
import { emittedFingerprint, type CliTextBlock, type McpToolResult } from './history.js'
import type { McpBridgeServer } from './mcp-server.js'
import { AsyncQueue } from './util.js'

/** Lifecycle of one process, as seen by the adapter. */
export type SessionState =
  /** Waiting for the next user turn. */
  | 'idle'
  /** A step is streaming. */
  | 'busy'
  /** The last step ended with tool calls whose results are still owed. */
  | 'awaiting-tools'
  /** The last step ended normally; the trailing `result` line is not read yet. */
  | 'draining'
  | 'closed'

/** Everything fixed for one process's lifetime. */
export interface SessionSpec {
  launchKey: string
  model: string
  effort?: string
  system: string
  tools: readonly ToolSchema[]
  maxTokens?: number
}

/** Shared services every session uses. */
export interface SessionEnvironment {
  config: () => Config
  mcp: McpBridgeServer
  /** Working directory for the CLI. */
  cwd: () => string
  /** Directory for per-process prompt files. */
  scratch: string
  /** Called once the session closes, for registry bookkeeping. */
  onClosed: (session: ClaudeCodeSession) => void
}

interface Parked {
  resolve: (result: McpToolResult) => void
  reject: (error: unknown) => void
}

/** Environment variables that would make Claude Code bill something other than the signed-in subscription. */
const NON_SUBSCRIPTION_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
]

export class ClaudeCodeSession {
  state: SessionState = 'idle'
  /** Fingerprints of every turn this process has seen, in order. */
  consumed: string[] = []
  /** Tool calls of the last step whose results are owed. */
  awaiting: EmittedToolCall[] = []
  /** Tool calls of the most recent tool step, kept for pairing id-less MCP calls. */
  private pairing: EmittedToolCall[] = []
  lastUsed = Date.now()
  readonly id = randomBytes(6).toString('hex')

  private readonly events = new AsyncQueue<CliEvent>()
  private readonly parked = new Map<string, Parked>()
  private readonly unmatched: { name: string; args: unknown; parked: Parked }[] = []
  private readonly early = new Map<string, McpToolResult>()
  private readonly claimed = new Set<string>()
  private child: ChildProcessWithoutNullStreams | undefined
  private stderrTail = ''
  private disposeEndpoint: (() => void) | undefined
  private promptFile: string | undefined
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private exitError: LlmError | undefined

  private constructor(
    readonly spec: SessionSpec,
    private readonly env: SessionEnvironment,
  ) {}

  /** Start a process for `spec`. Spawn failures surface on the first step. */
  static async start(spec: SessionSpec, env: SessionEnvironment): Promise<ClaudeCodeSession> {
    const session = new ClaudeCodeSession(spec, env)
    await session.launch()
    return session
  }

  get toolPrefix(): string {
    return `mcp__${this.env.config().mcpServerName}__`
  }

  get alive(): boolean {
    return this.state !== 'closed'
  }

  private async launch(): Promise<void> {
    const config = this.env.config()
    const serverName = config.mcpServerName
    let mcpUrl: string | undefined
    if (this.spec.tools.length > 0) {
      const endpoint = await this.env.mcp.register({
        tools: () => this.spec.tools,
        call: (name, args, toolUseId, signal) => this.onToolCall(name, args, toolUseId, signal),
      })
      mcpUrl = endpoint.url
      this.disposeEndpoint = endpoint.dispose
    }
    this.promptFile = join(this.env.scratch, `system-${this.id}.md`)
    writeFileSync(this.promptFile, this.spec.system, { mode: 0o600 })

    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--model', this.spec.model,
      '--system-prompt-file', this.promptFile,
      // No built-in tools: every action goes through the harness's own tools.
      '--tools', '',
      '--permission-mode', 'dontAsk',
      '--no-session-persistence',
      '--disable-slash-commands',
      '--strict-mcp-config',
    ]
    if (mcpUrl !== undefined) {
      args.push(
        '--mcp-config', JSON.stringify({ mcpServers: { [serverName]: { type: 'http', url: mcpUrl } } }),
        '--allowedTools', `mcp__${serverName}`,
      )
    }
    if (config.settingSources.length > 0) args.push('--setting-sources', config.settingSources)
    if (this.spec.effort !== undefined) args.push('--effort', this.spec.effort)
    args.push(...config.extraArgs)

    const childEnv: NodeJS.ProcessEnv = { ...process.env }
    // A harness launched from a Claude Code terminal must not look nested.
    delete childEnv.CLAUDECODE
    if (config.subscriptionOnly) for (const name of NON_SUBSCRIPTION_ENV) delete childEnv[name]
    Object.assign(childEnv, {
      MCP_TOOL_TIMEOUT: String(config.toolResultTimeoutMs),
      CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH: '1000000',
      // The harness owns compaction; a silent CLI-side compaction would make
      // the two histories diverge.
      DISABLE_AUTO_COMPACT: '1',
      DISABLE_AUTOUPDATER: '1',
    })
    if (config.isolateContext) {
      childEnv.CLAUDE_CODE_DISABLE_CLAUDE_MDS = '1'
      childEnv.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1'
    }
    if (this.spec.maxTokens !== undefined) childEnv.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(this.spec.maxTokens)
    Object.assign(childEnv, config.env)

    const child = spawn(config.command, args, { cwd: this.env.cwd(), env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    child.on('error', (error: NodeJS.ErrnoException) => {
      this.exitError = error.code === 'ENOENT'
        ? new LlmError(
          `Claude Code CLI not found ("${config.command}"). Install it (npm install -g @anthropic-ai/claude-code),`
          + ' sign in once by running `claude` and `/login`, or set `command` to its absolute path.',
          'CLAUDE_CODE_NOT_FOUND',
          { cause: error },
        )
        : new LlmError(`Failed to start Claude Code: ${error.message}`, 'TRANSPORT', { cause: error })
      this.close()
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000)
    })
    child.stdin.on('error', () => { /* surfaced through exit */ })
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      if (line.trim().length === 0) return
      try {
        this.events.push(JSON.parse(line) as CliEvent)
      } catch {
        // Not a protocol line (a stray log); ignore.
      }
    })
    child.on('close', (code, signal) => {
      if (this.exitError === undefined && this.state !== 'closed') {
        const detail = this.stderrTail.trim()
        this.exitError = classify(
          `Claude Code exited unexpectedly (${signal ?? `code ${String(code)}`})${detail.length > 0 ? `: ${detail}` : ''}`,
          'TRANSPORT',
        )
      }
      this.close()
    })
  }

  /** Write one user turn. */
  sendUser(blocks: CliTextBlock[]): void {
    this.touch()
    this.awaiting = []
    this.write({ type: 'user', message: { role: 'user', content: blocks }, parent_tool_use_id: null, session_id: '' })
  }

  /** Release the parked MCP calls of the last step with the harness's results. */
  deliverToolResults(results: ReadonlyMap<string, McpToolResult>): void {
    this.touch()
    for (const [id, result] of results) {
      const parked = this.parked.get(id)
      if (parked !== undefined) {
        this.parked.delete(id)
        parked.resolve(result)
        continue
      }
      const call = this.pairing.find(candidate => candidate.id === id)
      const index = call === undefined
        ? -1
        : this.unmatched.findIndex(entry => entry.name === call.name && sameJson(entry.args, call.arguments))
      if (index >= 0) {
        const [entry] = this.unmatched.splice(index, 1)
        entry?.parked.resolve(result)
        continue
      }
      // Claude Code has not issued this call yet; answer it on arrival.
      this.early.set(id, result)
    }
    this.awaiting = []
  }

  /**
   * Wait for the trailing `result` line of a finished turn.
   * @returns false when the process went on producing model output instead,
   *   meaning its history no longer matches the harness's.
   */
  async drain(signal?: AbortSignal): Promise<boolean> {
    if (this.state !== 'draining') return this.state === 'idle'
    // Claim the process so a concurrent request on the same conversation
    // does not read the event stream at the same time.
    this.state = 'busy'
    const deadline = Date.now() + this.env.config().drainTimeoutMs
    for (;;) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return false
      const event = await this.events.next(signal, remaining)
      if (event === undefined) return false
      if (event.type === 'result') {
        this.state = 'idle'
        return true
      }
      if (event.type === 'stream_event' && event.event?.type === 'message_start' && event.parent_tool_use_id == null) return false
    }
  }

  /**
   * Stream one model step. Ends after the first complete Anthropic message.
   * @param signal - the request's abort signal; aborting closes the process.
   */
  async *runStep(signal?: AbortSignal): AsyncGenerator<StreamChunk> {
    this.state = 'busy'
    this.touch()
    const translator = new StepTranslator(this.toolPrefix)
    let completed = false
    let errorText: string | undefined
    try {
      for (;;) {
        let event: CliEvent | undefined
        try {
          event = await this.events.next(signal)
        } catch (error) {
          throw new LlmError('Claude Code request aborted', 'ABORTED', { cause: error })
        }
        if (event === undefined) {
          throw this.exitError ?? new LlmError('Claude Code process closed', 'TRANSPORT')
        }
        switch (event.type) {
          case 'stream_event': {
            if (event.parent_tool_use_id != null || event.event === undefined) break
            if (event.event.type === 'message_start' && translator.started) {
              // A second message within one step means the CLI continued on
              // its own; stop here and let continuity checks restart it.
              throw new LlmError('Claude Code continued without the harness', 'TRANSPORT')
            }
            for (const chunk of translator.handle(event.event)) yield chunk
            if (!translator.done) break
            const usage = translator.usageChunk()
            if (usage !== undefined) yield usage
            const reason = translator.finishReason()
            this.consumed.push(emittedFingerprint(translator.text, translator.toolCalls.map(call => call.id)))
            if (reason.kind === 'tool-calls') {
              this.awaiting = [...translator.toolCalls]
              this.pairing = [...translator.toolCalls]
              this.claimed.clear()
              this.state = 'awaiting-tools'
            } else {
              this.state = 'draining'
            }
            completed = true
            yield { type: 'finish', reason }
            return
          }
          case 'assistant':
            if (typeof event.error === 'string' || event.message?.model === '<synthetic>') {
              errorText = syntheticText(event) ?? event.error
            }
            break
          case 'result': {
            const text = errorText ?? (typeof event.result === 'string' ? event.result : undefined)
            if (event.is_error === true || (event.subtype !== undefined && event.subtype !== 'success')) {
              throw classify(text ?? `Claude Code turn failed (${event.subtype ?? 'error'})`, 'UNKNOWN')
            }
            // A turn that produced no streamed message (should not happen):
            // surface whatever text the CLI reported.
            if (!translator.started) {
              if (text !== undefined && text.length > 0) {
                yield { type: 'block-start', index: 0, blockType: 'text' }
                yield { type: 'text-delta', index: 0, text }
                yield { type: 'block-end', index: 0, block: { type: 'text', text } }
              }
              this.consumed.push(emittedFingerprint(text ?? '', []))
              this.state = 'idle'
              completed = true
              yield { type: 'finish', reason: { kind: 'stop' } }
              return
            }
            break
          }
          default:
            break
        }
      }
    } finally {
      // An error, an abort, or a consumer that stopped reading leaves the
      // process in an unknown position: retire it.
      if (!completed) this.close()
    }
  }

  /** Stop the process and fail everything waiting on it. */
  close(): void {
    if (this.state === 'closed') return
    this.state = 'closed'
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer)
    this.disposeEndpoint?.()
    const error = this.exitError ?? new Error('Claude Code session closed')
    for (const parked of this.parked.values()) parked.reject(error)
    this.parked.clear()
    for (const entry of this.unmatched) entry.parked.reject(error)
    this.unmatched.length = 0
    this.events.end()
    if (this.child !== undefined && this.child.exitCode === null && this.child.signalCode === null) {
      this.child.stdin.end()
      this.child.kill('SIGTERM')
      const child = this.child
      setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }, 5000).unref()
    }
    if (this.promptFile !== undefined) rmSync(this.promptFile, { force: true })
    this.env.onClosed(this)
  }

  private onToolCall(name: string, args: unknown, toolUseId: string | undefined, signal: AbortSignal): Promise<McpToolResult> {
    if (this.state === 'closed') return Promise.reject(new Error('Claude Code session closed'))
    let id = toolUseId
    if (id === undefined) {
      // Older CLI builds omit the tool_use id; pair by name and arguments.
      id = this.pairing.find(call => !this.claimed.has(call.id) && call.name === name && sameJson(args, call.arguments))?.id
    }
    if (id !== undefined) {
      this.claimed.add(id)
      const ready = this.early.get(id)
      if (ready !== undefined) {
        this.early.delete(id)
        return Promise.resolve(ready)
      }
    }
    return new Promise<McpToolResult>((resolve, reject) => {
      const parked: Parked = { resolve, reject }
      if (id !== undefined) this.parked.set(id, parked)
      else this.unmatched.push({ name, args, parked })
      signal.addEventListener('abort', () => {
        if (id !== undefined && this.parked.get(id) === parked) this.parked.delete(id)
        const index = this.unmatched.findIndex(entry => entry.parked === parked)
        if (index >= 0) this.unmatched.splice(index, 1)
        reject(new Error('tool call cancelled by Claude Code'))
      }, { once: true })
    })
  }

  private write(message: unknown): void {
    const child = this.child
    if (child === undefined || this.state === 'closed' || !child.stdin.writable) return
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private touch(): void {
    this.lastUsed = Date.now()
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      if (this.state !== 'busy') this.close()
    }, this.env.config().idleTimeoutMs)
    this.idleTimer.unref()
  }
}

function sameJson(left: unknown, rightJson: string): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(JSON.parse(rightJson))
  } catch {
    return false
  }
}

function syntheticText(event: CliEvent): string | undefined {
  const content = event.message?.content
  if (!Array.isArray(content)) return undefined
  const text = content
    .map(block => (typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text')
      ? String((block as { text?: unknown }).text ?? '')
      : '')
    .join('')
  return text.length > 0 ? text : undefined
}

/**
 * Map Claude Code's error text onto the harness's stable failure codes, so
 * retry and compaction policies treat it like any other provider.
 */
export function classify(text: string, fallback: string): LlmError {
  if (isContextWindowExceededError(text) || /prompt is too long/i.test(text)) {
    return new LlmError(text, CONTEXT_WINDOW_EXCEEDED_CODE)
  }
  if (/\/login|not logged in|invalid api key|oauth token|authenticat|unauthori[sz]ed|\b401\b|\b403\b/i.test(text)) {
    return new LlmError(
      `${text} — sign in to Claude Code with your Claude subscription: run \`claude\`, then \`/login\`.`,
      INVALID_CREDENTIAL_CODE,
    )
  }
  if (/usage limit|limit reached|out of extra usage|weekly limit/i.test(text)) {
    return new LlmError(text, QUOTA_EXCEEDED_CODE)
  }
  if (/rate.?limit|\b429\b|too many requests/i.test(text)) return new LlmError(text, 'RATE_LIMIT')
  if (/overloaded|\b5\d\d\b|internal server error/i.test(text)) return new LlmError(text, 'SERVER')
  if (/api error/i.test(text) && /\b4\d\d\b/.test(text)) return new LlmError(text, 'INVALID_REQUEST')
  if (/timed? ?out|timeout/i.test(text)) return new LlmError(text, 'TIMEOUT')
  if (/ECONNRESET|ENOTFOUND|EAI_AGAIN|network|socket hang up|fetch failed/i.test(text)) return new LlmError(text, 'TRANSPORT')
  return new LlmError(text, fallback)
}
