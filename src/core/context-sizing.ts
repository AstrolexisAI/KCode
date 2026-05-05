// KCode - Auto-size the model context based on available memory
//
// On macOS Apple Silicon (unified memory), running a model at its full
// max_position_embeddings can OOM because the KV cache scales linearly
// with context length. We size context down to what actually fits the
// hardware after accounting for model weights, OS reserve, and a safety
// headroom — and pick the largest "round" ceiling (32k / 64k / 128k /
// 256k) that fits.
//
// Without this, server.json carries whatever default the wizard wrote
// (typically 32k), or worse — the user manually sets max_position
// (~262k for Qwen3.6) and the server crashes 30 seconds into the first
// long-context request.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * KV cache shape extracted from a HuggingFace config.json. Only the
 * fields that drive the per-token KV size — head dim, KV-head count,
 * layer count. Models that omit a field (e.g. `head_dim` derived from
 * hidden_size / num_attention_heads) get filled with sensible defaults.
 */
interface ModelKvShape {
  numLayers: number;
  numKvHeads: number;
  headDim: number;
  /** Self-reported max — used as the upper bound; we never exceed it. */
  maxPositionEmbeddings: number;
}

/** Read a HuggingFace `config.json` from the local snapshot cache. */
export function readModelConfig(repo: string): ModelKvShape | null {
  // Resolve via ~/.cache/huggingface/hub/models--<owner>--<name>/snapshots/<rev>/config.json
  // Walk the snapshots dir; pick the first revision (there is normally one).
  const home = process.env.HOME ?? "";
  if (!home) return null;
  const cacheRoot = join(home, ".cache", "huggingface", "hub");
  const slug = `models--${repo.replace("/", "--")}`;
  const modelDir = join(cacheRoot, slug, "snapshots");
  if (!existsSync(modelDir)) return null;

  let snapshot: string | null = null;
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const entries = fs.readdirSync(modelDir);
    for (const entry of entries) {
      const full = join(modelDir, entry);
      try {
        if (statSync(full).isDirectory()) {
          snapshot = full;
          break;
        }
      } catch {
        /* skip unreadable entry */
      }
    }
  } catch {
    return null;
  }
  if (!snapshot) return null;

  const configPath = join(snapshot, "config.json");
  if (!existsSync(configPath)) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }

  const numLayers = Number(raw.num_hidden_layers ?? raw.n_layer ?? 0);
  const numKvHeads = Number(raw.num_key_value_heads ?? raw.num_attention_heads ?? 0);
  const numAttHeads = Number(raw.num_attention_heads ?? 0);
  const hidden = Number(raw.hidden_size ?? 0);
  const declaredHeadDim = Number(raw.head_dim ?? 0);
  const headDim =
    declaredHeadDim > 0
      ? declaredHeadDim
      : numAttHeads > 0
        ? Math.floor(hidden / numAttHeads)
        : 128;
  const maxPositionEmbeddings = Number(
    raw.max_position_embeddings ?? raw.max_sequence_length ?? 32768,
  );

  if (!numLayers || !numKvHeads || !headDim) return null;
  return { numLayers, numKvHeads, headDim, maxPositionEmbeddings };
}

/** Bytes per stored KV value. fp16 default; q4 KV (when supported) ≈ 0.5. */
const KV_BYTES_PER_VALUE_FP16 = 2;

/** Round-down ceilings we pick from. Matches what the field commonly tests at. */
const CTX_CEILINGS = [32_768, 65_536, 131_072, 262_144];

interface ComputeOptions {
  /** Total system memory in bytes. */
  totalMemoryBytes: number;
  /** On-disk size of the model in bytes (estimated from cache size if not provided). */
  modelSizeBytes: number;
  /** Reserved for OS + apps + kcode itself. Default 12 GB on Mac. */
  reservedBytes?: number;
  /** Safety headroom for transient allocations (Metal command buffers etc). Default 3 GB. */
  headroomBytes?: number;
  /** Bytes per stored KV value. Default fp16 = 2. */
  kvBytesPerValue?: number;
}

/**
 * Compute the largest "round" context ceiling that fits the available
 * unified memory budget after subtracting model weights, OS reserve,
 * and headroom. Always clamped to the model's declared max_position.
 */
export function computeMaxSafeContext(shape: ModelKvShape, opts: ComputeOptions): number {
  const reserved = opts.reservedBytes ?? 12 * 1024 ** 3;
  const headroom = opts.headroomBytes ?? 3 * 1024 ** 3;
  const kvBytesPerValue = opts.kvBytesPerValue ?? KV_BYTES_PER_VALUE_FP16;

  const budgetForKv = opts.totalMemoryBytes - opts.modelSizeBytes - reserved - headroom;
  if (budgetForKv <= 0) return CTX_CEILINGS[0]!; // fallback to smallest; user will likely OOM but at least we picked something

  const perTokenBytes = 2 * shape.numLayers * shape.numKvHeads * shape.headDim * kvBytesPerValue;
  if (perTokenBytes <= 0) return CTX_CEILINGS[0]!;

  const maxTokensThatFit = Math.floor(budgetForKv / perTokenBytes);
  // Cap to model's own max_position_embeddings — never advertise beyond
  // what the model actually supports.
  const cap = Math.min(maxTokensThatFit, shape.maxPositionEmbeddings);

  // Pick the largest ceiling we can fit, never above the cap.
  let chosen = CTX_CEILINGS[0]!;
  for (const c of CTX_CEILINGS) {
    if (c <= cap) chosen = c;
    else break;
  }
  return chosen;
}

/**
 * Best-effort estimate of the on-disk size of a HuggingFace cached
 * model — sums the size of every blob in `~/.cache/huggingface/hub/...`.
 * Used as the model_weights term in the budget calculation.
 */
export function estimateModelSizeBytes(repo: string): number {
  const home = process.env.HOME ?? "";
  if (!home) return 0;
  const blobsDir = join(
    home,
    ".cache",
    "huggingface",
    "hub",
    `models--${repo.replace("/", "--")}`,
    "blobs",
  );
  if (!existsSync(blobsDir)) return 0;
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const entries = fs.readdirSync(blobsDir);
    let total = 0;
    for (const entry of entries) {
      try {
        total += statSync(join(blobsDir, entry)).size;
      } catch {
        /* skip unreadable */
      }
    }
    return total;
  } catch {
    return 0;
  }
}

/**
 * Convenience: do all the work in one call given just the repo name.
 * Returns null if config or cache is missing.
 */
export function autoSizeContext(
  repo: string,
  totalMemoryBytes: number,
): { contextSize: number; shape: ModelKvShape; modelSizeBytes: number } | null {
  const shape = readModelConfig(repo);
  if (!shape) return null;
  const modelSizeBytes = estimateModelSizeBytes(repo);
  if (modelSizeBytes === 0) return null;
  const contextSize = computeMaxSafeContext(shape, {
    totalMemoryBytes,
    modelSizeBytes,
  });
  return { contextSize, shape, modelSizeBytes };
}
