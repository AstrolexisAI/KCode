# KCode Architecture

Architecture reference documentation.

## Original Reference Structure

```
reference-source
├── cli.js          # Single minified bundle (~12MB, ~15K lines)
├── resvg.wasm      # SVG rendering (for image processing)
├── sdk-tools.d.ts  # Public tool type definitions
├── vendor/
│   ├── ripgrep/    # Bundled rg binary (multi-platform)
│   └── tree-sitter-bash/  # Bash syntax parsing (.node addon)
└── package.json
```

### Key Findings

- **Runtime**: Bun 1.2 (compiled to standalone ELF binary, 225MB)
- **Also works as**: Node.js >=18 (via npm install)
- **Bundle**: Single `cli.js` file, minified with Bun's bundler
- **UI Framework**: Ink (React for terminals)
- **API Client**: OpenAI-compatible API (local llama-server) + native Anthropic Messages API
- **Search**: Bundled ripgrep binary
- **Parsing**: tree-sitter for Bash syntax analysis

### Streaming & API Layer

**OpenAI-compatible** (local models, OpenAI, Gemini, Groq, DeepSeek, Together):
- SSE streaming via `/v1/chat/completions` with `stream: true`
- Delta types: text_delta, input_json_delta, thinking_delta
- Tool calls via `tool_calls` array in message deltas

**Anthropic native** (Claude models):
- SSE streaming via `/v1/messages` with `x-api-key` + `anthropic-version: 2023-06-01`
- System prompt as top-level `system` field (not a message)
- Strict user/assistant message alternation (consecutive same-role messages merged)
- Event types: message_start, content_block_start, content_block_delta, content_block_stop, message_delta, message_stop
- Tool use as content blocks (`tool_use`/`tool_result`) inside messages
- Provider auto-detection from model registry `provider` field or name heuristic (`claude-*` → anthropic)

**Common**:
- Retry: exponential backoff 0.5s→8s, max 2 retries, 75-100% jitter
- `buildRequestForModel()` + `executeModelRequest()` unified helpers handle both providers
- Extended thinking with budget_tokens

### Permission & Security System

- Permission modes: ask, auto, plan, bypassPermissions, dontAsk
- Bash command safety: prefix extraction, injection detection ($(), backticks), dangerous redirections, shell invocation blocking
- Hooks: PreToolUse, PostToolUse, PreCompact, UserPromptSubmit, Stop, Notification
- Hook output: { decision: allow|deny|block, reason, updatedInput }
- Exit codes: 0=success, 2=block, other=warning
- Policy enforcement via managed settings

### Agent & Task System

- Subagents as separate processes (not threads)
- Agent types: general-purpose (all tools), explore (read-only), plan (read-only + plan)
- Background tasks with DAG dependencies (blocks/blockedBy)
- Git worktree isolation for parallel work
- Agent resumption via agentId
- Team coordination (TeamCreate, idle notifications)

### Memory & Configuration

- Memory: YAML frontmatter + markdown files in ~/.kcode/projects/<hash>/memory/
- MEMORY.md index (200 line limit), @include directives
- Settings hierarchy: user > project > local + env vars
- KCODE.md: loaded from cwd up to git root
- Rules directory: .kcode/rules/ recursive loading
- Git context: branch, status, log 5 commits (snapshot at session start)

### UI System (Ink/React)

- Ink components: Box, Text, Static, useInput
- Progressive text rendering via streaming deltas
- Permission prompt with y/n/a keyboard shortcuts
- Custom InputPrompt with history, cursor movement
- Spinner animation during API calls

---

## KCode Implementation

### Architecture

```
src/
├── core/                          # Core engine
│   ├── types.ts         (183)     # Type definitions, StreamEvent, TokenUsage
│   ├── conversation.ts  (870)     # Agent loop with SSE streaming, retry, context pruning, undo
│   ├── tool-registry.ts  (51)     # Tool registration and dispatch
│   ├── system-prompt.ts (341)     # Modular prompt builder (identity, tools, git, env)
│   ├── permissions.ts   (520)     # Permission system, bash safety, pipe-to-shell, diff preview
│   ├── hooks.ts         (333)     # Hook system (PreToolUse, PostToolUse, lifecycle)
│   ├── config.ts        (249)     # Settings hierarchy, env vars, KCODE.md loading
│   ├── memory.ts        (325)     # Memory files with YAML frontmatter, @include
│   ├── git.ts           (144)     # Git context (branch, status, commits)
│   ├── models.ts        (166)     # Dynamic model registry (~/.kcode/models.json)
│   ├── compaction.ts    (155)     # Conversation compaction via LLM summarization
│   ├── transcript.ts    (299)     # Session transcript persistence (JSONL) + session resume
│   ├── skills.ts        (302)     # Skill discovery, template expansion, slash commands
│   ├── builtin-skills.ts (80)     # Built-in skill definitions (commit, review-pr, template, etc.)
│   ├── mcp.ts           (588)     # MCP client manager (JSON-RPC, server lifecycle, discoverTools)
│   ├── router.ts         (79)     # Multi-model auto-routing (images → vision model)
│   ├── stats.ts         (324)     # Usage statistics aggregation from logs/transcripts
│   ├── diff.ts          (130)     # Unified diff generation for file change previews
│   ├── rate-limiter.ts   (80)     # Request rate limiting (sliding window + semaphore)
│   ├── undo.ts          (110)     # Undo system for file-modifying tools
│   ├── indexer.ts       (240)     # Project file indexer with symbol extraction
│   ├── templates.ts     (140)     # Reusable prompt template system
│   ├── doctor.ts        (190)     # Setup diagnostics and health checks
│   ├── logger.ts        (194)     # Logging system with rotation and categories
│   ├── theme.ts         (120)     # Color theme system (default/dark/light + custom)
│   ├── export.ts        (105)     # Conversation export (markdown/JSON)
│   ├── clipboard.ts      (55)     # Clipboard integration (xclip/xsel/wl-copy)
│   ├── watcher.ts       (125)     # File watcher with debouncing
│   └── metrics.ts       (165)     # LLM performance metrics collector
│
├── tools/                         # 17 built-in + 2 MCP resource tools
│   ├── bash.ts           (61)     # Shell execution with timeout
│   ├── read.ts          (423)     # File reading: text, images, PDFs, Jupyter notebooks
│   ├── write.ts          (41)     # File creation/overwrite
│   ├── edit.ts           (71)     # String replacement
│   ├── glob.ts           (46)     # File pattern matching
│   ├── grep.ts           (86)     # Ripgrep wrapper
│   ├── agent.ts         (223)     # Subagent spawning (general/explore/plan)
│   ├── web-fetch.ts     (146)     # URL fetching with HTML→text, 15min cache
│   ├── web-search.ts    (181)     # Brave Search API + DuckDuckGo fallback
│   ├── notebook.ts      (216)     # Jupyter notebook editing
│   ├── tasks.ts         (270)     # TaskCreate/List/Get/Update/Stop with dependencies
│   ├── mcp-tools.ts     (202)     # MCP tool proxying and resource operations
│   └── index.ts          (85)     # Registration of all tools + MCP integration
│
├── ui/                            # Ink-based terminal UI
│   ├── App.tsx          (430)     # Main component, event processing, undo, templates
│   ├── render.tsx        (26)     # Ink render entry point
│   ├── print-mode.ts     (64)     # Non-interactive piped output mode
│   └── components/
│       ├── Header.tsx     (45)    # Model, cwd, token/tool stats
│       ├── MessageList.tsx(342)   # Static messages + markdown rendering
│       ├── ThinkingBlock.tsx(94)  # Collapsible thinking block (streaming/collapsed/expanded)
│       ├── InputPrompt.tsx(302)   # Input with history, cursor, tab completion
│       ├── PermissionDialog.tsx(81)# Allow/deny/always prompt
│       ├── CloudMenu.tsx  (232)   # Cloud provider API key configuration
│       ├── ModelToggle.tsx(160)   # Interactive model switcher (local/cloud)
│       └── Spinner.tsx    (30)    # Animated braille spinner
│
├── index.ts             (279)     # CLI entry point (models, stats, doctor subcommands)
└── build.ts              (67)     # Build script (Bun.build, version injection, minification)
scripts/
└── install.sh                     # Installer (copies binary to ~/.local/bin or /usr/local/bin)
```

**Total: 51 files, ~11,000+ lines of TypeScript**

### What's Implemented (v1.0)

- [x] SSE streaming with delta accumulation (text, thinking, tool input JSON)
- [x] Agent loop with tool execution cycle
- [x] Retry logic (exponential backoff, jitter, retryable error detection)
- [x] Context window pruning when approaching limits
- [x] Token usage tracking (input, output, cache)
- [x] Permission system (ask/auto/plan/deny modes)
- [x] Bash command safety (injection detection, shell blocking, redirect analysis, pipe-to-shell detection)
- [x] Permission allowlist ("always allow" patterns)
- [x] Hooks system (PreToolUse, PostToolUse, lifecycle events)
- [x] 17 built-in tools + 2 MCP resource tools + dynamic MCP server tools
- [x] Subagent spawning (general/explore/plan types, background, resume, worktree)
- [x] Memory system (YAML frontmatter, MEMORY.md index, @include, search)
- [x] Configuration hierarchy (user/project/local settings + env vars)
- [x] KCODE.md loading (cwd + parent dirs)
- [x] Rules directory (.kcode/rules/)
- [x] Git context gathering (branch, status, commits)
- [x] System prompt builder (modular sections)
- [x] Ink-based TUI (React terminal components)
- [x] Streaming text rendering
- [x] Input with history and cursor navigation
- [x] Permission dialog UI
- [x] MCP (Model Context Protocol) client with JSON-RPC, server lifecycle, health checks
- [x] Skills / slash commands system (built-in + user + project level)
- [x] PDF reading via pdftotext (page ranges, max 20 pages per request)
- [x] Image reading (PNG, JPG, GIF, WEBP) with dimension detection from binary headers
- [x] Jupyter notebook reading (.ipynb with cell outputs)
- [x] Session transcript persistence (JSONL in ~/.kcode/transcripts/)
- [x] Conversation compaction (LLM-powered summarization of pruned messages)
- [x] Dynamic model registry (`kcode models` CLI + ~/.kcode/models.json)
- [x] Print mode for piped output (`kcode --print "prompt" | less`)
- [x] Native Anthropic Messages API (`/v1/messages` with SSE, tool_use/tool_result blocks)
- [x] Cloud provider configuration (`/cloud` interactive TUI menu for 6 providers)
- [x] Model switcher (`/toggle` TUI with LOCAL/CLOUD grouping)

- [x] Extended thinking UI (ThinkingBlock.tsx: streaming, collapsed, expanded modes)
- [x] Tab completion for slash commands and file paths
- [x] Session resume (`kcode --continue` to restore last session)
- [x] Usage statistics dashboard (`kcode stats --days N`)
- [x] Multi-model auto-routing (images → vision model, code → code model)
- [x] Markdown rendering in TUI (code blocks, headers, lists, bold, inline code, links)
- [x] Diff preview in permission dialogs for Edit/Write tools
- [x] Request rate limiting (sliding window + concurrency semaphore)
- [x] Undo system for file modifications (`/undo` command)
- [x] Project file indexer with symbol extraction
- [x] Reusable prompt templates (`/template` command)
- [x] Health check diagnostics (`kcode doctor`)
- [x] Theme system (3 built-in themes + custom ~/.kcode/theme.json)
- [x] Conversation export (markdown/JSON)
- [x] Clipboard integration (xclip/xsel/wl-copy)
- [x] File watcher for change detection
- [x] LLM performance metrics collector
- [x] 24 slash commands (git, code analysis, testing, docs, system)
- [x] Standalone binary compilation (`build.ts` → `dist/kcode`, 100MB ELF)
- [x] Installer script (`scripts/install.sh` → `~/.local/bin/kcode`)
- [x] 149 tests across 5 suites (models, config, permissions, edit, read)

---

### LLM Setup

KCode connects to **local llama-server** (or any OpenAI-compatible endpoint) and optionally to **cloud APIs** (Anthropic, OpenAI, Gemini, Groq, DeepSeek, Together AI).

- **Default endpoint**: `http://localhost:10091` (overridden via `KCODE_API_BASE` env var or model registry)
- **Default model**: `mnemo:code3` (configurable via `kcode models default <name>`)
- **Auth**: Optional `ASTROLEXIS_API_KEY` as Bearer token, or provider-specific keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `DEEPSEEK_API_KEY`, `TOGETHER_API_KEY`)
- **Protocols**:
  - OpenAI-compatible: `/v1/chat/completions` with SSE streaming
  - Anthropic native: `/v1/messages` with SSE streaming, `x-api-key` header
- **URL resolution**: Model registry entries take priority over `configBase` — each model's `baseUrl` in `~/.kcode/models.json` is authoritative
- **Provider detection**: `provider` field in registry, or name heuristic (`claude-*` → anthropic)

### Cloud Provider Configuration

**Interactive** (`/cloud`, `/api-key`, `/provider`):
- TUI menu to select provider, enter API key, save to `~/.kcode/settings.json`
- Auto-registers provider's default models in the registry
- Auto-switches active model to the provider's first model

**Model Switching** (`/toggle`, `/model`, `/switch`):
- TUI menu listing all registered models grouped by LOCAL and CLOUD
- Shows current model indicator, description, GPU info
- Switches model with proper context window and API key resolution
- Sets `modelExplicitlySet` to prevent auto-router from overriding

---

### `kcode models` CLI Subcommand

Manage the dynamic model registry from the command line:

```
kcode models list|ls              # List all registered models
kcode models add <name> <url>     # Add or update a model
  --context <size>                #   Context window size in tokens
  --gpu <gpu>                     #   GPU identifier (informational)
  --caps <capabilities>           #   Comma-separated capabilities
  --desc <description>            #   Description
  --default                       #   Set as default model
kcode models remove|rm <name>     # Remove a model
kcode models default <name>       # Set the default model
```

Example:
```
kcode models add mnemo:code3 http://localhost:8091 --context 32000 --gpu 'RTX 5090' --default
```

---

### Dynamic Model Registry

**File**: `src/core/models.ts` | **Config**: `~/.kcode/models.json`

Each model entry stores: name, baseUrl, contextSize, capabilities, gpu, description, provider (`"openai"` | `"anthropic"`). The registry provides:

- `getModelBaseUrl(name)` -- resolve a model name to its API endpoint (registry first, then `configBase`, then `KCODE_API_BASE` or `localhost:10091`)
- `getModelProvider(name)` -- detect provider from registry field or name heuristic
- `getModelContextSize(name)` -- used by the conversation manager for context pruning thresholds
- `getDefaultModel()` -- returns the configured default or `mnemo:code3`
- In-memory caching with `invalidateCache()` for external edits

---

### Compaction System

**File**: `src/core/compaction.ts`

When the conversation exceeds the context window, older messages are pruned. Instead of discarding them, the `CompactionManager` summarizes them via the LLM:

1. Converts pruned messages to plain text (skipping thinking blocks, truncating tool I/O)
2. Sends a summarization request to the local model (`/v1/chat/completions`, max 1024 tokens)
3. Injects a summary message: `[Conversation Summary - Compaction #N]`
4. Falls back to simple pruning if the summary call fails
5. Tracks compaction count per session

---

### Transcript System

**File**: `src/core/transcript.ts` | **Storage**: `~/.kcode/transcripts/`

Session transcripts are persisted in JSONL format for crash safety and post-session review:

- **Filename**: `{ISO-timestamp}-{prompt-slug}.jsonl`
- **Entry types**: `user_message`, `assistant_text`, `tool_use`, `tool_result`, `thinking`, `error`
- Each entry has a timestamp, role, type, and content
- Auto-prunes to keep at most 100 session files (oldest deleted first)
- `startSession(prompt)` / `append(role, type, content)` / `endSession()` lifecycle
- `listSessions()` and `loadSession(filename)` for retrieval

---

### Skills System

**Files**: `src/core/skills.ts`, `src/core/builtin-skills.ts`

Slash commands that expand into LLM prompts via Handlebars-style templates:

- **Discovery order** (later overrides earlier): built-in > `~/.kcode/skills/*.md` > `.kcode/skills/*.md`
- **24 built-in slash commands**:
  - **Git**: `/commit` (`/ci`), `/diff`, `/branch` (`/br`), `/log` (`/gl`), `/stash`
  - **Code**: `/review-pr` (`/pr`), `/simplify` (`/clean`, `/refactor`), `/explain` (`/what`), `/find-bug` (`/bug`, `/debug`), `/security` (`/audit`)
  - **Dev**: `/test` (`/tests`), `/build`, `/lint` (`/fix`), `/deps` (`/dependencies`), `/todo` (`/todos`), `/test-for` (`/test-gen`), `/doc` (`/document`), `/type` (`/types`)
  - **System**: `/help` (`/?`), `/template` (`/tpl`, `/tmpl`), `/stats`, `/doctor` (`/health`), `/models` (`/model`), `/clear` (`/cls`), `/compact` (`/summarize`), `/undo`, `/status`
  - **Cloud**: `/cloud` (`/api-key`, `/provider`), `/toggle` (`/model`, `/switch`)
- **Custom skills**: Markdown files with YAML frontmatter (`name`, `description`, `aliases`, `args`) and a template body
- **Template expansion**: `{{args}}` substitution, `{{#if args}}...{{/if}}` conditional blocks
- **Matching**: by name or alias, case-insensitive
