# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

KCode (Kulvex Code) by Astrolexis — a terminal-based AI coding assistant that runs 100% locally via llama.cpp, Ollama, vLLM, or any OpenAI-compatible API. Built with Bun and TypeScript, using React/Ink for the terminal UI.

## Build & Development Commands

```bash
bun install                # Install dependencies
bun run src/index.ts       # Run directly (no build needed, 0 MB overhead)
bun run dev                # Watch mode
bun run build              # Production build → dist/kcode (~101 MB, minified)
bun run build:dev          # Dev build (no minification)
bun test                   # Run all tests (18 test files, 309 tests)
bun test src/core/config.test.ts   # Run a single test file
```

## Key Conventions

- **Bun over Node.js**: Use `Bun.file()` instead of `node:fs` readFile/writeFile. Bun auto-loads `.env`.
- **Ports**: Ports below 10000 are reserved. Use 10000+ for any new defaults.
- **Never reference competing products** in code or docs.
- **Proprietary**: Copyright Astrolexis. All rights reserved.

## Architecture

### Entry Point & CLI

`src/index.ts` — Commander.js CLI with subcommands (`models`, `setup`, `server`, `activate`, `license`, `stats`, `doctor`, `teach`, `init`, `resume`, `search`, `watch`, `new`, `update`, `benchmark`, `completions`, `history`, `serve`). The default command launches the interactive TUI or single-prompt mode.

### Core Engine (`src/core/`)

- **`conversation.ts`** (~57 KB) — Main conversation loop. Handles SSE streaming from OpenAI-compatible APIs, tool call extraction (native format + text-based patterns for local models), context window pruning at 80% capacity with auto-compaction, retry with exponential backoff, max 25 tool turns per agent loop. Supports parallel tool execution, JSON schema validation of tool inputs, smart context injection, desktop notifications on completion, and prompt caching for supported providers.
- **`system-prompt.ts`** (~37 KB) — Assembles a 10-layer system prompt: Identity → Tools → Code Guidelines → Git → Environment → Situational Awareness → Metacognition → User Model → World Model → Session Narrative. Loads extensible sections from `~/.kcode/identity.md`, `~/.kcode/awareness/*.md`, `.kcode/awareness/*.md`, `KCODE.md`, `.kcode/rules/*.md`. Injects active plan context and pinned files into the prompt.
- **`config.ts`** — Settings hierarchy (highest priority first): CLI flags → env vars (`KCODE_MODEL`, `KCODE_API_KEY`, etc.) → `.kcode/settings.local.json` → `.kcode/settings.json` → `~/.kcode/settings.json`.
- **`models.ts`** (~166 KB) — Dynamic model registry stored in `~/.kcode/models.json`. Fallback: `KCODE_API_BASE` env var or `http://localhost:10091`.
- **`permissions.ts`** — 5 permission modes (ask/auto/plan/deny/acceptEdits). Safety analysis detects command injection, pipe-to-shell, dangerous redirections, quote desync.
- **`db.ts`** — Shared SQLite connection (`~/.kcode/awareness.db`) with WAL mode. Tables: `narrative`, `user_model`, `user_interests`, `predictions`, `learnings` (FTS5), `distilled_examples`.
- **`model-manager.ts`** (~47 KB) — Hardware-aware setup wizard. Detects CPU/GPU/RAM, recommends models, manages downloads. Supports llama.cpp (Linux/Windows) and MLX (macOS Apple Silicon).
- **`llama-server.ts`** — Manages local inference server lifecycle (start/stop/health check). State files: `~/.kcode/server.pid`, `server.port`, `server.log`.
- **`license.ts`** — Machine-ID-based license validation with 30-day grace period.
- **`mcp.ts`** — JSON-RPC MCP client. Discovers tools/resources from MCP servers configured in plugin manifests.
- **`auto-test.ts`** — Detects related test files after Edit/Write and prompts to run them.
- **`context-pin.ts`** — Pin files to always include in LLM context across conversation turns.
- **`codebase-index.ts`** — SQLite-backed file/export/import index for fast codebase-wide symbol lookup.
- **`pricing.ts`** — Per-model cost tracking for remote APIs, with running session totals.
- **`keybindings.ts`** — Configurable keybindings with vim mode support.
- **`http-server.ts`** — HTTP API server for IDE integrations (VS Code, JetBrains, etc.).
- **`compaction.ts`** — LLM-based conversation summarization when context window fills up.
- **`memory.ts`** — Persistent memory system with YAML frontmatter for cross-session recall.

### Tools (`src/tools/`)

22 built-in tools registered in `src/tools/index.ts`. Each tool exports a definition object with name, description, parameters schema, and execute function. MCP tools are dynamically merged at startup.

### Terminal UI (`src/ui/`)

React 19 + Ink 6 for terminal rendering. `App.tsx` (~26 KB) is the main interactive component. `print-mode.ts` handles non-interactive piped output. 11 color themes via `ThemeContext.tsx`.

### Key Patterns

- **Singletons with lazy init**: `getDb()`, `getMcpManager()`, `getWorldModel()`, `getUserModel()`, etc.
- **Streaming**: SSE from LLM with partial tool call extraction from text (for models without native tool_calls).
- **Database-backed state**: Long-term memory, user model, world model, narrative all share SQLite.
- **Plan system**: Structured task plans with step tracking, injected into system prompt for multi-step workflows.
- **Parallel-safe tool batching**: Multiple independent tool calls execute concurrently within a single agent turn.
- **Plugin structure**: `plugin.json` manifest with skills, hooks, and MCP server bundles in `~/.kcode/plugins/` or `.kcode/plugins/`.

### Slash Commands

43 slash commands total (22 builtin + 21 LLM-powered). Key examples:
- `/plan` — Create or view a structured task plan
- `/pin <file>` — Pin a file to persistent context
- `/memory` — View or edit persistent memory
- `/search <query>` — Search codebase index
- `/stats` — Show session cost and token usage
- `/compact` — Manually trigger conversation compaction
- `/vim` — Toggle vim keybinding mode
- `/resume` — Resume a previous conversation
- `/benchmark` — Run model benchmarks
- `/doctor` — Diagnose environment issues
