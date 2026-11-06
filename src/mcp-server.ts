/**
 * A minimal MCP (streamable HTTP) server on 127.0.0.1 that exposes the
 * harness's tool declarations to Claude Code. It never executes anything:
 * a `tools/call` is parked until the harness has run the tool itself and
 * sent the result back with the next model request.
 *
 * Each Claude Code process gets its own unguessable endpoint path, so one
 * listener serves every live conversation.
 * @module dsh-llm-claude-code/mcp-server
 */

import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { McpToolResult } from './history.js'

/** What one endpoint serves. */
export interface McpEndpointHandler {
  /** Tool declarations advertised through `tools/list`. */
  tools(): readonly ToolSchema[]
  /**
   * Resolve one tool call with the harness's result.
   * @param name - harness tool name (without the MCP prefix).
   * @param args - parsed arguments.
   * @param toolUseId - Anthropic tool_use id Claude Code attaches in `_meta`.
   * @param signal - aborts when the HTTP request is torn down.
   */
  call(name: string, args: unknown, toolUseId: string | undefined, signal: AbortSignal): Promise<McpToolResult>
}

interface JsonRpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

const PROTOCOL_FALLBACK = '2025-06-18'
const KEEPALIVE_MS = 15_000

export class McpBridgeServer {
  private server: Server | undefined
  private starting: Promise<number> | undefined
  private readonly endpoints = new Map<string, McpEndpointHandler>()

  /** Register an endpoint and return its URL; the returned function removes it. */
  async register(handler: McpEndpointHandler): Promise<{ url: string; dispose: () => void }> {
    const port = await this.listen()
    const token = randomBytes(24).toString('hex')
    this.endpoints.set(token, handler)
    return {
      url: `http://127.0.0.1:${port}/mcp/${token}`,
      dispose: () => { this.endpoints.delete(token) },
    }
  }

  async close(): Promise<void> {
    this.endpoints.clear()
    const server = this.server
    this.server = undefined
    this.starting = undefined
    if (server === undefined) return
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }

  private listen(): Promise<number> {
    if (this.starting !== undefined) return this.starting
    const server = createServer((req, res) => { void this.route(req, res) })
    // Tool calls stay open for as long as the harness takes to run a tool
    // (including waiting for a human approval), so no server-side timeout.
    server.requestTimeout = 0
    server.headersTimeout = 0
    server.timeout = 0
    server.keepAliveTimeout = 60_000
    this.server = server
    this.starting = new Promise<number>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve((server.address() as AddressInfo).port)
      })
    })
    return this.starting
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const match = /^\/mcp\/([0-9a-f]+)\/?$/.exec(req.url ?? '')
    const handler = match === null ? undefined : this.endpoints.get(match[1] as string)
    if (handler === undefined) {
      res.writeHead(404).end()
      return
    }
    if (req.method === 'DELETE') {
      res.writeHead(200).end()
      return
    }
    if (req.method !== 'POST') {
      // No server-initiated stream: this server never pushes notifications.
      res.writeHead(405, { allow: 'POST, DELETE' }).end()
      return
    }
    let body = ''
    try {
      for await (const chunk of req) body += chunk
    } catch {
      return
    }
    let message: JsonRpcRequest | JsonRpcRequest[]
    try {
      message = JSON.parse(body) as JsonRpcRequest | JsonRpcRequest[]
    } catch {
      sendJson(res, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      return
    }
    if (Array.isArray(message)) {
      // Batches only ever carry notifications/responses from this client.
      res.writeHead(202).end()
      return
    }
    if (message.id === undefined || message.id === null) {
      // Notification (initialized, cancelled, …): acknowledge.
      res.writeHead(202).end()
      return
    }
    const id = message.id
    switch (message.method) {
      case 'initialize': {
        const requested = message.params?.protocolVersion
        sendJson(res, {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: typeof requested === 'string' ? requested : PROTOCOL_FALLBACK,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'dsh-harness-tools', version: '0.1.0' },
            instructions: 'Tools provided by the host agent harness. The host executes every call.',
          },
        })
        return
      }
      case 'ping':
        sendJson(res, { jsonrpc: '2.0', id, result: {} })
        return
      case 'tools/list':
        sendJson(res, {
          jsonrpc: '2.0',
          id,
          result: { tools: handler.tools().map(tool => ({ name: tool.name, description: tool.description, inputSchema: inputSchemaOf(tool) })) },
        })
        return
      case 'tools/call':
        await this.toolCall(handler, id, message.params ?? {}, req, res)
        return
      default:
        sendJson(res, { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${String(message.method)}` } })
    }
  }

  /**
   * Answer a tool call as an SSE stream: headers go out at once and comment
   * lines keep the connection busy, so no client-side idle or body timeout
   * fires while the harness runs a long tool.
   */
  private async toolCall(
    handler: McpEndpointHandler,
    id: string | number,
    params: Record<string, unknown>,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const controller = new AbortController()
    const onClose = (): void => { if (!res.writableEnded) controller.abort() }
    res.on('close', onClose)
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    res.write(': accepted\n\n')
    const keepalive = setInterval(() => { if (!res.writableEnded) res.write(': keepalive\n\n') }, KEEPALIVE_MS)
    const meta = params._meta as Record<string, unknown> | undefined
    const toolUseId = typeof meta?.['claudecode/toolUseId'] === 'string' ? meta['claudecode/toolUseId'] : undefined
    let payload: unknown
    try {
      const result = await handler.call(String(params.name ?? ''), params.arguments ?? {}, toolUseId, controller.signal)
      payload = { jsonrpc: '2.0', id, result }
    } catch (error) {
      payload = {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true },
      }
    } finally {
      clearInterval(keepalive)
      res.off('close', onClose)
      void req
    }
    if (!res.writableEnded && !res.destroyed) {
      res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`)
    }
  }
}

function sendJson(res: ServerResponse, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }).end(body)
}

function inputSchemaOf(tool: ToolSchema): Record<string, unknown> {
  const schema = tool.parameters
  if (schema !== null && typeof schema === 'object' && schema.type === 'object') return schema
  return { type: 'object', properties: {}, ...schema }
}
