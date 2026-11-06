/**
 * `LlmAdapter` that serves a harness provider route through Claude Code.
 *
 * Conversations are pinned to long-lived `claude -p` processes, so Claude
 * Code keeps the exact native history (tool_use / tool_result pairs, prompt
 * caching) between harness steps. Whenever the harness's history and a
 * process's history stop matching — first contact, harness-side compaction,
 * an edited prompt, a changed model or tool set, a crashed process — the
 * adapter retires the process and starts a new one primed with a transcript
 * of the conversation so far.
 * @module dsh-llm-claude-code/adapter
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { Config, ModelConfig } from './config.js'
import {
  fingerprint,
  launchKey,
  toolResultOf,
  transcriptBlocks,
  userBlocks,
  viewOf,
  type ImageText,
  type McpToolResult,
  type Turn,
} from './history.js'
import { McpBridgeServer } from './mcp-server.js'
import { ClaudeCodeSession, type SessionEnvironment } from './session.js'

export interface ClaudeCodeAdapterOptions {
  /** Live configuration; read on every request. */
  config: () => Config
  /** Text shown in place of an image block. */
  imageText: ImageText
  /** Diagnostics sink. */
  logger?: { debug?: (...args: unknown[]) => void; warn: (...args: unknown[]) => void }
}

type Plan =
  | { kind: 'user'; blocks: ReturnType<typeof userBlocks> }
  | { kind: 'tools'; results: Map<string, McpToolResult> }

export class ClaudeCodeAdapter extends LlmAdapter {
  private readonly sessions = new Map<string, ClaudeCodeSession>()
  private readonly loose = new Set<ClaudeCodeSession>()
  private readonly mcp = new McpBridgeServer()
  private readonly base: string
  private readonly env: SessionEnvironment
  private disposed = false

  constructor(private readonly options: ClaudeCodeAdapterOptions) {
    super()
    this.base = mkdtempSync(join(tmpdir(), 'dsh-claude-code-'))
    const scratch = join(this.base, 'prompts')
    const emptyCwd = join(this.base, 'cwd')
    mkdirSync(scratch, { recursive: true, mode: 0o700 })
    mkdirSync(emptyCwd, { recursive: true })
    this.env = {
      config: options.config,
      mcp: this.mcp,
      cwd: () => options.config().cwd ?? emptyCwd,
      scratch,
      onClosed: session => this.forget(session),
    }
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.options.config().displayName }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.options.config().models.map(model => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
      ...model.description === undefined ? {} : { description: model.description },
      inputModalities: ['text'] as const,
    })))
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const config = this.options.config()
    const entry = this.modelConfig(model)
    // Schema validation materializes an unset per-model list as [], so an
    // empty list means "inherit the route-wide levels".
    const efforts = entry?.efforts !== undefined && entry.efforts.length > 0 ? entry.efforts : config.efforts
    const defaultEffort = entry?.defaultEffort ?? config.defaultEffort
    return Promise.resolve({
      provider,
      id: model,
      name: entry?.name ?? model,
      ...entry?.description === undefined ? {} : { description: entry.description },
      inputModalities: ['text'] as const,
      context: { contextWindow: entry?.contextWindow ?? config.contextWindow },
      ...efforts.length === 0
        ? {}
        : {
          reasoning: {
            efforts: efforts.map(effort => ({ id: ReasoningEffortId(effort), name: titleCase(effort) })),
            ...defaultEffort === undefined || !efforts.includes(defaultEffort)
              ? {}
              : { defaultEffort: ReasoningEffortId(defaultEffort) },
          },
        },
    })
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (this.disposed) throw new Error('Claude Code adapter disposed')
    const config = this.options.config()
    const view = viewOf(options)
    const tools = options.tools ?? []
    const entry = this.modelConfig(options.model)
    const effort = options.reasoningEffort ?? entry?.defaultEffort ?? config.defaultEffort
    const system = view.system.length > 0 ? view.system : config.defaultSystemPrompt
    const spec = {
      launchKey: launchKey({ model: options.model, ...effort === undefined ? {} : { effort }, system, tools }) + `:${options.maxTokens ?? ''}`,
      model: options.model,
      ...effort === undefined ? {} : { effort },
      system,
      tools,
      ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
    }
    const fingerprints = view.turns.map(fingerprint)
    const key = `${options.sessionId ?? 'anonymous'}|${options.purpose ?? 'conversation'}`
    const oneShot = options.purpose !== undefined

    let session = this.sessions.get(key)
    let plan: Plan | undefined
    let pinned = true
    if (session !== undefined && session.state === 'busy') {
      // Another request of this conversation is mid-stream (concurrent
      // callers sharing a session id): leave it alone and serve this one
      // from a throwaway process.
      session = undefined
      pinned = false
    } else if (session !== undefined
      && session.alive
      && session.spec.launchKey === spec.launchKey
      && isPrefix(session.consumed, fingerprints)) {
      plan = this.continuation(session, view.turns.slice(session.consumed.length))
      if (plan !== undefined && session.state === 'draining' && !(await session.drain(options.signal))) plan = undefined
    }

    if (plan === undefined || session === undefined) {
      if (session !== undefined) {
        this.options.logger?.debug?.('llm-claude-code: restarting Claude Code for %s (history or launch settings changed)', key)
        session.close()
      }
      session = await ClaudeCodeSession.start(spec, this.env)
      if (pinned) {
        this.sessions.set(key, session)
        this.evict(session)
      } else {
        this.loose.add(session)
      }
      plan = { kind: 'user', blocks: transcriptBlocks(view.turns, this.options.imageText) }
    }

    session.consumed = fingerprints
    if (plan.kind === 'tools') session.deliverToolResults(plan.results)
    else session.sendUser(plan.blocks)

    try {
      yield* session.runStep(options.signal)
    } finally {
      // Throwaway and auxiliary-purpose processes do not outlive their turn
      // unless the model is waiting on tool results.
      if ((!pinned || oneShot) && session.state !== 'awaiting-tools') session.close()
    }
  }

  /** Close every process and the MCP listener. */
  async dispose(): Promise<void> {
    this.disposed = true
    for (const session of [...this.sessions.values(), ...this.loose]) session.close()
    this.sessions.clear()
    this.loose.clear()
    await this.mcp.close()
    rmSync(this.base, { recursive: true, force: true })
  }

  /** Live process count, for diagnostics and tests. */
  get liveProcesses(): number {
    return this.sessions.size + this.loose.size
  }

  /**
   * Decide whether the turns the harness added since the process last spoke
   * can be fed to it natively.
   */
  private continuation(session: ClaudeCodeSession, delta: readonly Turn[]): Plan | undefined {
    if (session.state === 'awaiting-tools') {
      const owed = new Set(session.awaiting.map(call => call.id))
      if (delta.length !== owed.size) return undefined
      const results = new Map<string, McpToolResult>()
      for (const turn of delta) {
        if (turn.role !== 'tool' || !owed.has(turn.toolCallId)) return undefined
        results.set(turn.toolCallId, toolResultOf(turn, this.options.imageText))
      }
      return { kind: 'tools', results }
    }
    if (session.state === 'idle' || session.state === 'draining') {
      if (delta.length === 0 || delta.some(turn => turn.role !== 'user')) return undefined
      return { kind: 'user', blocks: userBlocks(delta, this.options.imageText) }
    }
    return undefined
  }

  private evict(keep: ClaudeCodeSession): void {
    const limit = this.options.config().maxLiveProcesses
    while (this.sessions.size > limit) {
      let oldest: ClaudeCodeSession | undefined
      for (const candidate of this.sessions.values()) {
        if (candidate === keep || candidate.state === 'busy') continue
        if (oldest === undefined || candidate.lastUsed < oldest.lastUsed) oldest = candidate
      }
      if (oldest === undefined) return
      oldest.close()
    }
  }

  private forget(session: ClaudeCodeSession): void {
    this.loose.delete(session)
    for (const [key, candidate] of this.sessions) {
      if (candidate === session) this.sessions.delete(key)
    }
  }

  private modelConfig(model: string): ModelConfig | undefined {
    return this.options.config().models.find(entry => entry.id === model)
  }
}

function isPrefix(prefix: readonly string[], full: readonly string[]): boolean {
  if (prefix.length > full.length) return false
  return prefix.every((value, index) => full[index] === value)
}

function titleCase(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1)
}
