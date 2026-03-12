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
- **API Client**: OpenAI-compatible API (local llama-server)
- **Search**: Bundled ripgrep binary
- **Parsing**: tree-sitter for Bash syntax analysis

### Streaming & API Layer

- SSE streaming via `/v1/chat/completions` with `stream: true`
- Event types: message_start, content_block_start, content_block_delta, content_block_stop, message_delta, message_stop
- Delta types: text_delta, input_json_delta, thinking_delta, citations_delta, signature_delta
- Retry: exponential backoff 0.5s→8s, max 2 retries, 75-100% jitter
- Context management is caller responsibility (no auto-compression in SDK)
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
- KCODE.md/CLAUDE.md: loaded from cwd up to git root
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
│   ├── types.ts         (180)     # Type definitions, StreamEvent, TokenUsage
│   ├── conversation.ts  (804)     # Agent loop with SSE streaming, retry, context pruning
│   ├── tool-registry.ts  (51)     # Tool registration and dispatch
│   ├── system-prompt.ts (341)     # Modular prompt builder (identity, tools, git, env)
│   ├── permissions.ts   (489)     # Permission system, bash safety analysis, pipe-to-shell, allowlist
│   ├── hooks.ts         (333)     # Hook system (PreToolUse, PostToolUse, lifecycle)
│   ├── config.ts        (245)     # Settings hierarchy, env vars, KCODE.md loading
│   ├── memory.ts        (325)     # Memory files with YAML frontmatter, @include
│   ├── git.ts           (144)     # Git context (branch, status, commits)
│   ├── models.ts        (158)     # Dynamic model registry (~/.kcode/models.json)
│   ├── compaction.ts    (155)     # Conversation compaction via LLM summarization
│   ├── transcript.ts    (189)     # Session transcript persistence (JSONL)
│   ├── skills.ts        (235)     # Skill discovery, template expansion, slash commands
│   ├── builtin-skills.ts (73)     # Built-in skill definitions (commit, review-pr, etc.)
│   └── mcp.ts           (588)     # MCP client manager (JSON-RPC, server lifecycle, discoverTools)
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
│   ├── App.tsx          (370)     # Main component, event processing, thinking state
│   ├── render.tsx        (26)     # Ink render entry point
│   ├── print-mode.ts     (64)     # Non-interactive piped output mode
│   └── components/
│       ├── Header.tsx     (45)    # Model, cwd, token/tool stats
│       ├── MessageList.tsx(184)   # Static completed + streaming text + thinking
│       ├── ThinkingBlock.tsx(94)  # Collapsible thinking block (streaming/collapsed/expanded)
│       ├── InputPrompt.tsx(114)   # Custom input with history/cursor
│       ├── PermissionDialog.tsx(81)# Allow/deny/always prompt
│       └── Spinner.tsx    (30)    # Animated braille spinner
│
├── index.ts             (241)     # CLI entry point with models subcommand
└── build.ts              (67)     # Build script (Bun.build, version injection, minification)
scripts/
└── install.sh                     # Installer (copies binary to ~/.local/bin or /usr/local/bin)
```

**Total: 38 files, ~7,610 lines of TypeScript**

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
- [x] KCODE.md/CLAUDE.md loading (cwd + parent dirs)
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

- [x] Extended thinking UI (ThinkingBlock.tsx: streaming, collapsed, expanded modes)
- [x] Standalone binary compilation (`build.ts` → `dist/kcode`, 100MB ELF)
- [x] Installer script (`scripts/install.sh` → `~/.local/bin/kcode`)
- [x] 149 tests across 5 suites (models, config, permissions, edit, read)

---

### LLM Setup

KCode connects to a **local llama-server** (or any OpenAI-compatible API endpoint). No external cloud APIs are required.

- **Default endpoint**: `http://localhost:10091` (overridden via `KCODE_API_BASE` env var or model registry)
- **Default model**: `mnemo:code3` (configurable via `kcode models default <name>`)
- **Auth**: Optional `ASTROLEXIS_API_KEY` sent as Bearer token if set
- **Protocol**: OpenAI-compatible `/v1/chat/completions` with SSE streaming

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

Each model entry stores: name, baseUrl, contextSize, capabilities, gpu, description. The registry provides:

- `getModelBaseUrl(name)` -- resolve a model name to its API endpoint (falls back to `KCODE_API_BASE` or `localhost:10091`)
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
- **Built-in skills**: `/commit` (`/ci`), `/review-pr` (`/pr`, `/review`), `/simplify` (`/clean`, `/refactor`), `/help` (`/?`, `/commands`)
- **Custom skills**: Markdown files with YAML frontmatter (`name`, `description`, `aliases`, `args`) and a template body
- **Template expansion**: `{{args}}` substitution, `{{#if args}}...{{/if}}` conditional blocks
- **Matching**: by name or alias, case-insensitive
