# KCode — Kulvex Code by Astrolexis

AI-powered coding assistant for the terminal. Runs entirely on local LLMs via llama-server (llama.cpp) — no external APIs required.

## Quick Start

```bash
# Install dependencies
bun install

# Register your local LLMs
kcode models add mnemo:code3 http://localhost:8091 --context 32000 --caps code --default
kcode models add mnemo:scanner http://localhost:8092 --context 4000 --caps vision,ocr

# Run interactive mode
bun run src/index.ts

# Or build and install the standalone binary
bun run build.ts
./scripts/install.sh
kcode
```

## Usage

```bash
# Interactive mode (full TUI)
kcode

# Single prompt (non-interactive)
kcode "explain this function"

# Pipe-friendly output
kcode --print "list all TODO comments" | less

# Override model for a session
kcode -m mnemo:mark4

# Permission modes
kcode -p auto      # auto-approve all tool calls
kcode -p ask       # prompt before each tool call (default)
kcode -p plan      # read-only, no writes
kcode -p deny      # block all tool calls
```

## Model Management

KCode uses a dynamic model registry — no hardcoded model names or ports.

```bash
kcode models list                    # Show registered models
kcode models add <name> <url>        # Register a model
  --context <tokens>                 #   Context window size
  --gpu <gpu>                        #   GPU (informational)
  --caps <cap1,cap2>                 #   Capabilities
  --desc "description"               #   Description
  --default                          #   Set as default
kcode models remove <name>           # Remove a model
kcode models default <name>          # Change default model
```

Models are stored in `~/.kcode/models.json`.

## Configuration

Settings are loaded in order (later overrides earlier):

1. **User**: `~/.kcode/settings.json`
2. **Project**: `.kcode/settings.json`
3. **Local** (gitignored): `.kcode/settings.local.json`
4. **Environment variables**: `KCODE_MODEL`, `KCODE_API_BASE`, `KCODE_API_KEY`, `KCODE_MAX_TOKENS`, `KCODE_EFFORT_LEVEL`, `KCODE_PERMISSION_MODE`

Example `settings.json`:
```json
{
  "model": "mnemo:code3",
  "maxTokens": 16384,
  "permissionMode": "ask",
  "autoMemory": true
}
```

## Project Instructions

Create a `KCODE.md` file in your project root to give KCode project-specific context:

```markdown
# Project conventions

- Use Bun instead of Node.js
- Run tests with `bun test`
- API is at localhost:16000
```

KCode loads `KCODE.md` from the working directory up to the git root.

## Tools (17 built-in)

| Tool | Description |
|------|-------------|
| **Bash** | Execute shell commands with timeout and safety analysis |
| **Read** | Read files (text, images, PDFs, Jupyter notebooks) |
| **Write** | Create or overwrite files |
| **Edit** | Precise string replacement in files |
| **Glob** | Find files by pattern (`**/*.ts`) |
| **Grep** | Search file contents with regex (ripgrep) |
| **Agent** | Spawn subagents for parallel/isolated tasks |
| **WebFetch** | Fetch URLs with HTML-to-text conversion |
| **WebSearch** | Search the web (Brave/DuckDuckGo) |
| **NotebookEdit** | Edit Jupyter notebook cells |
| **Tasks** | Create/list/get/update/stop background tasks |
| **MCP Tools** | Dynamically loaded from MCP servers |

## Skills (Slash Commands)

Built-in slash commands:

| Command | Aliases | Description |
|---------|---------|-------------|
| `/commit` | `/ci` | Stage and commit changes |
| `/review-pr` | `/pr`, `/review` | Review a pull request |
| `/simplify` | `/clean`, `/refactor` | Simplify selected code |
| `/help` | `/?`, `/commands` | Show available commands |

Create custom skills in `.kcode/skills/` or `~/.kcode/skills/` as markdown files with YAML frontmatter.

## MCP Servers

Configure Model Context Protocol servers in your settings:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["path/to/server.js"],
      "env": {}
    }
  }
}
```

MCP tools are auto-discovered and registered as `mcp__<server>__<tool>`.

## Hooks

Hooks run shell commands before/after tool execution:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "command": "echo $TOOL_INPUT | jq .command"
      }
    ],
    "PostToolUse": []
  }
}
```

Hook output is JSON: `{ "decision": "allow"|"deny"|"block", "reason": "...", "updatedInput": {} }`

## Memory System

KCode can persist context across conversations using memory files:

- Stored in `~/.kcode/projects/<hash>/memory/`
- YAML frontmatter with types: `user`, `feedback`, `project`, `reference`
- `MEMORY.md` index file (max 200 lines)
- Searchable via grep

## Security

- **Permission system**: 4 modes controlling tool execution
- **Bash safety analysis**: Detects command injection, pipe-to-shell, dangerous redirections, shell invocation
- **Write validation**: Blocks writes outside working directory and to sensitive files (.env, .bashrc)
- **Allowlist**: "Always allow" specific tool patterns per session

## Build

```bash
# Development build (fast, no minification)
bun run build:dev

# Production build (minified standalone binary)
bun run build

# Install to PATH
./scripts/install.sh           # → ~/.local/bin/kcode
./scripts/install.sh --system  # → /usr/local/bin/kcode (needs sudo)

# Run tests
bun test
```

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full technical reference.

```
src/
├── core/     # Engine: conversation loop, permissions, hooks, config, memory, models
├── tools/    # 17 built-in tools + MCP integration
├── ui/       # Ink-based terminal UI (React components)
└── index.ts  # CLI entry point
```

**38 source files, ~7,610 lines of TypeScript.**

## Requirements

- [Bun](https://bun.sh) 1.0+
- Local LLM via [llama-server](https://github.com/ggerganov/llama.cpp) (or any OpenAI-compatible API)
- Optional: `pdftotext` (poppler-utils) for PDF reading
- Optional: `ripgrep` for enhanced grep

## License

Proprietary — Astrolexis. All rights reserved.
