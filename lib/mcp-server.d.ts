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
import type { ToolSchema } from '@deepseek-ai/dsh-llm';
import type { McpToolResult } from './history.js';
/** What one endpoint serves. */
export interface McpEndpointHandler {
    /** Tool declarations advertised through `tools/list`. */
    tools(): readonly ToolSchema[];
    /**
     * Resolve one tool call with the harness's result.
     * @param name - harness tool name (without the MCP prefix).
     * @param args - parsed arguments.
     * @param toolUseId - Anthropic tool_use id Claude Code attaches in `_meta`.
     * @param signal - aborts when the HTTP request is torn down.
     */
    call(name: string, args: unknown, toolUseId: string | undefined, signal: AbortSignal): Promise<McpToolResult>;
}
export declare class McpBridgeServer {
    private server;
    private starting;
    private readonly endpoints;
    /** Register an endpoint and return its URL; the returned function removes it. */
    register(handler: McpEndpointHandler): Promise<{
        url: string;
        dispose: () => void;
    }>;
    close(): Promise<void>;
    private listen;
    private route;
    /**
     * Answer a tool call as an SSE stream: headers go out at once and comment
     * lines keep the connection busy, so no client-side idle or body timeout
     * fires while the harness runs a long tool.
     */
    private toolCall;
}
