// KCode - Multi-GPU Utilities
// Tensor split calculation for llama.cpp multi-GPU inference.

import type { GpuInfo } from "./hardware";

/**
 * Calculate optimal tensor split ratios for llama.cpp `--tensor-split` flag.
 *
 * Distributes model layers across GPUs proportional to each GPU's available VRAM.
 * Returns an array of proportions that sum to 1.0 (one per GPU, ordered by index).
 *
 * Example: two GPUs with 24GB and 16GB → [0.6, 0.4]
 * llama.cpp usage: --tensor-split 0.6,0.4
 *
 * @param gpus - Array of detected GPUs (must have at least 1 entry)
 * @param modelSizeGB - Total model size in GB (used for validation, not ratios)
 * @returns Array of split ratios (one per GPU), or empty array if no GPUs
 */
export function calculateOptimalTensorSplit(gpus: GpuInfo[], modelSizeGB: number): number[] {
  if (!gpus || gpus.length === 0) return [];
  if (gpus.length === 1) return [1.0];

  // Sort by GPU index to ensure consistent ordering
  const sorted = [...gpus].sort((a, b) => a.index - b.index);

  const totalVram = sorted.reduce((sum, g) => sum + g.vramMB, 0);
  if (totalVram === 0) return sorted.map(() => 1 / sorted.length);

  // Proportional split based on VRAM
  const ratios = sorted.map((g) => g.vramMB / totalVram);

  // Round to 2 decimal places for clean output
  const rounded = ratios.map((r) => Math.round(r * 100) / 100);

  // Adjust last element to ensure sum is exactly 1.0
  const sumSoFar = rounded.slice(0, -1).reduce((s, r) => s + r, 0);
  rounded[rounded.length - 1] = Math.round((1.0 - sumSoFar) * 100) / 100;

  return rounded;
}

/**
 * Format tensor split ratios as a comma-separated string for llama.cpp CLI.
 * Example: [0.6, 0.4] → "0.6,0.4"
 */
export function formatTensorSplit(ratios: number[]): string {
  return ratios.join(",");
}

/**
 * Check if the model fits across all GPUs combined.
 * Reserves ~20% headroom for KV cache and runtime overhead.
 */
export function modelFitsMultiGpu(gpus: GpuInfo[], modelSizeGB: number): boolean {
  if (!gpus || gpus.length === 0) return false;
  const totalVramGB = gpus.reduce((sum, g) => sum + g.vramMB, 0) / 1024;
  // Need at least model size + 20% headroom for KV cache
  return totalVramGB >= modelSizeGB * 1.2;
}
