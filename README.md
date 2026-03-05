# Cat — MCP Agent Server

An autonomous AI coding agent that runs as an MCP server over stdio. Parent agents (KiloCode, Cursor, Claude Desktop, or your own bot) can delegate software engineering tasks to it — cat plans the work, executes it step by step, and reports progress.

## Setup

```bash
bun install
```

Configure your LLM provider in `~/.cat/config.json`:

```json
{
  "provider": "google",
  "model": "gemini-2.5-flash",
  "keys": {
    "google": "your-api-key"
  }
}
```

Supported providers: `google`, `anthropic`, `openai`, `groq`, `xai`, `deepseek`, `qwen`, `kimi`, `gemini`, `minimax`

> The `gemini` provider uses OAuth via the Gemini CLI (no API key needed). All others need a key in `keys`.

## Running

```bash
bun run start
```

Starts the MCP server on stdio. Wire it up in your client's MCP config and you're good.

## Connecting

### KiloCode / Cursor

Add to `.kilocode/mcp.json` or `.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "cat-agent": {
      "type": "stdio",
      "command": "bun",
      "args": ["run", "/path/to/cat/src/server.ts"]
    }
  }
}
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cat-agent": {
      "command": "bun",
      "args": ["run", "/path/to/cat/src/server.ts"]
    }
  }
}
```

## Tools

### `run_task`

Delegates a task to the cat agent. Cat breaks it into steps, executes each one using filesystem, shell, and web search tools, and tracks progress in SQLite. Returns a task ID immediately — use `get_progress` to poll.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `prompt` | string | yes | What you want done |
| `workingDirectory` | string | no | Where to work (defaults to server cwd) |
| `history` | array | no | Conversation history for context |

### `get_progress`

Poll for the status of a running task. Returns which todos are done, in progress, pending, or failed.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `taskId` | string | yes | The task ID from `run_task` |

### `abort_task`

Cancel a running task.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `taskId` | string | yes | The task ID to cancel |

### `shell-exec`

Runs a shell command directly without going through the full agent. Good for quick one-off commands.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `command` | string | yes | Shell command to run |
| `cwd` | string | no | Working directory |

## Architecture

```
Parent agent (KiloCode / Cursor / gh-bot)
  └── MCP stdio ──> cat server (src/server.ts)
                        ├── run_task ──> agent (src/lib/agent.ts)
                        │                  ├── planTask()       — LLM breaks prompt into todos
                        │                  ├── executeTodo()    — LLM executes each todo
                        │                  │     ├── Filesystem MCP (@modelcontextprotocol/server-filesystem)
                        │                  │     ├── Shell tool
                        │                  │     └── Exa web search
                        │                  └── progress → SQLite (~/.cat/cat.db)
                        ├── get_progress ──> reads SQLite directly
                        ├── abort_task ──> sets abort flag
                        └── shell-exec ──> direct shell execution
```

## A note on client compatibility

Cat's `run_task` returns immediately with a task ID and runs the actual work in the background. This works great when the parent keeps the MCP connection open while polling `get_progress`.

However, some clients (KiloCode, Cursor) close the stdin pipe as soon as they get a response — they follow the standard request/response MCP pattern and don't expect background work. Cat handles this with a keep-alive mechanism that holds the process open until the task finishes.

**This works reliably as long as the client doesn't force-kill the process.** If the client sends SIGKILL (not SIGTERM), the task will die mid-execution — there's no way to catch that signal. KiloCode sends SIGKILL after ~4 seconds if the process doesn't exit after SIGTERM, so for long-running tasks via KiloCode you may occasionally see tasks cut short. The task state is always saved to SQLite, so you can see what completed before the kill.

For production use (e.g. running inside a sandbox controlled by your own agent), this isn't an issue — your agent controls the process and won't kill it until you're done.

## Requirements

- [Bun](https://bun.sh) runtime
- API key for at least one LLM provider (or Gemini CLI OAuth for `gemini` provider)
