# Changelog

All notable changes to KCode are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
