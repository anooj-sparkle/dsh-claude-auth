/**
 * Translation of the harness's provider-neutral request history into what a
 * Claude Code process consumes: fingerprints for continuity checks, user
 * message content, MCP tool results, and a replay transcript for the cases
 * where a fresh process has to pick a conversation up mid-way.
 * @module dsh-llm-claude-code/history
 */
import { digest } from './util.js';
/**
 * Split a request into its system prompt and model-visible turns.
 * Developer messages only carry tool additions/removals, which this route
 * does not opt into (every request declares its complete tool list).
 */
export function viewOf(options) {
    const systemParts = [];
    if (options.system !== undefined && options.system.length > 0)
        systemParts.push(options.system);
    const turns = [];
    for (const message of options.messages) {
        if (message.role === 'system') {
            const text = textOf(message.content);
            if (text.length > 0)
                systemParts.push(text);
            continue;
        }
        if (message.role === 'developer')
            continue;
        turns.push(message);
    }
    return { system: systemParts.join('\n\n'), turns };
}
/** Plain text of text blocks only. */
export function textOf(content) {
    return content.filter((block) => block.type === 'text')
        .map(block => block.text)
        .join('');
}
/** Tool calls an assistant turn requested. */
export function toolCallsOf(content) {
    return content.filter((block) => block.type === 'tool-call');
}
/**
 * Identity of one turn for continuity checks. Assistant turns are identified
 * by their visible text and tool-call ids only, because that is all this
 * adapter emitted for them; reasoning text and harness-side bookkeeping must
 * not make an otherwise identical history look different.
 */
export function fingerprint(turn) {
    switch (turn.role) {
        case 'assistant':
            return `A:${digest([textOf(turn.content).trim(), toolCallsOf(turn.content).map(call => call.id)])}`;
        case 'tool':
            return `T:${turn.toolCallId}:${digest([turn.content, turn.isError === true])}`;
        case 'user':
            return `U:${digest(turn.content)}`;
        default:
            return `X:${digest(turn)}`;
    }
}
/** Fingerprint of an assistant response as this adapter streamed it. */
export function emittedFingerprint(text, toolCallIds) {
    return `A:${digest([text.trim(), toolCallIds])}`;
}
/** Render one content block as text for a model that only receives text here. */
export function blockText(block, imageText) {
    switch (block.type) {
        case 'text':
            return block.text;
        case 'image':
            return imageText(block);
        case 'reasoning':
        case 'tool-addition':
        case 'tool-removal':
            return undefined;
        case 'tool-call':
            return `[tool call ${block.name} ${block.arguments}]`;
        case 'file':
            // Request assembly projects files to handle text before adapters see
            // them; this only guards a hand-built request.
            return `[file attachment ${block.attachment.name ?? block.attachment.attachmentId}]`;
        default:
            return JSON.stringify(block);
    }
}
/** User turns rendered as stream-json text blocks. */
export function userBlocks(turns, imageText) {
    const blocks = [];
    for (const turn of turns) {
        for (const block of turn.content) {
            const text = blockText(block, imageText);
            if (text !== undefined && text.length > 0)
                blocks.push({ type: 'text', text });
        }
    }
    if (blocks.length === 0)
        blocks.push({ type: 'text', text: '(empty message)' });
    return blocks;
}
/** One harness tool-result turn as an MCP `tools/call` result. */
export function toolResultOf(turn, imageText) {
    const content = [];
    for (const block of turn.content) {
        const text = blockText(block, imageText);
        if (text !== undefined && text.length > 0)
            content.push({ type: 'text', text });
    }
    if (content.length === 0)
        content.push({ type: 'text', text: turn.isError === true ? 'Tool failed with no output.' : '(no output)' });
    return { content, ...turn.isError === true ? { isError: true } : {} };
}
const TRANSCRIPT_PREAMBLE = [
    'The host application is resuming an existing conversation in a new model session.',
    'Everything inside <conversation_history> already happened: tool calls listed there were',
    'executed by the host and their results are shown. Continue from where it ends; do not',
    'repeat completed work. Use the available tools for any further actions.',
].join(' ');
/**
 * Replay a conversation into a single user message for a fresh process.
 * Used when no live process holds this conversation (first contact after a
 * restart, after harness-side compaction, or after a configuration change).
 * @param turns - every model-visible turn of the request.
 */
export function transcriptBlocks(turns, imageText) {
    // A request ending in user turns: those become the live message and the
    // rest is history. Otherwise (it ends with tool results) everything is
    // history and the model is asked to continue.
    let split = turns.length;
    while (split > 0 && turns[split - 1]?.role === 'user')
        split--;
    const history = turns.slice(0, split);
    const live = turns.slice(split);
    if (history.length === 0)
        return userBlocks(live, imageText);
    const lines = [];
    for (const turn of history) {
        switch (turn.role) {
            case 'user':
                lines.push('<user>', joinText(turn.content, imageText), '</user>');
                break;
            case 'assistant': {
                const text = textOf(turn.content).trim();
                if (text.length > 0)
                    lines.push('<assistant>', text, '</assistant>');
                for (const call of toolCallsOf(turn.content)) {
                    lines.push(`<tool_call id="${call.id}" name="${call.name}">`, call.arguments, '</tool_call>');
                }
                break;
            }
            case 'tool':
                lines.push(`<tool_result id="${turn.toolCallId}"${turn.isError === true ? ' is_error="true"' : ''}>`, joinText(turn.content, imageText), '</tool_result>');
                break;
            default:
                break;
        }
    }
    const blocks = [{
            type: 'text',
            text: `${TRANSCRIPT_PREAMBLE}\n\n<conversation_history>\n${lines.join('\n')}\n</conversation_history>`,
        }];
    if (live.length > 0)
        blocks.push(...userBlocks(live, imageText));
    else
        blocks.push({ type: 'text', text: 'Continue the conversation from the last tool results above.' });
    return blocks;
}
function joinText(content, imageText) {
    return content.map(block => blockText(block, imageText)).filter((text) => text !== undefined).join('\n');
}
/** Process-launch identity: anything that is fixed for a process's lifetime. */
export function launchKey(input) {
    return digest([input.model, input.effort ?? '', input.system, input.tools.map(tool => [tool.name, tool.description, tool.parameters])]);
}
