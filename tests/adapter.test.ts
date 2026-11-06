import { chmodSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { GenerateOptions, StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'
import { ClaudeCodeAdapter } from '../src/adapter.js'
import { Config } from '../src/config.js'

const FAKE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url))
chmodSync(FAKE, 0o755)

let dir: string
let logFile: string
let adapter: ClaudeCodeAdapter
let config: Config

const tools: ToolSchema[] = [
  { name: 'read_file', description: 'Read a file. '.repeat(400), parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'bash', description: 'Run a command', parameters: { type: 'object', properties: { n: { type: 'number' } } } },
]

let seq = 0
const id = (): string => `m${++seq}`
const system = (text: string) => ({ id: id(), role: 'system', content: [{ type: 'text', text }], source: { kind: 'system-prompt' } })
const user = (text: string) => ({ id: id(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const assistantOf = (chunks: StreamChunk[]) => ({
  id: id(),
  role: 'assistant',
  content: chunks.flatMap(chunk => chunk.type === 'block-end' ? [chunk.block] : []),
  source: { kind: 'model', provider: 'claude-code', model: 'sonnet' },
})
const toolResult = (callId: string, text: string, isError = false) => ({
  id: id(),
  role: 'tool',
  toolCallId: callId,
  isError,
  content: [{ type: 'text', text }],
  source: { kind: 'tool', callId },
})

function request(messages: unknown[], extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'claude-code',
    model: 'sonnet',
    messages: messages as GenerateOptions['messages'],
    tools,
    sessionId: 'session-1' as GenerateOptions['sessionId'],
    ...extra,
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function textOf(chunks: StreamChunk[]): string {
  return chunks.flatMap(chunk => chunk.type === 'text-delta' ? [chunk.text] : []).join('')
}

function log(): Array<Record<string, any>> {
  if (!existsSync(logFile)) return []
  return readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}

const spawns = () => log().filter(entry => entry.kind === 'spawn')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-cc-test-'))
  logFile = join(dir, 'fake.log')
  config = Config({ command: FAKE, env: { FAKE_CLAUDE_LOG: logFile } })
  adapter = new ClaudeCodeAdapter({ config: () => config, imageText: () => '[image]' })
})

afterEach(async () => {
  await adapter.dispose()
  rmSync(dir, { recursive: true, force: true })
  delete process.env.ANTHROPIC_API_KEY
})

describe('ClaudeCodeAdapter', () => {
  it('advertises configured models with context and effort metadata', async () => {
    const models = await adapter.listModels('claude-code')
    expect(models.map(model => model.id)).toEqual(['opus', 'sonnet', 'haiku'])
    const resolved = await adapter.resolveModel('claude-code', 'opus')
    expect(resolved.context?.contextWindow).toBe(200_000)
    expect(resolved.reasoning?.efforts.map(effort => effort.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(adapter.providerInfo('claude-code').name).toBe('Claude (Claude Code subscription)')
  })

  it('streams a plain text turn with usage and a stop finish', async () => {
    const chunks = await collect(adapter.stream(request([system('Be terse.'), user('hello')])))
    expect(textOf(chunks)).toBe('echo: hello')
    expect(chunks[0]).toEqual({ type: 'block-start', index: 0, blockType: 'text' })
    expect(chunks.at(-2)).toEqual({
      type: 'usage',
      usage: { inputTokens: 10, outputTokens: 7, cacheReadTokens: 5, cacheWriteTokens: 2, totalTokens: 24 },
    })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    const [spawn] = spawns()
    expect(spawn?.system).toBe('Be terse.')
    expect(spawn?.tools).toBe('')
    expect(spawn?.allowed).toBe('mcp__dsh')
    expect(spawn?.disableMds).toBe('1')
  })

  it('exposes harness tools over MCP with full descriptions', async () => {
    await collect(adapter.stream(request([system('s'), user('hi')])))
    const listed = log().find(entry => entry.kind === 'tools')
    expect(listed?.names).toEqual(['read_file', 'bash'])
    expect(listed?.descriptions[0]).toBe(tools[0]?.description)
  })

  it('runs a tool round trip inside one Claude Code process', async () => {
    const history: unknown[] = [system('s'), user('TOOL read_file {"path":"a.txt"}')]
    const first = await collect(adapter.stream(request(history)))
    expect(first.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    const call = first.find(chunk => chunk.type === 'block-end')
    expect(call).toMatchObject({ block: { type: 'tool-call', name: 'read_file', arguments: '{"path":"a.txt"}' } })
    const callId = (call as { block: { id: string } }).block.id

    history.push(assistantOf(first), toolResult(callId, 'file contents'))
    const second = await collect(adapter.stream(request(history)))
    expect(textOf(second)).toBe('Result was: file contents')
    expect(second.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })

    history.push(assistantOf(second), user('and now?'))
    const third = await collect(adapter.stream(request(history)))
    expect(textOf(third)).toBe('echo: and now?')
    expect(spawns()).toHaveLength(1)
  })

  it('handles parallel tool calls and error results', async () => {
    const history: unknown[] = [system('s'), user('TOOLS2 bash')]
    const first = await collect(adapter.stream(request(history)))
    const ids = first.flatMap(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call' ? [chunk.block.id] : [])
    expect(ids).toHaveLength(2)
    history.push(assistantOf(first), toolResult(ids[1] as string, 'two'), toolResult(ids[0] as string, 'boom', true))
    const second = await collect(adapter.stream(request(history)))
    expect(textOf(second)).toBe('Result was: ERR boom | two')
    expect(spawns()).toHaveLength(1)
  })

  it('pairs tool calls by name and arguments when the CLI sends no tool_use id', async () => {
    config = Config({ command: FAKE, env: { FAKE_CLAUDE_LOG: logFile, FAKE_CLAUDE_NO_META: '1' } })
    const history: unknown[] = [system('s'), user('TOOLS2 bash')]
    const first = await collect(adapter.stream(request(history)))
    const ids = first.flatMap(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call' ? [chunk.block.id] : [])
    history.push(assistantOf(first), toolResult(ids[0] as string, 'one'), toolResult(ids[1] as string, 'two'))
    const second = await collect(adapter.stream(request(history)))
    expect(textOf(second)).toBe('Result was: one | two')
  })

  it('restarts with a transcript when the harness history diverges', async () => {
    const first = await collect(adapter.stream(request([system('s'), user('first question')])))
    // Harness-side compaction rewrote the history.
    const compacted = [system('s'), user('Summary: earlier we discussed things'), assistantOf(first), user('next')]
    const second = await collect(adapter.stream(request(compacted)))
    expect(textOf(second)).toBe('echo: next')
    expect(spawns()).toHaveLength(2)
    const replay = log().filter(entry => entry.kind === 'user').at(-1)?.text as string
    expect(replay).toContain('<conversation_history>')
    expect(replay).toContain('Summary: earlier we discussed things')
    expect(replay).toContain('echo: first question')
  })

  it('restarts when the model or effort changes', async () => {
    const history: unknown[] = [system('s'), user('one')]
    const first = await collect(adapter.stream(request(history)))
    history.push(assistantOf(first), user('two'))
    await collect(adapter.stream(request(history, { model: 'opus', reasoningEffort: 'high' as GenerateOptions['reasoningEffort'] })))
    const all = spawns()
    expect(all).toHaveLength(2)
    expect(all[1]).toMatchObject({ model: 'opus', effort: 'high' })
  })

  it('keeps separate processes per session and closes auxiliary-purpose ones', async () => {
    await collect(adapter.stream(request([system('s'), user('a')])))
    await collect(adapter.stream(request([system('s'), user('b')], { sessionId: 'session-2' as GenerateOptions['sessionId'] })))
    expect(adapter.liveProcesses).toBe(2)
    await collect(adapter.stream(request([system('title'), user('c')], { purpose: 'session-title' as never, maxTokens: 64 })))
    expect(adapter.liveProcesses).toBe(2)
    expect(spawns().at(-1)?.maxOutput).toBe('64')
  })

  it('emits reasoning blocks', async () => {
    const chunks = await collect(adapter.stream(request([system('s'), user('THINK')])))
    expect(chunks.filter(chunk => chunk.type === 'block-end').map(chunk => (chunk as { block: { type: string } }).block.type))
      .toEqual(['reasoning', 'text'])
  })

  it('maps a signed-out CLI to INVALID_CREDENTIAL and recovers on retry', async () => {
    await expect(collect(adapter.stream(request([system('s'), user('FAIL_AUTH')])))).rejects.toMatchObject({
      code: 'INVALID_CREDENTIAL',
    })
    const ok = await collect(adapter.stream(request([system('s'), user('hello again')])))
    expect(textOf(ok)).toBe('echo: hello again')
  })

  it('strips API-key credentials so the subscription sign-in is used', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test'
    await collect(adapter.stream(request([system('s'), user('x')])))
    expect(spawns()[0]?.hasApiKey).toBe(false)
  })

  it('reports a missing CLI clearly', async () => {
    config = Config({ command: join(dir, 'does-not-exist') })
    await expect(collect(adapter.stream(request([system('s'), user('x')])))).rejects.toMatchObject({
      code: 'CLAUDE_CODE_NOT_FOUND',
    })
  })

  it('aborts a running step and retires the process', async () => {
    const controller = new AbortController()
    const history: unknown[] = [system('s'), user('TOOL read_file {"path":"b"}')]
    const first = await collect(adapter.stream(request(history)))
    const callId = (first.find(chunk => chunk.type === 'block-end') as { block: { id: string } }).block.id
    controller.abort()
    history.push(assistantOf(first), toolResult(callId, 'late'))
    await expect(collect(adapter.stream(request(history, { signal: controller.signal })))).rejects.toMatchObject({ code: 'ABORTED' })
    expect(adapter.liveProcesses).toBe(0)
  })
})
