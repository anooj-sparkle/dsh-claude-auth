# dsh-llm-claude-code

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) plugin that routes model calls to **Claude**, billed to **your own Claude subscription** (Pro / Max / Team / Enterprise).

It adds a `claude-code` provider with Claude Opus, Sonnet and Haiku, and makes Claude the default for new agents. The harness keeps everything else: its agent loop, tools, permissions, compaction, sessions, and Web UI. Only the model calls go to Claude.

## How it works

```
 dsh agent loop ──GenerateOptions──▶ ClaudeCodeAdapter ──stdin (stream-json)──▶ claude -p   ──▶ Claude
       ▲                                  │      ▲                                 │  (your sign-in)
       │                                  │      └──── stream-json events ◀───────┘
       │                                  ▼                                         │
   harness tools  ◀── tool calls ── StreamChunks          local MCP bridge ◀── tools/call (parked)
   (read, edit, bash…)  ── results ──────────────────────▶ (127.0.0.1)  ── result ──▶
```

- **Signing in is left to Claude Code.** The plugin starts the unmodified official `claude` CLI, which signs in through its own `/login` flow. The plugin never reads, stores, or forwards a Claude token. This follows [Anthropic's rules on credential use](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use): third-party tools may not collect or relay Claude.ai credentials, but you may run the unmodified Claude Code binary with your own subscription.
- **The CLI gets no tools of its own, and the harness does all the work.** Claude Code starts with every built-in tool disabled (`--tools ""`). The harness's tool declarations reach it over a small MCP server on `127.0.0.1`. When Claude calls a tool, the MCP call is held open. The step ends with `tool-calls`, and the harness runs the tool itself, with its own sandbox and approvals. The next model request carries the result, and that result answers the held MCP call.
- **One process per conversation, so native history and prompt caching work.** Each harness session is pinned to a long-lived `claude -p --input-format stream-json` process. Raw Anthropic streaming events are translated 1:1 into harness chunks: text, thinking, tool calls, and usage including cache reads and writes.
- **Divergence is handled.** The harness's history can stop matching the process's, for example after harness compaction, an edited system prompt, a model/effort/tool change, a crash, a restart, or the idle timeout. When that happens, the process is retired and a new one starts with a transcript of the conversation so far.

## Requirements

- Node.js 20+ and DeepSeek Harness `>=0.2.2-rc.1 <0.3.0`.
- [Claude Code](https://code.claude.com/docs/en/overview) installed and signed in with your subscription:

  ```bash
  npm install -g @anthropic-ai/claude-code
  ```

  ```bash
  claude          # then run /login and pick your Claude subscription account
  ```

  ```bash
  claude auth status   # should report "loggedIn": true
  ```

  Tested with Claude Code 2.1.318.

## Install

Add the bundle to the profile you run. For the Web UI:

```bash
dsh plugin --profile web add github:anooj-sparkle/dsh-cluade-auth
```

From a local checkout (works for private repos too):

```bash
dsh plugin --profile web add /path/to/dsh-cluade-auth
```

Then start the harness as usual:

```bash
dsh web
```

New sessions use **Claude Sonnet**. Pick **Claude Opus** or **Claude Haiku** and an effort level (`low` … `max`) in the model picker; your choice is saved in the profile. The compiled `lib/` is committed, so a git install needs no build step and no `allowBuilds` grant.

The same works for one-shot jobs:

```bash
dsh plugin --profile headless add github:anooj-sparkle/dsh-cluade-auth
```

```bash
dsh --profile headless "summarize this repository"
```

## Configuration

The bundle's `cordis.patch.yml` inserts the adapter row and sets `agent-default-model` to `claude-code` / `sonnet`. Override either in your profile's `cordis.patch.yml`. A row's `config` is replaced as a whole, so restate every key you need:

```yaml
- id: llm-claude-code
  config:
    provider: claude-code
    defaultEffort: high
    models:
      - id: opus
        name: Claude Opus
        contextWindow: 1000000
      - id: sonnet
        name: Claude Sonnet

- id: agent-default-model
  config:
    provider: claude-code
    model: opus
```

| Field | Default | Meaning |
|---|---|---|
| `provider` | `claude-code` | Provider route key used in model selections. |
| `displayName` | `Claude (Claude Code subscription)` | Provider name in selectors. |
| `command` | `claude` | Claude Code executable (name on `PATH` or absolute path). |
| `models` | Opus, Sonnet, Haiku | Advertised models. `id` is anything `claude --model` accepts (aliases or full ids such as `claude-opus-5-5`). Optional `name`, `description`, `contextWindow`, `efforts`, `defaultEffort` per model. |
| `efforts` | `low, medium, high, xhigh, max` | Selectable `--effort` levels. Use `[]` to hide the selector. |
| `defaultEffort` | unset | Effort used when none is selected. Unset uses Claude Code's default. |
| `contextWindow` | `200000` | Context budget for models that do not set one. The harness compacts against it. |
| `cwd` | private empty temp dir | Working directory of the CLI processes. Workspace access goes through the harness tools, never through this directory. |
| `settingSources` | `project` | `--setting-sources` value. Combined with the empty `cwd`, your user-level Claude Code hooks, settings and plugins stay out. |
| `subscriptionOnly` | `true` | Removes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and the Bedrock/Vertex/Foundry switches from the CLI's environment, so usage goes to your subscription sign-in. |
| `isolateContext` | `true` | Sets `CLAUDE_CODE_DISABLE_CLAUDE_MDS` and `CLAUDE_CODE_DISABLE_AUTO_MEMORY`. The harness supplies its own context. |
| `extraArgs` | `[]` | Extra CLI arguments. |
| `env` | `{}` | Extra CLI environment variables. |
| `idleTimeoutMs` | 15 min | Closes a conversation's process after this much inactivity. The next request replays a transcript. |
| `toolResultTimeoutMs` | 24 h | How long Claude Code waits for the harness to finish one tool (`MCP_TOOL_TIMEOUT`). Covers slow tools and approval prompts. |
| `maxLiveProcesses` | `8` | Cap on live CLI processes. The least recently used one is closed first. |
| `drainTimeoutMs` | 30 s | Wait for a finished turn's trailing `result` line before falling back to a restart. |
| `mcpServerName` | `dsh` | MCP server name. Claude sees the tools as `mcp__dsh__<tool>`. |
| `defaultSystemPrompt` | `You are a helpful assistant.` | Used only when a request carries no system prompt. |

Claude Code's own auto-compaction is turned off (`DISABLE_AUTO_COMPACT=1`) because the harness owns compaction. MCP tool descriptions are passed through untruncated.

## Errors

Claude Code failures are mapped onto the harness's failure codes, so retry and compaction policies behave as they do for any provider:

| Situation | Code |
|---|---|
| Not signed in / expired sign-in | `INVALID_CREDENTIAL`; the message says to run `claude` → `/login` |
| Subscription usage limit reached | `QUOTA` (not retried) |
| Rate limited | `RATE_LIMIT` |
| Overloaded / 5xx | `SERVER` |
| Prompt too long | `CONTEXT_WINDOW_EXCEEDED` (the harness compacts) |
| CLI crashed / exited | `TRANSPORT` (the retry starts a fresh process) |
| `claude` not installed | `CLAUDE_CODE_NOT_FOUND` |

## Limitations

- **Images** reach Claude as text placeholders naming the attachment and, when the harness exposes one, its read-only path. The route advertises text input only.
- **Usage counts against your Claude plan's limits.** Advertised limits assume ordinary individual use, so this is meant for your own sessions. Don't share it as a hosted service.
- Profiles that hard-code their own model row (the ACP app's `acp` row) keep that setting. Point those rows at `provider: claude-code` yourself if you use them.
- Anthropic limits tool names to 64 characters, and Claude Code adds `mcp__dsh__` (10 characters). Harness tool names longer than 54 characters would be rejected.

## Development

```bash
npm install
```

```bash
npm test            # adapter tests against a scripted fake `claude` CLI (no account needed)
```

```bash
npm run typecheck
```

```bash
npm run build       # regenerate lib/ and commit it
```

Source map:

| File | Role |
|---|---|
| `src/index.ts` | Plugin entry: config, adapter registration, sign-in check |
| `src/adapter.ts` | `LlmAdapter`: model catalog, request routing, continuity decisions |
| `src/session.ts` | One `claude -p` process: spawn, steps, parked tool calls, error mapping |
| `src/events.ts` | Anthropic stream events → harness `StreamChunk`s |
| `src/history.ts` | Fingerprints, user/tool-result content, transcript replay |
| `src/mcp-server.ts` | Localhost MCP server exposing the harness tools |
| `cordis.patch.yml` | Bundle layer: inserts the adapter, makes Claude the default |

## License

MIT
