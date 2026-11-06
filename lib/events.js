/**
 * Translation of Claude Code's `stream-json` output into harness stream
 * chunks. With `--include-partial-messages`, Claude Code forwards the raw
 * Anthropic Messages streaming events of every API call as `stream_event`
 * lines, so one harness model step is exactly one Anthropic message:
 * `message_start` … `message_stop`.
 * @module dsh-llm-claude-code/events
 */
import { ToolCallId } from '@deepseek-ai/dsh-llm';
/**
 * Stateful translator for one Anthropic message. Feed it `stream_event`
 * payloads; it returns the harness chunks each one produces.
 */
export class StepTranslator {
    toolPrefix;
    open = new Map();
    nextIndex = 0;
    usage = {};
    stop;
    /** Whether `message_start` was seen. */
    started = false;
    /** Whether `message_stop` was seen. */
    done = false;
    /** Concatenated visible text, for continuity fingerprints. */
    text = '';
    toolCalls = [];
    /**
     * @param toolPrefix - prefix Claude Code puts on MCP tool names (`mcp__dsh__`).
     */
    constructor(toolPrefix) {
        this.toolPrefix = toolPrefix;
    }
    handle(event) {
        switch (event.type) {
            case 'message_start':
                this.started = true;
                this.mergeUsage(event.message?.usage);
                return [];
            case 'content_block_start':
                return this.start(event);
            case 'content_block_delta':
                return this.delta(event);
            case 'content_block_stop':
                return this.end(event);
            case 'message_delta':
                if (event.delta?.stop_reason !== undefined)
                    this.stop = event.delta.stop_reason;
                this.mergeUsage(event.usage);
                return [];
            case 'message_stop':
                this.done = true;
                return this.closeDangling();
            default:
                return [];
        }
    }
    /** Native Anthropic stop reason, once known. */
    get stopReason() {
        return this.stop;
    }
    /** Usage chunk for the message so far, or undefined before `message_start`. */
    usageChunk() {
        if (!this.started)
            return undefined;
        const usage = {
            inputTokens: this.usage.input_tokens ?? 0,
            outputTokens: this.usage.output_tokens ?? 0,
        };
        if (this.usage.cache_read_input_tokens !== undefined)
            usage.cacheReadTokens = this.usage.cache_read_input_tokens;
        if (this.usage.cache_creation_input_tokens !== undefined)
            usage.cacheWriteTokens = this.usage.cache_creation_input_tokens;
        usage.totalTokens = usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
        return { type: 'usage', usage };
    }
    /** Finish reason for a completed message. */
    finishReason() {
        if (this.stop === 'tool_use' && this.toolCalls.length > 0)
            return { kind: 'tool-calls' };
        if (this.stop === 'max_tokens')
            return { kind: 'max-tokens' };
        return { kind: 'stop' };
    }
    mergeUsage(usage) {
        if (usage === undefined)
            return;
        for (const key of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) {
            const value = usage[key];
            if (typeof value === 'number' && Number.isFinite(value) && value >= 0)
                this.usage[key] = value;
        }
    }
    start(event) {
        const source = event.content_block;
        if (source === undefined || event.index === undefined)
            return [];
        const index = this.nextIndex;
        switch (source.type) {
            case 'text': {
                this.nextIndex++;
                const block = { index, kind: 'text', text: '' };
                this.open.set(event.index, block);
                const chunks = [{ type: 'block-start', index, blockType: 'text' }];
                if (source.text !== undefined && source.text.length > 0) {
                    block.text += source.text;
                    chunks.push({ type: 'text-delta', index, text: source.text });
                }
                return chunks;
            }
            case 'thinking': {
                this.nextIndex++;
                const block = { index, kind: 'reasoning', text: '' };
                this.open.set(event.index, block);
                const chunks = [{ type: 'block-start', index, blockType: 'reasoning' }];
                if (source.thinking !== undefined && source.thinking.length > 0) {
                    block.text += source.thinking;
                    chunks.push({ type: 'reasoning-delta', index, text: source.thinking });
                }
                return chunks;
            }
            case 'tool_use': {
                this.nextIndex++;
                const id = source.id ?? `toolu_missing_${index}`;
                const name = this.stripPrefix(source.name ?? 'unknown');
                this.open.set(event.index, { index, kind: 'tool-call', text: '', id, name, startInput: source.input });
                return [
                    { type: 'block-start', index, blockType: 'tool-call' },
                    { type: 'tool-call-delta', index, id: ToolCallId(id), name, argumentsDelta: '' },
                ];
            }
            default:
                // redacted_thinking, server tools, and anything newer carry nothing
                // the harness can replay; skip them.
                return [];
        }
    }
    delta(event) {
        if (event.index === undefined)
            return [];
        const block = this.open.get(event.index);
        const delta = event.delta;
        if (block === undefined || delta === undefined)
            return [];
        switch (delta.type) {
            case 'text_delta':
                if (block.kind !== 'text' || delta.text === undefined || delta.text.length === 0)
                    return [];
                block.text += delta.text;
                return [{ type: 'text-delta', index: block.index, text: delta.text }];
            case 'thinking_delta':
                if (block.kind !== 'reasoning' || delta.thinking === undefined || delta.thinking.length === 0)
                    return [];
                block.text += delta.thinking;
                return [{ type: 'reasoning-delta', index: block.index, text: delta.thinking }];
            case 'input_json_delta':
                if (block.kind !== 'tool-call' || delta.partial_json === undefined || delta.partial_json.length === 0)
                    return [];
                block.text += delta.partial_json;
                return [{ type: 'tool-call-delta', index: block.index, id: ToolCallId(block.id), argumentsDelta: delta.partial_json }];
            default:
                return [];
        }
    }
    end(event) {
        if (event.index === undefined)
            return [];
        const block = this.open.get(event.index);
        if (block === undefined)
            return [];
        this.open.delete(event.index);
        return this.finishBlock(block);
    }
    finishBlock(block) {
        let content;
        const chunks = [];
        switch (block.kind) {
            case 'text':
                this.text += block.text;
                content = { type: 'text', text: block.text };
                break;
            case 'reasoning':
                content = { type: 'reasoning', text: block.text };
                break;
            case 'tool-call': {
                let args = block.text;
                if (args.trim().length === 0) {
                    args = block.startInput !== undefined && block.startInput !== null ? JSON.stringify(block.startInput) : '{}';
                    chunks.push({ type: 'tool-call-delta', index: block.index, id: ToolCallId(block.id), argumentsDelta: args });
                }
                const call = { id: block.id, name: block.name, arguments: args };
                this.toolCalls.push(call);
                content = { type: 'tool-call', id: ToolCallId(call.id), name: call.name, arguments: args };
                break;
            }
        }
        chunks.push({ type: 'block-end', index: block.index, block: content });
        return chunks;
    }
    closeDangling() {
        const chunks = [];
        for (const [key, block] of [...this.open.entries()].sort((a, b) => a[1].index - b[1].index)) {
            this.open.delete(key);
            chunks.push(...this.finishBlock(block));
        }
        return chunks;
    }
    stripPrefix(name) {
        return name.startsWith(this.toolPrefix) ? name.slice(this.toolPrefix.length) : name;
    }
}
