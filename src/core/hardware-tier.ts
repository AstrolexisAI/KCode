// KCode — Hardware Tier Classification
//
// Classifies a user's hardware into one of four tiers so the setup
// wizard can pick the right flow:
//
//   strong    → local-first with the largest viable model
//   medium    → local-first with a balanced model + "or use cloud"
//   weak      → cloud-first; local only as a small-model fallback
//   unusable  → cloud-only; no viable local option
//
// Motivation: the v2.10.96 wizard assumed local is always the right
// answer and tried to download an 18GB model onto a Fedora box with
// 16GB RAM and no GPU — which technically fits via mmap but runs at
// ~1 token/sec. Better: detect hardware, and when the hardware can't
// run local at usable speed, route straight to cloud providers.

import type { HardwareInfo } from "./hardware";

export type HardwareTier = "strong" | "medium" | "weak" | "unusable";

export interface TierClassification {
  tier: HardwareTier;
  reason: string;
  /** Suggested primary path: "local" or "cloud" */
  primary: "local" | "cloud";
  /** Whether the alternative path should be offered alongside the primary */
  offerAlternative: boolean;
}

/**
 * Classify a user's hardware into one of four tiers. Thresholds are
 * tuned for usable speed (≥10 tok/s for common coding models) rather
 * than "technically fits".
 *
 * Rules (checked in order):
 *   1. Apple Silicon with unified memory gets a bonus — mlx models
 *      run well on Apple GPU cores with relatively modest RAM.
 *   2. Discrete GPU VRAM is the primary gate — ≥20GB = strong,
 *      8-20GB = medium, <8GB = weak (CPU-only by necessity).
 *   3. No GPU falls back to RAM — ≥32GB = weak (viable for 8B Q4),
 *      16-32GB = weak (only 4B fits at speed), <12GB = unusable.
 */
export function classifyHardware(
  hw: HardwareInfo,
  opts?: {
    /**
     * Live usable VRAM in MB — what's actually free right now, not
     * what's physically installed. When provided, overrides
     * hw.totalVramMB for tier decisions. This catches the case where
     * a 12GB card has only 1GB free because Blender/another LLM is
     * holding 11GB — we want "weak" in that case, not "medium".
     *
     * Detection-source note: nvidia-smi memory.free, collected via
     * gpu-availability.ts.
     */
    liveUsableVramMB?: number;
  },
): TierClassification {
  // When live usable VRAM is drastically lower than total (e.g., 1GB
  // free of 12GB), force a downgrade to weak/unusable even if the
  // card itself is medium or strong. The tiniest model in the catalog
  // is 2.6GB — if that can't fit, local is not viable right now.
  if (opts?.liveUsableVramMB !== undefined && hw.totalVramMB > 0) {
    const liveGB = opts.liveUsableVramMB / 1024;
    if (liveGB < 3) {
      return {
        tier: liveGB < 1.5 ? "unusable" : "weak",
        reason: `Only ${liveGB.toFixed(1)}GB free of ${(hw.totalVramMB / 1024).toFixed(0)}GB VRAM (other processes holding the rest). Local inference not viable right now.`,
        primary: "cloud",
        offerAlternative: liveGB >= 1.5, // let them force-local if they want
      };
    }
    // Between 3GB and full: classify based on LIVE usable instead of total
    // so someone with 6GB free of 24GB gets "weak" not "strong".
    if (liveGB < 8) {
      return {
        tier: "weak",
        reason: `${liveGB.toFixed(0)}GB free of ${(hw.totalVramMB / 1024).toFixed(0)}GB VRAM — small models only`,
        primary: "cloud",
        offerAlternative: true,
      };
    }
    if (liveGB < 20) {
      return {
        tier: "medium",
        reason: `${liveGB.toFixed(0)}GB free VRAM — medium local models OK`,
        primary: "local",
        offerAlternative: true,
      };
    }
    // liveGB >= 20 → strong regardless of total
    return {
      tier: "strong",
      reason: `${liveGB.toFixed(0)}GB free VRAM — large local models viable`,
      primary: "local",
      offerAlternative: true,
    };
  }

  // Apple Silicon special case: unified memory + mlx
  if (hw.platform === "darwin" && hw.arch === "arm64") {
    if (hw.ramMB >= 32 * 1024) {
      return {
        tier: "strong",
        reason: `Apple Silicon with ${Math.round(hw.ramMB / 1024)}GB unified memory`,
        primary: "local",
        offerAlternative: true,
      };
    }
    if (hw.ramMB >= 16 * 1024) {
      return {
        tier: "medium",
        reason: `Apple Silicon with ${Math.round(hw.ramMB / 1024)}GB unified memory (medium models)`,
        primary: "local",
        offerAlternative: true,
      };
    }
    return {
      tier: "weak",
      reason: `Apple Silicon with only ${Math.round(hw.ramMB / 1024)}GB RAM`,
      primary: "cloud",
      offerAlternative: true,
    };
  }

  // Discrete GPU tier
  if (hw.totalVramMB > 0) {
    const vramGB = hw.totalVramMB / 1024;
    if (vramGB >= 20) {
      return {
        tier: "strong",
        reason: `Discrete GPU with ${vramGB.toFixed(0)}GB VRAM`,
        primary: "local",
        offerAlternative: true,
      };
    }
    if (vramGB >= 8) {
      return {
        tier: "medium",
        reason: `Discrete GPU with ${vramGB.toFixed(0)}GB VRAM (medium models)`,
        primary: "local",
        offerAlternative: true,
      };
    }
    return {
      tier: "weak",
      reason: `Discrete GPU with only ${vramGB.toFixed(1)}GB VRAM (small models only)`,
      primary: "cloud",
      offerAlternative: true,
    };
  }

  // CPU-only — RAM tier
  const ramGB = hw.ramMB / 1024;
  if (ramGB < 12) {
    return {
      tier: "unusable",
      reason: `No GPU and only ${ramGB.toFixed(0)}GB RAM — local inference not viable`,
      primary: "cloud",
      offerAlternative: false,
    };
  }
  if (ramGB < 32) {
    return {
      tier: "weak",
      reason: `No GPU, ${ramGB.toFixed(0)}GB RAM — only tiny models (4B) at usable speed`,
      primary: "cloud",
      offerAlternative: true, // local fallback with mark5-pico is OK
    };
  }
  // >=32GB RAM CPU-only — still "weak" from a speed POV but at least viable
  return {
    tier: "weak",
    reason: `No GPU, ${ramGB.toFixed(0)}GB RAM — 8B models run at moderate speed via CPU`,
    primary: "cloud",
    offerAlternative: true,
  };
}

/** Human-readable label for a tier. Used in wizard output. */
export function tierLabel(tier: HardwareTier): string {
  switch (tier) {
    case "strong":
      return "Strong (local-first, large models)";
    case "medium":
      return "Medium (local-first, balanced models)";
    case "weak":
      return "Weak (cloud-first with local fallback)";
    case "unusable":
      return "Local not viable (cloud-only)";
  }
}
