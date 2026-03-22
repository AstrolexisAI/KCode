# Changelog

All notable changes to KCode are documented here.

## [1.3.0] - 2026-03-22

### Changed
- **Open-sourced under AGPLv3** — KCode is now free to use, modify, and distribute under the GNU Affero General Public License v3.0.
- **Pro tier replaces license system** — Core features work without any key. Premium features (swarm, browser, API server, image-gen, transcript search, webhook/agent hooks, distilled learning) require a Pro key.
- **Setup wizard simplified** — Removed mandatory license activation step. Wizard is now 7 steps instead of 8.
- **New CLI**: `kcode pro status|activate|deactivate` replaces `kcode license` commands. `kcode activate` kept as legacy alias.

### Added
- `src/core/pro.ts` — Feature gating module with `isPro()` and `requirePro()`.
- Pro key validation (offline format check + online validation against kulvex.ai).
- CONTRIBUTING.md, CODE_OF_CONDUCT.md, SECURITY.md for open-source community.

### Removed
- `src/core/license.ts` — Machine-ID license system with grace period and phone-home validation.
- Mandatory license check on startup — KCode now starts freely.

## [1.2.0] - 2026-03-15

### Added
- Challenge mode with 20 timed levels
- Booster system (bomb, upgrade, shuffle)
- Easter eggs and haptic patterns
- Multi-agent swarm orchestration
- Browser automation (Playwright)
- Image generation (ComfyUI)
- Distilled learning from past sessions
- HTTP API server for IDE integrations
- Full-text transcript search

## [1.1.0] - 2026-03-08

### Added
- Fine-grained permissions system
- Agent hooks and plugin marketplace
- MCP elicitation and JetBrains integration
- Sandbox mode for safe execution

## [1.0.0] - 2026-03-01

### Added
- Initial release with local LLM support (llama.cpp, Ollama, vLLM)
- Cloud API support (Anthropic, OpenAI, Gemini, Groq, DeepSeek, Together AI)
- React/Ink terminal UI with 11 color themes
- 46 built-in tools, 152+ slash commands
- Session persistence, memory system, conversation compaction
