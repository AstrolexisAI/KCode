# Changelog

All notable changes to KCode are documented here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/).

Each release entry links to its merged PR so the history is
navigable from here alone. When reviewing a release, read the
**Changed** / **Fixed** / **Security** sections first — that's
where regressions hide.

## [Unreleased]

(Nothing pending.)

## [2.10.123] — 2026-04-17

### Added
- Pattern fixture harness expanded to **28/257 patterns** (up from
  18). Ten new critical/high-severity entries spanning Go, Java,
  C/C++, Python, and JS/TS. [#91]

### Notes
- Identified percent-placeholder false-positive in
  `py-004-sql-injection` regex. Negative fixture uses `?`
  placeholders to dodge the bug — proper Phase 3b-style fix
  tracked for a future PR.

## [2.10.122] — 2026-04-17

### Added
- Fixture coverage jumped 7 → 18. First fixture harness coverage
  for Go (go-001, go-003) and Java (java-001, java-003). [#90]

## [2.10.121] — 2026-04-17

### Fixed (Phase 3b — regex bugs caught by the fixture harness)
- `py-002-shell-injection`: bare `f["']` matched `"-rf"` substring
  (the `f"` at end of `"-rf"`). Now `(?<!["'\w])f["']`. [#89]
- `js-002-innerhtml`: negative lookahead used `$` without `m` flag,
  so `innerHTML = "";` followed by more code still matched. Now
  uses `gm`, `(?=\S)` to pin position, and `[ \t]*` instead of
  `\s*` inside. [#89]

### Added
- **Scanner comment-awareness**. New `computeCommentRanges()` and
  `isInsideComment()` helpers filter matches inside `//`, `/*…*/`,
  and `#` comments. Cross-cutting fix — applies to ALL 257
  patterns, not just the ones with fixtures. [#89]

## [2.10.120] — 2026-04-17

### Added (Phase 4 — enterprise pipeline entry)
- **SARIF v2.1.0 output** via `kcode audit --sarif`. Spec-
  conformant document with rules, results, CVSS-like
  `security-severity`, CWE helpUri, partialFingerprints for
  cross-commit dedup. Consumable by GitHub Advanced Security,
  Azure DevOps, SonarQube, Snyk. [#88]
- **GitHub Action** at `action.yml`. 7-line drop-in for consumer
  workflows. Composite action: Bun install → KCode build →
  `kcode audit --sarif` → upload via `github/codeql-action/
  upload-sarif@v3` → severity-gate enforcement. [#88]
- Self-audit workflow on every push/PR to master. [#88]
- `docs/github-action.md` — full reference with examples.

## [2.10.119] — 2026-04-17

### Added (Phase 3 — pattern fixture harness)
- `tests/patterns/<pattern-id>/` directory structure with positive
  + negative fixtures per pattern. `tests/pattern-fixtures.test.ts`
  asserts the invariants. Pattern library stops degrading silently
  across refactors. Initial coverage: 7 patterns. [#87]
- `scanPatternAgainstContent()` exported for test-friendly regex
  invocation.

## [2.10.118] — 2026-04-17

### Removed (Phase 1 pruning)
- `mobile/` (997 LOC RN + iOS stubs, single-commit bulk-add with
  zero iterations, no production path). [#86]
- `jetbrains-plugin/` and `nvim-kcode/` — duplicates of the
  canonical `ide/jetbrains/` and `ide/neovim/`. Old kulvex
  namespace, pre-Astrolexis rebrand. [#86]
- `src/core/gpu-orchestrator*` — 1,060 LOC, 1 reference (the test
  itself), 0 production usage. [#86]
- `src/core/user-model*` — 333 LOC, 3 silent try/catch refs. [#86]
- `src/core/narrative*` — 453 LOC, 6 silent try/catch refs. [#86]
- `src/core/plugin-marketplace*` + 5 seed plugin stubs — 427 LOC
  of unused marketplace client; seed plugins were `.md` skill
  files with zero implementation. [#86]

### Changed (Phase 1)
- `/swarm` gated behind `KCODE_EXPERIMENTAL_SWARM=1`. [#86]
- Web-engine auto-scaffold gated behind
  `KCODE_EXPERIMENTAL_SCAFFOLD=1`. Fixes today's Python+textual
  "btctop" mis-fire where a Python prompt produced 17 Next.js
  files. [#86]

## [2.10.117] — 2026-04-17

### Changed
- Kodi autonomy refactored **timer-driven → urge-driven**. Three
  internal urges (boredom, curiosity, wanderlust) build ambiently
  and drain on activity; Kodi acts when an urge crosses threshold,
  not on a cron schedule. [#85]

## [2.10.116] — 2026-04-17

### Added
- Kodi door teleport — appears on the opposite side of the info
  panel with a 1.5s door-frame animation. [#84]
- Musings — passing thoughts every 3-5 min of idle. [#84]

### Fixed
- Advisor fluff filter catches assistant-persona meta-chatter
  ("please provide more context", "let me know"). [#84]

## [2.10.115] — 2026-04-17

### Fixed
- Web-engine detector misfire: Python prompts with the word
  "ticker" or "trading" (even in negation) triggered Next.js
  scaffolds. Regex now requires compound patterns (`trading X`,
  `stock ticker`, `portfolio tracker`). New `mentionsNonWebStack`
  veto shorts the web engine on Python/Rust/Go/CLI/terminal/textual
  prompts unconditionally. [#83]

## [2.10.114] — 2026-04-17

### Added (Kodi Phase 3)
- Four autonomy layers: idle actions, walking, observations,
  personality. Gated on the Kodi advisor server being reachable. [#82]

## [2.10.113] — 2026-04-17

### Fixed
- `/quit` still slow after v2.10.112. Tier-flex `setTimeout`
  wasn't cleared on unmount; in-flight advisor fetch had no abort
  hook. Both clean up explicitly now. [#81]

## [2.10.112] — 2026-04-17

### Fixed
- `/quit` hang caused by `startKodiServer` child_process pipes
  keeping Bun's event loop alive even after `child.unref()`. Now
  uses raw fds passed to `stdio` directly so no parent-side pipes
  exist. [#80]

## [2.10.111] — 2026-04-17

### Changed
- Kodi advisor emits **advice-only** (dropped `mood` and `speech`
  from the schema). Simplified prompt, narrowed scope to the 1.5B
  model's strongest signal. Added 7-regex fluff filter. [#79]

## [2.10.110] — 2026-04-16

### Added (Kodi Phase 2)
- Wire dedicated Kodi advisor model (port 10092) into reactions.
  Structured JSON output parsing, trigger filter on high-info
  events only, advice line under the bubble. [#78]

## [2.10.109] — 2026-04-16

### Fixed
- Kodi model download size check was byte-exact. HuggingFace
  shows decimal GB while files are binary MiB — dropped the
  check; `llama.cpp` validates GGUF on load anyway. [#77]

## [2.10.108] — 2026-04-16

### Added (Kodi Phase 1)
- Dedicated abliterated LLM for Kodi — lifecycle (download,
  start, stop, delete), TUI menu, enterprise first-run prompt.
  Three candidate models (Qwen 2.5 Coder 1.5B / Qwen 2.5 1.5B /
  Gemma 3 1B, all abliterated). Server on port 10092, CPU-only
  by default so it never steals GPU from the main model. [#76]

## [2.10.107] — 2026-04-16

### Changed
- Inline hints next to the `hookify` proto-pollution guard so the
  audit verifier LLM doesn't need context from the top of the
  file. [#75]

## [2.10.106] — 2026-04-16

### Security
- **Prototype pollution** via `hookify` YAML frontmatter parser.
  `meta[key] = value` where key was `\w+` allowed `__proto__`,
  `constructor`, `prototype` to overwrite `Object.prototype`
  globally. Added `RESERVED_META_KEYS` guard at 3 write sites.
  7 regression tests added. [#74]

## [2.10.105] — 2026-04-16

### Added
- Tier-aware Kodi: per-tier badges (★ Pro, ♛ Team, ✦ Enterprise),
  new `flex` / `dance` / `waving` moods, richer idle cycle, tier
  entrance flourishes, periodic tier-flex. [#73]

## [2.10.104] — 2026-04-16

### Fixed
- Astrolexis OAuth endpoints — CLI pointed at
  `https://astrolexis.space/oauth/*`, backend exposes
  `/api/oauth/*`. 404 at `/login` step 1. Now aligned. [#72]
- Phase-33 low-entropy detector wired into the content-stream
  channel (not just thinking). Catches the grok-code-fast-1 loop
  in ≤1K tokens vs ~7K pre-fix. [#72]

---

## [1.8.0] - 2026-04-01

### Added
- **E2E test suite** with 46 end-to-end tests for full integration coverage.
- **Model catalog expansion** with voice input support and telemetry hardening.
- **Web UI** with React SPA and Vite build pipeline (`kcode web` command).
- **RAG auto-index** for automatic codebase indexing and retrieval-augmented generation.
- **Auto-pin** that automatically pins relevant files to context based on conversation.
- **Ensemble cost-awareness** for multi-model routing with cost optimization.
- **Adaptive effort classifier** that adjusts reasoning depth based on task complexity.
- **Remote feature flags** for runtime feature toggling without redeployment.
- **Auto-checkpoint and rewind** system for reverting to previous conversation states.
- **Crash recovery** to resume sessions after unexpected termination.
- **Extension API** for building third-party integrations.
- **Auto-test detection** that finds and suggests related tests after file edits.
- **Swarm intelligence** improvements for multi-agent coordination.
- **Homebrew formula** and native installers for streamlined installation.
- **Shell completions** auto-install for bash, zsh, and fish.

### Changed
- **Startup profiler** with prefetch, lazy imports, and feature flags for faster boot.
- **Tool-aware compaction** that preserves tool context during conversation summarization.
- **SAFE_TOOLS classifier** and dangerous patterns registry for improved security.
- **Auto-mode breaker** that exits auto-permission mode on risky operations.
- **Enhanced audit logging** for tool execution tracking.

### Fixed
- Biome linter integration with all lint violations resolved.
- All test suites passing after Phase 1 stabilization.
- Large file splitting for improved maintainability.

### Security
- Pro license hardening: cache expiry, key checksum, rate limiting, hardware binding.

## [1.7.0] - 2026-03-28

### Added
- **Offline mode** with local RAG engine for fully air-gapped operation.
- **Hardware auto-optimizer** that tunes inference settings based on detected GPU/CPU.
- **Multi-model ensemble** for routing queries to the best model per task type.
- **Model distillation pipeline** for creating smaller task-specific models from session data.
- **P2P agent mesh** for distributed multi-agent workflows across machines.
- **Plugin marketplace** for discovering and installing community plugins.
- **Coordinator mode** for orchestrating multiple agents with task dependencies.
- **Keybindings with chords** (multi-key shortcuts) and vim mode enhancements.
- **Auto-memory** that learns and remembers user preferences across sessions.
- **Migration system** for upgrading configuration and database schemas between versions.
- **Multi-strategy compaction** with pluggable summarization backends.

### Changed
- Improved 400 error messages with context window size hints.

### Fixed
- Path F: Quality of life improvements across 6 feature areas with 121 new tests.
- Path E: Feature parity fixes across 18 modules and 160 files.
- Path D: Hardening and performance improvements across all 6 priority areas.

## [1.6.0] - 2026-03-25

### Added
- **Bridge/daemon mode** for persistent background sessions.
- **Remote mode** for connecting to KCode instances on other machines.
- **Enterprise features** including team workspace support.
- **Virtual UI** for headless operation and CI/CD integration.
- **Feature flags** system for gradual rollout of new capabilities.
- **Lazy loading** for faster startup with deferred module initialization.
- **Startup profiler** for diagnosing boot performance.
- **Telemetry** (opt-in) for anonymous usage analytics.
- **Interactive workspace trust** prompt on first run in a new project.
- All built-in tools added to auto-approve list in permissions.

## [1.5.0] - 2026-03-24

### Security
- Three-round security audit resolving 45+ findings with 0 critical/high remaining.
- Shell injection fixes in UI actions and MCP cleanup.
- Python injection, port injection, and HTTP cwd vulnerability fixes.
- TOCTOU mitigations for file operations.
- Write symlink traversal prevention.
- ReDoS pattern hardening in input validation.
- Plugin directory traversal prevention.
- Workspace trust enforcement and HTTP server hardening.

### Added
- Conversation.ts test suite (36 tests, 68 assertions).
- Comprehensive security test coverage (368 new tests across 4 phases).

### Fixed
- Refactored conversation.ts for improved maintainability.
- Edit/Write parity for consistent file modification behavior.

## [1.4.1] - 2026-03-23

### Added
- Plan execution coherence guard with `stopAfterStep` support.
- Structured `partial_progress` events for plan step tracking.
- E2E scaffold tests for plan execution.
- Workspace consistency checks and scaffold conflict handling.
- Checkpoint runtime with retry discipline and error fingerprinting.
- Recovery summary with scoped context.

### Fixed
- Block destructive `rm -rf` flag bypass.
- Paste integration issues in terminal input.
- Empty response hints showing after tool execution.
- Duplicate empty hint suppression.
- Truncated response detection on short prompts.

## [1.3.0] - 2026-03-22

### Changed
- **Open-sourced under AGPLv3** -- KCode is now free to use, modify, and distribute under the GNU Affero General Public License v3.0.
- **Pro tier replaces license system** -- Core features work without any key. Premium features (swarm, browser, API server, image-gen, transcript search, webhook/agent hooks, distilled learning) require a Pro key.
- **Setup wizard simplified** -- Removed mandatory license activation step. Wizard is now 7 steps instead of 8.
- **New CLI**: `kcode pro status|activate|deactivate` replaces `kcode license` commands. `kcode activate` kept as legacy alias.

### Added
- `src/core/pro.ts` -- Feature gating module with `isPro()` and `requirePro()`.
- Pro key validation (offline format check + online validation against kulvex.ai).
- CONTRIBUTING.md, CODE_OF_CONDUCT.md, SECURITY.md for open-source community.

### Removed
- `src/core/license.ts` -- Machine-ID license system with grace period and phone-home validation.
- Mandatory license check on startup -- KCode now starts freely.

## [1.2.0] - 2026-03-15

### Added
- Multi-agent swarm orchestration.
- Browser automation (Playwright).
- Image generation (ComfyUI).
- Distilled learning from past sessions.
- HTTP API server for IDE integrations.
- Full-text transcript search.

## [1.1.0] - 2026-03-08

### Added
- Fine-grained permissions system.
- Agent hooks and plugin marketplace.
- MCP elicitation and JetBrains integration.
- Sandbox mode for safe execution.

## [1.0.0] - 2026-03-01

### Added
- Initial release with local LLM support (llama.cpp, Ollama, vLLM).
- Cloud API support (Anthropic, OpenAI, Gemini, Groq, DeepSeek, Together AI).
- React/Ink terminal UI with 11 color themes.
- 46 built-in tools, 152+ slash commands.
- Session persistence, memory system, conversation compaction.
