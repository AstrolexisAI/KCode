# KCode — Kulvex Code by Astrolexis

> AI-powered coding assistant for the terminal. Runs 100% local on your GPU.

KCode is a terminal-based AI coding agent that connects to local LLMs (llama.cpp, Ollama, vLLM) and cloud APIs (Anthropic, OpenAI, Gemini, Groq, DeepSeek, Together AI) to read, write, search, and refactor code directly from your terminal. Built with Bun and TypeScript, featuring a React/Ink TUI with 46 built-in tools, 152+ slash commands, multi-agent swarm orchestration, browser automation, and a 10-layer cognitive architecture.

## Features

### Core (free, open-source)

- **46 built-in tools**: Bash, Read, Write, Edit, MultiEdit, Glob, Grep, GrepReplace, Rename, DiffView, LS, GitStatus, GitCommit, GitLog, TestRunner, Worktree (Enter/Exit), CronCreate/List/Delete, Clipboard, Undo, Stash, LSP, PlanMode, Skill, ToolSearch, AskUser, SendMessage, and more
- **152+ slash commands**: /commit, /review-pr, /simplify, /diff, /test, /build, /lint, /branch, /log, /stash, /explain, /find-bug, /security, /security-review, /batch, /loop, /template, /deps, /todo, /test-for, /doc, /type, /export, /stats, /doctor, /models, /context, /compact, /rewind, /clear, /theme, /help, /plan, /pin, /memory, /search, /vim, /resume, /benchmark, /profile, /mcp, /style, /insights, /session-tags, /auto-compact, /fast, /cloud, /toggle, and many more
- **11 color themes**: default, dark, light, cyberpunk, monokai, solarized, dracula, gruvbox, nord, catppuccin, matrix
- **5 permission modes**: ask, auto, plan, deny, acceptEdits
- **10-layer cognitive architecture**: identity, tools, code guidelines, git awareness, environment sensing, situational awareness, metacognition, user model, world model, session narrative
- **Local LLM support**: Hardware-aware setup wizard detects GPU/VRAM, downloads models, manages llama.cpp (Linux/Windows) and MLX (macOS Apple Silicon) automatically
- **Cloud API support**: Anthropic, OpenAI, Gemini, Groq, DeepSeek, Together AI — switch with `/cloud` or `/toggle`
- **Multi-GPU inference**: Distribute across multiple GPUs (e.g., RTX 5090 + 4090) via llama.cpp RPC
- **Plugin system**: Directory-based plugins with skills, hooks, and MCP server bundles
- **LSP integration**: Auto-detects language servers (TypeScript, Pyright, gopls, rust-analyzer)
- **Long-term memory**: SQLite FTS5-backed persistent knowledge across sessions
- **MCP support**: Connect to external tools via Model Context Protocol
- **Session management**: Resume, fork, worktree isolation, conversation compaction
- **Context pinning**: Pin files to always include in LLM context
- **Codebase indexing**: SQLite-backed symbol index for fast project-wide lookup
- **Cost tracking**: Per-model token pricing with running session totals
- **Vim mode**: Configurable keybindings with full vim support
- **Privacy-first**: Your code stays on your machine

### Pro ($19/mo)

- **Multi-agent swarm**: Spawn parallel sub-agents for divide-and-conquer workflows (`--agents`)
- **Browser automation**: Playwright-based web interaction
- **HTTP API server**: REST API for IDE integrations (VS Code, JetBrains)
- **Image generation**: ComfyUI integration
- **Transcript search**: Full-text search across past conversation transcripts
- **Webhook hooks**: HTTP webhook lifecycle hooks
- **Agent-spawn hooks**: Spawn agents from hook events
- **Distilled learning**: Learn from past sessions to improve future responses

## Quick Start

```bash
# Install (requires Bun — https://bun.sh)
git clone https://github.com/AstrolexisAI/KCode.git
cd KCode
bun install

# Option 1: Run the setup wizard (auto-detects GPU, downloads model)
bun run src/index.ts setup

# Option 2: Build standalone binary (~101 MB)
bun run build
./dist/kcode

# Option 3: Connect to an existing local/cloud API
KCODE_API_BASE=http://localhost:8080 bun run src/index.ts
```

## Requirements

- [Bun](https://bun.sh) runtime
- A GPU with 8+ GB VRAM recommended (CPU works but slow)
- Or a cloud API key (Anthropic, OpenAI, etc.)

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
kcode --agents 4 "refactor auth module"  # Multi-agent swarm (Pro)
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
/plan                # Create a structured task plan
/pin src/core/       # Pin files to context
/memory              # View/edit persistent memory
/context             # View context window usage
/compact             # Compress conversation history
/export              # Save conversation to file
/rewind              # Undo recent file changes
/stats               # Usage statistics
/doctor              # System health check
/theme dracula       # Switch color theme
/cloud               # Configure cloud API providers
/toggle              # Switch between local and cloud models
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

### Pro management

```bash
kcode pro status                    # Show Pro status and features
kcode pro activate <your-pro-key>   # Activate Pro
kcode pro deactivate                # Remove Pro key
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
  "theme": "dracula",
  "proKey": "kcode_pro_..."
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
2. **Tool instructions** — usage patterns for all 46 built-in tools
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
              #   system prompt, pro gating, hooks, swarm, analytics, compaction,
              #   transcript search, distillation, pricing, and more
  tools/      # 46 built-in tools + MCP integration
  ui/         # Ink-based terminal UI (React 19 components) + print mode
  utils/      # Shared utilities
  index.ts    # CLI entry point (Commander.js)
```

## Security

- **Permission system**: 5 modes controlling tool execution (ask, auto, plan, deny, acceptEdits)
- **Bash safety analysis**: Detects command injection, pipe-to-shell, dangerous redirections, shell invocation, quote desync
- **Write validation**: Blocks writes outside working directory and to sensitive files (.env, .bashrc, .zshrc)
- **Allowlist**: "Always allow" specific tool+pattern combos per session
- **Workspace trust**: Hooks and plugins require explicit trust per workspace

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
bun test             # Run tests (31 test files, 559 tests)
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

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines. Report security issues to contact@astrolexis.space (see [SECURITY.md](./SECURITY.md)).

## License

AGPL-3.0-only — Copyright (c) 2026 Astrolexis. See [LICENSE](./LICENSE) for details.

Some features require [KCode Pro](https://kulvex.ai/pro). Core functionality is fully open source.
