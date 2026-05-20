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

## [2.10.466] — 2026-05-10

### Fixed
- backfill model tags so multimodel routing actually calls cloud APIs

## [2.10.465] — 2026-05-10

### Fixed
- /quit and TUI shutdown now actually kill MLX (override wired-pin persistence)

## [2.10.464] — 2026-05-10

### Fixed
- revert flexible-batch (CPU fallback) + add multi-process pool for real parallelism

## [2.10.463] — 2026-05-10

### Added
- use 100% — dynamic bash timeout + skip fake-parallel orchestration + agentic tools hint + ANE batch inference

## [2.10.462] — 2026-05-10

### Fixed
- respect mlxWiredLimitMB as persistent-intent — don't kill MLX on kcode exit

## [2.10.461] — 2026-05-10

### Fixed
- persistent prompt cache stops the per-turn 'unloading' illusion

## [2.10.460] — 2026-05-10

### Fixed
- prefer the live local default over the first-registered local entry

## [2.10.459] — 2026-05-10

### Fixed
- lower compactThreshold default 0.75 → 0.6 + token-ratio calibration scaffold

## [2.10.458] — 2026-05-10

### Fixed
- allow README on 'crear nuevo proyecto' / 'create new project' intent

## [2.10.457] — 2026-05-09

### Fixed
- Gemma mismatch rule was contradicting catalog post-bench

## [2.10.456] — 2026-05-09

### Fixed
- no-tool failsafe must reset on tool calls — caught Curly's 392K loop

## [2.10.455] — 2026-05-09

### Fixed
- distinguish MLX cold-load from dead + spawn lock to stop respawn cascade

## [2.10.454] — 2026-05-09

### Added
- Gemma 4 31B Q6 → mark5-mid agentic default; Q8 reframed as single-shot
- parallel bg shells — BashOutput + KillShell + persistent registry
- real xlm-roberta tokenizer via Python sidecar + auto-index TUI startup

### Fixed
- strip macOS Terminal focus events from input stream (DEC mode 1004)
- no-tool failsafe at 6K, action-defer patterns extended, search shortcut tighter
- allow idiomatic bash — every local model bench failed on '2>/dev/null'
- respect explicit --model + GLM-4.7-Flash mismatch rule + better suggestion
- correct GLM-4.7-Flash classification + context window registry + migration 006
- surface endpoint+remedy on connect-fail, cloud rescue, configurable server timeout
- prevent silent failures in non-interactive runs

## [2.10.438] — 2026-05-09

### Added
- kcode rag status / index / search — ANE-backed semantic search
- kcode ane status / probe / similarity diagnostics + Kodi PATH fix
- pass attention_mask + pad to MAX_SEQ_LEN=512

## [2.10.436] — 2026-05-08

### Fixed
- offline license takes precedence over cloud cache

## [2.10.435] — 2026-05-08

### Added
- paid-addon ANE embedder scaffolding (macOS-arm64-only)
- give-up detection + cost-aware sort + auto-blacklist
- warn when default model mismatches task + extend code classifier
- auto-substitute Linux→macOS commands when 1:1 equivalence

### Fixed
- cost-sort regression, sandbox bypass, warning spam

## [2.10.433] — 2026-05-08

### Added
- brew-install fallback + anti-give-up directive

## [2.10.430] — 2026-05-08

### Fixed
- left-pad ECDH P-256 private key to 32 bytes

## [2.10.429] — 2026-05-08

### Fixed
- replace Qwen3-Coder backed mark5 entries with Gemma
- promote Gemma 2/3/4 from 'weak' to 'good'

## [2.10.428] — 2026-05-08

### Fixed
- mark Qwen3-Coder as 'weak' for agentic sessions

## [2.10.427] — 2026-05-08

### Fixed
- imperative cross-OS hint + actionable Grep error

## [2.10.426] — 2026-05-08

### Fixed
- reactive cross-OS command-equivalence hint on failure

## [2.10.425] — 2026-05-08

### Fixed
- explicit Linux↔macOS command equivalence table

## [2.10.422] — 2026-05-08

### Added
- tool-fitness badge in /model + kcode models list
- list authorized SSH remotes in system prompt
- GlobOnRemote / GrepOnRemote — fs search on authorized hosts
- WriteOnRemote / EditOnRemote — write + transactional edit
- BashOnRemote / ReadOnRemote — operate authorized hosts
- RemoteAuthorize — model-callable SSH bootstrap
- authorize/list/rm/test for SSH bootstrap
- OS-aware tool hints + bash-not-paste directive
- hash-chained transcript + post-auth release script
- boot banner + Header swap when offline mode is forced
- kcode sbom (CycloneDX 1.6) + kcode doctor --secure
- gate the long tail of egress (auth, plugins, voice, RAG, hooks)
- gate chat completions, conductor, and telemetry sinks
- gate cloud discovery + auto-update + model downloads
- KCODE_OFFLINE env var + skip dead local endpoints

### Fixed
- require entropy/quotes for prose secret patterns
- auto-Read on Edit failure + cleanup stale local registry entries

## [2.10.421] — 2026-05-05

### Added
- tiered severity (critical/warning/advisory) + orienting messages

## [2.10.420] — 2026-05-05

### Fixed
- /clear also resets the App.tsx UI state, not just conversation

## [2.10.419] — 2026-05-05

### Added
- add xAI to provider auto-discovery

## [2.10.418] — 2026-05-05

### Added
- \`models use\` auto-sizes context to fit available memory

## [2.10.417] — 2026-05-04

### Fixed
- /clear actually clears the conversation

## [2.10.416] — 2026-05-04

### Fixed
- \`models use\` now updates the registry + saved preference too

## [2.10.415] — 2026-05-03

### Fixed
- run discovery before model resolution, not inside the local-server branch

## [2.10.414] — 2026-05-03

### Fixed
- override saved-preference + multi-model when sharing

## [2.10.413] — 2026-05-03

### Added
- share Kulvex inference instead of loading a duplicate model

## [2.10.412] — 2026-05-03

### Added
- stop local MLX/llama server on kcode exit

## [2.10.411] — 2026-05-03

### Added
- explicit /scan slash command + conditional audit prompt

## [2.10.410] — 2026-05-03

### Added
- \`models use\` bootstraps server.json when missing

## [2.10.409] — 2026-05-03

### Added
- bring-your-own MLX model — \`models use\` + \`--model owner/repo\` passthrough
- standalone model download script using hf_transfer

### Fixed
- pin huggingface_hub<1.0 + tolerate `hf` rename

## [2.10.408] — 2026-05-03

### Added
- public install.sh + setup --yes for scripted installs

### Fixed
- stream pip + HuggingFace progress to terminal (was hidden behind piped stdout)
- honor --model flag (Commander parent-option collision) + retry Esc until onDone

## [2.10.407] — 2026-05-02

### Fixed
- respect unified memory budget on Apple Silicon + tolerant Python lookup

## [2.10.406] — 2026-04-29

### Added
- cascade-on-confirmed ensemble + multi-provider routing fix

## [2.10.396] — 2026-04-27

### Fixed
- clear remaining 352 typecheck errors — typecheck is now 0
- wire banner + incomplete_response handlers in stream-handler
- caza-bugs round 2 — plugin SDK, App.tsx, hardware (Tier 3.E.2)
- caza-bugs in production code (Tier 3.E)
- correct ModelEntry field names in /api/models response
- resolve 10 typecheck errors that exposed real bugs (Tier 3.C)
- clear ~110 single-error files from typecheck (Tier 3.B)
- clear all 151 typecheck errors in src/core/diff subtree
- Tier 2 cleanup — README Pro narrative + canonical port for kcode serve clients
- Tier 1 cleanup from external audit (CI branch + import + license + slash count)

## [2.10.395] — 2026-04-27

### Added
- external-audit response — Reviewable types + SBOM evidence + diff pre-filter + FIX_RESULT.json + docs

## [2.10.394] — 2026-04-27

### Added
- post-audit polish — CWE backfill + scan disable marker + per-pack metrics

## [2.10.393] — 2026-04-27

### Added
- P2.4 slice 1 — SBOM dependency scan (npm + curated advisory DB)

### Docs
- refresh numbers — 399 patterns, 100/92.3/0.960, 7 framework packs

## [2.10.392] — 2026-04-27

### Added
- P2.3 Rails + Spring + Laravel framework packs (4+3+3 patterns)

## [2.10.391] — 2026-04-27

### Added
- P2.3 Express + Django framework packs (4 + 4 patterns)
- P2.3 FastAPI framework pack — 4 new patterns (pack: web)
- P2.3 Next.js framework pack — first 5 patterns (pack: web)

## [2.10.390] — 2026-04-27

### Added
- P2.5 /review noise hints + P2.6 /pr --compact body
- P2.2 Supply-chain scanner pack — first 5 patterns
- P2.1 Cloud / IaC scanner pack — first 6 patterns
- P1.3 wire exploit-gen.ts into runAudit + CLI + /scan
- P1.2 separate SAFE vs HEURISTIC bespoke fixers

## [2.10.389] — 2026-04-27

### Added
- P1.1 site-level dedupe (+23 pts recall, 100% precision held)

### Fixed
- async scanProject with periodic event-loop yields

## [2.10.388] — 2026-04-27

### Fixed
- P0 cleanup from external audit + /scan UX (indeterminate bar, event-loop yields)

## [2.10.385] — 2026-04-27

### Added
- cancel /scan with Esc + visible "Press Esc to cancel" hint

## [2.10.383] — 2026-04-26

### Fixed
- wire dangerous-patterns registry into Bash flow + git/cloud destructive ops

## [2.10.382] — 2026-04-26

### Added
- new fsw-005b-buffer-size-unchecked pattern (read-past-end)

## [2.10.381] — 2026-04-26

### Fixed
- applyRecipe idempotency recognizes audit-fix:/KCODE-FIX: tags

## [2.10.380] — 2026-04-26

### Fixed
- three hardening fixes from external audit (HD.1-3)

## [2.10.379] — 2026-04-26

### Added
- /fix --ci is an alias for --safe-only (CI-safe default)

## [2.10.378] — 2026-04-26

### Added
- explicit Fixed / Manual / Ignored sections in PR body

## [2.10.377] — 2026-04-26

### Fixed
- /scan passes through --since / --pack / --max-files

## [2.10.375] — 2026-04-26

### Fixed
- shell-quote-aware tokenizer for /scan /review /fix subcommands

## [2.10.374] — 2026-04-26

### Added
- activate learning loop — demoted patterns pre-marked needs_context

## [2.10.373] — 2026-04-26

### Added
- stable finding_id hash so /review survives reruns + refactors

### Fixed
- fail-closed on binary mirror + install.sh bsdiff hint

## [2.10.372] — 2026-04-26

### Added
- tag flight-software (embedded) + injection (web) patterns

## [2.10.371] — 2026-04-26

### Fixed
- mirror full binaries to CDN dir alongside manifest + deltas
- synthetic AI-key fixtures with explicit FAKE markers + GitGuardian config

## [2.10.370] — 2026-04-26

### Added
- F9 vendible packs taxonomy + AI/ML Security Pack

## [2.10.369] — 2026-04-26

### Added
- three explicit modes — --safe-only / --annotate / --all

## [2.10.368] — 2026-04-26

### Fixed
- three regressions in the previous fix commit

## [2.10.367] — 2026-04-26

### Fixed
- 10 issues from session-wide audit (1 critical, 1 high, 8 medium)

## [2.10.366] — 2026-04-26

### Added
- taint-lite AST patterns for JS — eval/exec/innerHTML of tainted data

## [2.10.365] — 2026-04-26

### Added
- public audit benchmark with locked precision/recall regression

## [2.10.364] — 2026-04-26

### Added
- note + assign + ignore + restore + stats + export + learning loop

## [2.10.363] — 2026-04-26

### Added
- quantitative AuditConfidence score with five subscores

## [2.10.362] — 2026-04-26

### Added
- render Evidence Pack fields in Markdown report, PR body, and SARIF

## [2.10.361] — 2026-04-26

### Added
- structured Evidence Pack JSON contract for verifier output

## [2.10.360] — 2026-04-26

### Added
- bsdiff binary deltas with SHA-verified fallback

## [2.10.359] — 2026-04-26

### Fixed
- suppress nag when no update + add CI/quiet/TTY guards

## [2.10.358] — 2026-04-26

### Added
- self-hosted auto-update via kulvex.ai manifest + rollback
- emit latest.json manifest for the auto-updater

## [2.10.354] — 2026-04-25

### Added
- /fix --safe-only restricts to bespoke rewrites
- `kcode audit --ci` mode for PR pre-merge gates
- Audit Confidence header — single-glance trustworthiness

### Fixed
- detectDefaultDiffBase tries origin/HEAD first
- strip prior reviewer prefix on round-trips (A.1.1 audit fix)
- Markdown respects review_state — counts, sections, ignored bucket
- SARIF results respect review_state, exclude ignored
- /fix and /pr respect review_state, skip ignored
- typecheck clean for audit-engine + file-actions-audit
- promote owns verdict + reasoning + fix_support, summary recomputed
- listChangedFilesSinceRef uses execFileSync, no shell
- hash-comment language id is 'shell', not 'bash'
- expand onPhase union with 'initializing' for submodule preflight
- pr-generator.ts:732 used `result` instead of `auditResult`

## [2.10.351] — 2026-04-25

### Fixed
- v2.10.351 — verifier resolves AST patterns by id (was "Unknown pattern id")

## [2.10.350] — 2026-04-25

### Fixed
- v2.10.350 — internal audit of v349, PHP qualified-name FQN fix

## [2.10.349] — 2026-04-25

### Added
- v2.10.349 — Ruby + PHP AST taint patterns (6 patterns, 2 grammars)

## [2.10.348] — 2026-04-25

### Added
- v2.10.348 — Rust AST taint patterns (Command::new + std::fs path ops)

## [2.10.347] — 2026-04-25

### Fixed
- v2.10.347 — internal audit of v346, cpp-ast-002 FP fix

## [2.10.346] — 2026-04-25

### Added
- v2.10.346 — C and C++ AST taint patterns

## [2.10.345] — 2026-04-25

### Fixed
- v2.10.345 — internal audit of v343-v344, two real bugs + FP cleanup

## [2.10.344] — 2026-04-25

### Added
- v2.10.344 — Java AST taint patterns (Runtime.exec / File / Class.forName)

## [2.10.343] — 2026-04-25

### Added
- v2.10.343 — three more Python AST taint patterns

## [2.10.342] — 2026-04-25

### Fixed
- v2.10.342 — internal audit of v340-v341, two real bugs fixed

## [2.10.341] — 2026-04-25

### Added
- v2.10.341 — TypeScript + TSX bundled, ts-ast-001 prototype pollution, js-ast-003 ReDoS

## [2.10.340] — 2026-04-25

### Added
- v2.10.340 — AST taint patterns for JavaScript/TypeScript and Go

## [2.10.339] — 2026-04-25

### Added
- v2.10.339 — `kcode grammars install` for AST patterns on the compiled binary

## [2.10.338] — 2026-04-25

### Fixed
- v2.10.338 — internal audit of v332-v337, AST scope gaps closed

## [2.10.337] — 2026-04-25

### Added
- v2.10.337 — bundle Python grammar, AST patterns fire end-to-end

## [2.10.336] — 2026-04-25

### Added
- v2.10.336 — Phase 2 #2: AST-based pattern infrastructure (tree-sitter)

## [2.10.335] — 2026-04-25

### Added
- v2.10.335 — Phase 2 force-multiplier #1: diff-based audit (--since)

## [2.10.334] — 2026-04-25

### Added
- v2.10.334 — Phase B: deepen flight-software differential pack

## [2.10.333] — 2026-04-25

### Added
- v2.10.333 — Phase A round 2: Java/PHP/Ruby web verticals

## [2.10.332] — 2026-04-25

### Added
- v2.10.332 — Milestone 3 Phase A: web/ML vertical patterns

## [2.10.331] — 2026-04-25

### Fixed
- v2.10.331 — internal audit of v326-v330, four bugs corrected

## [2.10.330] — 2026-04-25

### Added
- v2.10.330 — Sprint 5/6: pattern_metrics + 12 new fixtures

## [2.10.329] — 2026-04-25

### Added
- v2.10.329 — Sprint 4: /pr structured-first, LLM only for the summary

## [2.10.328] — 2026-04-25

### Added
- v2.10.328 — Sprint 3: /fix honest about fix_support

## [2.10.327] — 2026-04-25

### Added
- v2.10.327 — Sprint 2: /review v2 with list/promote/demote/tag

## [2.10.326] — 2026-04-25

### Added
- v2.10.326 — Sprint 1 of audit-pipeline maturity roadmap

## [2.10.325] — 2026-04-25

### Fixed
- drop "review" alias from review-pr skill — second collision

## [2.10.324] — 2026-04-25

### Fixed
- drop "review" alias from forensic-audit skill — name collision

## [2.10.323] — 2026-04-25

### Fixed
- register /review as a builtin skill so the parser routes it

## [2.10.322] — 2026-04-25

### Added
- /review fprime/ — interactive triage between /scan and /fix

## [2.10.321] — 2026-04-25

### Added
- v2.10.321 — verifier checklist explicit about port-input vs external; ranking covers project-named test trees

## [2.10.320] — 2026-04-25

### Fixed
- three blockers preventing presentable upstream PRs

## [2.10.319] — 2026-04-25

### Added
- spell-check-clean PR body + attribution via post-creation comment

## [2.10.318] — 2026-04-25

### Fixed
- hoist node:fs import — fixes "writeTemp is not defined" in resume mode

## [2.10.317] — 2026-04-25

### Fixed
- /pr is now resumable + reports real git/gh stderr

## [2.10.316] — 2026-04-25

### Fixed
- /pr uses registry-aware async LLM callback (same as /scan v311)

## [2.10.315] — 2026-04-25

### Added
- v2.10.315 — bespoke fixers for fsw-005 and fsw-010

## [2.10.314] — 2026-04-24

### Added
- v2.10.314 — +55 patterns (crypto, injection, deserialize, flight-software)

## [2.10.313] — 2026-04-24

### Added
- v2.10.313 — verifier mitigation checklist + scope-aware ranking + wider context

## [2.10.312] — 2026-04-24

### Fixed
- cloud escalation /v1 normalization + 401/404 → abort + visible error

## [2.10.311] — 2026-04-24

### Fixed
- three-fold reach the local model — registry baseUrl + reasoning_content + bigger token budget

## [2.10.310] — 2026-04-24

### Added
- v2.10.310 — surface needs_context bucket

## [2.10.309] — 2026-04-24

### Fixed
- cloud-escalation merge now rebuilds false_positives_detail

## [2.10.308] — 2026-04-24

### Fixed
- remove hardcoded 500-file cap — /scan is unlimited by default

## [2.10.307] — 2026-04-24

### Added
- v2.10.307 — explicit coverage + FP detail + relevance ranking + adaptive cap

## [2.10.306] — 2026-04-24

### Added
- v2.10.306 — github repo verification + semantic snippets + informational closeout mode

## [2.10.305] — 2026-04-24

### Added
- v2.10.305 — ordinal resolution + overclaim rewrite

## [2.10.304] — 2026-04-24

### Fixed
- 4 externally-audited HIGH/MEDIUM issues (v2.10.304)

## [2.10.303] — 2026-04-24

### Fixed
- loadSavedKeys was sync-reading an async result; xAI/Kimi/Groq/DeepSeek filtered out of escalation menu

## [2.10.302] — 2026-04-24

### Fixed
- scroll window + AppMode type + pgup/pgdn/g/G navigation

## [2.10.301] — 2026-04-24

### Fixed
- probe verdict takes precedence over runtime error (v2.10.301)

## [2.10.300] — 2026-04-24

### Fixed
- re-read scope post-probe + probe pass overrides phase=failed (v2.10.300)

## [2.10.298] — 2026-04-24

### Added
- active verification probe registry + Bitcoin RPC probe + evidence tiers (Phase 2 #111)

## [2.10.297] — 2026-04-24

### Fixed
- stop promoting spawn-only + ||-wrapped runs to verified (#111)

## [2.10.296] — 2026-04-24

### Fixed
- discard persisted plan when user starts fresh scaffold (#111)

## [2.10.295] — 2026-04-24

### Fixed
- mandatory-rerun bypass for loop guard + explicit claim gate (#111)

## [2.10.294] — 2026-04-24

### Fixed
- ensemble never fired due to this.turnCount typo

## [2.10.293] — 2026-04-24

### Security
- redact quoted 'usuario' / 'contraseña' prose forms (#111)

## [2.10.292] — 2026-04-24

### Fixed
- prepend grounded closeout to context when scope is bad (#111)

## [2.10.291] — 2026-04-24

### Fixed
- heredoc-safe redirect extractor + phase lifts on verified rerun (#111)

## [2.10.290] — 2026-04-24

### Fixed
- detect fabricated artifact + diagnostic claims (#111)

## [2.10.289] — 2026-04-24

### Fixed
- Bash file mutations land in scope's recordMutation (#111)

## [2.10.288] — 2026-04-24

### Fixed
- seal UI also for partial scopes + honor seal on turn_end (#111)

## [2.10.287] — 2026-04-24

### Fixed
- seal post-failure UI so downstream prose can't leak (#111)

## [2.10.286] — 2026-04-24

### Fixed
- derive install/transactions/refresh/implement steps from scope events (#111)

## [2.10.285] — 2026-04-24

### Added
- wire multi-strategy compaction into runContextMaintenance

## [2.10.284] — 2026-04-24

### Fixed
- reinforce rerun directive + collapse all prose blocks on replace (#111)

## [2.10.283] — 2026-04-23

### Added
- feed AskUser context into scope for TUI-swallowed errors (#111)

## [2.10.282] — 2026-04-23

### Fixed
- downgrade alive_timeout / started_unverified to phase=partial (#111)

## [2.10.281] — 2026-04-23

### Fixed
- strip 'cd X && ' prefix from Bash loop-pattern key (#111)

## [2.10.280] — 2026-04-23

### Fixed
- skip HTTP probe for TUI/CLI projects (#111)

## [2.10.279] — 2026-04-23

### Fixed
- auto-launch effective-cwd + unverified-artifact gate (#111)

## [2.10.278] — 2026-04-23

### Added
- SendMessage guidance gate + relaxed isRelevantPatch (#111)

## [2.10.277] — 2026-04-23

### Fixed
- effective-cwd inference + auto-launch skip for TUI/CLI + runner_misfire transition (#111)

## [2.10.276] — 2026-04-23

### Added
- runtime-mode inference skips TUI/CLI from web-preflight + runner_misfire status (#111)

## [2.10.275] — 2026-04-23

### Added
- started_unverified status + plan widget sync + partial-phase suppression (#111)

## [2.10.274] — 2026-04-23

### Added
- RuntimeStatus classifier + auto-configure transition + freeform suppression + derived plan progress (#111)

## [2.10.273] — 2026-04-23

### Added
- forced-rerun gate — block closeout until patched artifact is re-executed (#111)

## [2.10.272] — 2026-04-23

### Fixed
- checkMutationAllowed import, prose-password redaction, timeout classification (#111)

## [2.10.271] — 2026-04-23

### Fixed
- forced-mkdir directive when executor skips ENOENT recovery (#110)

## [2.10.270] — 2026-04-23

### Added
- projectRoot state + recovery-cause classifier + bash dir events (#109)

## [2.10.269] — 2026-04-23

### Fixed
- wire tool-executor to record mutations + supersede-draft closeout

## [2.10.268] — 2026-04-23

### Added
- phases 6, 7, 8 — plan/recovery/continuation from scope

## [2.10.267] — 2026-04-23

### Added
- phase 5 — unified visible-text renderer

## [2.10.266] — 2026-04-23

### Added
- phase 4 — scope-grounded closeout renderer

## [2.10.265] — 2026-04-23

### Added
- phase 3 — grounding detectors write to scope

## [2.10.264] — 2026-04-23

### Added
- phase 2 — unified mutation policy + scope drives audit state

## [2.10.263] — 2026-04-23

### Added
- introduce unified TaskScope state (phase 1 of #100-#108 refactor)

## [2.10.262] — 2026-04-23

### Fixed
- apply redactor to assistant's own prose at finalization

## [2.10.261] — 2026-04-23

### Fixed
- detect runtime traceback in bash output + log reality-check counts

## [2.10.260] — 2026-04-23

### Fixed
- fall back to primary model + pass apiBase/apiKey

## [2.10.259] — 2026-04-23

### Fixed
- action-specific directive when reasoning loop fires in scaffold task

## [2.10.258] — 2026-04-23

### Fixed
- GrepReplace audit-guard + patch-without-rerun detector + self-critique observability

## [2.10.257] — 2026-04-23

### Added
- semantic self-critique pass against tool evidence

## [2.10.256] — 2026-04-23

### Fixed
- flag readiness claims that contradict errors or blocked repairs

## [2.10.255] — 2026-04-23

### Fixed
- close bash-mutation bypass of audit-Edit guard; flag strong completion claims

## [2.10.254] — 2026-04-23

### Fixed
- route scaffold prompts to complex-edit; detect ungrounded auth claims

## [2.10.253] — 2026-04-23

### Fixed
- broaden creation-claim regexes + verify files exist on disk

## [2.10.252] — 2026-04-23

### Fixed
- bash HTML-entity decode + grounding gate detects unfounded creation claims
- replace live Stripe webhook secret with synthetic fixture

## [2.10.251] — 2026-04-23

### Fixed
- secret redaction + grounding gate on tool output and turn end

## [2.10.250] — 2026-04-23

### Fixed
- lift turn spinner out of MessageList Static tree

### Docs
- add Kulvex logo to header
- add Kulvex logo
- add ROADMAP, Pro-features brochure, remove CLA

## [2.10.248] — 2026-04-22

### Fixed
- skip debug engine for monolithic creation prompts

## [2.10.247] — 2026-04-22

### Fixed
- collapse plan at 2+ parallel complex-edits (was 3)

## [2.10.246] — 2026-04-22

### Fixed
- short-circuit monolithic prompts + language coverage

## [2.10.245] — 2026-04-22

### Added
- auto-benchmarking + ✓/[NEW] badges in /model

## [2.10.244] — 2026-04-22

### Added
- rescue hallucinated tool calls + blacklist repeat offenders

## [2.10.243] — 2026-04-22

### Fixed
- remove duplicate const models declaration + update README

## [2.10.242] — 2026-04-22

### Fixed
- stop downstream hallucination when dep made no edits

## [2.10.241] — 2026-04-22

### Fixed
- restore fileLocks optional + default map

## [2.10.240] — 2026-04-22

### Fixed
- extend ReDoS detection to catch brace quantifiers

## [2.10.239] — 2026-04-22

### Fixed
- complete ReDoS mitigation — elapsed-time check + rule disable

## [2.10.238] — 2026-04-22

### Fixed
- prioritize reliable models, demote flaky ones

## [2.10.237] — 2026-04-22

### Fixed
- recon nudge ignores failed writes

## [2.10.236] — 2026-04-22

### Fixed
- permissive JSON extraction for mark7-style output

## [2.10.235] — 2026-04-22

### Fixed
- upgrade chat sub-tasks with deps to cloud model

## [2.10.234] — 2026-04-22

### Added
- intent directives + reconnaissance nudge

## [2.10.233] — 2026-04-22

### Fixed
- correct implementation of race-condition fix

## [2.10.232] — 2026-04-22

### Fixed
- longer timeout for local + visible failure reasons

## [2.10.231] — 2026-04-22

### Fixed
- exclude Plan/Task tools from sub-tasks + clear orphaned plan

## [2.10.230] — 2026-04-22

### Fixed
- 3 real bugs found by orchestrator's analysis sub-task

## [2.10.229] — 2026-04-22

### Added
- wrap-up warning + synthetic summary + turn limit bump

## [2.10.228] — 2026-04-22

### Fixed
- preserve assistant messages with tool_calls even if content is null

## [2.10.227] — 2026-04-22

### Fixed
- guard sub-task assistant content so it's never null

## [2.10.226] — 2026-04-22

### Fixed
- pass LoopGuardState to executeToolsSequential

## [2.10.225] — 2026-04-22

### Added
- sub-tasks run full agent loops with tool access

## [2.10.224] — 2026-04-22

### Fixed
- spinner starts immediately, not after conductor returns

## [2.10.223] — 2026-04-22

### Fixed
- refresh session-economy panel after orchestrator turn

## [2.10.222] — 2026-04-22

### Added
- live progress events so long waits feel alive

## [2.10.221] — 2026-04-22

### Added
- record per-sub-task cost in session economy

## [2.10.220] — 2026-04-22

### Added
- orchestrator path wired into TUI message processor

## [2.10.219] — 2026-04-22

### Added
- DAG orchestrator — parallel sub-tasks on specialized models

## [2.10.218] — 2026-04-22

### Fixed
- guard all 5 assistant pushes against null/empty content

## [2.10.217] — 2026-04-22

### Fixed
- never push null/undefined as assistant content

## [2.10.215] — 2026-04-22

### Fixed
- strip empty messages before API request

## [2.10.214] — 2026-04-22

### Fixed
- empty assistant after reasoning loop + fallback provider leak

## [2.10.213] — 2026-04-22

### Fixed
- update contextWindowSize when switching models

## [2.10.212] — 2026-04-22

### Fixed
- raise tool budget cap 15% → 25%

## [2.10.211] — 2026-04-22

### Added
- unified columnar economy panel — face + cost per column

## [2.10.210] — 2026-04-22

### Fixed
- add agregar/añadir/insertar/add to complex-edit patterns

## [2.10.209] — 2026-04-22

### Fixed
- include local models in session economy + fix cambiá routing

## [2.10.208] — 2026-04-22

### Fixed
- mini-Kodis headless — compact (o.o) face, no box, no body

## [2.10.207] — 2026-04-22

### Added
- animated mini-Kodis with independent engines per model

## [2.10.206] — 2026-04-22

### Added
- multi-model team display + 🔀 badge when multimodel active

## [2.10.205] — 2026-04-22

### Fixed
- accented Spanish imperatives + chat always routes to local

## [2.10.204] — 2026-04-22

### Fixed
- routing was in runNonInteractive but --print uses runPrintMode

## [2.10.203] — 2026-04-22

### Fixed
- await loadUserSettingsRaw — was called without await, returning Promise instead of settings

## [2.10.202] — 2026-04-22

### Fixed
- update apiBase+apiKey when routing, not just model name

## [2.10.201] — 2026-04-21

### Fixed
- add analysis keywords + fix chat threshold + complex-edit patterns

## [2.10.200] — 2026-04-21

### Fixed
- wire routing into non-interactive (--print) mode

## [2.10.199] — 2026-04-21

### Added
- automatic model routing + /multimodel toggle

## [2.10.198] — 2026-04-21

### Added
- session economy panel + live balance + per-model cost breakdown

## [2.10.197] — 2026-04-21

### Added
- auto-close plan panel when all steps reach done status

## [2.10.196] — 2026-04-21

### Fixed
- tags field now loads from models.json + benchmark-accurate labels

## [2.10.195] — 2026-04-21

### Added
- wire PreWrite and PostWrite in tool-executor.ts

## [2.10.194] — 2026-04-21

### Fixed
- read API keys from settings.json not just env vars

## [2.10.193] — 2026-04-21

### Added
- model picker for cloud re-verification + reasoning_content fix

## [2.10.192] — 2026-04-21

### Added
- tags per model + fix reasoning_content for Kimi/DeepSeek

## [2.10.191] — 2026-04-21

### Fixed
- exempt only Read from name-level blocking, not all read-only tools

## [2.10.190] — 2026-04-21

### Fixed
- 3 audit findings — emptyType, burned Read, incomplete banner

## [2.10.189] — 2026-04-21

### Added
- wire PostEdit for Edit/MultiEdit/Write in tool-executor.ts

## [2.10.188] — 2026-04-21

### Fixed
- all 3 abort paths now use repetition_aborted stopReason

## [2.10.187] — 2026-04-21

### Fixed
- proper stopReason + soft UI message instead of alarming banner

## [2.10.186] — 2026-04-21

### Fixed
- fix actual retry limit in conversation-post-turn.ts

## [2.10.185] — 2026-04-21

### Fixed
- 4 retries for thinking_only mid-task + urgent Edit directive

## [2.10.184] — 2026-04-21

### Fixed
- input focus after /model + thinking_only retry for reasoning models

## [2.10.183] — 2026-04-21

### Added
- viewport that follows selected item, centered

## [2.10.182] — 2026-04-21

### Fixed
- use correct mode name "toggle" not "model-toggle"

## [2.10.181] — 2026-04-21

### Fixed
- hide Kodi during /model to prevent arrow-key flicker

## [2.10.180] — 2026-04-21

### Fixed
- TDZ crash — move isLocal/providerLabel before useMemo hooks

## [2.10.179] — 2026-04-21

### Fixed
- arrow keys follow visual sort order, not internal array order

## [2.10.178] — 2026-04-21

### Added
- viewport scroll + sort + sub-headers per provider

## [2.10.176] — 2026-04-21

### Fixed
- expand OpenAI non-text filter, 122 → 60 useful models

## [2.10.175] — 2026-04-21

### Fixed
- correct endpoint api.moonshot.ai + kimi-k2.5/k2.6 context sizes

## [2.10.174] — 2026-04-21

### Fixed
- correct field names + filter non-text models

## [2.10.173] — 2026-04-21

### Fixed
- discover-then-replace, OAuth key for Anthropic, keep models on failure

## [2.10.172] — 2026-04-21

### Fixed
- remove stale models before registering fresh ones from API

## [2.10.171] — 2026-04-21

### Added
- fetch models live from provider API — no more hardcoded names

## [2.10.170] — 2026-04-21

### Fixed
- [SYSTEM] injections no longer reset turn boundary

## [2.10.169] — 2026-04-21

### Added
- add Kimi to /cloud menu + fix provider registration for all cloud models

## [2.10.168] — 2026-04-21

### Added
- add Kimi (Moonshot AI) as supported cloud provider

## [2.10.167] — 2026-04-21

### Fixed
- context window + empty response + reconnaissance loop guard

## [2.10.166] — 2026-04-21

### Fixed
- force loop continuation + explicit tool reminder in system prompt

## [2.10.165] — 2026-04-21

### Fixed
- fire immediately on turn 1 when reasoning model produces 0 tools
- stale contextWindowCap assertion after df203dd removed 64k cap

## [2.10.164] — 2026-04-21

### Fixed
- model label stuck bug + hook wiring + doc counts

## [2.10.163] — 2026-04-21

### Fixed
- merge consecutive thinking blocks + reasoning loop guard

## [2.10.162] — 2026-04-21

### Added
- post-edit feedback hook + error recovery (P3c + P4b)

### Fixed
- P1-P4 multi-provider correctness + RAG restore + coding agent improvements

## [2.10.161] — 2026-04-20

### Fixed
- auto-route xAI + key format validation + hard-stop on bad key in tool output

## [2.10.160] — 2026-04-20

### Fixed
- remove 64k display cap + update known sizes to real provider max

## [2.10.159] — 2026-04-20

### Fixed
- known-size fallback so unregistered cloud models don't read as 32k

## [2.10.158] — 2026-04-20

### Fixed
- session cost was priced off cumulative (double-counted) tokens

## [2.10.157] — 2026-04-20

### Added
- show per-provider balance in the modal stats line

## [2.10.156] — 2026-04-20

### Added
- per-provider credit tracking + low-balance alerts

## [2.10.155] — 2026-04-20

### Fixed
- context-pressure bar measured cumulative usage, not current context

## [2.10.154] — 2026-04-20

### Fixed
- extract tarball before installing + switch to per-file sha256 sidecar

## [2.10.153] — 2026-04-20

### Fixed
- handle versioned tarball asset names + extract before install

## [2.10.152] — 2026-04-20

### Fixed
- three release-pipeline bugs that broke kcode install/update

## [2.10.150] — 2026-04-20

### Fixed
- `InputPrompt` (the `mnemo:mark6-31b ~/KCode ❯` line) now also
  resolves the model label through `useModelDisplayLabel`, so the
  canonical mark shows up in the shell prompt too. Previously the
  hook covered Kodi and `/model` but missed this fourth render
  site, leaking the raw alias into the prompt.

## [2.10.149] — 2026-04-20

### Changed
- `/model` picker and Kodi header now show the canonical **mark
  generation** (`mark5`, `mark6`, `mark7`, …) instead of the raw
  GGUF basename when the loaded weights belong to a registered
  family. Mapping lives in `src/core/mark-registry.ts` — a small
  table of regexes keyed by mark; callers never hardcode the
  mapping, so adding a new generation is a single entry.
  - `mark7` → Qwen3.6 family (incl. 35B-A3B and abliterated variants)
  - `mark6` → Qwen3.5 family + Gemma 3-31B
  - `mark5` → Qwen3 / Qwen3-Coder-30B-A3B
  Unregistered families keep the previous behavior and render the
  GGUF basename verbatim so nothing regresses silently.

## [2.10.148] — 2026-04-20

### Changed
- Kodi header and `/model` footer now show the runtime-derived GGUF
  label (via the new `useModelDisplayLabel` hook in
  `src/ui/hooks/`) instead of the internal alias from
  `~/.kcode/models.json`. Users no longer see `mnemo:mark6-31b`
  anywhere in the UI when the server has Qwen3.6-35B-A3B loaded —
  the alias remains the persistent config key but never renders.
- `/model` picker drops the `(alias)` in-line text; only the GGUF
  basename shows in the list when the runtime reports one.

## [2.10.147] — 2026-04-20

### Fixed
- `/model` — when a runtime-derived label was long (e.g.
  `Qwen3.6-35B-A3B-Abliterated-Heretic-Q4_K_M`), Ink's `<Box gap>`
  wrapped the Text to a second line and then rendered the `(alias)`
  sibling between the two halves of the label, producing a garbled
  header like "Qwen3.6-35B-A3B-Abliterated-He(mnemo:mark6-retic-Q4_K_M".
  Rewrote the per-row layout as a single `<Text>` for the head line
  plus a column of optional `<Text>` children for description and GPU,
  so the head never splits mid-word. No behavior change — same data,
  clean rendering.

## [2.10.146] — 2026-04-20

### Changed
- `/model` now derives its display label from the GGUF currently
  loaded by llama.cpp, not from the stale alias in `models.json`.
  New helper `src/core/model-local-discovery.ts` calls the
  `/props` endpoint and extracts the basename of `model_path`, so
  when the weights change (e.g. Kulvex swaps `mark6-31b` Gemma for
  `Qwen3.6-35B-A3B-Heretic-Q4_K_M`) the model picker reflects the
  new model on the next open — no hand-edit of `~/.kcode/models.json`
  needed. The original id stays visible in dim text as an alias hint,
  so users can still correlate with scripts that reference
  `mnemo:mark6-31b` directly. 1s cache per `baseUrl`, 1.5s timeout,
  silent fallback to the raw id when the endpoint is cloud or
  doesn't respond.

## [2.10.145] — 2026-04-20

### Changed (internal refactor — zero user-facing behavior change)
- `src/core/conversation.ts` reduced from 1858 to 1514 LOC (-18.5%)
  via 15 facade-pattern extractions into new `conversation-*.ts`
  modules. Public API surface is unchanged — the 20+ importers see
  the same symbols. Each tanda was committed individually and
  validated against the full 5261-test core suite.

  New modules: `conversation-fabrication`, `conversation-transcript`,
  `conversation-effort`, `conversation-context-maintenance`,
  `conversation-inline-warnings`, `conversation-denials`,
  `conversation-turn-limits`, `conversation-cache-replay`,
  `conversation-phantom-typo`, `conversation-turn-cost`,
  `conversation-stream-acquire`,
  `conversation-streaming-executor-setup`,
  `conversation-reality-check`, `conversation-auto-launch`,
  `conversation-schema-validation`.

  `runAgentLoop` is still the largest remaining method in
  `conversation.ts`; further extraction of its tool-execution
  blocks is deferred to a dedicated session so the contracts
  around the mutable `toolExecCtx` / `guardState` can be
  designed rather than shaved line by line.

## [2.10.144] — 2026-04-20

### Security
- `src/core/post-turn.ts` — `sendDesktopNotification` now uses
  `spawnSync` with array-form args (`shell: false`) instead of
  `execSync` with interpolated backticks. The previous regex
  sanitizer (`[^a-zA-Z0-9 _.!?-]`) was bypassable with Unicode
  characters that the allowlist didn't cover. For macOS the
  inner AppleScript literal is still escaped for `"` and `\`
  (osascript parses the `-e` arg as AppleScript regardless).

### Docs
- `bunfig.toml` note for the two skipped RAG tests updated:
  the `Illegal instruction` crash reproduces on Bun 1.3.13 as
  well (peak RSS ~44GB), so it is not a Bun-version issue and
  likely a runaway pattern in `code-chunker.ts`.

## [2.10.130] — 2026-04-17

### Changed (branding — KCode is its own product)
- Removed Claude/Claude Code branding references from all public
  surfaces: README comparison tables, site/src/pages/compare.astro
  (column dropped, "vs Claude Code" scenario removed), blog excerpt,
  HN post draft, iOS companion (Settings picker + README + default
  model), docstring in `src/tools/plan.ts`, comment in `Kodi.tsx`,
  help text in `session-actions.ts`, test fixtures in Header /
  InputPrompt / ModelToggle / Kodi render tests, comment in
  `system-prompt.ts` and `audit-engine/patterns.ts`.
- Anthropic stays supported as a cloud provider in `/cloud` —
  OAuth bridge, pricing table, model-discovery, request formatting,
  rate-limit cascade, and config key are unchanged. The literal
  `claude-*` model identifiers in `CloudMenu.tsx` and provider-
  detection plumbing are Anthropic's API IDs, not KCode branding;
  they remain.
- Default audit model flipped from `claude-opus-4-6` /
  `api.anthropic.com` → `gpt-4o` / `api.openai.com` (only affects
  users who have neither `--model` nor `settings.model` configured).

### Added (distribution)
- Binaries 2.10.129 published on GitHub Releases + kulvex.ai CDN
  (see v2.10.129 entry). This version is branding-only; identical
  runtime behavior except for the audit-default fallback note above.

## [2.10.129] — 2026-04-17

### Added (licensing framework — dual license)
- `LICENSE-COMMERCIAL.md` — framework for the commercial
  license path. Explains when you need it vs. when AGPL-3.0
  covers you, the scope of what's included (indemnification,
  support SLA, air-gapped deployment, custom patterns), and
  the inquiry process at `contact@astrolexis.space`. Not a
  legally binding contract — that's negotiated per customer
  — but the public framing enterprise evaluators expect. [#99]
- `CLA.md` — Developer Certificate of Origin (DCO) v1.1 for
  contributions. Every commit needs `-s`/`--signoff` so the
  dual-license structure stays enforceable as new code
  lands. Same mechanism the Linux kernel, Docker, GitLab use. [#99]
- README: new "License — dual licensed" section replacing the
  flat "AGPL-3.0-only" one-liner. Clear guidance on which
  license applies per use case. [#99]
- CONTRIBUTING: new "Dual license + DCO sign-off" section
  ahead of the existing versioning contract. [#99]

### Notes
- `LICENSE` (AGPL-3.0 text) is **unchanged**. Community users
  see no change — they still use the same free, open-source
  license they always did.
- No code changes in this PR — documentation + legal framework
  only. Binary installs of v2.10.129 behave identically to
  v2.10.128.
- Commercial license terms above are the INTENDED scope,
  subject to legal review before going live. Astrolexis should
  have a lawyer review LICENSE-COMMERCIAL.md + CLA.md before
  using them in a signed contract.

## [2.10.128] — 2026-04-17

### Security / docs
- GitGuardian-false-positive prevention on the embedded license
  public key (`src/core/license.ts:52`). The PEM block is RSA
  **PUBLIC** key material — used to VERIFY signed JWTs offline —
  and is intentionally committed so every install can verify
  licenses without a network call. Replaced the brief comment
  with a prominent `!!! PUBLIC KEY — NOT A SECRET !!!` docblock
  explicitly telling scanners / reviewers this is asymmetric-
  crypto verification material, not a credential. [#98]
- Audit confirmed no PRIVATE key or JWT token is embedded
  anywhere in the repo. `license-signer.ts` reads the private
  key from an external path (`$KCODE_LICENSE_PRIVATE_KEY` env
  or `~/.kcode/license-signing.pem`), never embeds it.

## [2.10.127] — 2026-04-17

### Security
- Untracked `data/kcode.db*` — integration-test SQLite DB was
  committed to the repo with ~100 test rows (customers / trials /
  webhook_events with `@test.com` emails). No real customer data
  leaked, but the DB was growing on every test run and polluting
  git history. Now `.gitignore`'d; `data/.gitkeep` keeps the
  directory present for tests that expect it. [#97]
- Untracked `AUDIT_REPORT.md`, `AUDIT_REPORT.json`,
  `AUDIT_REPORT.sarif` — output artifacts regenerated on every
  `kcode audit` run. Not secrets themselves, but noise that
  shouldn't be source-of-truth. [#97]

### Audit results
- Full-repo grep for real-shaped secrets (`sk_live_`, `AKIA...`,
  `ghp_`, `xoxb-`, `re_...`, `whsec_...`, etc.) across both
  working tree and all git history — **no real credentials
  leaked**. Every hit was either a test fixture (clearly marked
  with `FAKE` / `TEST` / `EXAMPLE`), a secret-detection regex
  pattern, or a well-known documentation example
  (`AKIAIOSFODNN7EXAMPLE`).
- Cloudflare D1 `database_id` in `wrangler.toml` is present but
  is not a secret per Cloudflare docs — it identifies the DB,
  not authenticates to it.

## [2.10.126] — 2026-04-17

### Fixed
- `py-004-sql-injection` regex false positive on `%s` / `%d` /
  `%i` parameterized placeholders. The branch `["'].*%` now
  requires `%[\s(]` — the actual Python `%`-format operator
  syntax (`"x" % var`, `"x" %(dict)s`), never adjacent to a
  format-specifier letter. Negative fixture
  `py-004-sql-injection/negative-pct-placeholder.py` pins the
  regression. [#95]

### Added
- Pattern fixture harness expanded **28 → 38 patterns**, **11
  languages**. First-time coverage for **Rust** (rs-001),
  **Swift** (swift-001), **PHP** (php-001), **Ruby** (rb-001),
  **Kotlin** (kt-001), **C#** (cs-001). [#95]
- `scanPatternAgainstContent` gains `{bypassPathFilters}` option
  so the fixture harness can assert pattern-regex invariants on
  fixtures in `tests/` without tripping the scanner's
  production-time test-file / config-file / low-severity
  suppressions. Production scanner behavior unchanged —
  bypass is opt-in only.

## [2.10.125] — 2026-04-17

### Added
- `docs/architecture/modules.md` — honest core-vs-auxiliary
  classification of the codebase. Each auxiliary module
  (RAG, compaction, distillation, voice, world-model) carries a
  top-of-file STATUS comment pointing to the doc. [#93]
- `CLAUDE.md` now references the module classification doc so
  future edits stay anchored to the "core product = audit engine"
  framing.

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
