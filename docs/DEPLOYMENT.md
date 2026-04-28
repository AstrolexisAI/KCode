# KCode — Deployment & Implementation Guide

Guide for deploying and understanding the KCode (Kulvex Code) system by Astrolexis.

---

## 1. System Requirements

| Component | Requirement |
|-----------|-------------|
| Runtime | Bun 1.0+ |
| LLM Backend | llama-server (llama.cpp) or any OpenAI-compatible `/v1/chat/completions` endpoint |
| GPU | NVIDIA GPU with CUDA (for local LLM inference) |
| OS | Linux x86_64 (tested on Fedora 43) |
| Optional | `pdftotext` (poppler-utils), `ripgrep` |

### Current Hardware Setup

| Model | Port | GPU | Purpose |
|-------|------|-----|---------|
| mnemo:code3 | 8091 | RTX 5090 | Code generation (default) |
| mnemo:scanner | 8092 | RTX 4090 | Image analysis / OCR |
| mnemo:mark4 | 8090 | — | Chat / general purpose |

---

## 2. LLM Backend Setup

KCode connects to llama-server instances via the OpenAI-compatible API.

### Starting llama-server

```bash
# Code model on GPU 0 (RTX 5090)
llama-server \
  --model /path/to/code3.gguf \
  --alias mnemo:code3 \
  --port 8091 \
  --n-gpu-layers 99 \
  --ctx-size 32768 \
  --host 0.0.0.0

# Scanner model on GPU 1 (RTX 4090)
CUDA_VISIBLE_DEVICES=1 llama-server \
  --model /path/to/scanner.gguf \
  --alias mnemo:scanner \
  --port 8092 \
  --n-gpu-layers 99 \
  --ctx-size 4096 \
  --host 0.0.0.0

# Chat model
llama-server \
  --model /path/to/mark4.gguf \
  --alias mnemo:mark4 \
  --port 8090 \
  --n-gpu-layers 99 \
  --ctx-size 8192 \
  --host 0.0.0.0
```

### Verifying LLM connectivity

```bash
# Quick health check
curl http://localhost:8091/health

# Test completion
curl http://localhost:8091/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"mnemo:code3","messages":[{"role":"user","content":"hello"}],"max_tokens":50}'
```

---

## 3. KCode Installation

### From Source

```bash
cd /home/curly/KCode
bun install
bun run build.ts          # → dist/kcode (100MB standalone binary)
./scripts/install.sh      # → ~/.local/bin/kcode
```

### Register Models

```bash
kcode models add mnemo:code3 http://localhost:8091 \
  --context 32000 --gpu "RTX 5090" --caps code --default

kcode models add mnemo:scanner http://localhost:8092 \
  --context 4000 --gpu "RTX 4090" --caps vision,ocr

kcode models add mnemo:mark4 http://localhost:8090 \
  --context 8000 --caps chat
```

### Verify Installation

```bash
kcode --version           # Should print the current version (matches package.json)
kcode models list         # Should show all registered models
kcode "say hello"         # Quick test
```

---

## 4. Architecture Overview

```
User Input
    │
    ▼
┌─────────────────────────┐
│  CLI (src/index.ts)     │  Parses args, routes to interactive/non-interactive/print mode
└─────────┬───────────────┘
          │
          ▼
┌─────────────────────────┐
│  ConversationManager    │  The heart of KCode
│  (src/core/             │
│   conversation.ts)      │  Agent loop:
│                         │  1. Convert messages → OpenAI format
│                         │  2. POST /v1/chat/completions (SSE stream)
│                         │  3. Parse streaming deltas (text, tool calls)
│                         │  4. Execute tool calls (with permission checks)
│                         │  5. Append results → loop back to step 1
│                         │  6. Stop when finish_reason = "stop"
└────┬──────────┬─────────┘
     │          │
     ▼          ▼
┌──────────┐ ┌──────────────────┐
│ LLM API  │ │  Tool Registry   │
│ (SSE)    │ │  (48 tools)      │
│          │ │                  │
│ llama-   │ │  Bash, Read,     │
│ server   │ │  Write, Edit,    │
│ :8091    │ │  Glob, Grep,     │
│ :8092    │ │  Agent, Web*,    │
│ :8090    │ │  Tasks, MCP,     │
│          │ │  Notebook        │
└──────────┘ └──────────────────┘
                    │
                    ▼
          ┌──────────────────┐
          │  Permission      │
          │  Manager         │
          │                  │
          │  ask/auto/plan/  │
          │  deny modes      │
          │  bash safety     │
          │  pipe-to-shell   │
          │  write validation│
          └──────────────────┘
```

### Request Flow (Detailed)

1. **User types a message** → `ConversationManager.sendMessage(text)`
2. **System prompt built** → `SystemPromptBuilder.build(config)` assembles identity, tool docs, environment, KCODE.md content, memory
3. **Messages converted** → `convertToOpenAIMessages()` transforms internal format to OpenAI chat format
4. **API call** → `fetch()` POST to `{modelBaseUrl}/v1/chat/completions` with SSE streaming
5. **SSE parsing** → `parseSSEStream()` async generator yields structured chunks
6. **Delta accumulation** → Text chunks concatenated, tool call arguments assembled from fragments
7. **Tool execution** → For each tool call:
   - `PermissionManager.checkPermission()` — mode-based access control
   - `HookManager.runPreToolUse()` — may modify input or block
   - `ToolRegistry.execute()` — runs the actual tool
   - `HookManager.runPostToolUse()` — post-execution notification
8. **Loop continues** → Tool results appended as user messages, back to step 3
9. **Turn ends** → When LLM returns `finish_reason: "stop"` with no tool calls

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Native `fetch()` instead of SDK | No dependency on any vendor SDK; works with any OpenAI-compatible API |
| Dynamic model registry | Models change — today it's 2, tomorrow it's 5. No recompilation needed |
| Ink (React) for TUI | Component-based UI, same mental model as web React |
| Bun runtime | Fast startup, built-in TypeScript, `Bun.file()` API, `bun build --compile` for standalone binary |
| Permission system | Safety-first — bash commands analyzed before execution |
| JSONL transcripts | Append-only, crash-safe, easy to grep/replay |
| LLM-powered compaction | Instead of dropping old messages, summarize them to preserve context |

---

## 5. Configuration Reference

### File Locations

| Path | Purpose |
|------|---------|
| `~/.kcode/settings.json` | User-level settings |
| `~/.kcode/models.json` | Model registry |
| `~/.kcode/transcripts/` | Session transcripts (JSONL) |
| `~/.kcode/memory.md` | Global memory |
| `~/.kcode/skills/*.md` | User-level custom skills |
| `.kcode/settings.json` | Project-level settings |
| `.kcode/settings.local.json` | Local overrides (gitignored) |
| `.kcode/rules/*.md` | Project rules (loaded into system prompt) |
| `.kcode/skills/*.md` | Project-level custom skills |
| `KCODE.md` | Project instructions (loaded into system prompt) |

### Environment Variables

| Variable | Description |
|----------|-------------|
| `KCODE_MODEL` | Override default model |
| `KCODE_API_BASE` | Override API base URL |
| `KCODE_API_KEY` / `ASTROLEXIS_API_KEY` | Bearer token for API auth |
| `KCODE_MAX_TOKENS` | Max response tokens |
| `KCODE_EFFORT_LEVEL` | low / medium / high |
| `KCODE_PERMISSION_MODE` | ask / auto / plan / deny |

### models.json Schema

```json
{
  "models": [
    {
      "name": "mnemo:code3",
      "baseUrl": "http://localhost:8091",
      "contextSize": 32000,
      "capabilities": ["code"],
      "gpu": "RTX 5090",
      "description": "Code generation model"
    }
  ],
  "defaultModel": "mnemo:code3"
}
```

---

## 6. Adding New Models

When you add a new LLM to the fleet:

```bash
# 1. Start llama-server on a free port (>10000 for new services)
llama-server --model /path/to/new.gguf --alias mnemo:newmodel --port 10100

# 2. Register it
kcode models add mnemo:newmodel http://localhost:10100 \
  --context 16000 --caps code,chat --gpu "RTX 5090"

# 3. Test it
kcode -m mnemo:newmodel "hello world"

# 4. Optionally set as default
kcode models default mnemo:newmodel
```

No code changes, no recompilation, no restart needed.

---

## 7. Adding Custom Tools

Create a new file in `src/tools/`:

```typescript
// src/tools/my-tool.ts
import type { ToolDefinition, ToolResult } from "../core/types";

export const myToolDefinition: ToolDefinition = {
  name: "MyTool",
  description: "Does something useful",
  input_schema: {
    type: "object",
    properties: {
      input: { type: "string", description: "The input" },
    },
    required: ["input"],
  },
};

export async function executeMyTool(input: Record<string, unknown>): Promise<ToolResult> {
  const value = input.input as string;
  // ... implementation ...
  return { tool_use_id: "", content: `Result: ${value}` };
}
```

Register it in `src/tools/index.ts`:

```typescript
import { myToolDefinition, executeMyTool } from "./my-tool";

// Inside registerBuiltinTools():
registry.register(myToolDefinition, async (input) => executeMyTool(input));
```

Rebuild: `bun run build.ts`

---

## 8. Adding Custom Skills

Create a markdown file in `.kcode/skills/` or `~/.kcode/skills/`:

```markdown
---
name: test
description: Run project tests
aliases: [t, tests]
args: [pattern]
---

Run the project tests{{#if args}} matching pattern "{{args}}"{{/if}}.
Use `bun test` as the test runner.
Report results clearly: total, passed, failed.
```

Usage: `/test` or `/test auth` or `/t login`

---

## 9. Troubleshooting

| Issue | Solution |
|-------|----------|
| `ECONNREFUSED` on port 8091 | llama-server not running. Start it first. |
| Slow responses | Check GPU utilization with `nvidia-smi`. Model may be CPU-bound. |
| `Raw mode not supported` | KCode needs a TTY for interactive mode. Use `--print` for pipes. |
| Tool permission denied | Switch to `-p auto` or respond `y` at the permission prompt. |
| Context window exceeded | KCode auto-prunes and compacts. Increase `contextSize` in model registry if possible. |
| Binary too large (100MB) | Normal — includes Bun runtime. The JS bundle is only 2MB. |

---

## 10. Development

```bash
# Watch mode (auto-reload on changes)
bun run dev

# Run tests
bun test

# Build standalone binary
bun run build.ts

# Version bump (current version is in package.json)
bun run version:patch   # X.Y.Z → X.Y.(Z+1)
bun run version:minor   # X.Y.Z → X.(Y+1).0
bun run version:major   # X.Y.Z → (X+1).0.0
```

### Project Structure

- `src/core/` — Engine (don't touch `conversation.ts` unless you understand the agent loop)
- `src/tools/` — Each tool is independent, easy to add/modify
- `src/ui/` — Ink components, modify for visual changes
- `docs/` — This file + ARCHITECTURE.md
- `build.ts` — Build script
- `scripts/` — Installation scripts

---

*Kulvex Code by Astrolexis — Built for local LLM-powered development.*
