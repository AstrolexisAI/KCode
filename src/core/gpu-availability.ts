// KCode — Live GPU Availability Detection
//
// `hardware.ts` reports TOTAL VRAM (physical capacity). For model
// recommendation we need FREE VRAM — what's actually available right
// now. A 12GB card with 8GB already in use by another app has only
// 4GB usable for inference.
//
// This module is called by the setup wizard before recommendModel
// so recommendations match reality, not marketing specs.

import { log } from "./logger";

export interface GpuAvailability {
  /** Total VRAM (physical capacity) in MB. */
  totalMB: number;
  /** VRAM currently free in MB. `null` if detection failed. */
  freeMB: number | null;
  /** VRAM currently used by other processes in MB. `null` on failure. */
  usedMB: number | null;
  /** Source of the data (for logging / debug). */
  source: "nvidia-smi" | "apple-unified" | "unknown";
}

/**
 * Detect free VRAM across all discrete GPUs by querying nvidia-smi.
 * Sums free memory across cards so multi-GPU setups get the combined
 * value (same as hardware.ts totals vramMB).
 *
 * Returns `freeMB: null` if:
 *   - No nvidia-smi available (non-NVIDIA GPU, driver missing)
 *   - The query times out (10s)
 *   - Parse failure
 *
 * In the `null` case, the caller should fall back to a conservative
 * fraction of totalVramMB (e.g. 0.8x) since we can't confirm what's
 * free.
 */
export async function detectGpuAvailability(
  platform: string,
  totalVramMB: number,
): Promise<GpuAvailability> {
  // Apple Silicon has unified memory — no separate VRAM pool, and
  // no per-app free/used tracking at the level we can easily query.
  // Caller should treat the full reported RAM as "available modulo OS".
  if (platform === "darwin") {
    return {
      totalMB: totalVramMB,
      freeMB: null, // caller falls back to ramMB * 0.75 or similar
      usedMB: null,
      source: "apple-unified",
    };
  }

  try {
    const output = await runNvidiaSmi();
    if (!output) {
      log.debug("gpu-availability", "nvidia-smi returned no output");
      return {
        totalMB: totalVramMB,
        freeMB: null,
        usedMB: null,
        source: "unknown",
      };
    }

    // CSV: free,used,total — one row per GPU in MB
    let sumFree = 0;
    let sumUsed = 0;
    let sumTotal = 0;
    let rows = 0;
    for (const line of output.split("\n")) {
      const parts = line.split(",").map((s) => s.trim());
      if (parts.length < 3) continue;
      const free = parseInt(parts[0]!, 10);
      const used = parseInt(parts[1]!, 10);
      const total = parseInt(parts[2]!, 10);
      if (!Number.isFinite(free) || !Number.isFinite(used) || !Number.isFinite(total)) continue;
      sumFree += free;
      sumUsed += used;
      sumTotal += total;
      rows++;
    }
    if (rows === 0) {
      return {
        totalMB: totalVramMB,
        freeMB: null,
        usedMB: null,
        source: "unknown",
      };
    }

    return {
      totalMB: sumTotal,
      freeMB: sumFree,
      usedMB: sumUsed,
      source: "nvidia-smi",
    };
  } catch (err) {
    log.debug("gpu-availability", `detection failed: ${err}`);
    return {
      totalMB: totalVramMB,
      freeMB: null,
      usedMB: null,
      source: "unknown",
    };
  }
}

async function runNvidiaSmi(): Promise<string | null> {
  const { execSync } = require("node:child_process") as typeof import("node:child_process");
  const candidatePaths = [
    "/usr/bin/nvidia-smi",
    "nvidia-smi",
    "/usr/local/bin/nvidia-smi",
    "/usr/local/cuda/bin/nvidia-smi",
    "/opt/cuda/bin/nvidia-smi",
  ];
  const query = "--query-gpu=memory.free,memory.used,memory.total --format=csv,noheader,nounits";

  for (const smiPath of candidatePaths) {
    try {
      const out = execSync(`${smiPath} ${query}`, {
        encoding: "utf-8",
        timeout: 5_000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      if (out) return out;
    } catch {
      /* try next */
    }
  }
  return null;
}

/**
 * Compute effective usable VRAM for recommendation purposes. Uses
 * live free-VRAM when available, falls back to a conservative fraction
 * of total VRAM when detection fails.
 *
 * Applies a 10% safety margin on top — even if nvidia-smi says 12GB
 * is free, we reserve some for KV cache + runtime overhead.
 */
export function effectiveUsableVramMB(availability: GpuAvailability, totalVramMB: number): number {
  const SAFETY = 0.9;
  if (availability.freeMB !== null) {
    // Live detection: use actual free with safety margin
    return Math.max(0, availability.freeMB * SAFETY);
  }
  // Fallback: conservative fraction of total (assume ~20% is in use)
  return totalVramMB * 0.8 * SAFETY;
}
