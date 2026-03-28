// KCode - Model Catalog
// Model definitions, recommendations, and catalog queries.
//
// The mnemo:mark5 series are curated, renamed, and optimized abliterated Qwen
// variants (uncensored via abliteration) for seamless local use in KCode/KULVEX.
// Base models from open-source community creators (huihui-ai, mradermacher, mlabonne).
// Our contribution: quantization tuning, hardware-aware selection, and ecosystem
// integration — not the base model training.

import { join } from "node:path";
import { existsSync } from "node:fs";
import { kcodePath } from "./paths";
import type { HardwareInfo } from "./hardware";

// ─── Paths & Config ─────────────────────────────────────────────

const MODELS_DIR = kcodePath("models");

// Models are served from the Astrolexis CDN — already renamed with codenames.
// Users NEVER see real model names. GGUF format works on any GPU (NVIDIA, AMD, Apple, CPU).
export const MODEL_CDN = process.env.KCODE_MODEL_CDN ?? "https://kulvex.ai/models/mnemo";

// ─── Model Catalog (INTERNAL — codenames only) ─────────────────
// Real model names and repos are NEVER exposed to the user.

export interface CatalogEntry {
  codename: string;        // e.g. "mnemo:mark5-7b"
  paramBillions: number;   // e.g. 7
  quant: string;           // e.g. "Q5_K_M"
  sizeGB: number;          // approximate download size
  minVramMB: number;       // minimum VRAM to run
  contextSize: number;     // context window
  localFile: string;       // filename on CDN and locally (codename-based, no real names)
  description: string;     // user-facing description
  split?: number;          // number of split files (for >50GB models)
  cdnUrl?: string;         // override CDN URL (for HuggingFace direct downloads before CDN upload)
  mlxRepo?: string;        // MLX HuggingFace repo for macOS (INTERNAL — never shown to user)
  mlxQuant?: string;       // MLX quantization (4bit, 8bit)
  // NOTE: real model identity is NEVER stored. Files are pre-renamed on the CDN.
  // The CDN URL is: ${MODEL_CDN}/${localFile} (or cdnUrl if set)
}

// ── Model Catalog ────────────────────────────────────────────────────────
// mark5-pico: Qwen3-4B dense — tiny, fits 4GB GPUs or CPU-only, tool calling
// mark5-nano: Qwen3-8B dense — fast, fits 12GB GPUs, native tool calling
// mark5-mini to mark5-max: Qwen3-Coder-30B-A3B MoE (30B total, 3.3B active)
//   MoE models need 16GB+ because all experts must be in VRAM even though
//   only 3.3B params are active per token.
// mark5-80b: Qwen3-Coder-Next (dense 80B) — flagship
export const MODEL_CATALOG: CatalogEntry[] = [
  {
    codename: "mnemo:mark5-pico",
    paramBillions: 4,
    quant: "Q4_K_M",
    sizeGB: 2.6,
    minVramMB: 3072,
    contextSize: 16384,
    localFile: "mark5-pico.gguf",
    description: "Compact 4B abliterated — fits 4GB GPUs or CPU, uncensored",
    mlxRepo: "mlx-community/Qwen3.5-4B-MLX-4bit",
    mlxQuant: "4bit",
  },
  {
    codename: "mnemo:mark5-nano",
    paramBillions: 8,
    quant: "Q5_K_M",
    sizeGB: 6,
    minVramMB: 10240,
    contextSize: 32768,
    localFile: "mark5-nano.gguf",
    description: "Fast dense 8B — fits 12GB GPUs, native tool calling",
    mlxRepo: "mlx-community/Qwen3-8B-8bit",
    mlxQuant: "8bit",
  },
  {
    codename: "mnemo:mark5-mini",
    paramBillions: 30,
    quant: "IQ3_M",
    sizeGB: 13.5,
    minVramMB: 16384,
    contextSize: 32768,
    localFile: "mark5-mini.gguf",
    description: "MoE 30B — fits 16GB GPUs (3.3B active per token)",
    mlxRepo: "mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit",
    mlxQuant: "4bit",
  },
  {
    codename: "mnemo:mark5-mid",
    paramBillions: 30,
    quant: "Q4_K_M",
    sizeGB: 18.6,
    minVramMB: 24576,
    contextSize: 32768,
    localFile: "mark5-mid.gguf",
    description: "MoE 30B — fits 24GB GPUs (3.3B active per token)",
    mlxRepo: "mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit",
    mlxQuant: "4bit",
  },
  {
    codename: "mnemo:mark5-max",
    paramBillions: 30,
    quant: "Q6_K",
    sizeGB: 25,
    minVramMB: 32768,
    contextSize: 32768,
    localFile: "mark5-max.gguf",
    description: "Best quality MoE — fits 32GB GPUs (3.3B active per token)",
    mlxRepo: "mlx-community/Qwen3-Coder-30B-A3B-Instruct-8bit",
    mlxQuant: "8bit",
  },
  {
    codename: "mnemo:mark5-80b",
    paramBillions: 80,
    quant: "Q4_K_M",
    sizeGB: 48.5,
    minVramMB: 53248,
    contextSize: 40960,
    localFile: "mark5-80b.gguf",
    description: "Maximum power — flagship dense 80B model",
    mlxRepo: "mlx-community/Qwen3-Coder-Next-4bit",
    mlxQuant: "4bit",
  },
  {
    codename: "mnemo:mark5-titan",
    paramBillions: 235,
    quant: "Q3_K_M",
    sizeGB: 105,
    minVramMB: 57344,
    contextSize: 40960,
    localFile: "mark5-titan.gguf",
    description: "MoE 235B abliterated — 22B active per token, massive reasoning, uncensored",
  },
];

// ─── Public API ─────────────────────────────────────────────────

/** Get the model catalog (codenames and descriptions only) */
export function getAvailableModels(): { codename: string; paramBillions: number; sizeGB: number; description: string; minVramMB: number }[] {
  return MODEL_CATALOG.map((m) => ({
    codename: m.codename,
    paramBillions: m.paramBillions,
    sizeGB: m.sizeGB,
    description: m.description,
    minVramMB: m.minVramMB,
  }));
}

/** Recommend the best model for the detected hardware */
export function recommendModel(hw: HardwareInfo): CatalogEntry {
  // ── macOS Apple Silicon: unified memory + SSD offloading ──────
  // On Apple Silicon, RAM = VRAM (unified memory). Models larger than RAM
  // can still run via mlx_lm's disk offloading — Apple's fast NVMe SSDs
  // (~7 GB/s) make this viable at reduced speed. We allow models up to
  // 2x RAM with offloading, and up to 1x RAM at full speed.
  if (hw.platform === "darwin" && hw.arch === "arm64") {
    const ramMB = hw.ramMB;
    let best: CatalogEntry | null = null;
    for (const entry of MODEL_CATALOG) {
      if (!entry.mlxRepo) continue; // skip non-MLX models
      const modelMB = entry.sizeGB * 1024;
      // Full speed: model fits in 80% of RAM (leave room for KV cache + OS)
      // Offloaded: model up to 2x RAM — disk offloading kicks in, slower but works
      const maxModelMB = ramMB * 2;
      if (modelMB <= maxModelMB) {
        best = entry;
      }
    }
    // Fallback to GGUF-based selection if no MLX models match
    if (best) return best;
  }

  // ── Discrete GPU: pick largest model that can run ─────────────
  // Priority: full VRAM fit > partial GPU offload (GPU + CPU/RAM via mmap)
  // With mmap, llama.cpp streams layers that don't fit in VRAM from SSD/RAM.
  // We allow models up to VRAM + 70% of system RAM (mmap handles the rest).
  if (hw.totalVramMB > 0) {
    let best: CatalogEntry | null = null;
    const totalCapacityMB = hw.totalVramMB + hw.ramMB * 0.7;
    for (const entry of MODEL_CATALOG) {
      const modelMB = entry.sizeGB * 1024;
      if (modelMB <= totalCapacityMB) {
        best = entry;
      }
    }
    if (best) return best;
  }

  // ── CPU mode: model runs in system RAM via mmap ────────────────
  // With mmap, models larger than RAM can work (SSD-backed pages) but are slow.
  // We recommend up to 1.5x RAM — mmap streams the overflow from SSD.
  const availableRAM = hw.ramMB * 1.5;
  let cpuBest: CatalogEntry | null = null;
  for (const entry of MODEL_CATALOG) {
    const neededRamMB = entry.sizeGB * 1024 * 1.2; // 20% overhead for KV cache
    if (neededRamMB <= availableRAM) {
      cpuBest = entry;
    }
  }

  return cpuBest ?? MODEL_CATALOG[0];
}

/** Find a catalog entry by codename */
export function findCatalogEntry(codename: string): CatalogEntry | undefined {
  return MODEL_CATALOG.find((m) => m.codename === codename);
}

/** Get the local path for a model's GGUF file */
export function getModelPath(codename: string): string | null {
  const entry = findCatalogEntry(codename);
  if (!entry) return null;
  const path = join(MODELS_DIR, entry.localFile);
  return existsSync(path) ? path : null;
}

/** Check if a model is downloaded */
export function isModelDownloaded(codename: string): boolean {
  return getModelPath(codename) !== null;
}

/** Calculate optimal GPU layers based on available VRAM.
 *  Reserves ~20% of VRAM for KV cache and OS overhead.
 *  Typical transformer: ~32-40 layers for 4B-8B models. */
export function calculateGpuLayers(hw: HardwareInfo, entry: CatalogEntry): number {
  if (hw.totalVramMB === 0) return 0; // No GPU — CPU only

  // Estimate available VRAM after OS/display overhead (~300-500 MB on Windows)
  const osOverheadMB = hw.platform === "win32" ? 400 : 200;
  const usableVramMB = hw.totalVramMB - osOverheadMB;
  const modelSizeMB = entry.sizeGB * 1024;

  // If plenty of VRAM (model + 30% for KV cache fits), offload everything
  if (usableVramMB >= modelSizeMB * 1.3) return -1;

  // Otherwise, calculate how many layers we can fit while leaving room for KV cache
  // KV cache estimate: ~15-25 MB per layer for small models at moderate context
  const kvCacheReserveMB = Math.min(usableVramMB * 0.2, 600); // 20% of VRAM or 600 MB max
  const vramForLayers = usableVramMB - kvCacheReserveMB;

  // Estimate total layers (roughly 32 for 4B, 32 for 8B, 64 for 30B+)
  const estimatedLayers = entry.paramBillions <= 8 ? 32 : entry.paramBillions <= 30 ? 64 : 80;
  const mbPerLayer = modelSizeMB / estimatedLayers;
  const fittableLayers = Math.floor(vramForLayers / mbPerLayer);

  return Math.max(1, Math.min(fittableLayers, estimatedLayers));
}

/** Get the models directory path */
export const MODELS_DIR_PATH = MODELS_DIR;
