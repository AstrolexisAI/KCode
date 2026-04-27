// KCode - Mark Registry
// Maps the GGUF basename currently loaded by a local llama.cpp server
// to the canonical "mark" generation. The mark is what users recognise
// at a glance ("mark7") whereas the GGUF basename
// ("Qwen3.6-35B-A3B-Abliterated-Heretic-Q4_K_M") is the upstream
// filename that changes per quant / variant / release.
//
// Adding a new generation: push an entry with a `patterns` list of
// case-insensitive regexes matched against the GGUF basename. First
// match wins — keep the registry ordered newest → oldest so a
// specific variant never gets shadowed by a broader pattern.

export interface MarkEntry {
  /** Canonical short label shown in the UI (e.g. "mark7"). */
  mark: string;
  /**
   * Patterns matched against the GGUF basename (the filename minus the
   * `.gguf` extension). First match wins; case-insensitive.
   */
  patterns: RegExp[];
  /** Short human description — not rendered, kept for docs/debug. */
  notes?: string;
}

// ─── Registry ───────────────────────────────────────────────────
// Newest first. Each mark is keyed by the Qwen / base-model family
// the community GGUFs are built from.

export const MARK_REGISTRY: MarkEntry[] = [
  {
    mark: "mark7",
    patterns: [/(^|[-_. ])Qwen3\.6([-_. ]|$)/i],
    notes: "Qwen3.6 family (35B-A3B MoE and variants) — abliterated builds",
  },
  {
    mark: "mark6",
    patterns: [/(^|[-_. ])Qwen3\.5([-_. ]|$)/i, /(^|[-_. ])Gemma[-_. ]?3[-_. ]?31[Bb]([-_. ]|$)/i],
    notes: "Qwen3.5 and Gemma 3 abliterated — previous generation",
  },
  {
    mark: "mark5",
    patterns: [/(^|[-_. ])Qwen3([-_. ]|$)/i],
    notes: "Qwen3 dense + Qwen3-Coder-30B-A3B family",
  },
];

/**
 * Look up the canonical mark for a GGUF basename. Returns null when
 * none of the registry patterns match (e.g. an unknown community model
 * or a brand-new family that's not registered yet). Callers should
 * fall back to the raw basename in that case.
 */
export function lookupMarkByGgufBasename(basename: string): string | null {
  for (const entry of MARK_REGISTRY) {
    for (const pattern of entry.patterns) {
      if (pattern.test(basename)) return entry.mark;
    }
  }
  return null;
}
