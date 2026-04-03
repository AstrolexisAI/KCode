// KCode - Model Manager
// Downloads llama.cpp engine and AI models with automatic hardware-based selection.
// Orchestrates setup wizard, engine installation, and model downloads.
//
// Model catalog (definitions, recommendations, queries) lives in ./model-catalog.ts.
// Hardware detection lives in ./hardware.ts.
//
// Implementation split across focused modules:
//   model-file-utils.ts — file download, extraction, binary discovery, PATH install
//   model-mlx.ts        — MLX engine install & model download (macOS Apple Silicon)
//   model-engine.ts     — llama.cpp engine download
//   setup-wizard.ts     — interactive setup wizard

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { GpuInfo } from "./hardware";
import { log } from "./logger";
import { findCatalogEntry, MODEL_CDN, MODELS_DIR_PATH } from "./model-catalog";
import { kcodeHome, kcodePath } from "./paths";

// ─── Re-exports from model-catalog (backward compatibility) ────
export type { CatalogEntry } from "./model-catalog";
export {
  findCatalogEntry,
  getAvailableModels,
  getModelPath,
  isModelDownloaded,
  recommendModel,
} from "./model-catalog";
export { downloadEngine } from "./model-engine";
// ─── Re-exports from sub-modules (backward compatibility) ──────
export {
  createLibSymlinks,
  downloadFile,
  ensureDir,
  ensureInPath,
  extractArchive,
  findBinaryInDir,
  findLibraryFiles,
  installToPath,
} from "./model-file-utils";
export { downloadMlxModel, installMlxEngine } from "./model-mlx";
export { runSetup } from "./setup-wizard";

// ─── Re-export from model-file-utils used by downloadModel ─────
import { downloadFile, ensureDir } from "./model-file-utils";

// ─── Paths & Config ─────────────────────────────────────────────

const KCODE_HOME = kcodeHome();
const MODELS_DIR = MODELS_DIR_PATH;
const SETUP_MARKER = kcodePath(".setup-complete");

// MLX venv lives inside ~/.kcode/mlx-venv (isolated, no system pollution)
const MLX_VENV = kcodePath("mlx-venv");
const MLX_MARKER = kcodePath(".mlx-engine");
const ENGINE_DIR = kcodePath("engine");

// ─── Public API ─────────────────────────────────────────────────

/** Check if initial setup has been completed */
export function isSetupComplete(): boolean {
  return existsSync(SETUP_MARKER);
}

/** Check if we should use MLX on this platform (macOS Apple Silicon) */
export function shouldUseMlx(): boolean {
  return process.platform === "darwin" && process.arch === "arm64";
}

/** Check if MLX engine is installed */
export function isMlxInstalled(): boolean {
  return existsSync(MLX_MARKER);
}

/** Get the mlx_lm.server command path (inside the venv) */
export function getMlxServerPath(): string | null {
  // Check if the venv python and mlx-lm are installed
  const python = join(MLX_VENV, "bin", "python3");
  if (existsSync(python) && existsSync(MLX_MARKER)) return python;
  return null;
}

/** Get the llama-server binary path */
export function getEnginePath(): string | null {
  // On macOS ARM64, prefer MLX
  if (shouldUseMlx() && isMlxInstalled()) {
    return getMlxServerPath();
  }

  const names = process.platform === "win32" ? ["llama-server.exe"] : ["llama-server"];
  for (const name of names) {
    const path = join(ENGINE_DIR, name);
    if (existsSync(path)) return path;
  }
  return null;
}

/** Check if inference engine is installed */
export function isEngineInstalled(): boolean {
  if (shouldUseMlx()) return isMlxInstalled();
  return getEnginePath() !== null;
}

/** Get the MLX model repo for a catalog entry (INTERNAL) */
export function getMlxRepo(codename: string): string | null {
  const entry = findCatalogEntry(codename);
  return entry?.mlxRepo ?? null;
}

// ─── Download Model ─────────────────────────────────────────────

/** Download a model by codename */
export async function downloadModel(
  codename: string,
  onProgress?: (msg: string) => void,
): Promise<string> {
  const entry = findCatalogEntry(codename);
  if (!entry) throw new Error(`Unknown model: ${codename}`);

  ensureDir(MODELS_DIR);
  const progress = onProgress ?? ((msg: string) => process.stderr.write(`\r  ${msg}`));

  const localPath = join(MODELS_DIR, entry.localFile);

  if (existsSync(localPath)) {
    progress(`${entry.codename} already downloaded\n`);
    return localPath;
  }

  // Handle split files (models > 50GB that are split into parts)
  if (entry.split && entry.split > 1) {
    progress(`Downloading ${entry.codename} (${entry.sizeGB} GB, ${entry.split} parts)...`);
    for (let i = 1; i <= entry.split; i++) {
      const partSuffix = `-${i.toString().padStart(5, "0")}-of-${entry.split.toString().padStart(5, "0")}`;
      // localFile may or may not have .gguf — normalize
      const baseName = entry.localFile.replace(/\.gguf$/, "");
      const partLocalName = `${baseName}${partSuffix}.gguf`;
      // Use cdnUrl as base pattern if set (HuggingFace), otherwise Kulvex CDN
      const partUrl = entry.cdnUrl
        ? `${entry.cdnUrl}${partSuffix}.gguf`
        : `${MODEL_CDN}/${partLocalName}`;
      const partPath = join(MODELS_DIR, partLocalName);

      if (!existsSync(partPath)) {
        await downloadFile(partUrl, partPath, (pct) => {
          progress(`${entry.codename} part ${i}/${entry.split}: ${pct}`);
        });
      }
    }
    // The first part IS the model file for llama.cpp split format
    const baseName = entry.localFile.replace(/\.gguf$/, "");
    const firstPart = `${baseName}-00001-of-${entry.split.toString().padStart(5, "0")}.gguf`;
    progress(`${entry.codename} downloaded\n`);
    return join(MODELS_DIR, firstPart);
  }

  // Single file download — use cdnUrl override if set, otherwise Kulvex CDN
  const url = entry.cdnUrl ?? `${MODEL_CDN}/${entry.localFile}`;
  progress(`Downloading ${entry.codename} (${entry.sizeGB} GB)...`);

  await downloadFile(url, localPath, (pct) => {
    progress(`${entry.codename}: ${pct}`);
  });

  progress(`${entry.codename} downloaded\n`);
  log.info("setup", `Model downloaded: ${entry.codename} (${entry.sizeGB} GB)`);

  return localPath;
}

// ─── Server Config ──────────────────────────────────────────────

/** Get server config (saved during setup) */
export async function getServerConfig(): Promise<{
  enginePath: string;
  modelPath: string;
  codename: string;
  port: number;
  contextSize: number;
  contextPerSlot?: number;
  parallelSlots?: number;
  gpuLayers: number;
  gpus: GpuInfo[];
  engine?: "mlx" | "llama.cpp";
  mlxRepo?: string;
  mlxWiredLimitMB?: number;
} | null> {
  const configPath = join(KCODE_HOME, "server.json");
  try {
    const file = Bun.file(configPath);
    if (await file.exists()) {
      return await file.json();
    }
  } catch (err) {
    log.debug("model-manager", `FS operation failed: ${err}`);
  }
  return null;
}
