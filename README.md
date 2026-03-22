# KCode — Kulvex Code by Astrolexis

> AI-powered coding assistant for the terminal. Runs 100% local on your GPU.

KCode is a terminal-based AI coding agent that connects to local LLMs (llama.cpp, Ollama, vLLM, or any OpenAI-compatible API) to read, write, search, and refactor code directly on your machine. Your code never leaves your hardware. Built with Bun and TypeScript, it features a rich Ink-based TUI, 18 built-in tools, 32 slash commands, a 10-layer cognitive architecture, SQLite-backed long-term memory, 11 color themes, a plugin system, and LSP integration.

## Features

- **18 built-in tools**: Bash, Read, Write, Edit, Glob, Grep, Agent, WebFetch, WebSearch, NotebookEdit, Tasks (create/list/get/update/stop), Learn, and MCP resource tools
- **32 slash commands**: /commit, /review-pr, /simplify, /diff, /test, /build, /lint, /branch, /log, /stash, /explain, /find-bug, /security, /security-review, /batch, /loop, /template, /deps, /todo, /test-for, /doc, /type, /export, /stats, /doctor, /models, /context, /compact, /rewind, /clear, /theme, /help
- **11 color themes**: default, dark, light, cyberpunk, monokai, solarized, dracula, gruvbox, nord, catppuccin, matrix
- **5 permission modes**: ask, auto, plan, deny, acceptEdits
- **10-layer cognitive architecture**: identity, tools, code guidelines, git awareness, environment sensing, situational awareness, metacognition, user model, world model, session narrative
- **Plugin system**: Directory-based plugins with skills, hooks, and MCP server bundles
- **LSP integration**: Auto-detects language servers (TypeScript, Pyright, gopls, rust-analyzer) for real-time diagnostics
- **VS Code extension**: Sidebar chat, context menu commands, terminal integration
- **Local LLM support**: Works with llama.cpp, Ollama, vLLM, or any OpenAI-compatible API
- **Multi-GPU**: Distribute inference across multiple GPUs (e.g., RTX 5090 + 4090) via llama.cpp RPC
- **MCP support**: Connect to external tools via Model Context Protocol
- **Long-term memory**: SQLite FTS5-backed Learn tool persists knowledge across sessions
- **Autonomous learning**: Searches the web, reads docs, and remembers findings without being asked
- **Privacy-first**: Your code never leaves your machine

## Quick Start

```bash
# Install (requires Bun — https://bun.sh)
git clone https://github.com/GaltRanch/KCode.git
cd KCode
bun install
bun run build

# Register your local model
./dist/kcode models add mymodel http://localhost:8080 --context 32000 --gpu "RTX 4090" --default

# Run
./dist/kcode
```

## Requirements

- [Bun](https://bun.sh) runtime
- A local LLM server (llama.cpp, Ollama, vLLM, etc.) with an OpenAI-compatible API
- GPU recommended (CPU works but slow)

## Usage

### Interactive mode

```bash
kcode                          # Start interactive session
kcode "fix the login bug"     # Start with a prompt
kcode -c                       # Continue last session
kcode --fork                   # Fork last session into a new one
kcode --worktree feature-x     # Work in an isolated git worktree
kcode --thinking               # Enable extended thinking mode
kcode --theme dracula          # Use a color theme
```

### Print mode (for piping)

```bash
kcode --print "explain this error" < error.log
cat src/app.ts | kcode --print "review this code"
kcode --print --json-schema '{"type":"object","properties":{"bugs":{"type":"array"}}}' "find bugs in src/"
```

### Slash commands

```bash
/commit              # Create git commit with conventions
/review-pr 123       # Review PR #123
/batch "add error handling to all API routes"
/security-review src/
/test                # Run project tests
/build               # Build the project
/lint                # Lint and auto-fix
/diff                # Show git diff with stats
/simplify            # Review and simplify recent changes
/find-bug src/       # Analyze code for bugs
/context             # View context window usage
/compact             # Compress conversation history
/export              # Save conversation to file
/rewind              # Undo recent file changes
/stats               # Usage statistics
/doctor              # System health check
/theme dracula       # Switch color theme
/plugins             # List installed plugins
/help                # Show all commands
```

### Model management

```bash
kcode models list
kcode models add gpt4 https://api.openai.com --context 128000 --default
kcode models default mymodel
kcode models rm oldmodel
```

## Configuration

Settings are loaded in this order (highest priority first):

1. CLI flags (`-m`, `-p`, `--thinking`, `--theme`, etc.)
2. Environment variables (`KCODE_MODEL`, `KCODE_API_KEY`, `KCODE_API_BASE`, `KCODE_EFFORT_LEVEL`, `KCODE_MAX_TOKENS`, `KCODE_PERMISSION_MODE`, `KCODE_THEME`)
3. `.kcode/settings.local.json` (gitignored, per-machine overrides)
4. `.kcode/settings.json` (project-level, committed)
5. `~/.kcode/settings.json` (user-level defaults)

### Key settings

```json
{
  "model": "mnemo:mark5",
  "maxTokens": 16384,
  "permissionMode": "ask",
  "autoMemory": true,
  "effortLevel": "high",
  "autoRoute": true,
  "theme": "dracula"
}
```

### Project instructions

Create a `KCODE.md` file in your project root with conventions, build commands, and rules. KCode loads it automatically and walks up to the git root looking for inherited instructions.

### Path-specific rules

Add `.kcode/rules/*.md` files with YAML frontmatter:

```markdown
---
name: api-conventions
paths:
  - "src/api/**"
  - "src/routes/**"
---
All API routes must validate input with zod schemas.
Always return proper HTTP status codes.
```

### Themes

KCode ships with 11 color themes. Switch with `/theme`, `--theme`, or `KCODE_THEME`:

| Theme | Style |
|-------|-------|
| `default` | Tokyonight-inspired (blue/purple) |
| `dark` | Blue/cyan dominant |
| `light` | Muted colors for light terminals |
| `cyberpunk` | Neon pink/cyan/yellow |
| `monokai` | Classic Monokai |
| `solarized` | Solarized Dark |
| `dracula` | Dracula |
| `gruvbox` | Gruvbox Dark |
| `nord` | Nord |
| `catppuccin` | Catppuccin Mocha |
| `matrix` | All green hacker vibes |

Custom themes: create `~/.kcode/theme.json` with your own hex colors.

### Plugins

Plugins live in `~/.kcode/plugins/` (global) or `.kcode/plugins/` (project-level). Each plugin is a directory with a `plugin.json` manifest:

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "My custom plugin",
  "skills": ["skills/my-command.md"],
  "hooks": { "PostToolUse": { "command": "notify-send", "args": ["KCode done"] } },
  "mcpServers": { "my-server": { "command": "my-mcp-server", "args": ["--stdio"] } }
}
```

Use `/plugins` to list installed plugins.

### Extensible awareness

- `~/.kcode/identity.md` — extend KCode's personality and preferences
- `~/.kcode/awareness/*.md` — global awareness modules injected into every session
- `.kcode/awareness/*.md` — project-level awareness modules

## Architecture

KCode assembles a system prompt from 10 independent layers:

1. **Identity** — who KCode is, its capabilities and limitations
2. **Tool instructions** — usage patterns for all 18 built-in tools
3. **Code guidelines** — safe coding practices, verification rules
4. **Git instructions** — commit protocol, safety rules, PR workflow
5. **Environment** — working directory, platform, git state, model info
6. **Situational awareness** — project scan, listening ports, disk/memory, time of day
7. **Metacognition** — confidence calibration, error monitoring, proactive behavior
8. **User model** — adapts to expertise level and preferences over time
9. **World model** — tracks prediction errors to avoid repeating mistakes
10. **Session narrative** — summaries from previous sessions for continuity

### Project structure

```
src/
  core/       # Engine: conversation loop, config, permissions, models, memory,
              #   system prompt, world model, user model, narrative, intentions,
              #   compaction, hooks, rules, templates, stats, doctor, MCP, etc.
  tools/      # 18 built-in tools + MCP integration
  ui/         # Ink-based terminal UI (React components) + print mode
  utils/      # Shared utilities
  index.ts    # CLI entry point (Commander.js)
```

## Security

- **Permission system**: 5 modes controlling tool execution (ask, auto, plan, deny, acceptEdits)
- **Bash safety analysis**: Detects command injection, pipe-to-shell, dangerous redirections, shell invocation, quote desync
- **Write validation**: Blocks writes outside working directory and to sensitive files (.env, .bashrc, .zshrc)
- **Allowlist**: "Always allow" specific tool+pattern combos per session

## Keyboard Shortcuts (TUI)

| Key | Action |
|-----|--------|
| Enter | Send message |
| Escape | Cancel response |
| Ctrl+C | Cancel or exit |
| Tab | Autocomplete commands/paths |
| Alt+T | Toggle extended thinking |
| Shift+Tab | Toggle plan mode |

## Development

```bash
bun run dev          # Watch mode
bun test             # Run tests (16 test files, 294 tests)
bun run build        # Build standalone binary (~101 MB)
bun run build:dev    # Build without minification
kcode doctor         # Check system health
kcode stats          # Usage statistics
```

## VS Code Extension

Install the extension:

```bash
code --install-extension vscode-extension/kcode-0.1.0.vsix
```

Features: sidebar chat panel, context menu (Explain/Fix/Test selection), `Ctrl+Shift+K` keybinding, terminal integration. See [vscode-extension/](./vscode-extension/) for details.

## License

AGPL-3.0-only — Copyright (c) 2026 Astrolexis. See [LICENSE](./LICENSE) for details.

Some features require [KCode Pro](https://kulvex.ai/pro). Core functionality is fully open source.
