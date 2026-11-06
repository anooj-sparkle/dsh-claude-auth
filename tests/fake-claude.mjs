#!/usr/bin/env node
// A scripted stand-in for `claude -p --input-format stream-json
// --output-format stream-json --include-partial-messages`. It speaks the same
// line protocol and calls the MCP bridge exactly like Claude Code does, so
// adapter tests run without network access or a Claude account.
//
// Behaviour is driven by the latest user text:
//   "TOOL <name> <json>"  → one tool_use for that tool, then a reply quoting
//                            the MCP result once it arrives;
//   "TOOLS2 <name>"       → two parallel tool_use blocks;
//   "FAIL_AUTH"           → the CLI's not-signed-in failure;
//   "THINK"               → a thinking block before the text;
//   anything else         → "echo: <text>".
import { appendFileSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const argv = process.argv.slice(2)
const flag = (name) => {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}
const log = (entry) => {
  if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ pid: process.pid, ...entry })}\n`)
}

if (argv[0] === 'auth' && argv[1] === 'status') {
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }))
  process.exit(0)
}

const model = flag('--model') ?? 'sonnet'
const systemFile = flag('--system-prompt-file')
const mcpConfig = flag('--mcp-config') ? JSON.parse(flag('--mcp-config')) : undefined
const serverName = mcpConfig ? Object.keys(mcpConfig.mcpServers)[0] : undefined
const mcpUrl = serverName ? mcpConfig.mcpServers[serverName].url : undefined

log({
  kind: 'spawn',
  model,
  effort: flag('--effort'),
  system: systemFile ? readFileSync(systemFile, 'utf8') : undefined,
  tools: flag('--tools'),
  allowed: flag('--allowedTools'),
  hasApiKey: process.env.ANTHROPIC_API_KEY !== undefined,
  disableMds: process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS,
  maxOutput: process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS,
  cwd: process.cwd(),
})

const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const ev = (event) => out({ type: 'stream_event', event, parent_tool_use_id: null, session_id: 'fake' })
let rpcId = 0
let toolSeq = 0

async function rpc(method, params) {
  const response = await fetch(mcpUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  })
  const text = await response.text()
  if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const data = text.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('')
    return JSON.parse(data).result
  }
  return JSON.parse(text).result
}

let tools = []
if (mcpUrl) {
  await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fake', version: '0' } })
  tools = (await rpc('tools/list', {})).tools
  log({ kind: 'tools', names: tools.map(tool => tool.name), descriptions: tools.map(tool => tool.description) })
}
out({ type: 'system', subtype: 'init', model, tools: tools.map(tool => `mcp__${serverName}__${tool.name}`) })

let messageSeq = 0
function message(blocks, stopReason) {
  ev({ type: 'message_start', message: { id: `msg_${++messageSeq}`, usage: { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 2, output_tokens: 1 } } })
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      ev({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
      const half = Math.ceil(block.text.length / 2)
      for (const part of [block.text.slice(0, half), block.text.slice(half)]) {
        if (part) ev({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: part } })
      }
    } else if (block.type === 'thinking') {
      ev({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } })
      ev({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } })
      ev({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'sig' } })
    } else {
      ev({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: `mcp__${serverName}__${block.name}`, input: {} } })
      const json = JSON.stringify(block.input)
      ev({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: '' } })
      ev({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(0, 3) } })
      ev({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(3) } })
    }
    if (block.type !== 'tool_use') out({ type: 'assistant', message: { model, content: [block] } })
    ev({ type: 'content_block_stop', index })
  })
  ev({ type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 7 } })
  ev({ type: 'message_stop' })
}

async function handle(text) {
  if (text.includes('FAIL_AUTH')) {
    out({ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: 'Invalid API key · Please run /login' }] }, error: 'authentication_failed' })
    out({ type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key · Please run /login' })
    return
  }
  const tool = /TOOL (\S+) (\{.*\})/.exec(text)
  const tools2 = /TOOLS2 (\S+)/.exec(text)
  if ((tool || tools2) && mcpUrl) {
    const calls = tool
      ? [{ type: 'tool_use', id: `toolu_${++toolSeq}`, name: tool[1], input: JSON.parse(tool[2]) }]
      : [1, 2].map(n => ({ type: 'tool_use', id: `toolu_${++toolSeq}`, name: tools2[1], input: { n } }))
    message(calls, 'tool_use')
    const results = await Promise.all(calls.map(call => rpc('tools/call', {
      name: call.name,
      arguments: call.input,
      _meta: process.env.FAKE_CLAUDE_NO_META ? undefined : { 'claudecode/toolUseId': call.id, progressToken: 1 },
    })))
    log({ kind: 'tool-results', results })
    out({ type: 'user', message: { role: 'user', content: results.map((result, i) => ({ type: 'tool_result', tool_use_id: calls[i].id, content: result.content })) } })
    const summary = results.map(result => `${result.isError ? 'ERR ' : ''}${result.content.map(block => block.text).join('')}`).join(' | ')
    message([{ type: 'text', text: `Result was: ${summary}` }], 'end_turn')
  } else if (text.includes('THINK')) {
    message([{ type: 'thinking', thinking: 'pondering' }, { type: 'text', text: 'thought about it' }], 'end_turn')
  } else {
    message([{ type: 'text', text: `echo: ${text.split('\n').at(-1)}` }], 'end_turn')
  }
  out({ type: 'result', subtype: 'success', is_error: false, result: 'done' })
}

const lines = createInterface({ input: process.stdin })
let queue = Promise.resolve()
lines.on('line', (line) => {
  if (!line.trim()) return
  const input = JSON.parse(line)
  const text = input.message.content.map(block => block.text ?? '').join('\n')
  log({ kind: 'user', text })
  queue = queue.then(() => handle(text)).catch((error) => {
    log({ kind: 'error', message: String(error) })
    process.exit(3)
  })
})
lines.on('close', () => { void queue.then(() => process.exit(0)) })
