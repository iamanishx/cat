# Cat - MCP Agent Server

An autonomous AI coding agent exposed as an MCP (Model Context Protocol) server. Other AI agents like Cursor, Claude Desktop, or any MCP-compatible client can delegate software engineering tasks to Cat.

Cat has access to filesystem operations, shell execution, and web search — and executes tasks independently without human-in-the-loop.

## Setup

```bash
bun install
```

Configure your LLM provider in `~/.axe/config.json`:

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

## Running

```bash
bun run start
```

This starts the MCP server on stdio transport.

## Connecting from AI Clients

### Cursor

Add to your MCP config (`.cursor/mcp.json` in your project or global config):

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

## Exposed Tools

### `run-task`

Delegates a full coding task to the Cat agent. It will autonomously use filesystem, shell, and web search tools to complete the task.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `prompt` | string | yes | The task or instruction to execute |
| `workingDirectory` | string | no | Working directory (defaults to server cwd) |
| `history` | array | no | Conversation history for context |

### `shell-exec`

Executes a shell command directly. For quick commands that don't need the full agent.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `command` | string | yes | The shell command to execute |
| `cwd` | string | no | Working directory for the command |

## Architecture

```
Cursor/Claude Desktop
  └── MCP (stdio) ──> Cat Server (src/server.ts)
                          ├── run-task ──> Agent (src/lib/agent.ts)
                          │                  ├── Filesystem MCP client
                          │                  ├── Shell tool
                          │                  └── Exa web search
                          └── shell-exec ──> Direct shell execution
```

## Requirements

- [Bun](https://bun.sh) runtime
- API key for at least one LLM provider
