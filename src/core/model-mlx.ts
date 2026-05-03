// KCode - MLX Engine Management (macOS Apple Silicon)
// Handles MLX engine installation and model downloads via mlx-lm.
// Extracted from model-manager.ts for modularity.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { log } from "./logger";
import type { CatalogEntry } from "./model-catalog";
import { kcodePath } from "./paths";

// MLX venv lives inside ~/.kcode/mlx-venv (isolated, no system pollution)
const MLX_VENV = kcodePath("mlx-venv");
const MLX_MARKER = kcodePath(".mlx-engine");

/** Find Python 3 on macOS — tolerant to ENOENT thrown by spawnSync on missing absolute paths */
function findPython3(): string | null {
  // Try `which python3` first — uses the user's shell PATH, the most
  // reliable lookup. Falls through to hardcoded candidates if missing.
  try {
    const which = Bun.spawnSync(["/usr/bin/which", "python3"], { stdout: "pipe", stderr: "pipe" });
    if (which.exitCode === 0) {
      const path = which.stdout.toString().trim();
      if (path) return path;
    }
  } catch {
    // /usr/bin/which not present — extremely unusual, fall through
  }

  for (const name of [
    "/usr/bin/python3",
    "/opt/homebrew/bin/python3",
    "/usr/local/bin/python3",
  ]) {
    try {
      const proc = Bun.spawnSync([name, "--version"], { stdout: "pipe", stderr: "pipe" });
      if (proc.exitCode === 0) return name;
    } catch {
      // ENOENT on absolute path — Bun throws instead of returning non-zero. Skip.
    }
  }
  return null;
}

/** Install MLX engine (creates venv, installs mlx-lm) */
export async function installMlxEngine(onProgress?: (msg: string) => void): Promise<string> {
  const progress = onProgress ?? ((msg: string) => process.stderr.write(`\r  ${msg}`));

  const python = findPython3();
  if (!python) {
    throw new Error(
      "Python 3 not found. Install Python 3 from python.org or via Homebrew: brew install python3",
    );
  }

  // Check Python version >= 3.9
  const verProc = Bun.spawnSync(
    [python, "-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const pyVer = verProc.stdout.toString().trim();
  const verParts = pyVer.split(".").map(Number);
  const major = verParts[0] ?? 0;
  const minor = verParts[1] ?? 0;
  if (major < 3 || (major === 3 && minor < 9)) {
    throw new Error(`Python ${pyVer} is too old. MLX requires Python 3.9+.`);
  }

  progress(`Creating Python venv (${pyVer})...`);

  // Create venv
  const venvProc = Bun.spawnSync([python, "-m", "venv", MLX_VENV], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (venvProc.exitCode !== 0) {
    throw new Error(`Failed to create venv: ${venvProc.stderr.toString()}`);
  }

  const pip = join(MLX_VENV, "bin", "pip");
  const venvPython = join(MLX_VENV, "bin", "python3");

  // Upgrade pip
  progress("Upgrading pip...");
  Bun.spawnSync([venvPython, "-m", "pip", "install", "--upgrade", "pip"], {
    stdout: "pipe",
    stderr: "pipe",
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
    stdout: "pipe",
    stderr: "pipe",
  });

  if (verifyProc.exitCode !== 0) {
    throw new Error("mlx-lm installation verification failed");
  }

  const mlxVersion = verifyProc.stdout.toString().trim();

  // Mark as installed
  await Bun.write(
    MLX_MARKER,
    `mlx-lm ${mlxVersion}\npython ${pyVer}\n${new Date().toISOString()}\n`,
  );

  progress(`MLX engine installed (mlx-lm ${mlxVersion})\n`);
  log.info("setup", `MLX engine installed: mlx-lm ${mlxVersion}, Python ${pyVer}`);

  return venvPython;
}

/** Pre-download an MLX model so first inference is fast */
export async function downloadMlxModel(
  entry: CatalogEntry,
  onProgress?: (msg: string) => void,
): Promise<string> {
  if (!entry.mlxRepo) throw new Error(`No MLX model available for ${entry.codename}`);

  const progress = onProgress ?? ((msg: string) => process.stderr.write(`\r  ${msg}`));
  const venvPython = join(MLX_VENV, "bin", "python3");

  progress(`Downloading ${entry.codename} (MLX ${entry.mlxQuant})...`);

  // Validate mlxRepo against HuggingFace naming pattern to prevent code injection.
  // HF repos allow alphanumeric, dots, dashes, underscores in both owner and model.
  if (!/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(entry.mlxRepo)) {
    throw new Error(
      `Invalid MLX model repo name: "${entry.mlxRepo}" — must match owner/model format`,
    );
  }

  // Use mlx_lm.load to trigger HuggingFace download and cache.
  // Pass repo name via env var instead of string interpolation to prevent injection.
  const proc = Bun.spawnSync(
    [
      venvPython,
      "-c",
      'import os; from mlx_lm import load; model, tokenizer = load(os.environ["KCODE_MLX_REPO"]); print("OK")',
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 600_000, // 10 min for large models
      env: { ...process.env, KCODE_MLX_REPO: entry.mlxRepo },
    },
  );

  if (proc.exitCode !== 0) {
    const err = proc.stderr.toString().slice(-500);
    throw new Error(`Failed to download MLX model: ${err}`);
  }

  progress(`${entry.codename} downloaded (MLX)\n`);
  log.info("setup", `MLX model downloaded: ${entry.codename} (${entry.mlxRepo})`);

  // Return the HuggingFace repo path (mlx_lm.server uses repo names, not file paths)
  return entry.mlxRepo;
}
