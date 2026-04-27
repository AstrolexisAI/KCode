# KCode — Module classification

This document is the honest map of what's **core product** versus
**auxiliary**. It exists because the codebase is large (~410k
LOC) and reviewers — whether enterprise evaluators or new
contributors — need to know where the product actually lives.

The classification is **not** a value judgement. Auxiliary
modules can still be useful. They're auxiliary because:

- They're not required to run the core audit engine.
- They can be removed / disabled without breaking the primary
  value proposition.
- They serve specialized workflows that a subset of users need.

Core modules, by contrast, are on the critical path: removing any
of them breaks the product for everyone.

## Core — critical path, always enabled

| Module | Path | Role |
|--------|------|------|
| Audit engine | `src/core/audit-engine/` | The product. Patterns, scanner, verifier, report-generator, fixer, exploit-gen, SARIF exporter. |
| Scanner + patterns | `src/core/audit-engine/patterns.ts`, `scanner.ts` | 399 curated patterns (372 regex + 27 AST) + regex engine + comment-awareness + opt-in `kcode-disable: audit` marker. |
| Conversation loop | `src/core/conversation.ts` | Orchestrates the LLM turn lifecycle. |
| Configuration | `src/core/config.ts` | Settings hierarchy + validation. |
| Permissions | `src/core/permissions*` | Security model + audit log. |
| System prompt assembly | `src/core/system-prompt.ts` | 10-layer prompt composer. |
| Tools | `src/tools/` | 48 built-in tools (Read/Write/Edit/Bash/etc.). |
| CLI router | `src/index.ts`, `src/cli/commands/` | Commander.js entry points. |
| Daemon / IPC | `src/core/http-server.ts`, bridge/daemon modules | Persistent background mode for IDE integrations. |
| Backend (reference + Cloudflare) | `backend/`, `~/astrolexis-site/` | OAuth, subscription, /api/subscription. Reference implementation of the SaaS plane. |
| Enterprise | `src/core/enterprise/` | SSO/SAML, audit export, policy enforcement. |
| MCP client | `src/core/mcp-client.ts` | Standard interface for external tool integration. |

## Auxiliary — specialized workflows, can be disabled

| Module | Path | Role | Default |
|--------|------|------|---------|
| RAG | `src/core/rag/` | Local semantic code search. Useful for agentic dev, not required for audit. | On |
| Compaction | `src/core/compaction*` | Context-window management strategies. | On |
| Training / Distillation | `src/core/training/`, `src/core/distillation*` | Fine-tuning + distillation pipelines. | On |
| Voice | `src/core/voice*` | Speech I/O. Skeletal. | On |
| Swarm | `src/core/swarm.ts` | Multi-agent parallel execution. | **Off** — `KCODE_EXPERIMENTAL_SWARM=1` to enable |
| Web-engine scaffold | `src/core/web-engine/` | Next.js/etc. project scaffold from a prompt. | **Off** — `KCODE_EXPERIMENTAL_SCAFFOLD=1` to enable |
| World-model | `src/core/world-model*` | Predictive user-action model. | On |
| Kodi mascot | `src/ui/kodi-*`, `src/ui/components/Kodi.tsx` | Animated terminal companion. Purely cosmetic. | On |

## Out-of-core, tracked separately

These live in the repo today but are not part of the core build
and may move to their own repos in a future phase.

| Module | Path | Future home |
|--------|------|-------------|
| SDK Python | `sdk/python/` | `AstrolexisAI/kcode-sdk-python` (separate repo, PyPI) |
| SDK TypeScript | `sdk/typescript/` | `AstrolexisAI/kcode-sdk-typescript` (separate repo, npm) |
| VSCode extension | `ide/vscode/` | `AstrolexisAI/kcode-vscode` (separate repo, marketplace) |
| JetBrains plugin | `ide/jetbrains/` | `AstrolexisAI/kcode-jetbrains` (separate repo, marketplace) |
| Neovim plugin | `ide/neovim/` | `AstrolexisAI/kcode-neovim` (separate repo, LuaRocks) |

## Disabling auxiliary modules

Each auxiliary module declares its status in a comment block at
the top of its main file. Users who want to turn one off have
two options:

1. **Env flag** (when available — `KCODE_EXPERIMENTAL_*`,
   `KCODE_ENABLE_*`): checked at module load / first-use. No code
   changes needed in the core.
2. **Build profile**: `bun run build --profile=core-only`
   (not yet implemented — tracked in the future enterprise
   minimal build).

## Why this document exists

During the enterprise-maturity refactor (PRs #86 / #90 / #91 / #92)
the codebase went from "ambitious monorepo" to "audit engine +
ecosystem". This doc is the anchor that keeps future PRs from
quietly promoting an auxiliary feature into the critical path
without a conscious decision.

**Rule of thumb**: if a PR touches a Core module, the CHANGELOG
entry should be visible from the top; if it touches Auxiliary, it
goes under a separate sub-section so enterprise consumers
reviewing changes can skim for what matters to them.
