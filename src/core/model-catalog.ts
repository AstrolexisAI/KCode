// KCode - Model Catalog
// Model definitions, recommendations, and catalog queries.
//
// The mnemo:mark5 series are curated, renamed, and optimized abliterated Qwen
// variants (uncensored via abliteration) for seamless local use in KCode/KULVEX.
// Base models from open-source community creators (huihui-ai, mradermacher, mlabonne).
// Our contribution: quantization tuning, hardware-aware selection, and ecosystem
// integration — not the base model training.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { HardwareInfo } from "./hardware";
import { kcodePath } from "./paths";

// ─── Paths & Config ─────────────────────────────────────────────

const MODELS_DIR = kcodePath("models");

// Models are served from the Astrolexis CDN — already renamed with codenames.
// Users NEVER see real model names. GGUF format works on any GPU (NVIDIA, AMD, Apple, CPU).
export const MODEL_CDN = process.env.KCODE_MODEL_CDN ?? "https://kulvex.ai/models/mnemo";

// ─── Model Catalog (INTERNAL — codenames only) ─────────────────
// Real model names and repos are NEVER exposed to the user.

export interface CatalogEntry {
  codename: string; // e.g. "mnemo:mark5-7b"
  paramBillions: number; // e.g. 7
  quant: string; // e.g. "Q5_K_M"
  sizeGB: number; // approximate download size
  minVramMB: number; // minimum VRAM to run
  contextSize: number; // context window
  localFile: string; // filename on CDN and locally (codename-based, no real names)
  description: string; // user-facing description
  split?: number; // number of split files (for >50GB models)
  cdnUrl?: string; // override CDN URL (for HuggingFace direct downloads before CDN upload)
  mlxRepo?: string; // MLX HuggingFace repo for macOS (INTERNAL — never shown to user)
  mlxQuant?: string; // MLX quantization (4bit, 8bit)
  // NOTE: real model identity is NEVER stored. Files are pre-renamed on the CDN.
  // The CDN URL is: ${MODEL_CDN}/${localFile} (or cdnUrl if set)
}

// ── Model Catalog ────────────────────────────────────────────────────────
// 2026-05-08 catalog refresh after multi-model verification on macOS:
//
// AGENTIC tier (general tool use, network/system, mixed work):
//   mark5-mini  → GLM-4.7-Flash 4bit  (16GB VRAM)  ← recommended default
//   GLM-4.7 verified to issue macOS-correct commands directly (ifconfig,
//   arp, lsof), use nmap when present, multi-stage exploration, no
//   "tools restricted" hallucinations.
//
// CODING tier (pure code generation, refactor, fix bug):
//   mark5-coder → Qwen3-Coder 30B-A3B 4bit DWQ  (16GB VRAM)
//   Best-in-class local coder. Tool-fitness=weak for agentic mixed
//   work (verified 2026-05-08), so it's deliberately a separate
//   tier and not a default — pick it when the task is pure code-gen.
//
// CHAT / TRANSLATION tier (Spanish↔English, explanations, doc-writing):
//   mark5-mid  → Gemma 4 31B 4bit  (24GB VRAM)
//   mark5-max  → Gemma 4 31B 8bit  (36GB VRAM)
//   Gemma is chat/translation-tuned. Falls into explain mode on
//   coding prompts (verified). Excellent for Spanish/English chat.
//
// SMALL tier (entry-level, CPU-only or 4-12GB GPUs):
//   mark5-pico → Qwen3.5 4B  (3GB)
//   mark5-nano → Qwen3 8B    (10GB)
//
// REMOVED:
//   mark5-80b (Qwen3-Coder-Next 80B) — flagship at 53GB, dropped
//     when Qwen3-Coder marked weak agentic 2026-05-08
//   Qwen3.6-35B — never made it into the catalog after E2E showed
//     it hallucinates fake hostnames/IPs in network output
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
    paramBillions: 32,
    quant: "Q4_K_M",
    sizeGB: 15.7,
    minVramMB: 16384,
    contextSize: 32768,
    localFile: "mark5-mini.gguf",
    description: "GLM-4.7-Flash — fits 16GB GPUs, strong agentic tool use (recommended default)",
    mlxRepo: "mlx-community/GLM-4.7-Flash-4bit",
    mlxQuant: "4bit",
  },
  {
    codename: "mnemo:mark5-coder",
    paramBillions: 30,
    quant: "Q4_K_M",
    sizeGB: 16,
    minVramMB: 16384,
    contextSize: 131072,
    localFile: "mark5-coder.gguf",
    description: "Qwen3-Coder 30B-A3B — pure code-gen, refactor, fix bug; weak agentic",
    mlxRepo: "mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit-DWQ",
    mlxQuant: "4bit",
  },
  {
    codename: "mnemo:mark5-mid",
    paramBillions: 31,
    quant: "Q4_K_M",
    sizeGB: 18.6,
    minVramMB: 24576,
    contextSize: 131072,
    localFile: "mark5-mid.gguf",
    description: "Gemma 4 31B — chat / translation / Spanish↔English (24GB GPUs)",
    mlxRepo: "mlx-community/gemma-4-31b-it-4bit",
    mlxQuant: "4bit",
  },
  {
    codename: "mnemo:mark5-max",
    paramBillions: 31,
    quant: "Q8_0",
    sizeGB: 33,
    minVramMB: 36864,
    contextSize: 131072,
    localFile: "mark5-max.gguf",
    description: "Gemma 4 31B at 8-bit — chat best-quality, 36GB+ GPUs",
    mlxRepo: "mlx-community/gemma-4-31b-it-8bit",
    mlxQuant: "8bit",
  },
  // ── Community Models ───────────────────────────────────────────────────
  // Open-source models from external teams, served as GGUF via HuggingFace.

  {
    codename: "mnemo:deepseek-coder-v2",
    paramBillions: 16,
    quant: "Q4_K_M",
    sizeGB: 10,
    minVramMB: 12288,
    contextSize: 65536,
    localFile: "deepseek-coder-v2-lite.gguf",
    description: "DeepSeek Coder V2 Lite 16B MoE — excellent for coding tasks",
    cdnUrl:
      "https://huggingface.co/TheBloke/deepseek-coder-v2-lite-instruct-GGUF/resolve/main/deepseek-coder-v2-lite-instruct.Q4_K_M.gguf",
  },
  {
    codename: "mnemo:codellama-34b",
    paramBillions: 34,
    quant: "Q4_K_M",
    sizeGB: 20,
    minVramMB: 24576,
    contextSize: 16384,
    localFile: "codellama-34b.gguf",
    description: "CodeLlama 34B — Meta's dedicated coding model",
    cdnUrl:
      "https://huggingface.co/TheBloke/CodeLlama-34B-Instruct-GGUF/resolve/main/codellama-34b-instruct.Q4_K_M.gguf",
  },
  {
    codename: "mnemo:phi3-medium",
    paramBillions: 14,
    quant: "Q5_K_M",
    sizeGB: 10,
    minVramMB: 12288,
    contextSize: 131072,
    localFile: "phi3-medium.gguf",
    description: "Phi-3 Medium 14B — Microsoft, compact but highly capable",
    cdnUrl:
      "https://huggingface.co/bartowski/Phi-3-medium-128k-instruct-GGUF/resolve/main/Phi-3-medium-128k-instruct-Q5_K_M.gguf",
  },
  {
    codename: "mnemo:phi3-mini",
    paramBillions: 3.8,
    quant: "Q5_K_M",
    sizeGB: 3,
    minVramMB: 4096,
    contextSize: 131072,
    localFile: "phi3-mini.gguf",
    description: "Phi-3 Mini 3.8B — ultra lightweight, runs on 4GB GPUs or CPU",
    cdnUrl:
      "https://huggingface.co/bartowski/Phi-3-mini-128k-instruct-GGUF/resolve/main/Phi-3-mini-128k-instruct-Q5_K_M.gguf",
  },
  {
    codename: "mnemo:mistral-nemo",
    paramBillions: 12,
    quant: "Q5_K_M",
    sizeGB: 9,
    minVramMB: 10240,
    contextSize: 131072,
    localFile: "mistral-nemo.gguf",
    description: "Mistral Nemo 12B — good general purpose model",
    cdnUrl:
      "https://huggingface.co/bartowski/Mistral-Nemo-Instruct-2407-GGUF/resolve/main/Mistral-Nemo-Instruct-2407-Q5_K_M.gguf",
  },
  {
    codename: "mnemo:llama31-8b",
    paramBillions: 8,
    quant: "Q5_K_M",
    sizeGB: 6,
    minVramMB: 8192,
    contextSize: 131072,
    localFile: "llama31-8b.gguf",
    description: "Llama 3.1 8B — Meta's popular general-purpose model",
    cdnUrl:
      "https://huggingface.co/bartowski/Meta-Llama-3.1-8B-Instruct-GGUF/resolve/main/Meta-Llama-3.1-8B-Instruct-Q5_K_M.gguf",
  },
];

// ─── Public API ─────────────────────────────────────────────────

/** Get the model catalog (codenames and descriptions only) */
export function getAvailableModels(): {
  codename: string;
  paramBillions: number;
  sizeGB: number;
  description: string;
  minVramMB: number;
}[] {
  return MODEL_CATALOG.map((m) => ({
    codename: m.codename,
    paramBillions: m.paramBillions,
    sizeGB: m.sizeGB,
    description: m.description,
    minVramMB: m.minVramMB,
  }));
}

/** Recommend the best model for the detected hardware */
export function recommendModel(
  hw: HardwareInfo,
  opts?: {
    /**
     * Override the VRAM budget used for "fits in VRAM" calculations.
     * When set, this replaces hw.totalVramMB * 0.9. Pass the live free
     * VRAM (minus overhead) so recommendations match what's actually
     * available, not marketing specs.
     */
    usableVramMB?: number;
  },
): CatalogEntry {
  // ── macOS Apple Silicon: unified memory ────────────────────────
  // RAM and VRAM share the SAME pool. We must reserve memory for OS,
  // browser, KCode itself, and KV cache — otherwise we OOM the system
  // or thrash swap. Reserve max(8GB, 25% of RAM):
  //   16GB → reserve 8GB  → usable 8GB
  //   24GB → reserve 8GB  → usable 16GB
  //   48GB → reserve 12GB → usable 36GB
  //   64GB → reserve 16GB → usable 48GB
  // SSD "offloading" via mmap on unified memory is a trap: it just
  // forces the kernel to swap pages between the model and the OS in
  // the same RAM. Performance collapses (1-3 tok/s) and kernel_task
  // bloats. Never recommend a model > usable.
  if (hw.platform === "darwin" && hw.arch === "arm64") {
    const reservedMB = Math.max(8 * 1024, hw.ramMB * 0.25);
    const usableMB = hw.ramMB - reservedMB;
    let best: CatalogEntry | null = null;
    for (const entry of MODEL_CATALOG) {
      if (!entry.mlxRepo) continue; // skip non-MLX models
      const modelMB = entry.sizeGB * 1024;
      if (modelMB <= usableMB && (!best || entry.sizeGB > best.sizeGB)) {
        best = entry;
      }
    }
    if (best) return best;
  }

  // ── Discrete GPU: pick largest model that fits FULLY in VRAM ──
  // Priority: usable speed > max size. Previously we'd pick the
  // largest model that technically fits via mmap (VRAM + 70% of
  // RAM), but that hit the common failure mode where a 12GB card
  // got recommended a 20GB model running at ~5 tok/s via SSD
  // streaming. Users canceled the download every time. Fix:
  //
  //   Step 1: find the largest model that fits in VRAM × 0.9
  //           (leaving 10% headroom for KV cache + overhead).
  //   Step 2: only fall back to mmap-fits if NO model fits in VRAM.
  //
  // This produces faster models at the cost of slightly smaller
  // ones. Users who want the biggest can still pass --model
  // explicitly.
  if (hw.totalVramMB > 0) {
    // Use live usable VRAM if provided (caller detected via nvidia-smi
    // memory.free), otherwise fall back to 90% of total.
    const vramFitMB = opts?.usableVramMB ?? hw.totalVramMB * 0.9;
    let vramBest: CatalogEntry | null = null;
    for (const entry of MODEL_CATALOG) {
      const modelMB = entry.sizeGB * 1024;
      if (modelMB <= vramFitMB && (!vramBest || entry.sizeGB > vramBest.sizeGB)) {
        vramBest = entry;
      }
    }
    if (vramBest) return vramBest;

    // No model fits fully — fall back to mmap (old behavior, but
    // only reached when the GPU is too small for any listed model).
    const totalCapacityMB = hw.totalVramMB + hw.ramMB * 0.7;
    let mmapBest: CatalogEntry | null = null;
    for (const entry of MODEL_CATALOG) {
      const modelMB = entry.sizeGB * 1024;
      if (modelMB <= totalCapacityMB && (!mmapBest || entry.sizeGB > mmapBest.sizeGB)) {
        mmapBest = entry;
      }
    }
    if (mmapBest) return mmapBest;
  }

  // ── CPU mode: model runs in system RAM via mmap ────────────────
  // With mmap, models larger than RAM can work (SSD-backed pages) but are slow.
  // We recommend up to 1.5x RAM — mmap streams the overflow from SSD.
  const availableRAM = hw.ramMB * 1.5;
  let cpuBest: CatalogEntry | null = null;
  for (const entry of MODEL_CATALOG) {
    const neededRamMB = entry.sizeGB * 1024 * 1.2; // 20% overhead for KV cache
    if (neededRamMB <= availableRAM && (!cpuBest || entry.sizeGB > cpuBest.sizeGB)) {
      cpuBest = entry;
    }
  }

  // Fallback to smallest model if nothing fits
  if (!cpuBest && MODEL_CATALOG.length > 0) {
    cpuBest = MODEL_CATALOG.reduce((smallest, entry) =>
      entry.sizeGB < smallest.sizeGB ? entry : smallest,
    );
  }

  return cpuBest ?? MODEL_CATALOG[0]!;
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

/**
 * Calculate optimal concurrency (parallel slots) and per-slot context size
 * based on available VRAM/RAM and model size.
 *
 * KV cache memory per token ≈ 2 * n_layers * n_kv_heads * head_dim * bytes_per_element
 * With q4_0 cache quantization, this is roughly halved.
 *
 * Strategy:
 *   1. Estimate VRAM used by model weights
 *   2. Calculate free VRAM after weights + OS overhead
 *   3. Estimate KV cache cost per token (based on model size heuristic)
 *   4. Find max slots where each slot gets the full model contextSize
 *   5. If only 1 slot fits, return 1 slot with full context
 */
export function calculateConcurrency(
  hw: HardwareInfo,
  entry: CatalogEntry,
  options?: { cacheQuant?: "f16" | "q8_0" | "q4_0" },
): { parallelSlots: number; contextPerSlot: number; totalContext: number } {
  const cacheQuant = options?.cacheQuant ?? "q4_0";

  // Available memory: VRAM for GPU systems, RAM for CPU-only
  const availableMB = hw.totalVramMB > 0 ? hw.totalVramMB : hw.ramMB;
  if (availableMB === 0) {
    return { parallelSlots: 1, contextPerSlot: entry.contextSize, totalContext: entry.contextSize };
  }

  // OS/display overhead
  const osOverheadMB = hw.platform === "win32" ? 500 : 300;

  // Model weights in VRAM
  const modelWeightsMB = entry.sizeGB * 1024;

  // Free memory after model + overhead
  const freeMB = availableMB - modelWeightsMB - osOverheadMB;
  if (freeMB <= 0) {
    // Barely fits the model, 1 slot with minimal context
    return { parallelSlots: 1, contextPerSlot: entry.contextSize, totalContext: entry.contextSize };
  }

  // Estimate KV cache bytes per token based on model parameters.
  // Approximate formula: 2 (K+V) * n_layers * hidden_dim * bytes_per_element
  // Simplified heuristic per billion params:
  //   - ~4B model: ~32 layers, 2560 hidden → ~0.15 MB/1K tokens (f16)
  //   - ~8B model: ~32 layers, 4096 hidden → ~0.25 MB/1K tokens (f16)
  //   - ~14B model: ~40 layers, 5120 hidden → ~0.40 MB/1K tokens (f16)
  //   - ~30B model: ~64 layers, 5120 hidden → ~0.60 MB/1K tokens (f16)
  //   - ~70B+ model: ~80 layers, 8192 hidden → ~1.25 MB/1K tokens (f16)
  let kvBytesPerTokenF16: number;
  if (entry.paramBillions <= 4) kvBytesPerTokenF16 = 160;
  else if (entry.paramBillions <= 8) kvBytesPerTokenF16 = 256;
  else if (entry.paramBillions <= 14) kvBytesPerTokenF16 = 410;
  else if (entry.paramBillions <= 34) kvBytesPerTokenF16 = 620;
  else kvBytesPerTokenF16 = 1280;

  // Apply cache quantization multiplier
  const quantMultiplier = cacheQuant === "f16" ? 1.0 : cacheQuant === "q8_0" ? 0.5 : 0.25;
  const kvBytesPerToken = kvBytesPerTokenF16 * quantMultiplier;

  // KV cache for one full-context slot (in MB)
  const kvPerSlotMB = (entry.contextSize * kvBytesPerToken) / (1024 * 1024);

  // How many full-context slots fit?
  const maxSlots = Math.max(1, Math.floor(freeMB / kvPerSlotMB));

  // Cap at a sensible max (diminishing returns beyond 8 for local inference)
  const parallelSlots = Math.min(maxSlots, 8);
  const contextPerSlot = entry.contextSize;
  const totalContext = parallelSlots * contextPerSlot;

  return { parallelSlots, contextPerSlot, totalContext };
}

/** Get the models directory path */
export const MODELS_DIR_PATH = MODELS_DIR;
