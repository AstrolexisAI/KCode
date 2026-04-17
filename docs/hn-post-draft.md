# Show HN: KCode — Found 28 bugs in NASA's IDF in 50 seconds with a local LLM

KCode is an open-source terminal coding assistant that uses a deterministic audit engine instead of sending everything to an LLM. Three commands: `/scan`, `/fix`, `/pr`.

## What happened

I pointed KCode at NASA's Input Device Framework (https://github.com/nasa/IDF) — a C++ library for joystick/HID device management used in spacecraft simulation.

```
/scan IDF/     → 31 findings in 50 seconds (local model, 0 cloud tokens)
/fix IDF/      → 28 fixes applied automatically
/pr IDF/       → PR submitted: https://github.com/nasa/IDF/pull/107
```

## What it found

**Critical bugs that were there for years:**

1. **Pointer arithmetic error** (`EthernetDevice.cpp:160`): `(&buffer)[bytesTotal]` takes the address of a `void*` parameter and indexes past the pointer variable on the stack — not into the buffer data. On partial UDP sends, garbage memory is transmitted.

2. **Unreachable code** (`EthernetDevice.cpp:143`): `lastPacketArrived = std::time(nullptr)` after a `return` statement. The timeout timestamp never updates, causing spurious disconnections.

3. **27 USB decoder files** with unchecked `data[N]` access: `UsbXBox.cpp`, `UsbDualShock3.cpp`, `UsbDualShock4.cpp`, etc. — all access fixed HID packet indices without validating packet length. A malformed USB device could trigger out-of-bounds reads.

All 28 fixes compile clean (`cmake && make` — zero errors).

## How it works (the interesting part)

KCode doesn't ask the LLM to "audit this project." That approach has ~30% success rate (we tested it extensively — same model, same prompt, wildly different results per session).

Instead:

1. **Pattern library** (65 regex patterns across 16 languages) scans every source file deterministically
2. **Deduplication** groups multiple hits per (pattern, file) into one candidate
3. **Model verification** — for each candidate, the LLM answers ONE specific question: "Is this actually triggered? Prove it with an execution path."
4. **Auto-fix** — deterministic patches (size guards, bounded copies, RAII wrappers)
5. **Auto-PR** — creates branch, LLM generates detailed PR description, auto-forks if no write access

The LLM only handles step 3 — everything else is machine code. Result: 91% precision on NASA IDF (28 real bugs out of 31 candidates).

## Token efficiency

- Full audit with LLM verification: **~10k tokens** (local model)
- Same audit done conversationally (LLM discovers + verifies): **~300k tokens**, 30% success rate

The machine does the discovery (0 tokens). The LLM only verifies (small, focused prompts).

## Stack

- Built with Bun + TypeScript + React/Ink (terminal UI)
- Works with local models (llama.cpp, Ollama) and cloud (Anthropic, OpenAI)
- Open source: AGPL-3.0

GitHub: https://github.com/AstrolexisAI/KCode
Compare with Cursor/Aider: https://kulvex.ai/kcode/compare

---

*Astrolexis.space — Kulvex Code*
