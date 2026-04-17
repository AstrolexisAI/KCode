# KCode -- Kulvex Code by Astrolexis

> AI-powered coding assistant for the terminal. Local-first, privacy-first, deterministic code auditor.

KCode is a terminal-based AI coding agent that connects to local LLMs (llama.cpp, Ollama, vLLM) and cloud APIs (Anthropic, OpenAI, Gemini, Groq, DeepSeek, Together AI). Built with Bun and TypeScript, featuring a React/Ink TUI with 48 built-in tools, 160+ slash commands, and a **deterministic audit engine** that finds real bugs, fixes them, and opens PRs — all from three commands.

### Audit in 3 Commands

```bash
kcode
/scan project/     # 65 patterns, 16 languages, model-verified
/fix project/      # deterministic auto-fixes
/pr project/       # branch + commit + PR (auto-forks if needed)
```

**Validated on NASA projects:** Found and fixed 28 real bugs in [NASA IDF](https://github.com/nasa/IDF) (buffer overflows, pointer arithmetic, resource leaks). PR submitted: [nasa/IDF#107](https://github.com/nasa/IDF/pull/107).

### Task Orchestrator

KCode translates human language → machine pipelines. The LLM receives pre-filtered context, not raw "figure it out" requests:

```
"fix the login bug" → grep errors → read files → git history → focused LLM prompt
"add REST endpoint" → detect framework → find patterns → scaffold → LLM review
"audit this"        → pattern scan → dedup → model verify → report
```

---

## Quick Start

```bash
# 1. Install Bun (if you don't have it)
curl -fsSL https://bun.sh/install | bash

# 2. Clone and install
git clone https://github.com/AstrolexisAI/KCode.git
cd KCode && bun install

# 3. Run the setup wizard
bun run src/index.ts setup
```

The wizard detects your hardware and picks the best path:

- **Strong HW** (GPU ≥ 20GB VRAM, or Apple Silicon ≥ 32GB) → downloads a large local model
- **Medium HW** (GPU 8-20GB, or ≥ 32GB RAM) → downloads a balanced local model
- **Weak HW** (small GPU or CPU-only) → **cloud-first setup**: prompts for an API key from Anthropic, OpenAI, Groq, DeepSeek, or Together AI. No gigabyte-sized download.

Build a standalone binary with `bun run build` (~101 MB). Override the auto-detection with `KCODE_FORCE_LOCAL=1` or `--model <codename>`.

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
- **Cloud-first setup** for weak hardware -- the wizard skips the model download and walks you through picking a provider
- **Auto-discovery of new models**: `kcode models discover` queries each provider's `/v1/models` and registers anything new (e.g. Opus 4.7 the day it ships). Also runs in the background at TUI startup (throttled to 6h)
- **Flexible auth**: OAuth session (`/auth`), API key in `settings.json` (`/cloud`), or env vars (`ANTHROPIC_API_KEY`, etc.) -- discovery and requests resolve from any of these
- **Easy switching**: `/cloud` to configure, `/model` or `/toggle` to switch
- **Auto-routing**: automatically sends queries to the best model based on task type

### 48 Built-in Tools

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

### Deterministic Audit Engine

- **65 bug patterns** across 16 languages (C, C++, Python, JS, TS, Go, Java, Rust, Swift, Kotlin, C#, PHP, Ruby, Dart, SQL, Scala)
- **Pattern library** based on real bugs found in NASA codebases (buffer overflow, pointer arithmetic, shell injection, SQL injection, XSS, deserialization, etc.)
- **Model verification** -- each candidate is verified by the LLM with a focused prompt, not open-ended discovery
- **Hybrid local+cloud** -- local model handles most verifications, cloud escalates ambiguous cases (with user consent)
- **Auto-fix** -- deterministic patches for confirmed findings (size guards, bounded copies, RAII wrappers, etc.)
- **Auto-PR** -- creates branch, generates detailed PR description via LLM, auto-forks if no write access, submits PR
- **Semantic guards** -- blocks known LLM hallucinations (e.g., strcmp inversion) at the Edit tool level

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
kcode models list                                                # List registered models
kcode models add gpt4 https://api.openai.com --context 128000 --default
kcode models default mymodel
kcode models rm oldmodel
kcode models discover                                            # Auto-discover new cloud models
kcode models discover --provider anthropic,openai                # Limit to specific providers
```

**Auto-discovery** runs in the background at TUI startup (throttled to 6h) and picks up newly-released models from each provider's `/v1/models` endpoint. You don't need to manually `kcode models add` when a new Claude / GPT / Llama drops.

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

The setup wizard auto-detects your hardware and picks the right path: strong/medium HW gets a local model download, weak/CPU-only HW gets routed to cloud setup. The bundled mnemo models are curated, optimized Qwen variants that work well across different VRAM sizes (8 GB to 48+ GB).

### Cloud Providers

| Provider | Setup | Models |
|----------|-------|--------|
| Anthropic | `ANTHROPIC_API_KEY`, `/cloud`, or `/auth` (OAuth) | Claude 4.7 Opus, 4.6 Sonnet, 4.5 Haiku, 3.x family |
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

> *"No es solo otro wrapper de LLM: es una orquestación inteligente donde la máquina hace el 90% del trabajo y el LLM brilla en el 10% donde realmente aporta valor."*

### Philosophy

| Approach | KCode | Claude Code | Cursor | Aider |
|----------|-------|-------------|--------|-------|
| Core philosophy | **Machine-first** (pipelines + LLM) | LLM agent (extreme agentic) | AI-native IDE (vibe coding) | Pair-programming + Git |
| Where LLM shines | End-stage only (pre-filtered context) | Almost everything | Heavy (editing) | High (direct edits) |
| Token efficiency | **~10k per audit** | ~300k per audit | Medium-high | Medium |
| Determinism | **High** (65 patterns, semantic guards) | Model-dependent | Model-dependent | Model-dependent |

### Features

| Feature | KCode | Claude Code | Cursor | Aider |
|---------|-------|-------------|--------|-------|
| Deterministic audit engine | **65 patterns, 16 languages** | -- | -- | -- |
| Auto-fix + Auto-PR pipeline | **/scan /fix /pr** | Manual | Manual | Manual |
| Runs 100% local (GPU) | **Yes (0 tokens)** | No (cloud-only) | No (cloud) | Yes (BYO keys) |
| Hybrid local+cloud verification | **Yes (auto-detects)** | No | No | No |
| NASA-validated findings | **PR #107 on nasa/IDF** | -- | -- | -- |
| Task orchestrator (intent→pipeline) | **Yes (8 task types)** | No | No | No |
| Open source | **Yes (AGPL-3.0)** | No (proprietary) | No (proprietary) | Yes |
| Built-in tools | **48 tools** | ~30 tools | Many (plugins) | Good (Git focus) |
| Slash commands | **160+** | ~20 | IDE commands | ~10 |
| Long-term memory (SQLite FTS5) | **Yes** | Session-based | Project-based | Limited |
| Privacy | **Code stays local** | Cloud-only | Cloud | Local possible |
| Multi-GPU inference | **Yes (llama.cpp RPC)** | No | No | No |
| Plugin system + MCP | **Yes** | Yes | Yes (plugins) | No |
| Cost | **Free (local) + $19/mo Pro** | $20-200/mo | $20-60/mo | Free + API cost |

### When to choose what

- **KCode** -- Audits, debug, scaffolding, privacy-critical projects, cost-sensitive teams, deterministic workflows
- **Claude Code** -- Maximum reasoning depth, complex multi-file problems, full autonomy
- **Cursor** -- Daily development, prototyping, visual IDE experience
- **Aider** -- Simple pair-programming, Git-first workflows

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

## License — dual licensed

KCode is available under **two licenses**. Pick the one that
fits how you use it:

### Open source: AGPL-3.0-only

Run KCode as a CLI, in CI pipelines, in GitHub Actions, in
your own fork — free of charge, no strings attached, under
the terms of the GNU Affero General Public License v3.
See [LICENSE](./LICENSE).

Most users are covered by this.

### Commercial: for proprietary SaaS / embedding / indemnification

If your use case triggers AGPL's network-use clause (§13) or
if you need to embed KCode into a proprietary product, you
need a commercial license. Contact `contact@astrolexis.space`.
See [LICENSE-COMMERCIAL.md](./LICENSE-COMMERCIAL.md) for the
framework, scope, and inquiry process.

Copyright © 2026 Astrolexis.

### Contributing

Every commit needs a DCO sign-off (`git commit -s -m "..."`)
so the dual-license structure stays clean. Details in
[CLA.md](./CLA.md).
