<div align="center">
  <img src="./docs/assets/kulvex-logo.svg" alt="Kulvex" width="120" />
</div>

# KCode -- Kulvex Code by Astrolexis

> **Deterministic security audit for C, Rust, Go, Python, and 20+ other languages.** 399 curated patterns (372 regex + 27 AST). A small local LLM verifies each finding to strip false positives. Source never leaves your machine.

KCode is an open-source SAST scanner with a twist: the pattern scanner does the bug-finding deterministically, then a small local LLM (runs on a 24GB GPU) verifies each candidate in isolation. The LLM's job is only to downgrade false positives, never to find bugs. Result: ~10k tokens per audit instead of the ~300k an LLM-first tool would burn, and your source never leaves the machine.

**Validated**:
- Real code: **28 real bugs found and patched in [NASA IDF](https://github.com/nasa/IDF)** (pointer arithmetic, unreachable code, USB decoder OOB reads). PR: [nasa/IDF#107](https://github.com/nasa/IDF/pull/107).
- Public benchmark: **precision 100.0% · recall 92.3% · F1 0.960** on the locked CI fixture set ([benchmarks/audit/](benchmarks/audit/)). Single-second per fixture.

### Vendible packs

Run a focused audit by domain:

```bash
/scan . --pack web            # Next.js, FastAPI, Express, Django, Rails, Spring, Laravel patterns
/scan . --pack ai-ml          # transformers, pickle, torch.load, prompt injection
/scan . --pack cloud          # Terraform, Kubernetes, Dockerfile, GitHub Actions
/scan . --pack supply-chain   # curl|sh installs, dependency confusion, npm tokens
/scan . --pack embedded       # flight software, OOB reads, FW_ASSERT validation
```

### From code to PR in three commands

```bash
kcode
/scan project/     # 399 patterns, 20+ languages, LLM-verified findings, Esc to cancel
/fix project/      # deterministic patches (size guards, bounded copies, RAII)
/pr project/       # branch + commit + LLM-written PR grounded in evidence
```

Output is SARIF v2.1.0 — drop-in with GitHub Code Scanning.

### Honest comparison

KCode is not trying to beat [Semgrep](https://semgrep.dev) on rule volume (~2000), [CodeQL](https://codeql.github.com) on dataflow depth, or [Snyk](https://snyk.io) on compliance dashboards. It occupies a narrower niche:

- **LLM-verified findings** → lower false-positive rate without query tuning
- **`/fix` ships patches**, not just flags
- **Source truly never leaves the machine** — the verifier is a local model, not a hosted API

Full side-by-side: https://kulvex.ai/kcode/compare

---

## Install

**One-line install (Linux / macOS, x64 or ARM64):**

```bash
curl -fsSL https://kulvex.ai/kcode/install.sh | sh
```

The script detects your OS + arch, fetches the latest pre-built binary from the KCode CDN, installs it to the first writable dir on `$PATH` (`~/.local/bin` by default), and prints a PATH hint if needed. No telemetry, no shell-config edits, no sudo prompts — [audit the script here](https://kulvex.ai/kcode/install.sh).

**Via npm (Node 18+):**

```bash
npm install -g @astrolexisai/kcode
```

**Manual download** (Linux ARM64 / Windows / specific version): [kulvex.ai/kcode#downloads](https://kulvex.ai/kcode#downloads) or [GitHub Releases](https://github.com/AstrolexisAI/KCode/releases).

**From source (Bun):**

```bash
curl -fsSL https://bun.sh/install | bash   # if needed
git clone https://github.com/AstrolexisAI/KCode.git
cd KCode && bun install
bun run src/index.ts audit .
```

The setup wizard (`bun run src/index.ts setup` or `kcode setup`) auto-detects your hardware and picks the best verifier:

- **Strong HW** (GPU ≥ 20GB VRAM, or Apple Silicon ≥ 32GB) → downloads a local 31B model
- **Medium HW** (GPU 8-20GB, or ≥ 32GB RAM) → downloads a local 14B model
- **Weak HW** (small GPU or CPU-only) → cloud verifier; prompts for an API key from OpenAI, Anthropic, Gemini, Groq, DeepSeek, or Together AI. No gigabyte-sized download.

Override with `KCODE_FORCE_LOCAL=1` or `--model <codename>`. Build a standalone binary yourself with `bun run build` (~101 MB).

---

## Features

### Local-First AI

- **Hardware-aware setup wizard** -- detects GPU/VRAM, recommends and downloads the best model for your hardware
- **llama.cpp** (Linux/Windows) and **MLX** (macOS Apple Silicon) managed automatically
- **Multi-GPU inference** -- distribute across multiple GPUs (e.g., RTX 5090 + 4090) via llama.cpp RPC
- **Offline mode** -- fully air-gapped operation with local RAG engine
- **Privacy-first** -- your code stays on your machine

### Cloud API Support

- **7 providers**: Anthropic, OpenAI, xAI (Grok), Kimi (Moonshot), Gemini, Groq, DeepSeek, Together AI
- **Cloud-first setup** for weak hardware -- the wizard skips the model download and walks you through picking a provider
- **Auto-discovery of new models**: `kcode models discover` queries each provider's `/v1/models` and registers anything new (e.g. Opus 4.7 the day it ships). Also runs in the background at TUI startup (throttled to 6h)
- **Flexible auth**: OAuth session (`/auth`), API key in `settings.json` (`/cloud`), or env vars (`ANTHROPIC_API_KEY`, `XAI_API_KEY`, `MOONSHOT_API_KEY`, etc.) -- discovery and requests resolve from any of these
- **Easy switching**: `/cloud` to configure, `/model` or `/toggle` to switch

### Multi-Model Orchestrator (`/multimodel`)

A conductor-orchestrator architecture that decomposes complex prompts into a DAG of specialized sub-tasks and runs independent ones in parallel on their best-suited models. Enabled with `/multimodel on`.

- **Conductor**: a fast cheap model (claude-haiku, gpt-4o-mini) reads your prompt and returns a JSON DAG like `[a:analysis, b:complex-edit<-a, c:chat<-a,b]` in ~2 seconds
- **Per-task routing by benchmark tags**: each sub-task picks the best model for its intent
  - `analysis` → reasoning models (grok-4.20-reasoning, claude-opus)
  - `complex-edit` / `simple-edit` → coding models (grok-code-fast-1, gpt-4o-mini)
  - `chat` without deps → local model (free, ~2s)
  - `chat` with deps → cloud model (synthesis needs more than local can handle)
- **Parallel execution**: independent sub-tasks run via `Promise.all`; dependent ones wait and receive prior outputs as context
- **Tool-enabled sub-tasks**: each sub-task gets Read/Edit/Grep/Bash through the shared tool registry, so analysis can actually read files and edit can actually edit them
- **File-level locking**: parallel sub-tasks editing the same file queue up instead of racing (prevents corruption)
- **Live progress**: `▶` / `✓` events show per-sub-task start/done with elapsed time and tokens
- **Anti-hallucination guard**: when an edit sub-task made no successful writes, downstream sub-tasks are explicitly told "no fix was made" so they don't fabricate one
- **Kodi session economy panel**: per-model cost breakdown + animated mini-Kodis (one per model used in the session) + live balance fetch where providers expose it (Kimi, OpenRouter)

### Task-Type Classification (regex heuristics)

When multi-model is off, a single-intent classifier picks the best model for each request:

- **analysis** → audit / review / debug / "analizá" / "cuándo usar" → reasoning model
- **complex-edit** → cambiar / modificar / agregar / add / update → coding model
- **simple-edit** → explicit `old_string` or `línea 42` → fast coding model
- **multi-step** → numbered instructions → structured model
- **chat** → short conversational → local or cheap cloud
- **vision** → image paths / data URIs → vision model

Supports Spanish (with accent handling for `analizá`, `cambiá`, `auditá`) and English patterns.

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
- **Configuration**: `/cloud`, `/toggle`, `/theme`, `/vim`, `/plugins`, `/multimodel`
- **Planning**: `/plan`, `/pin`, `/memory`, `/search`, `/batch`

### Deterministic Audit Engine

- **399 hand-written patterns (372 regex + 27 AST)** across 20+ languages (C, C++, Python, JS, TS, Go, Java, Rust, Swift, Kotlin, C#, PHP, Ruby, Dart, SQL, Scala, Haskell, Zig, Lua, Elixir + framework packs for Next.js, FastAPI, Express, Django, Rails, Spring, Laravel, Flask, React + IaC for Terraform, Kubernetes, Dockerfile, GitHub Actions)
- **Pattern library** rooted in real production bugs (buffer overflow, pointer arithmetic, shell injection, SQL injection, XSS, deserialization, path traversal, hardcoded secrets, TOCTOU, type confusion, etc.)
- **Fixture regression harness** -- every pattern ships with positive + negative fixtures; 863 regression tests run on every CI build to catch regex drift before release
- **Model verification** -- each candidate is verified in isolation with a focused prompt ("confirm or FALSE_POSITIVE, prove it with an execution path"), not open-ended discovery
- **Hybrid local+cloud** -- local model handles most verifications; cloud escalates ambiguous cases with user consent
- **Auto-fix** -- deterministic patches for confirmed findings (size guards, bounded copies, RAII wrappers, etc.)
- **Auto-PR** -- creates branch, generates detailed PR description via LLM, auto-forks if no write access, submits PR
- **SARIF v2.1.0 output** -- drop-in compatible with GitHub Code Scanning; inline PR comments for each finding
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
- **Hooks**: 28 lifecycle events for customization (pre/post tool execution, session events, etc.)
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

**Auto-discovery** runs in the background at TUI startup (throttled to 6h) and picks up newly-released models from each provider's `/v1/models` endpoint. You don't need to manually `kcode models add` when a new model drops.

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
| Anthropic | `ANTHROPIC_API_KEY`, `/cloud`, or `/auth` (OAuth) | Latest Anthropic models via `/v1/models` auto-discovery |
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

| Approach | KCode | Cursor | Aider |
|----------|-------|--------|-------|
| Core philosophy | **Machine-first** (pipelines + LLM) | AI-native IDE (vibe coding) | Pair-programming + Git |
| Where LLM shines | End-stage only (pre-filtered context) | Heavy (editing) | High (direct edits) |
| Token efficiency | **~10k per audit** | Medium-high | Medium |
| Determinism | **High** (399 patterns, semantic guards) | Model-dependent | Model-dependent |

### Features

| Feature | KCode | Cursor | Aider |
|---------|-------|--------|-------|
| Deterministic audit engine | **399 patterns, 20+ languages** | -- | -- |
| Auto-fix + Auto-PR pipeline | **/scan /fix /pr** | Manual | Manual |
| Runs 100% local (GPU) | **Yes (0 tokens)** | No (cloud) | Yes (BYO keys) |
| Hybrid local+cloud verification | **Yes (auto-detects)** | No | No |
| NASA-validated findings | **PR #107 on nasa/IDF** | -- | -- |
| Task orchestrator (intent→pipeline) | **Yes (8 task types)** | No | No |
| Open source | **Yes (Apache 2.0)** | No (proprietary) | Yes |
| Built-in tools | **48 tools** | Many (plugins) | Good (Git focus) |
| Slash commands | **190+** | IDE commands | ~10 |
| Long-term memory (SQLite FTS5) | **Yes** | Project-based | Limited |
| Privacy | **Code stays local** | Cloud | Local possible |
| Multi-GPU inference | **Yes (llama.cpp RPC)** | No | No |
| Plugin system + MCP | **Yes** | Yes (plugins) | No |
| Cost | **Free (local) + $19/mo Pro** | $20-60/mo | Free + API cost |

### When to choose what

- **KCode** -- Audits, debug, scaffolding, privacy-critical projects, cost-sensitive teams, deterministic workflows
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
- [SECURITY.md](./SECURITY.md) -- Security policy and vulnerability reporting

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines. Report security issues to contact@astrolexis.space (see [SECURITY.md](./SECURITY.md)).

## License

**KCode core is Apache 2.0.** Use it anywhere — personal, commercial,
embedded, CI/CD, fork it — no restrictions, no copyleft viral clauses.
See [LICENSE](./LICENSE).

### Pro features (separate repo, commercial license)

Certain advanced features live in a **separate commercial repository**
and are not covered by Apache 2.0:

- **Multi-Model Orchestrator** — DAG decomposition, conductor, parallel sub-tasks on specialized models
- **Multi-agent swarm** — parallel sub-agents for divide-and-conquer workflows
- **Auto-benchmarking background runner** — automatic model scoring on registered APIs
- **Hallucination recovery + session blacklist** — rescues tool calls when models emit text instead of the API format
- **Custom routing rules** — regex-based model routing with ReDoS protection
- **Cloud failover chains** — automatic fallback + rate-limit parking
- **Hosted KCode Cloud** — team sessions, dashboard, SSO, audit logs
- **Managed audit service** — Astrolexis team runs audits for you
- **Enterprise**: air-gapped deployment, compliance reports, priority SLA, white-label

For Pro access or commercial licensing: `contact@astrolexis.space`.

Copyright © 2026 Astrolexis.

### Contributing

Contributions to the Apache 2.0 core are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md).
Pull requests need a DCO sign-off (`git commit -s -m "..."`).
