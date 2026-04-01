# KCode Architecture

This document describes the high-level architecture of KCode v1.8.0. For the full module-by-module reference, see [CLAUDE.md](../CLAUDE.md).

## Entry Point Flow

```
CLI (src/index.ts)
  |
  +-- Commander.js parses args and subcommands
  |
  +-- Subcommands: models, setup, server, pro, stats, doctor, teach, init,
  |   resume, search, watch, new, update, benchmark, completions, history, serve
  |
  +-- Default command:
       |
       +-- --print flag? --> Print mode (non-interactive, piped output)
       |
       +-- Otherwise --> Interactive TUI (React/Ink)
            |
            +-- Load config (5-layer hierarchy)
            +-- Initialize model registry
            +-- Discover plugins, MCP servers, skills
            +-- Render App.tsx (Ink)
            +-- Enter conversation loop
```

## Core Engine

The conversation loop (`src/core/conversation.ts`) is the central engine:

```
User Input
  |
  v
System Prompt Assembly (10 layers)
  |
  v
Build Request (provider-specific formatting)
  |
  v
Execute Request (SSE streaming)
  |                           |
  v                           v
OpenAI-compatible API     Anthropic native API
(/v1/chat/completions)    (/v1/messages)
  |                           |
  +---------------------------+
  |
  v
Stream Processing (text deltas, thinking deltas, tool call extraction)
  |
  v
Tool Calls Detected? --yes--> Tool Execution (parallel-safe batching)
  |                              |
  |                              v
  |                           Permission Check (5 modes)
  |                              |
  |                              v
  |                           Execute Tool(s)
  |                              |
  |                              v
  |                           Inject tool results into conversation
  |                              |
  |                              +---> Loop back to Build Request
  |                                    (max 25 tool turns per agent loop)
  |
  no
  |
  v
Response Complete
  |
  +-- Context window check (prune at 80% capacity, auto-compaction)
  +-- Transcript persistence (JSONL)
  +-- Desktop notification (if enabled)
  +-- Wait for next user input
```

## Key Modules

| Module | File | Purpose |
|--------|------|---------|
| Conversation | `src/core/conversation.ts` | Main agent loop, SSE streaming, tool orchestration, retry, context pruning |
| System Prompt | `src/core/system-prompt.ts` | 10-layer prompt assembly from identity, tools, environment, memory, etc. |
| Config | `src/core/config.ts` | 5-layer settings hierarchy (CLI > env > local > project > user) |
| Models | `src/core/models.ts` | Dynamic model registry, provider detection, URL resolution |
| Permissions | `src/core/permissions.ts` | 5 permission modes, bash safety analysis, glob pattern rules |
| Tool Registry | `src/core/tool-registry.ts` | Tool registration, dispatch, and MCP tool integration |
| Hooks | `src/core/hooks.ts` | 25 lifecycle events for pre/post tool execution, session events |
| Memory | `src/core/memory.ts` | Persistent YAML+Markdown memory across sessions |
| Compaction | `src/core/compaction.ts` | LLM-based conversation summarization when context fills up |
| Transcript | `src/core/transcript.ts` | JSONL session persistence for resume and search |
| Skills | `src/core/skills.ts` | Slash command discovery and template expansion |
| MCP | `src/core/mcp.ts` | JSON-RPC MCP client for external tool integration |
| Swarm | `src/core/swarm.ts` | Multi-agent orchestration with parallel sub-agents |
| Pro | `src/core/pro.ts` | Feature gating for Pro tier |
| Database | `src/core/db.ts` | SQLite (WAL mode) for memory, user model, world model, learnings |
| Model Manager | `src/core/model-manager.ts` | Hardware detection, model download, llama.cpp/MLX management |
| Pricing | `src/core/pricing.ts` | Per-model cost tracking with session totals |
| Analytics | `src/core/analytics.ts` | Tool usage frequency, token consumption, timing |
| Auto-test | `src/core/auto-test.ts` | Detects related test files after edits, prompts to run them |
| Codebase Index | `src/core/codebase-index.ts` | SQLite-backed file/symbol index for fast lookup |
| Tool Cache | `src/core/tool-cache.ts` | Caches tool results within a session to avoid redundant I/O |

## Tools

46 built-in tools are registered in `src/tools/index.ts`. Each tool exports a definition object with:

- `name` -- unique identifier
- `description` -- used by the LLM to decide when to invoke the tool
- `parameters` -- JSON Schema for input validation
- `execute(params, context)` -- async function that performs the action

Tools are grouped by category:

- **File I/O**: Read, Write, Edit, MultiEdit, Glob, Grep, GrepReplace, Rename, DiffView, LS
- **Shell**: Bash (with safety analysis)
- **Git**: GitStatus, GitCommit, GitLog
- **Testing**: TestRunner
- **Worktree**: Enter, Exit
- **Scheduling**: CronCreate, CronList, CronDelete
- **Session**: Clipboard, Undo, Stash
- **LSP**: Language Server Protocol integration
- **Planning**: PlanMode (Enter/Exit)
- **Agent**: Skill, ToolSearch, AskUser, SendMessage

MCP tools from configured servers are dynamically merged at startup.

## Plugin System

Plugins provide extensibility through three mechanisms:

```
~/.kcode/plugins/       (global plugins)
.kcode/plugins/         (project-level plugins)
  |
  +-- plugin.json       (manifest: name, version, skills, hooks, mcpServers)
  +-- skills/           (slash command templates as Markdown files)
  +-- ...               (any supporting files)
```

- **Skills**: Markdown templates that expand into LLM prompts via `/command` syntax
- **Hooks**: Shell commands or scripts triggered on 25 lifecycle events (PreToolUse, PostToolUse, SessionStart, SessionEnd, PreCompact, etc.)
- **MCP Servers**: External tool servers launched and managed by KCode

Workspace trust is enforced: plugins in a project directory require explicit user approval before hooks can execute.

## Configuration Hierarchy

Settings are resolved top-down (first match wins):

```
1. CLI flags              (--model, --theme, --effort, etc.)
   |
2. Environment variables  (KCODE_MODEL, KCODE_API_KEY, KCODE_API_BASE, etc.)
   |
3. .kcode/settings.local.json    (per-machine, gitignored)
   |
4. .kcode/settings.json          (project-level, committed)
   |
5. ~/.kcode/settings.json        (user-level defaults)
```

Model URL resolution follows a separate chain: model registry entry (`~/.kcode/models.json`) > `configBase` > `KCODE_API_BASE` env var > `http://localhost:10091`.

## Data Storage

All persistent data lives under `~/.kcode/`:

| Path | Format | Contents |
|------|--------|----------|
| `~/.kcode/settings.json` | JSON | User-level configuration |
| `~/.kcode/models.json` | JSON | Dynamic model registry |
| `~/.kcode/awareness.db` | SQLite (WAL) | Narrative, user model, interests, predictions, learnings |
| `~/.kcode/transcripts/` | JSONL files | Session transcripts (auto-pruned to 100) |
| `~/.kcode/plugins/` | Directories | Global plugins |
| `~/.kcode/skills/` | Markdown | Global slash commands |
| `~/.kcode/identity.md` | Markdown | Custom identity/personality |
| `~/.kcode/awareness/*.md` | Markdown | Global awareness modules |
| `~/.kcode/theme.json` | JSON | Custom color theme |
| `~/.kcode/server.pid` | Text | llama.cpp server PID |
| `~/.kcode/server.port` | Text | llama.cpp server port |
| `~/.kcode/server.log` | Text | llama.cpp server log |

Project-level data lives in `.kcode/` within the project directory.

## Terminal UI

The UI is built with React 19 and Ink 6 (React for terminals):

- `src/ui/App.tsx` -- Main component: input handling, message display, streaming, permissions
- `src/ui/print-mode.ts` -- Non-interactive output for piped usage (`--print`)
- `src/ui/components/` -- Reusable components: Header, MessageList, ThinkingBlock, InputPrompt, PermissionDialog, CloudMenu, ModelToggle, Spinner
- `src/ui/ThemeContext.tsx` -- 11 built-in color themes with custom theme support

The UI renders streaming LLM output with markdown formatting, collapsible thinking blocks, permission dialogs for tool approval, and a command input with history and tab completion.
