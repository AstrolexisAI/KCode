# HN launch post draft

Title (pick one; first is recommended):

1. **Show HN: KCode – a SAST scanner that uses a local LLM to strip false positives**
2. Show HN: KCode – deterministic security scanner for C/Rust/Go, 256 patterns, local-first
3. Show HN: Found 28 bugs in NASA's IDF in 50s with a local LLM + 10k tokens

---

## Body

KCode is a static security scanner that flips the usual LLM-SAST split. Instead of sending your whole codebase to a cloud model and hoping it notices the bug, a deterministic scanner runs 256 hand-written patterns locally and then a small local LLM (runs on a 24GB GPU) verifies each candidate in isolation. The LLM's job is just to strip false positives — not to find bugs.

Open source, Apache 2.0: https://github.com/AstrolexisAI/KCode

### Why we built it

I spent six months watching LLM-first audit tools either hallucinate bugs that weren't there or miss the obvious ones under paragraphs of plausible prose. On the same codebase, same prompt, same model, two runs in a row would produce wildly different results. That's not a pipeline you can ship.

So we split the problem. Deterministic things should be deterministic:

1. **Scanner** — 256 curated patterns across 20+ languages (C, C++, Rust, Go, Python, Java, JS/TS, Ruby, PHP, Swift, Kotlin, Scala, Haskell, Zig, Dart, Lua, SQL + framework packs for Flask, Rails, React). Hand-written, not LLM-generated. Each pattern ships with positive + negative fixtures and survives a CI regression harness (158 fixture tests + 29 scanner-utility tests).

2. **Verifier** — the LLM receives one candidate at a time with a focused prompt: "Is this actually triggered? Prove it with an execution path or respond FALSE_POSITIVE." ~10k tokens per full audit instead of ~300k for an LLM-first tool. Uses a local 14B-31B model by default; optional cloud verifier for higher accuracy on complex bugs.

3. **Fixer** (`/fix`) — every pattern has a fix template. Size guards, bounded copies, RAII wrappers applied deterministically. Diff-previewed before write.

4. **PR pipeline** (`/pr`) — branch + commit + LLM-generated PR description grounded in the finding evidence. Auto-fork when you don't own the repo.

### Does it actually work?

We ran it against NASA's IDF (Input Device Framework — the C++ library used in spacecraft simulation). [PR #107 on nasa/IDF](https://github.com/nasa/IDF/pull/107) was the result: 28 real bugs confirmed and patched.

The highlights:

- `EthernetDevice.cpp:160` — `(&buffer)[bytesTotal]` takes the address of a `void*` parameter and indexes past the pointer variable on the stack, not into the buffer data. Partial UDP sends transmitted garbage memory.
- `EthernetDevice.cpp:143` — `lastPacketArrived = std::time(nullptr)` after a `return` statement. Timeout timestamp never updates → spurious disconnections.
- 27 USB decoder files (`UsbXBox.cpp`, `UsbDualShock3.cpp`, …) accessing `data[N]` for fixed HID packet indices without validating packet length. Malformed USB devices could trigger OOB reads.

31 candidates → 28 confirmed → 28 patches applied, all compile clean. 9 downgraded to false-positive by the verifier. 91% precision. Full run: ~50 seconds, 0 cloud tokens (local verifier).

### How it compares to Semgrep / CodeQL / Snyk / SonarQube

Honest breakdown, because we don't beat them at everything:

- **CodeQL** wins at deep cross-function dataflow — chasing a taint across 15 function hops is its specialty.
- **Semgrep** has ~2000 OSS rules, we have 256. We bet on depth + LLM verification over breadth.
- **Snyk** has the polished SOC2/compliance reporting. We emit SARIF; plug it into your existing dashboard.
- **SonarQube** dominates legacy-code quality audits. Different focus.

What KCode adds that none of them do:

- LLM-verified findings → lower false-positive rate without hand-tuning queries
- `/fix` produces actual patches, not just flags
- 100% local: scanner + verifier never upload your source (Snyk sends code to their hosted engine; CodeQL and Semgrep have optional cloud dashboards)

Full comparison page: https://kulvex.ai/kcode/compare

### What it's NOT

- Not a dataflow engine (use CodeQL for that)
- Not a compliance suite (we emit SARIF; use SonarQube/Snyk for dashboards)
- Not the largest rule catalog
- Free and permissive — Apache 2.0, use it anywhere (including commercial). Pro features (multi-model orchestrator, multi-agent swarm, hosted service) are a separate commercial repo: contact@astrolexis.space

### Stack

- Bun + TypeScript. Terminal UI via React/Ink.
- Local LLMs: llama.cpp, Ollama, vLLM.
- Cloud (optional): OpenAI, Anthropic, Gemini, Groq, DeepSeek, Together.
- Cross-compile: Linux x64/ARM64, macOS x64/ARM64, Windows x64. Single ~100MB binary.

### Install

```
# Linux x64
curl -LO https://kulvex.ai/downloads/kcode/kcode-2.10.134-linux-x64
chmod +x kcode-2.10.134-linux-x64
./kcode-2.10.134-linux-x64 audit .
```

Other platforms: https://kulvex.ai/kcode#downloads

---

**GitHub**: https://github.com/AstrolexisAI/KCode
**Compare**: https://kulvex.ai/kcode/compare
**Landing**: https://kulvex.ai/kcode

Feedback welcome — especially from people running SAST in production. What's missing from the 256-pattern catalog? What false positives do Semgrep/CodeQL still cost you despite the tuning? Both answers make the product better.
