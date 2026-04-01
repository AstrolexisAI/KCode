# KCode -- Kulvex Code by Astrolexis

> AI-powered coding assistant for the terminal. Runs 100% local on your GPU.

KCode is a terminal-based AI coding agent that connects to local LLMs (llama.cpp, Ollama, vLLM) and cloud APIs (Anthropic, OpenAI, Gemini, Groq, DeepSeek, Together AI) to read, write, search, and refactor code directly from your terminal. Built with Bun and TypeScript, featuring a React/Ink TUI with 46 built-in tools, 152+ slash commands, multi-agent swarm orchestration, browser automation, and a 10-layer cognitive architecture.

---

## Quick Start

```bash
# 1. Install Bun (if you don't have it)
curl -fsSL https://bun.sh/install | bash

# 2. Clone and install
git clone https://github.com/AstrolexisAI/KCode.git
cd KCode && bun install

# 3. Run the setup wizard (auto-detects GPU, downloads model)
bun run src/index.ts setup
```

That's it. The wizard detects your hardware, downloads an optimized model, and launches the interactive TUI. You can also build a standalone binary with `bun run build` (~101 MB).

---

## Features

### Local-First AI

- **Hardware-aware setup wizard** -- detects GPU/VRAM, recommends and downloads the best model for your hardware
- **llama.cpp** (Linux/Windows) and **MLX** (macOS Apple Silicon) managed automatically
- **Multi-GPU inference** -- distribute across multiple GPUs (e.g., RTX 5090 + 4090) via llama.cpp RPC
- **Offline mode** -- fully air-gapped operation with local RAG engine
- **Privacy-first** -- your code stays on your machine

### Cloud API Support

- **6 providers**: Anthropic, OpenAI, Gemini, Groq, DeepSeek, Together AI
- **Easy setup**: `/cloud` command to configure, `/toggle` to switch between local and cloud
- **Auto-routing**: automatically sends queries to the best model based on task type

### 46 Built-in Tools

- **File operations**: Read, Write, Edit, MultiEdit, Glob, Grep, GrepReplace, Rename, DiffView, LS
- **Shell**: Bash with safety analysis and permission controls
- **Git**: GitStatus, GitCommit, GitLog with commit protocol enforcement
- **Testing**: TestRunner with auto-test detection for related test files
- **Worktree**: Enter/Exit for isolated git worktree operations
- **Scheduling**: CronCreate, CronList, CronDelete for recurring tasks
- **Session**: Clipboard, Undo, Stash for workflow management
- **LSP**: Language Server Protocol for go-to-definition, references, diagnostics
- **Planning**: PlanMode for structured multi-step task execution
- **Agent**: Skill, ToolSearch, AskUser, SendMessage for orchestration

### 152+ Slash Commands

- **Git**: `/commit`, `/diff`, `/branch`, `/log`, `/stash`, `/review-pr`
- **Code analysis**: `/simplify`, `/explain`, `/find-bug`, `/security-review`
- **Development**: `/test`, `/build`, `/lint`, `/deps`, `/todo`, `/doc`
- **Session management**: `/compact`, `/rewind`, `/resume`, `/export`, `/stats`
- **Configuration**: `/cloud`, `/toggle`, `/theme`, `/vim`, `/plugins`
- **Planning**: `/plan`, `/pin`, `/memory`, `/search`, `/batch`

### Terminal UI

- **React 19 + Ink 6** for rich terminal rendering
- **11 color themes**: default, dark, light, cyberpunk, monokai, solarized, dracula, gruvbox, nord, catppuccin, matrix
- **Vim mode** with configurable keybindings and chord shortcuts
- **Markdown rendering** in the terminal (code blocks, headers, lists, links)
- **Extended thinking** visualization with collapsible thinking blocks
- **Tab completion** for slash commands and file paths

### Intelligence

- **10-layer cognitive architecture**: identity, tools, code guidelines, git, environment, situational awareness, metacognition, user model, world model, session narrative
- **Long-term memory**: SQLite FTS5-backed persistent knowledge across sessions
- **Adaptive effort**: adjusts reasoning depth based on task complexity
- **Ensemble cost-awareness**: routes to the cheapest adequate model
- **Auto-pin**: automatically includes relevant files in context

### Security

- **5 permission modes**: ask, auto, plan, deny, acceptEdits
- **Bash safety analysis**: detects command injection, pipe-to-shell, dangerous redirections
- **Write validation**: blocks writes outside working directory and to sensitive files
- **Workspace trust**: hooks and plugins require explicit trust per workspace
- **Three-round security audit** with 0 critical/high findings

### Extensibility

- **Plugin system**: directory-based plugins with skills, hooks, and MCP server bundles
- **MCP support**: connect to external tools via Model Context Protocol
- **Extension API** for building third-party integrations
- **Hooks**: 25 lifecycle events for customization (pre/post tool execution, session events, etc.)
- **Custom themes**: create `~/.kcode/theme.json` with your own colors
- **Project instructions**: `KCODE.md` files and `.kcode/rules/*.md` for per-project conventions

### Pro ($19/mo)

- **Multi-agent swarm**: spawn parallel sub-agents for divide-and-conquer workflows (`--agents`)
- **Browser automation**: Playwright-based web interaction
- **HTTP API server**: REST API for IDE integrations (VS Code, JetBrains)
- **Image generation**: ComfyUI integration
- **Transcript search**: full-text search across past conversation transcripts
- **Webhook hooks**: HTTP webhook lifecycle hooks
- **Agent-spawn hooks**: spawn agents from hook events
- **Distilled learning**: learn from past sessions to improve future responses

---

## Usage

### Interactive Mode

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

### Print Mode (for piping)

```bash
kcode --print "explain this error" < error.log
cat src/app.ts | kcode --print "review this code"
kcode --print --json-schema '{"type":"object","properties":{"bugs":{"type":"array"}}}' "find bugs in src/"
```

### Slash Commands

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

### Model Management

```bash
kcode models list
kcode models add gpt4 https://api.openai.com --context 128000 --default
kcode models default mymodel
kcode models rm oldmodel
```

### Pro Management

```bash
kcode pro status                    # Show Pro status and features
kcode pro activate <your-pro-key>   # Activate Pro
kcode pro deactivate                # Remove Pro key
```

---

## Model Compatibility

KCode works with any OpenAI-compatible API endpoint and native Anthropic API.

### Local Models

| Runtime | Platform | Notes |
|---------|----------|-------|
| llama.cpp | Linux, Windows | Auto-managed by setup wizard, multi-GPU via RPC |
| MLX | macOS (Apple Silicon) | Native Metal acceleration |
| Ollama | All platforms | Connect via `KCODE_API_BASE` |
| vLLM | Linux | High-throughput serving |

The setup wizard auto-detects your hardware and recommends models. The bundled mnemo models are curated, optimized Qwen variants that work well across different VRAM sizes (8 GB to 48+ GB).

### Cloud Providers

| Provider | Setup | Models |
|----------|-------|--------|
| Anthropic | `ANTHROPIC_API_KEY` or `/cloud` | Claude 4, Claude 3.5 Sonnet, etc. |
| OpenAI | `OPENAI_API_KEY` or `/cloud` | GPT-4o, GPT-4, etc. |
| Google Gemini | `GEMINI_API_KEY` or `/cloud` | Gemini 2.5 Pro, Flash, etc. |
| Groq | `GROQ_API_KEY` or `/cloud` | Llama, Mixtral (fast inference) |
| DeepSeek | `DEEPSEEK_API_KEY` or `/cloud` | DeepSeek V3, Coder |
| Together AI | `TOGETHER_API_KEY` or `/cloud` | Wide model catalog |

To configure a cloud provider interactively, run `/cloud` from the TUI or set the environment variable and restart.

---

## Configuration

Settings are loaded in this order (highest priority first):

1. CLI flags (`-m`, `-p`, `--thinking`, `--theme`, etc.)
2. Environment variables (`KCODE_MODEL`, `KCODE_API_KEY`, `KCODE_API_BASE`, `KCODE_EFFORT_LEVEL`, `KCODE_MAX_TOKENS`, `KCODE_PERMISSION_MODE`, `KCODE_THEME`)
3. `.kcode/settings.local.json` (gitignored, per-machine overrides)
4. `.kcode/settings.json` (project-level, committed)
5. `~/.kcode/settings.json` (user-level defaults)

### Key Settings

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

### Project Instructions

Create a `KCODE.md` file in your project root with conventions, build commands, and rules. KCode loads it automatically and walks up to the git root looking for inherited instructions.

### Path-Specific Rules

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

### Extensible Awareness

- `~/.kcode/identity.md` -- extend KCode's personality and preferences
- `~/.kcode/awareness/*.md` -- global awareness modules injected into every session
- `.kcode/awareness/*.md` -- project-level awareness modules

---

## How KCode Compares

| Capability | KCode | Other AI Coding Tools |
|------------|-------|----------------------|
| Runs fully local (no internet required) | Yes | Varies |
| Multi-GPU inference | Yes (llama.cpp RPC) | Rare |
| Open source (AGPL-3.0) | Yes | Varies |
| 6 cloud providers | Yes | Typically 1-2 |
| 46 built-in tools | Yes | Typically 10-20 |
| Multi-agent swarm | Yes (Pro) | Rare |
| Plugin system with MCP | Yes | Varies |
| Long-term memory across sessions | Yes | Rare |
| 11 color themes + custom | Yes | Limited |
| Vim keybindings | Yes | Rare |
| Works without an account | Yes | Usually requires signup |
| Privacy-first (code stays local) | Yes | Varies |

---

## Keyboard Shortcuts (TUI)

| Key | Action |
|-----|--------|
| Enter | Send message |
| Escape | Cancel response |
| Ctrl+C | Cancel or exit |
| Tab | Autocomplete commands/paths |
| Alt+T | Toggle extended thinking |
| Shift+Tab | Toggle plan mode |

---

## Development

```bash
bun run dev          # Watch mode
bun test             # Run tests (31 test files, 559 tests)
bun run build        # Build standalone binary (~101 MB)
bun run build:dev    # Build without minification
bun run lint         # Lint with Biome
bun run typecheck    # TypeScript type checking
kcode doctor         # Check system health
kcode stats          # Usage statistics
```

## VS Code Extension

Install the extension:

```bash
code --install-extension vscode-extension/kcode-0.1.0.vsix
```

Features: sidebar chat panel, context menu (Explain/Fix/Test selection), `Ctrl+Shift+K` keybinding, terminal integration. See [vscode-extension/](./vscode-extension/) for details.

---

## Documentation

- [CONTRIBUTING.md](./CONTRIBUTING.md) -- How to contribute, development setup, code style
- [CHANGELOG.md](./CHANGELOG.md) -- Version history and release notes
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) -- System architecture reference
- [CLAUDE.md](./CLAUDE.md) -- Detailed codebase reference (conventions, module descriptions)
- [SECURITY.md](./SECURITY.md) -- Security policy and vulnerability reporting

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines. Report security issues to contact@astrolexis.space (see [SECURITY.md](./SECURITY.md)).

## License

**AGPL-3.0-only** -- Copyright (c) 2026 Astrolexis. See [LICENSE](./LICENSE) for details.

Core functionality is fully open source. Some features require [KCode Pro](https://kulvex.ai/pro) ($19/mo).
