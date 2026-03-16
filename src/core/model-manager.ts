// KCode - Model Manager
// Downloads llama.cpp engine and AI models with automatic hardware-based selection.
// All model codenames use the mnemo:mark5 scheme — real names are NEVER exposed.

import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, existsSync, unlinkSync, renameSync, chmodSync } from "node:fs";
import { log } from "./logger";
import { detectHardware, formatHardware, type HardwareInfo, type GpuInfo } from "./hardware";
import { addModel, setDefaultModel } from "./models";

// ─── Paths & Config ─────────────────────────────────────────────

const KCODE_HOME = join(homedir(), ".kcode");
const ENGINE_DIR = join(KCODE_HOME, "engine");
const MODELS_DIR = join(KCODE_HOME, "models");
const SETUP_MARKER = join(KCODE_HOME, ".setup-complete");

// Models are served from the Astrolexis CDN — already renamed with codenames.
// Users NEVER see real model names. GGUF format works on any GPU (NVIDIA, AMD, Apple, CPU).
const MODEL_CDN = process.env.KCODE_MODEL_CDN ?? "https://kulvex.ai/models/mnemo";

// ─── Model Catalog (INTERNAL — codenames only) ─────────────────
// Real model names and repos are NEVER exposed to the user.

interface CatalogEntry {
  codename: string;        // e.g. "mnemo:mark5-7b"
  paramBillions: number;   // e.g. 7
  quant: string;           // e.g. "Q5_K_M"
  sizeGB: number;          // approximate download size
  minVramMB: number;       // minimum VRAM to run
  contextSize: number;     // context window
  localFile: string;       // filename on CDN and locally (codename-based, no real names)
  description: string;     // user-facing description
  split?: number;          // number of split files (for >50GB models)
  // NOTE: real model identity is NEVER stored. Files are pre-renamed on the CDN.
  // The CDN URL is: ${MODEL_CDN}/${localFile}
}

const MODEL_CATALOG: CatalogEntry[] = [
  {
    codename: "mnemo:mark5-0.5b",
    paramBillions: 0.5,
    quant: "Q8_0",
    sizeGB: 0.5,
    minVramMB: 1024,
    contextSize: 32768,
    localFile: "mark5-0.5b.gguf",
    description: "Ultra-light model for basic tasks",
  },
  {
    codename: "mnemo:mark5-1.5b",
    paramBillions: 1.5,
    quant: "Q8_0",
    sizeGB: 1.6,
    minVramMB: 2048,
    contextSize: 32768,
    localFile: "mark5-1.5b.gguf",
    description: "Light model for simple coding",
  },
  {
    codename: "mnemo:mark5-3b",
    paramBillions: 3,
    quant: "Q6_K",
    sizeGB: 2.5,
    minVramMB: 4096,
    contextSize: 32768,
    localFile: "mark5-3b.gguf",
    description: "Compact model for everyday coding",
  },
  {
    codename: "mnemo:mark5-7b",
    paramBillions: 7,
    quant: "Q5_K_M",
    sizeGB: 5.5,
    minVramMB: 8192,
    contextSize: 32768,
    localFile: "mark5-7b.gguf",
    description: "Balanced model for most coding tasks",
  },
  {
    codename: "mnemo:mark5-14b",
    paramBillions: 14,
    quant: "Q5_K_M",
    sizeGB: 10.5,
    minVramMB: 14336,
    contextSize: 32768,
    localFile: "mark5-14b.gguf",
    description: "Strong model for complex coding",
  },
  {
    codename: "mnemo:mark5-32b",
    paramBillions: 32,
    quant: "Q4_K_M",
    sizeGB: 19,
    minVramMB: 22528,
    contextSize: 32768,
    localFile: "mark5-32b.gguf",
    description: "Elite model for advanced coding",
  },
  {
    codename: "mnemo:mark5-80b",
    paramBillions: 80,
    quant: "Q4_K_M",
    sizeGB: 48.5,
    minVramMB: 53248,
    contextSize: 40960,
    localFile: "mark5-80b.gguf",
    description: "Maximum power — flagship model",
    split: 2,
  },
];

// ─── Public API ─────────────────────────────────────────────────

/** Check if initial setup has been completed */
export function isSetupComplete(): boolean {
  return existsSync(SETUP_MARKER);
}

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
  // Available VRAM — for GPU inference we need VRAM, for CPU we use RAM
  const availableMB = hw.totalVramMB > 0
    ? hw.totalVramMB
    : hw.ramMB * 0.7; // CPU mode: use ~70% of RAM

  // Find the largest model that fits, leaving 2GB headroom for KV cache
  const headroomMB = 2048;
  const usableMB = availableMB - headroomMB;

  let best = MODEL_CATALOG[0]; // smallest as default
  for (const entry of MODEL_CATALOG) {
    if (entry.minVramMB <= usableMB) {
      best = entry;
    }
  }

  return best;
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

/** Get the llama-server binary path */
export function getEnginePath(): string | null {
  const names = process.platform === "win32" ? ["llama-server.exe"] : ["llama-server"];
  for (const name of names) {
    const path = join(ENGINE_DIR, name);
    if (existsSync(path)) return path;
  }
  return null;
}

/** Check if llama.cpp engine is installed */
export function isEngineInstalled(): boolean {
  return getEnginePath() !== null;
}

// ─── Download Engine ────────────────────────────────────────────

/** Download llama.cpp server binary for the current platform */
export async function downloadEngine(hw: HardwareInfo, onProgress?: (msg: string) => void): Promise<string> {
  ensureDir(ENGINE_DIR);
  const progress = onProgress ?? ((msg: string) => process.stderr.write(`\r  ${msg}`));

  progress("Fetching latest llama.cpp release...");

  // Get latest release from GitHub API
  const releaseResp = await fetch("https://api.github.com/repos/ggml-org/llama.cpp/releases/latest", {
    headers: { "User-Agent": "KCode" },
  });

  if (!releaseResp.ok) {
    throw new Error(`Failed to fetch llama.cpp releases: ${releaseResp.status}`);
  }

  const release = await releaseResp.json() as { tag_name: string; assets: { name: string; browser_download_url: string }[] };
  const tag = release.tag_name;
  progress(`Latest release: ${tag}`);

  // Find the right asset for this platform
  const assetName = findEngineAsset(release.assets.map((a) => a.name), hw);
  if (!assetName) {
    throw new Error(`No pre-built llama.cpp binary found for ${hw.platform} ${hw.arch}. Consider building from source.`);
  }

  const asset = release.assets.find((a) => a.name === assetName)!;
  progress(`Downloading ${assetName}...`);

  // Download the archive
  const archivePath = join(ENGINE_DIR, assetName);
  await downloadFile(asset.browser_download_url, archivePath, (pct) => {
    progress(`Downloading engine: ${pct}%`);
  });

  // Extract the archive
  progress("Extracting...");
  await extractArchive(archivePath, ENGINE_DIR);

  // Find llama-server in extracted files
  const serverBin = findBinaryInDir(ENGINE_DIR, "llama-server");
  if (!serverBin) {
    throw new Error("llama-server binary not found in extracted archive");
  }

  // Make executable on Unix
  if (hw.platform !== "win32") {
    chmodSync(serverBin, 0o755);
  }

  // Move all shared libraries (.so, .dylib, .dll) next to the binary
  // so LD_LIBRARY_PATH / DYLD_LIBRARY_PATH can find them
  progress("Installing libraries...");
  const binDir = join(serverBin, "..");
  const libProc = Bun.spawnSync(
    ["find", ENGINE_DIR, "-name", "*.so", "-o", "-name", "*.so.*", "-o", "-name", "*.dylib", "-o", "-name", "*.dll"],
    { stdout: "pipe", stderr: "pipe" },
  );
  for (const libPath of libProc.stdout.toString().trim().split("\n").filter(Boolean)) {
    const libName = libPath.split("/").pop()!;
    const dest = join(binDir, libName);
    if (libPath !== dest && !existsSync(dest)) {
      try { renameSync(libPath, dest); } catch { /* ignore */ }
    }
  }

  // Save version info
  await Bun.write(join(ENGINE_DIR, "version.txt"), `${tag}\n${assetName}\n`);

  // Clean up archive
  try { unlinkSync(archivePath); } catch { /* ignore */ }

  progress(`Engine installed: ${tag}\n`);
  log.info("setup", `llama.cpp engine installed: ${tag} (${assetName})`);

  return serverBin;
}

/** Find the best matching asset for the platform */
function findEngineAsset(assetNames: string[], hw: HardwareInfo): string | null {
  const { platform, arch, cudaAvailable, cudaVersion } = hw;

  // Build priority list of patterns to match
  const patterns: string[] = [];

  if (platform === "linux") {
    if (cudaAvailable) {
      // Prefer CUDA build, try matching CUDA version
      if (cudaVersion) {
        const major = cudaVersion.split(".")[0];
        patterns.push(`ubuntu-${arch}-cuda-cu${cudaVersion}`);
        patterns.push(`ubuntu-${arch}-cuda-cu${major}`);
        patterns.push(`linux-${arch}-cuda-cu${cudaVersion}`);
        patterns.push(`linux-${arch}-cuda-cu${major}`);
      }
      patterns.push(`ubuntu-${arch}-cuda`);
      patterns.push(`linux-${arch}-cuda`);
    }
    // Fallback to CPU/Vulkan
    patterns.push(`ubuntu-${arch}`);
    patterns.push(`linux-${arch}`);
  } else if (platform === "darwin") {
    patterns.push(`macos-${arch}`);
    patterns.push(`darwin-${arch}`);
  } else if (platform === "win32") {
    if (cudaAvailable) {
      if (cudaVersion) {
        const major = cudaVersion.split(".")[0];
        patterns.push(`win-cuda-cu${cudaVersion}-${arch}`);
        patterns.push(`win-cuda-cu${major}`);
      }
      patterns.push(`win-cuda`);
    }
    patterns.push(`win-${arch}`);
  }

  // Match against available assets
  for (const pattern of patterns) {
    const match = assetNames.find((name) =>
      name.includes(pattern) && (name.endsWith(".tar.gz") || name.endsWith(".zip"))
    );
    if (match) return match;
  }

  return null;
}

// ─── Download Model ─────────────────────────────────────────────

/** Download a model by codename */
export async function downloadModel(codename: string, onProgress?: (msg: string) => void): Promise<string> {
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
      const partLocalName = entry.localFile.replace(".gguf", `${partSuffix}.gguf`);
      const partUrl = `${MODEL_CDN}/${partLocalName}`;
      const partPath = join(MODELS_DIR, partLocalName);

      if (!existsSync(partPath)) {
        await downloadFile(partUrl, partPath, (pct) => {
          progress(`${entry.codename} part ${i}/${entry.split}: ${pct}`);
        });
      }
    }
    // The first part IS the model file for llama.cpp split format
    const firstPart = entry.localFile.replace(".gguf", "-00001-of-" + entry.split.toString().padStart(5, "0") + ".gguf");
    progress(`${entry.codename} downloaded\n`);
    return join(MODELS_DIR, firstPart);
  }

  // Single file download from Kulvex CDN
  const url = `${MODEL_CDN}/${entry.localFile}`;
  progress(`Downloading ${entry.codename} (${entry.sizeGB} GB)...`);

  await downloadFile(url, localPath, (pct) => {
    progress(`${entry.codename}: ${pct}`);
  });

  progress(`${entry.codename} downloaded\n`);
  log.info("setup", `Model downloaded: ${entry.codename} (${entry.sizeGB} GB)`);

  return localPath;
}

// ─── Full Setup Flow ────────────────────────────────────────────

/** Run the full auto-setup: detect hardware, download engine, download best model */
export async function runSetup(options?: { model?: string; force?: boolean }): Promise<{ model: string; enginePath: string; modelPath: string }> {
  const C = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    cyan: "\x1b[36m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    magenta: "\x1b[35m",
  };

  console.log(`\n${C.bold}${C.cyan}KCode Setup${C.reset}\n`);

  // Step 1: Detect hardware
  console.log(`${C.bold}1. Detecting hardware...${C.reset}`);
  const hw = await detectHardware();
  console.log(formatHardware(hw).split("\n").map((l) => `   ${l}`).join("\n"));
  console.log();

  // Step 2: Select model
  const recommended = recommendModel(hw);
  const targetCodename = options?.model ?? recommended.codename;
  const entry = findCatalogEntry(targetCodename) ?? recommended;

  console.log(`${C.bold}2. Model selection${C.reset}`);
  console.log(`   Recommended: ${C.green}${recommended.codename}${C.reset} (${recommended.paramBillions}B, ${recommended.sizeGB} GB)`);
  if (targetCodename !== recommended.codename) {
    console.log(`   Selected:    ${C.yellow}${entry.codename}${C.reset} (${entry.paramBillions}B, ${entry.sizeGB} GB)`);
  }
  console.log(`   ${C.dim}${entry.description}${C.reset}`);
  console.log();

  // Step 3: Download engine
  console.log(`${C.bold}3. Installing inference engine...${C.reset}`);
  let enginePath = getEnginePath();
  if (enginePath && !options?.force) {
    console.log(`   Engine already installed\n`);
  } else {
    enginePath = await downloadEngine(hw, (msg) => {
      process.stderr.write(`\r   ${msg}`.padEnd(80));
    });
    console.log();
  }

  // Step 4: Download model
  console.log(`${C.bold}4. Downloading model...${C.reset}`);
  let modelPath: string;
  if (isModelDownloaded(entry.codename) && !options?.force) {
    console.log(`   ${entry.codename} already downloaded\n`);
    modelPath = getModelPath(entry.codename)!;
  } else {
    modelPath = await downloadModel(entry.codename, (msg) => {
      process.stderr.write(`\r   ${msg}`.padEnd(80));
    });
    console.log();
  }

  // Step 5: Register model in models.json
  console.log(`${C.bold}5. Configuring KCode...${C.reset}`);

  // Default port for local llama-server
  const port = 10091;

  await addModel({
    name: entry.codename,
    baseUrl: `http://localhost:${port}`,
    contextSize: entry.contextSize,
    gpu: hw.gpus.map((g) => g.name).join(" + ") || "CPU",
    capabilities: ["code"],
    description: entry.description,
  });

  await setDefaultModel(entry.codename);

  // Save server config for llama-server.ts
  await Bun.write(
    join(KCODE_HOME, "server.json"),
    JSON.stringify({
      enginePath,
      modelPath,
      codename: entry.codename,
      port,
      contextSize: entry.contextSize,
      gpuLayers: -1, // offload all layers
      gpus: hw.gpus,
    }, null, 2) + "\n",
  );

  // Mark setup as complete
  await Bun.write(SETUP_MARKER, `${new Date().toISOString()}\n${entry.codename}\n`);

  console.log(`   Default model: ${C.green}${entry.codename}${C.reset}`);
  console.log(`   Server port: ${port}`);
  console.log(`\n${C.bold}${C.green}Setup complete!${C.reset} Run ${C.cyan}kcode${C.reset} to start.\n`);

  // Show all available models
  console.log(`${C.dim}Available models (use 'kcode setup --model <name>' to switch):${C.reset}`);
  for (const m of MODEL_CATALOG) {
    const fit = m.minVramMB <= (hw.totalVramMB || hw.ramMB * 0.7) ? C.green + "✓" : C.yellow + "⚠";
    const current = m.codename === entry.codename ? ` ${C.cyan}← installed${C.reset}` : "";
    console.log(`  ${fit} ${m.codename}${C.reset} (${m.paramBillions}B, ~${m.sizeGB} GB) — ${m.description}${current}`);
  }
  console.log();

  return { model: entry.codename, enginePath, modelPath };
}

// ─── Helpers ────────────────────────────────────────────────────

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Download a file with progress tracking */
async function downloadFile(url: string, destPath: string, onProgress: (pct: string) => void): Promise<void> {
  const response = await fetch(url, {
    headers: { "User-Agent": "KCode" },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText} — ${url}`);
  }

  const contentLength = parseInt(response.headers.get("content-length") ?? "0", 10);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");

  const file = Bun.file(destPath);
  const writer = file.writer();
  let downloaded = 0;
  let lastReport = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    writer.write(value);
    downloaded += value.length;

    // Report progress every 1%
    if (contentLength > 0) {
      const pct = Math.round((downloaded / contentLength) * 100);
      if (pct > lastReport) {
        lastReport = pct;
        const useMB = contentLength < 1024 * 1024 * 1024; // < 1 GB
        if (useMB) {
          const dlMB = (downloaded / (1024 * 1024)).toFixed(0);
          const totalMB = (contentLength / (1024 * 1024)).toFixed(0);
          onProgress(`${pct}% (${dlMB}/${totalMB} MB)`);
        } else {
          const dlGB = (downloaded / (1024 * 1024 * 1024)).toFixed(1);
          const totalGB = (contentLength / (1024 * 1024 * 1024)).toFixed(1);
          onProgress(`${pct}% (${dlGB}/${totalGB} GB)`);
        }
      }
    } else {
      const downloadedMB = (downloaded / (1024 * 1024)).toFixed(0);
      onProgress(`${downloadedMB} MB`);
    }
  }

  await writer.end();
}

/** Extract a .tar.gz or .zip archive */
async function extractArchive(archivePath: string, destDir: string): Promise<void> {
  if (archivePath.endsWith(".tar.gz") || archivePath.endsWith(".tgz")) {
    const proc = Bun.spawnSync(["tar", "-xzf", archivePath, "-C", destDir], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) {
      throw new Error(`Failed to extract tar.gz: ${proc.stderr.toString()}`);
    }
  } else if (archivePath.endsWith(".zip")) {
    const proc = Bun.spawnSync(["unzip", "-o", archivePath, "-d", destDir], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) {
      throw new Error(`Failed to extract zip: ${proc.stderr.toString()}`);
    }
  } else {
    throw new Error(`Unknown archive format: ${archivePath}`);
  }
}

/** Find a binary in a directory (recursively) */
function findBinaryInDir(dir: string, name: string): string | null {
  const isWin = process.platform === "win32";
  const target = isWin ? `${name}.exe` : name;

  // Try direct path first
  const directPath = join(dir, target);
  if (existsSync(directPath)) return directPath;

  // Search subdirectories (extracted archives often have a subfolder)
  try {
    const proc = Bun.spawnSync(["find", dir, "-name", target, "-type", "f"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const found = proc.stdout.toString().trim().split("\n")[0];
    if (found && existsSync(found)) {
      // Move to engine root for simplicity
      const finalPath = join(dir, target);
      if (found !== finalPath) {
        renameSync(found, finalPath);
      }
      return finalPath;
    }
  } catch { /* ignore */ }

  return null;
}

/** Get server config (saved during setup) */
export async function getServerConfig(): Promise<{
  enginePath: string;
  modelPath: string;
  codename: string;
  port: number;
  contextSize: number;
  gpuLayers: number;
  gpus: GpuInfo[];
} | null> {
  const configPath = join(KCODE_HOME, "server.json");
  try {
    const file = Bun.file(configPath);
    if (await file.exists()) {
      return await file.json();
    }
  } catch { /* ignore */ }
  return null;
}
