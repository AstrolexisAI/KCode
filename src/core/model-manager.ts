// KCode - Model Manager
// Downloads llama.cpp engine and AI models with automatic hardware-based selection.
// All model codenames use the mnemo:mark5 scheme — real names are NEVER exposed.

import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, existsSync, unlinkSync, renameSync, chmodSync, copyFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { log } from "./logger";
import { detectHardware, formatHardware, type HardwareInfo, type GpuInfo } from "./hardware";
import { addModel, setDefaultModel } from "./models";
import { activateLicense, hasLicense } from "./license";

// ─── Paths & Config ─────────────────────────────────────────────

const KCODE_HOME = join(homedir(), ".kcode");
const ENGINE_DIR = join(KCODE_HOME, "engine");
const MODELS_DIR = join(KCODE_HOME, "models");
const SETUP_MARKER = join(KCODE_HOME, ".setup-complete");

// Models are served from the Astrolexis CDN — already renamed with codenames.
// Users NEVER see real model names. GGUF format works on any GPU (NVIDIA, AMD, Apple, CPU).
const MODEL_CDN = process.env.KCODE_MODEL_CDN ?? "https://kulvex.ai/models/mnemo";

// MLX venv lives inside ~/.kcode/mlx-venv (isolated, no system pollution)
const MLX_VENV = join(KCODE_HOME, "mlx-venv");
const MLX_MARKER = join(KCODE_HOME, ".mlx-engine");

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
  mlxRepo?: string;        // MLX HuggingFace repo for macOS (INTERNAL — never shown to user)
  mlxQuant?: string;       // MLX quantization (4bit, 8bit)
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
    mlxRepo: "mlx-community/Qwen2.5-Coder-0.5B-Instruct-8bit",
    mlxQuant: "8bit",
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
    mlxRepo: "mlx-community/Qwen2.5-Coder-1.5B-Instruct-8bit",
    mlxQuant: "8bit",
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
    mlxRepo: "mlx-community/Qwen2.5-Coder-3B-Instruct-8bit",
    mlxQuant: "8bit",
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
    mlxRepo: "mlx-community/Qwen2.5-Coder-7B-Instruct-4bit",
    mlxQuant: "4bit",
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
    mlxRepo: "mlx-community/Qwen2.5-Coder-14B-Instruct-4bit",
    mlxQuant: "4bit",
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
    mlxRepo: "mlx-community/Qwen2.5-Coder-32B-Instruct-4bit",
    mlxQuant: "4bit",
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
    // No MLX version — 80b is too large for most Macs
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
  const mlxServer = join(MLX_VENV, "bin", "mlx_lm.server");
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

// ─── MLX Engine (macOS Apple Silicon) ───────────────────────────

/** Find Python 3 on macOS */
function findPython3(): string | null {
  for (const name of ["python3", "/usr/bin/python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3"]) {
    const proc = Bun.spawnSync([name, "--version"], { stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode === 0) return name;
  }
  return null;
}

/** Install MLX engine (creates venv, installs mlx-lm) */
export async function installMlxEngine(onProgress?: (msg: string) => void): Promise<string> {
  const progress = onProgress ?? ((msg: string) => process.stderr.write(`\r  ${msg}`));

  const python = findPython3();
  if (!python) {
    throw new Error("Python 3 not found. Install Python 3 from python.org or via Homebrew: brew install python3");
  }

  // Check Python version >= 3.9
  const verProc = Bun.spawnSync([python, "-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"], {
    stdout: "pipe", stderr: "pipe",
  });
  const pyVer = verProc.stdout.toString().trim();
  const [major, minor] = pyVer.split(".").map(Number);
  if (major < 3 || (major === 3 && minor < 9)) {
    throw new Error(`Python ${pyVer} is too old. MLX requires Python 3.9+.`);
  }

  progress(`Creating Python venv (${pyVer})...`);

  // Create venv
  const venvProc = Bun.spawnSync([python, "-m", "venv", MLX_VENV], {
    stdout: "pipe", stderr: "pipe",
  });
  if (venvProc.exitCode !== 0) {
    throw new Error(`Failed to create venv: ${venvProc.stderr.toString()}`);
  }

  const pip = join(MLX_VENV, "bin", "pip");
  const venvPython = join(MLX_VENV, "bin", "python3");

  // Upgrade pip
  progress("Upgrading pip...");
  Bun.spawnSync([venvPython, "-m", "pip", "install", "--upgrade", "pip"], {
    stdout: "pipe", stderr: "pipe",
  });

  // Install mlx-lm
  progress("Installing mlx-lm (this may take a minute)...");
  const installProc = Bun.spawnSync([pip, "install", "mlx-lm"], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 300_000, // 5 min timeout
  });

  if (installProc.exitCode !== 0) {
    const err = installProc.stderr.toString().slice(-500);
    throw new Error(`Failed to install mlx-lm: ${err}`);
  }

  // Verify installation
  progress("Verifying mlx-lm...");
  const verifyProc = Bun.spawnSync([venvPython, "-c", "import mlx_lm; print(mlx_lm.__version__)"], {
    stdout: "pipe", stderr: "pipe",
  });

  if (verifyProc.exitCode !== 0) {
    throw new Error("mlx-lm installation verification failed");
  }

  const mlxVersion = verifyProc.stdout.toString().trim();

  // Mark as installed
  await Bun.write(MLX_MARKER, `mlx-lm ${mlxVersion}\npython ${pyVer}\n${new Date().toISOString()}\n`);

  progress(`MLX engine installed (mlx-lm ${mlxVersion})\n`);
  log.info("setup", `MLX engine installed: mlx-lm ${mlxVersion}, Python ${pyVer}`);

  return venvPython;
}

/** Pre-download an MLX model so first inference is fast */
export async function downloadMlxModel(entry: CatalogEntry, onProgress?: (msg: string) => void): Promise<string> {
  if (!entry.mlxRepo) throw new Error(`No MLX model available for ${entry.codename}`);

  const progress = onProgress ?? ((msg: string) => process.stderr.write(`\r  ${msg}`));
  const venvPython = join(MLX_VENV, "bin", "python3");

  progress(`Downloading ${entry.codename} (MLX ${entry.mlxQuant})...`);

  // Use mlx_lm.load to trigger HuggingFace download and cache
  const proc = Bun.spawnSync([
    venvPython, "-c",
    `from mlx_lm import load; model, tokenizer = load("${entry.mlxRepo}"); print("OK")`,
  ], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 600_000, // 10 min for large models
  });

  if (proc.exitCode !== 0) {
    const err = proc.stderr.toString().slice(-500);
    throw new Error(`Failed to download MLX model: ${err}`);
  }

  progress(`${entry.codename} downloaded (MLX)\n`);
  log.info("setup", `MLX model downloaded: ${entry.codename} (${entry.mlxRepo})`);

  // Return the HuggingFace repo path (mlx_lm.server uses repo names, not file paths)
  return entry.mlxRepo;
}

// ─── Download Engine (llama.cpp) ────────────────────────────────

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
  // so LD_LIBRARY_PATH / DYLD_LIBRARY_PATH / PATH can find them
  progress("Installing libraries...");
  const binDir = join(serverBin, "..");
  const sep = process.platform === "win32" ? "\\" : "/";
  for (const libPath of findLibraryFiles(ENGINE_DIR)) {
    const libName = libPath.split(sep).pop() ?? libPath.split("/").pop()!;
    const dest = join(binDir, libName);
    if (libPath !== dest && !existsSync(dest)) {
      try { renameSync(libPath, dest); } catch { /* ignore */ }
    }
  }

  // Create symlinks for versioned .so files (e.g. libmtmd.so.0.0.8368 → libmtmd.so.0)
  if (hw.platform !== "win32") {
    createLibSymlinks(binDir);
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
      // Prefer CUDA build first, then Vulkan (which also uses GPU), then CPU
      if (cudaVersion) {
        const major = cudaVersion.split(".")[0];
        patterns.push(`ubuntu-${arch}-cuda-cu${cudaVersion}`);
        patterns.push(`ubuntu-${arch}-cuda-cu${major}`);
        patterns.push(`linux-${arch}-cuda-cu${cudaVersion}`);
        patterns.push(`linux-${arch}-cuda-cu${major}`);
      }
      patterns.push(`ubuntu-${arch}-cuda`);
      patterns.push(`linux-${arch}-cuda`);
      // Vulkan works with NVIDIA GPUs and is often the only GPU build for Linux
      patterns.push(`ubuntu-vulkan-${arch}`);
      patterns.push(`ubuntu-${arch}-vulkan`);
      patterns.push(`linux-vulkan-${arch}`);
    }
    // Fallback to CPU
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

/** Run the full auto-setup wizard: detect hardware, download engine, download best model */
export async function runSetup(options?: { model?: string; force?: boolean }): Promise<{ model: string; enginePath: string; modelPath: string }> {
  const C = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    italic: "\x1b[3m",
    underline: "\x1b[4m",
    cyan: "\x1b[36m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    magenta: "\x1b[35m",
    blue: "\x1b[34m",
    red: "\x1b[31m",
    white: "\x1b[97m",
    bgCyan: "\x1b[46m",
    bgBlue: "\x1b[44m",
    bgGreen: "\x1b[42m",
    bgMagenta: "\x1b[45m",
  };

  // Clear screen for the wizard
  process.stdout.write("\x1b[2J\x1b[H");

  // ── Banner ──────────────────────────────────────────────────────
  const banner = [
    "",
    `${C.bold}${C.cyan}    ██╗  ██╗ ██████╗ ██████╗ ██████╗ ███████╗`,
    `    ██║ ██╔╝██╔════╝██╔═══██╗██╔══██╗██╔════╝`,
    `    █████╔╝ ██║     ██║   ██║██║  ██║█████╗  `,
    `    ██╔═██╗ ██║     ██║   ██║██║  ██║██╔══╝  `,
    `    ██║  ██╗╚██████╗╚██████╔╝██████╔╝███████╗`,
    `    ╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝${C.reset}`,
    "",
    `    ${C.dim}Kulvex Code — AI Coding Assistant by Astrolexis${C.reset}`,
    `    ${C.dim}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}`,
    "",
  ];
  console.log(banner.join("\n"));

  // ── Spinner helper ──────────────────────────────────────────────
  const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  // Strip ANSI codes to get real visible length for padding
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  function createSpinner(label: string) {
    let frame = 0;
    let suffix = "";
    let stopped = false;
    const interval = setInterval(() => {
      if (stopped) return;
      const spinner = `${C.cyan}${spinnerFrames[frame % spinnerFrames.length]}${C.reset}`;
      const line = `    ${spinner} ${label}${suffix}`;
      const pad = Math.max(0, 90 - stripAnsi(line).length);
      process.stderr.write(`\r${line}${" ".repeat(pad)}\r`);
      frame++;
    }, 80);
    return {
      update(msg: string) { suffix = ` ${C.dim}${msg.replace(/\n/g, "")}${C.reset}`; },
      stop() { stopped = true; clearInterval(interval); },
      succeed(msg: string) {
        stopped = true;
        clearInterval(interval);
        const line = `    ${C.green}✓${C.reset} ${msg}`;
        const pad = Math.max(0, 90 - stripAnsi(line).length);
        process.stderr.write(`\r${line}${" ".repeat(pad)}\n`);
      },
      fail(msg: string) {
        stopped = true;
        clearInterval(interval);
        const line = `    ${C.red}✗${C.reset} ${msg}`;
        const pad = Math.max(0, 90 - stripAnsi(line).length);
        process.stderr.write(`\r${line}${" ".repeat(pad)}\n`);
      },
    };
  }

  // ── Progress bar helper ─────────────────────────────────────────
  function renderProgressBar(pct: number, width: number = 30): string {
    const filled = Math.round(pct / 100 * width);
    const empty = width - filled;
    const bar = `${C.cyan}${"█".repeat(filled)}${C.dim}${"░".repeat(empty)}${C.reset}`;
    return `${bar} ${pct}%`;
  }

  // ── Step header ─────────────────────────────────────────────────
  function stepHeader(num: number, title: string) {
    console.log(`  ${C.bold}${C.bgCyan}${C.white} ${num} ${C.reset} ${C.bold}${title}${C.reset}`);
  }

  // ═══════════════════════════════════════════════════════════════
  //  Step 1: Hardware Detection
  // ═══════════════════════════════════════════════════════════════

  stepHeader(1, "Scanning your hardware");
  console.log();

  const hwSpinner = createSpinner("Detecting GPUs, VRAM, and platform...");
  const hw = await detectHardware();
  hwSpinner.succeed("Hardware detected");

  // Display hardware info in a nice box (dynamic width)
  const hwLines = formatHardware(hw).split("\n");
  const maxLen = Math.max(...hwLines.map((l) => l.length));
  const boxWidth = maxLen + 4; // 2 padding each side
  console.log();
  console.log(`    ${C.dim}┌${"─".repeat(boxWidth)}┐${C.reset}`);
  for (const line of hwLines) {
    console.log(`    ${C.dim}│${C.reset}  ${line.padEnd(maxLen + 2)}${C.dim}│${C.reset}`);
  }
  console.log(`    ${C.dim}└${"─".repeat(boxWidth)}┘${C.reset}`);
  console.log();

  // ═══════════════════════════════════════════════════════════════
  //  Step 2: Model Selection
  // ═══════════════════════════════════════════════════════════════

  stepHeader(2, "Selecting the best model for your system");
  console.log();

  const recommended = recommendModel(hw);
  const targetCodename = options?.model ?? recommended.codename;
  const entry = findCatalogEntry(targetCodename) ?? recommended;

  // Show model catalog as a visual table
  const availableVram = hw.totalVramMB > 0 ? hw.totalVramMB : hw.ramMB * 0.7;
  console.log(`    ${C.dim}Model                Size      VRAM     Status${C.reset}`);
  console.log(`    ${C.dim}${"─".repeat(52)}${C.reset}`);

  for (const m of MODEL_CATALOG) {
    const fits = m.minVramMB <= availableVram;
    const isSelected = m.codename === entry.codename;
    const icon = isSelected ? `${C.green}▸` : fits ? `${C.dim} ` : `${C.red} `;
    const nameColor = isSelected ? C.bold + C.green : fits ? C.white : C.dim;
    const sizeStr = `${m.sizeGB} GB`.padStart(8);
    const vramStr = `${(m.minVramMB / 1024).toFixed(0)} GB`.padStart(6);
    const statusStr = isSelected
      ? `${C.green}${C.bold}← SELECTED${C.reset}`
      : fits
      ? `${C.green}compatible${C.reset}`
      : `${C.red}too large${C.reset}`;

    console.log(`    ${icon} ${nameColor}${m.codename.padEnd(20)}${C.reset}${sizeStr}  ${vramStr}    ${statusStr}`);
  }

  console.log();
  console.log(`    ${C.bold}Selected:${C.reset} ${C.green}${C.bold}${entry.codename}${C.reset} ${C.dim}— ${entry.description}${C.reset}`);
  if (targetCodename !== recommended.codename) {
    console.log(`    ${C.yellow}Note: Using manually selected model instead of recommended ${recommended.codename}${C.reset}`);
  }
  console.log();

  // ═══════════════════════════════════════════════════════════════
  //  Step 3: Engine Installation
  // ═══════════════════════════════════════════════════════════════

  const useMlx = shouldUseMlx() && entry.mlxRepo;
  const engineLabel = useMlx ? "MLX (Apple Silicon optimized)" : "llama.cpp";

  stepHeader(3, `Installing inference engine (${engineLabel})`);
  console.log();

  if (useMlx) {
    console.log(`    ${C.magenta}Apple Silicon detected — using MLX for 2x faster inference${C.reset}`);
    console.log();
  }

  let enginePath = getEnginePath();
  if (enginePath && !options?.force) {
    console.log(`    ${C.green}✓${C.reset} Engine already installed`);
    console.log();
  } else if (useMlx) {
    // Install MLX engine on macOS
    enginePath = await installMlxEngine((msg) => {
      const clean = msg.replace(/\n/g, "");
      const line = `    ${C.cyan}⠸${C.reset} ${clean}`;
      const pad = Math.max(0, 90 - stripAnsi(line).length);
      process.stderr.write(`\r${line}${" ".repeat(pad)}\r`);
    });
    const mlxDone = `    ${C.green}✓${C.reset} MLX engine installed`;
    process.stderr.write(`\r${mlxDone}${" ".repeat(Math.max(0, 90 - stripAnsi(mlxDone).length))}\n`);
    console.log();
  } else {
    // Install llama.cpp on Linux/Windows
    const engineSpinner = createSpinner("Downloading llama.cpp...");
    enginePath = await downloadEngine(hw, (msg) => {
      const clean = msg.replace(/\n/g, "");
      const pctMatch = clean.match(/(\d+)%/);
      if (pctMatch) {
        engineSpinner.stop();
        const pct = parseInt(pctMatch[1], 10);
        const bar = renderProgressBar(pct);
        const detail = clean.replace(/.*?\d+%\s*/, "").trim();
        const line = `    ${C.cyan}↓${C.reset} Engine: ${bar} ${C.dim}${detail}${C.reset}`;
        const pad = Math.max(0, 90 - stripAnsi(line).length);
        process.stderr.write(`\r${line}${" ".repeat(pad)}\r`);
      } else {
        engineSpinner.update(clean);
      }
    });
    engineSpinner.succeed("Engine installed successfully");
    console.log();
  }

  // ═══════════════════════════════════════════════════════════════
  //  Step 4: Model Download
  // ═══════════════════════════════════════════════════════════════

  stepHeader(4, `Downloading ${entry.codename}`);
  console.log();

  let modelPath: string;

  if (useMlx) {
    // MLX model download (via HuggingFace)
    console.log(`    ${C.dim}Format: MLX ${entry.mlxQuant} — optimized for Apple Silicon${C.reset}`);
    console.log();

    modelPath = await downloadMlxModel(entry, (msg) => {
      process.stderr.write(`\r    ${C.cyan}↓${C.reset} ${msg}`.padEnd(90) + "\r");
    });
    process.stderr.write(`\r    ${C.green}✓${C.reset} Model downloaded (MLX)`.padEnd(90) + "\n");
    console.log();
  } else if (isModelDownloaded(entry.codename) && !options?.force) {
    console.log(`    ${C.green}✓${C.reset} Model already downloaded`);
    console.log();
    modelPath = getModelPath(entry.codename)!;
  } else {
    console.log(`    ${C.dim}Size: ${entry.sizeGB} GB — this may take a while...${C.reset}`);
    console.log();

    modelPath = await downloadModel(entry.codename, (msg) => {
      const clean = msg.replace(/\n/g, "");
      const pctMatch = clean.match(/(\d+)%/);
      if (pctMatch) {
        const pct = parseInt(pctMatch[1], 10);
        const bar = renderProgressBar(pct, 35);
        const detail = clean.replace(/.*?\d+%\s*/, "").trim();
        const line = `    ${C.cyan}↓${C.reset} Model: ${bar} ${C.dim}${detail}${C.reset}`;
        const pad = Math.max(0, 90 - stripAnsi(line).length);
        process.stderr.write(`\r${line}${" ".repeat(pad)}\r`);
      } else {
        const line = `    ${C.cyan}↓${C.reset} ${clean}`;
        const pad = Math.max(0, 90 - stripAnsi(line).length);
        process.stderr.write(`\r${line}${" ".repeat(pad)}\r`);
      }
    });
    const doneLine = `    ${C.green}✓${C.reset} Model downloaded successfully`;
    const donePad = Math.max(0, 90 - stripAnsi(doneLine).length);
    process.stderr.write(`\r${doneLine}${" ".repeat(donePad)}\n`);
    console.log();
  }

  // ═══════════════════════════════════════════════════════════════
  //  Step 5: License Activation
  // ═══════════════════════════════════════════════════════════════

  stepHeader(5, "License activation");
  console.log();

  if (hasLicense()) {
    console.log(`    ${C.green}✓${C.reset} License already activated`);
    console.log();
  } else {
    console.log(`    ${C.dim}KCode requires a license key to run.${C.reset}`);
    console.log(`    ${C.dim}Purchase at: ${C.cyan}https://kulvex.ai${C.reset}`);
    console.log();

    // Interactive license key input
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const askKey = (): Promise<string> => new Promise((resolve) => {
      rl.question(`    ${C.bold}Enter license key:${C.reset} `, (answer) => resolve(answer.trim()));
    });

    let activated = false;
    while (!activated) {
      const key = await askKey();
      if (!key) {
        console.log(`    ${C.yellow}⚠${C.reset} License key is required to use KCode.`);
        continue;
      }

      const licSpinner = createSpinner("Activating license...");
      const result = await activateLicense(key);

      if (result.valid) {
        licSpinner.succeed(`License activated — tier: ${C.cyan}${result.tier}${C.reset}`);
        activated = true;
      } else {
        licSpinner.fail(`${result.message}`);
        console.log(`    ${C.dim}Try again or press Ctrl+C to exit.${C.reset}`);
        console.log();
      }
    }

    rl.close();
    console.log();
  }

  // ═══════════════════════════════════════════════════════════════
  //  Step 6: Install to PATH
  // ═══════════════════════════════════════════════════════════════

  stepHeader(6, "Installing kcode command");
  console.log();

  const installSpinner = createSpinner("Installing to PATH...");
  const installed = installToPath();
  if (installed) {
    installSpinner.succeed(`Installed: ${C.cyan}${installed}${C.reset}`);
  } else {
    installSpinner.succeed(`Already available as ${C.cyan}kcode${C.reset}`);
  }
  console.log();

  // ═══════════════════════════════════════════════════════════════
  //  Step 7: Configuration
  // ═══════════════════════════════════════════════════════════════

  stepHeader(7, "Finalizing configuration");
  console.log();

  const configSpinner = createSpinner("Writing configuration...");

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
      engine: useMlx ? "mlx" : "llama.cpp",
      mlxRepo: useMlx ? entry.mlxRepo : undefined,
    }, null, 2) + "\n",
  );

  // Mark setup as complete
  await Bun.write(SETUP_MARKER, `${new Date().toISOString()}\n${entry.codename}\n`);

  configSpinner.succeed("Configuration saved");
  console.log();

  // ═══════════════════════════════════════════════════════════════
  //  Complete!
  // ═══════════════════════════════════════════════════════════════

  const successBox = [
    `    ${C.green}╔══════════════════════════════════════════════╗${C.reset}`,
    `    ${C.green}║${C.reset}                                              ${C.green}║${C.reset}`,
    `    ${C.green}║${C.reset}   ${C.bold}${C.green}Setup complete!${C.reset}                           ${C.green}║${C.reset}`,
    `    ${C.green}║${C.reset}                                              ${C.green}║${C.reset}`,
    `    ${C.green}║${C.reset}   Model:   ${C.cyan}${entry.codename.padEnd(33)}${C.reset}${C.green}║${C.reset}`,
    `    ${C.green}║${C.reset}   Port:    ${C.cyan}${port.toString().padEnd(33)}${C.reset}${C.green}║${C.reset}`,
    `    ${C.green}║${C.reset}   Engine:  ${C.dim}${engineLabel.padEnd(33)}${C.reset}${C.green}║${C.reset}`,
    `    ${C.green}║${C.reset}                                              ${C.green}║${C.reset}`,
    `    ${C.green}║${C.reset}   Run ${C.bold}${C.cyan}kcode${C.reset} to start coding!               ${C.green}║${C.reset}`,
    `    ${C.green}║${C.reset}                                              ${C.green}║${C.reset}`,
    `    ${C.green}╚══════════════════════════════════════════════╝${C.reset}`,
  ];
  console.log(successBox.join("\n"));
  console.log();

  // Tip
  console.log(`    ${C.dim}Tip: Use ${C.reset}kcode setup --model <name>${C.dim} to switch models${C.reset}`);
  console.log(`    ${C.dim}     Use ${C.reset}kcode server status${C.dim} to check the inference server${C.reset}`);
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

/** Extract a .tar.gz or .zip archive (cross-platform) */
async function extractArchive(archivePath: string, destDir: string): Promise<void> {
  if (archivePath.endsWith(".tar.gz") || archivePath.endsWith(".tgz")) {
    // tar works on Linux, macOS, and modern Windows (tar is built-in since Win10 1803)
    const proc = Bun.spawnSync(["tar", "-xzf", archivePath, "-C", destDir], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) {
      throw new Error(`Failed to extract tar.gz: ${proc.stderr.toString()}`);
    }
  } else if (archivePath.endsWith(".zip")) {
    if (process.platform === "win32") {
      // PowerShell Expand-Archive on Windows
      const proc = Bun.spawnSync([
        "powershell", "-NoProfile", "-Command",
        `Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force`,
      ], { stdout: "pipe", stderr: "pipe" });
      if (proc.exitCode !== 0) {
        throw new Error(`Failed to extract zip: ${proc.stderr.toString()}`);
      }
    } else {
      const proc = Bun.spawnSync(["unzip", "-o", archivePath, "-d", destDir], {
        stdout: "pipe",
        stderr: "pipe",
      });
      if (proc.exitCode !== 0) {
        throw new Error(`Failed to extract zip: ${proc.stderr.toString()}`);
      }
    }
  } else {
    throw new Error(`Unknown archive format: ${archivePath}`);
  }
}

/** Find a binary in a directory (recursively, cross-platform) */
function findBinaryInDir(dir: string, name: string): string | null {
  const isWin = process.platform === "win32";
  const target = isWin ? `${name}.exe` : name;

  // Try direct path first
  const directPath = join(dir, target);
  if (existsSync(directPath)) return directPath;

  // Search subdirectories using Bun's Glob (cross-platform, no Unix find dependency)
  try {
    const glob = new Bun.Glob(`**/${target}`);
    for (const match of glob.scanSync({ cwd: dir, onlyFiles: true })) {
      const found = join(dir, match);
      if (existsSync(found)) {
        // Move to engine root for simplicity
        const finalPath = join(dir, target);
        if (found !== finalPath) {
          renameSync(found, finalPath);
        }
        return finalPath;
      }
    }
  } catch { /* ignore */ }

  return null;
}

/** Find all shared library files in a directory (cross-platform) */
function findLibraryFiles(dir: string): string[] {
  const results: string[] = [];
  const patterns = process.platform === "darwin"
    ? ["**/*.dylib"]
    : process.platform === "win32"
    ? ["**/*.dll"]
    : ["**/*.so", "**/*.so.*"];

  try {
    for (const pattern of patterns) {
      const glob = new Bun.Glob(pattern);
      for (const match of glob.scanSync({ cwd: dir, onlyFiles: true })) {
        results.push(join(dir, match));
      }
    }
  } catch { /* ignore */ }

  return results;
}

/** Create symlinks for versioned .so files so the dynamic linker can find them.
 *  e.g. libmtmd.so.0.0.8368 → libmtmd.so.0 → libmtmd.so */
function createLibSymlinks(dir: string): void {
  const { symlinkSync, readdirSync } = require("node:fs");

  try {
    const files = readdirSync(dir) as string[];
    for (const file of files) {
      // Match versioned .so files: libfoo.so.X.Y.Z
      const match = file.match(/^(lib.+\.so)\.(\d+)\.(\d+)\.(\d+)$/);
      if (!match) continue;

      const base = match[1];          // libfoo.so
      const major = match[2];         // X
      const soMajor = `${base}.${major}`; // libfoo.so.X

      // Create libfoo.so.X → libfoo.so.X.Y.Z
      if (!existsSync(join(dir, soMajor))) {
        try { symlinkSync(file, join(dir, soMajor)); } catch { /* ignore */ }
      }

      // Create libfoo.so → libfoo.so.X.Y.Z
      if (!existsSync(join(dir, base))) {
        try { symlinkSync(file, join(dir, base)); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

/** Install kcode binary to a PATH directory so it can be run as 'kcode' */
function installToPath(): string | null {
  // Find the current executable path
  const execPath = process.execPath;

  // If already named 'kcode' and in PATH, skip
  const whichProc = Bun.spawnSync(["which", "kcode"], { stdout: "pipe", stderr: "pipe" });
  if (whichProc.exitCode === 0) {
    const existing = whichProc.stdout.toString().trim();
    if (existing && existsSync(existing)) return null; // already installed
  }

  // Try /usr/local/bin first (system-wide), then ~/.local/bin (user)
  const candidates = [
    "/usr/local/bin/kcode",
    join(homedir(), ".local", "bin", "kcode"),
  ];

  for (const dest of candidates) {
    try {
      const dir = join(dest, "..");
      mkdirSync(dir, { recursive: true });
      copyFileSync(execPath, dest);
      chmodSync(dest, 0o755);

      // If ~/.local/bin, ensure it's in PATH by adding to shell rc
      if (dest.includes(".local/bin")) {
        ensureLocalBinInPath();
      }

      log.info("setup", `Installed kcode to ${dest}`);
      return dest;
    } catch {
      // Permission denied or other error — try next
      continue;
    }
  }

  log.warn("setup", "Could not install kcode to PATH");
  return null;
}

/** Ensure ~/.local/bin is in PATH (add to shell rc if needed) */
function ensureLocalBinInPath(): void {
  const localBin = join(homedir(), ".local", "bin");
  if (process.env.PATH?.includes(localBin)) return;

  // Detect shell and rc file
  const shell = process.env.SHELL ?? "/bin/bash";
  const rcFile = shell.includes("zsh")
    ? join(homedir(), ".zshrc")
    : join(homedir(), ".bashrc");

  const exportLine = `export PATH="$HOME/.local/bin:$PATH"`;

  try {
    const existing = existsSync(rcFile) ? require("node:fs").readFileSync(rcFile, "utf-8") : "";
    if (!existing.includes(".local/bin")) {
      require("node:fs").appendFileSync(rcFile, `\n# KCode\n${exportLine}\n`);
    }
  } catch { /* ignore */ }
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
  engine?: "mlx" | "llama.cpp";
  mlxRepo?: string;
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
