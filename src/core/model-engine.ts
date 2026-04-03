// KCode - Engine Download (llama.cpp)
// Downloads and installs the llama.cpp inference engine binary.
// Extracted from model-manager.ts for modularity.

import { execSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { HardwareInfo } from "./hardware";
import { log } from "./logger";
import {
  createLibSymlinks,
  downloadFile,
  ensureDir,
  extractArchive,
  findBinaryInDir,
  findLibraryFiles,
} from "./model-file-utils";
import { kcodePath } from "./paths";

const ENGINE_DIR = kcodePath("engine");
const ENGINE_SOURCE_DIR = kcodePath("engine-src");

/** Get the llama-server binary path (engine-local check, no MLX fallback) */
function getEnginePathLocal(): string | null {
  const names = process.platform === "win32" ? ["llama-server.exe"] : ["llama-server"];
  for (const name of names) {
    const path = join(ENGINE_DIR, name);
    if (existsSync(path)) return path;
  }
  return null;
}

/** Download llama.cpp server binary for the current platform */
export async function downloadEngine(
  hw: HardwareInfo,
  onProgress?: (msg: string) => void,
): Promise<string> {
  // Clean up corrupt engine dir from previous failed installs
  if (existsSync(ENGINE_DIR) && !getEnginePathLocal()) {
    try {
      rmSync(ENGINE_DIR, { recursive: true, force: true });
    } catch (err) {
      log.debug("model-manager", `Failed to clean corrupt engine dir: ${err}`);
    }
  }
  ensureDir(ENGINE_DIR);
  const progress = onProgress ?? ((msg: string) => process.stderr.write(`\r  ${msg}`));

  progress("Fetching latest llama.cpp release...");

  // Get latest release from GitHub API
  const releaseResp = await fetch(
    "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest",
    {
      headers: { "User-Agent": "KCode" },
    },
  );

  if (!releaseResp.ok) {
    throw new Error(`Failed to fetch llama.cpp releases: ${releaseResp.status}`);
  }

  const release = (await releaseResp.json()) as {
    tag_name: string;
    assets: { name: string; browser_download_url: string }[];
  };
  const tag = release.tag_name;
  progress(`Latest release: ${tag}`);

  // Find the right asset for this platform
  const assetName = findEngineAsset(
    release.assets.map((a) => a.name),
    hw,
  );
  if (!assetName) {
    throw new Error(
      `No pre-built llama.cpp binary found for ${hw.platform} ${hw.arch}. Consider building from source.`,
    );
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

  // Log extracted files for diagnostics
  try {
    const allFiles = readdirSync(ENGINE_DIR);
    log.info(
      "setup",
      `Extracted to ${ENGINE_DIR}: [${allFiles.slice(0, 20).join(", ")}]${allFiles.length > 20 ? ` ... (${allFiles.length} total)` : ""}`,
    );
    // Also check subdirectories
    for (const f of allFiles) {
      const sub = join(ENGINE_DIR, f);
      try {
        if (statSync(sub).isDirectory()) {
          const subFiles = readdirSync(sub);
          log.info(
            "setup",
            `  subdir ${f}/: [${subFiles.slice(0, 10).join(", ")}]${subFiles.length > 10 ? ` ...` : ""}`,
          );
        }
      } catch (err) {
        log.debug("model-manager", `FS operation failed: ${err}`);
      }
    }
  } catch (err) {
    log.debug("model-manager", `FS operation failed: ${err}`);
  }

  // Find llama-server in extracted files
  const serverBin = findBinaryInDir(ENGINE_DIR, "llama-server");
  if (!serverBin) {
    // Provide detailed error for diagnostics
    let contents = "";
    try {
      contents = readdirSync(ENGINE_DIR).join(", ");
    } catch (err) {
      log.debug("model-manager", `FS operation failed: ${err}`);
    }
    throw new Error(
      `llama-server binary not found in extracted archive. Engine dir contents: [${contents}]`,
    );
  }

  // Make executable on Unix
  if (hw.platform !== "win32") {
    chmodSync(serverBin, 0o755);
  }

  // On Windows with CUDA: also download the cudart DLLs package
  if (hw.platform === "win32" && hw.cudaAvailable) {
    const cudartAsset = release.assets.find(
      (a) => a.name.startsWith("cudart") && a.name.includes("win") && a.name.endsWith(".zip"),
    );
    if (cudartAsset) {
      progress("Downloading CUDA runtime DLLs...");
      const cudartPath = join(ENGINE_DIR, cudartAsset.name);
      if (!existsSync(cudartPath)) {
        try {
          await downloadFile(cudartAsset.browser_download_url, cudartPath, (pct) => {
            progress(`CUDA runtime: ${pct}`);
          });
          await extractArchive(cudartPath, ENGINE_DIR);
          try {
            unlinkSync(cudartPath);
          } catch (err) {
            log.debug("model-manager", `FS operation failed: ${err}`);
          }
        } catch (err) {
          log.warn(
            "setup",
            `Failed to download CUDA runtime: ${err instanceof Error ? err.message : err}`,
          );
          // Not fatal — llama-server may still work without bundled cudart if CUDA toolkit is installed
        }
      }
    }
  }

  // Move all shared libraries (.so, .dylib, .dll) next to the binary
  // so LD_LIBRARY_PATH / DYLD_LIBRARY_PATH / PATH can find them
  progress("Installing libraries...");
  const binDir = dirname(serverBin);
  for (const libPath of findLibraryFiles(ENGINE_DIR)) {
    const libName = basename(libPath);
    const dest = join(binDir, libName);
    if (libPath !== dest && !existsSync(dest)) {
      try {
        renameSync(libPath, dest);
      } catch (err) {
        log.debug("model-manager", `FS operation failed: ${err}`);
      }
    }
  }

  // Create symlinks for versioned .so files (e.g. libmtmd.so.0.0.8368 → libmtmd.so.0)
  if (hw.platform !== "win32") {
    createLibSymlinks(binDir);
  }

  // Save version info
  await Bun.write(join(ENGINE_DIR, "version.txt"), `${tag}\n${assetName}\n`);

  // Clean up archive
  try {
    unlinkSync(archivePath);
  } catch (err) {
    log.debug("model-manager", `FS operation failed: ${err}`);
  }

  // Verify the pre-built binary supports all detected GPU architectures.
  // Pre-built binaries may not include kernels for newer GPUs (e.g. sm_120 for RTX 5090).
  // If unsupported, fall back to compiling from source with the correct architectures.
  if (hw.cudaAvailable && hw.gpus.some((g) => g.computeCapability)) {
    const unsupported = getUnsupportedArchitectures(hw);
    if (unsupported.length > 0) {
      const gpuList = unsupported.map((a) => `sm_${a.replace(".", "")}`).join(", ");
      progress(`Pre-built binary missing GPU support for ${gpuList}, compiling from source...\n`);
      log.warn(
        "setup",
        `Pre-built llama.cpp binary does not support GPU architectures: ${gpuList}. Building from source.`,
      );
      const sourceBin = await buildEngineFromSource(hw, progress);
      if (sourceBin) return sourceBin;
      // If source build fails, continue with the pre-built binary and warn
      log.warn(
        "setup",
        "Source build failed, falling back to pre-built binary (may not use all GPUs)",
      );
    }
  }

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
        // llama.cpp asset names: llama-bXXXX-bin-win-cuda-12.4-x64.zip
        patterns.push(`win-cuda-${cudaVersion}-${arch}`);
        patterns.push(`win-cuda-${major}`);
        // Legacy format: win-cuda-cuXX
        patterns.push(`win-cuda-cu${cudaVersion}-${arch}`);
        patterns.push(`win-cuda-cu${major}`);
      }
      patterns.push(`win-cuda`);
      // Vulkan also uses GPU on Windows
      patterns.push(`win-vulkan-${arch}`);
    }
    // CPU fallback
    patterns.push(`win-cpu-${arch}`);
    patterns.push(`win-${arch}`);
  }

  // Match against available assets
  // Skip cudart-* packages (CUDA runtime only, no llama-server binary)
  for (const pattern of patterns) {
    const match = assetNames.find(
      (name) =>
        name.includes(pattern) &&
        (name.endsWith(".tar.gz") || name.endsWith(".zip")) &&
        !name.startsWith("cudart"),
    );
    if (match) return match;
  }

  return null;
}

// ─── GPU Architecture Verification & Source Build ──────────────────

/** Known CUDA architectures supported by typical pre-built llama.cpp releases */
const PREBUILT_CUDA_ARCHS = ["5.0", "6.1", "7.0", "7.5", "8.0", "8.6", "8.9"];

/**
 * Check which GPU compute capabilities are NOT covered by pre-built binaries.
 * Returns a list of compute capability strings (e.g. ["12.0"]) that need source compilation.
 */
function getUnsupportedArchitectures(hw: HardwareInfo): string[] {
  const unsupported: string[] = [];
  for (const gpu of hw.gpus) {
    if (!gpu.computeCapability) continue;
    const cc = gpu.computeCapability;
    // Check if this CC is covered by any pre-built arch (exact match or same major with lower minor)
    const ccMajor = cc.split(".")[0]!;
    const covered = PREBUILT_CUDA_ARCHS.some((arch) => {
      const archMajor = arch.split(".")[0]!;
      return arch === cc || (archMajor === ccMajor && parseFloat(arch) <= parseFloat(cc));
    });
    if (!covered && !unsupported.includes(cc)) {
      unsupported.push(cc);
    }
  }
  return unsupported;
}

/**
 * Get the CMAKE_CUDA_ARCHITECTURES string for all detected GPUs.
 * Converts compute capabilities like "8.9", "12.0" into CMake format "89;120".
 */
function getCudaArchitectures(hw: HardwareInfo): string {
  const archs = new Set<string>();
  for (const gpu of hw.gpus) {
    if (gpu.computeCapability) {
      archs.add(gpu.computeCapability.replace(".", ""));
    }
  }
  if (archs.size === 0) return "native";
  return [...archs].sort((a, b) => parseInt(a, 10) - parseInt(b, 10)).join(";");
}

/**
 * Build llama.cpp from source with correct CUDA architectures for all detected GPUs.
 * This is the fallback when pre-built binaries don't support the user's GPU hardware.
 *
 * Requirements: git, cmake, C++ compiler, CUDA toolkit.
 * Returns the path to the built llama-server binary, or null on failure.
 */
async function buildEngineFromSource(
  hw: HardwareInfo,
  progress: (msg: string) => void,
): Promise<string | null> {
  const cudaArchs = getCudaArchitectures(hw);
  const archDisplay = cudaArchs
    .split(";")
    .map((a) => `sm_${a}`)
    .join(" + ");

  log.info("setup", `Building llama.cpp from source with CUDA architectures: ${cudaArchs}`);

  // Check build prerequisites
  const prerequisites = ["git", "cmake", "make"];
  for (const cmd of prerequisites) {
    try {
      execSync(`which ${cmd}`, { stdio: "pipe", timeout: 5000 });
    } catch {
      log.error("setup", `Build prerequisite missing: ${cmd}`);
      progress(`Cannot build from source: '${cmd}' not found. Install it and retry.\n`);
      return null;
    }
  }

  // Check for C++ compiler
  let hasCompiler = false;
  for (const cc of ["g++", "c++", "clang++"]) {
    try {
      execSync(`which ${cc}`, { stdio: "pipe", timeout: 5000 });
      hasCompiler = true;
      break;
    } catch {
      /* try next */
    }
  }
  if (!hasCompiler) {
    progress("Cannot build from source: no C++ compiler found (g++, clang++).\n");
    return null;
  }

  // Check for CUDA toolkit (nvcc)
  try {
    execSync("nvcc --version 2>/dev/null || /usr/local/cuda/bin/nvcc --version 2>/dev/null", {
      stdio: "pipe",
      timeout: 5000,
    });
  } catch {
    progress("Cannot build from source: CUDA toolkit (nvcc) not found.\n");
    return null;
  }

  try {
    ensureDir(ENGINE_SOURCE_DIR);

    // Clone or update llama.cpp
    const repoDir = join(ENGINE_SOURCE_DIR, "llama.cpp");
    if (existsSync(join(repoDir, ".git"))) {
      progress("Updating llama.cpp source...");
      execSync("git pull --ff-only", {
        cwd: repoDir,
        stdio: "pipe",
        timeout: 60000,
      });
    } else {
      progress("Cloning llama.cpp source...");
      if (existsSync(repoDir)) rmSync(repoDir, { recursive: true, force: true });
      execSync("git clone --depth 1 https://github.com/ggml-org/llama.cpp.git", {
        cwd: ENGINE_SOURCE_DIR,
        stdio: "pipe",
        timeout: 120000,
      });
    }

    // Configure with CMake — targeting ALL detected GPU architectures
    progress(`Configuring build for ${archDisplay}...`);
    const cmakeArgs = [
      "cmake",
      "-B build",
      "-DGGML_CUDA=ON",
      `-DCMAKE_CUDA_ARCHITECTURES="${cudaArchs}"`,
      "-DCMAKE_BUILD_TYPE=Release",
    ].join(" ");

    execSync(cmakeArgs, {
      cwd: repoDir,
      stdio: "pipe",
      timeout: 120000,
    });

    // Build (use all available CPU cores)
    const nproc = (() => {
      try {
        return execSync("nproc", { encoding: "utf-8", stdio: "pipe" }).trim();
      } catch {
        return "4";
      }
    })();

    progress(`Compiling llama.cpp (${nproc} cores, ${archDisplay})... this may take a few minutes`);
    execSync(`cmake --build build --config Release -j${nproc}`, {
      cwd: repoDir,
      stdio: "pipe",
      timeout: 600000, // 10 minutes max
    });

    // Find the built binary
    const builtBin = join(repoDir, "build", "bin", "llama-server");
    if (!existsSync(builtBin)) {
      log.error("setup", "Source build completed but llama-server binary not found");
      return null;
    }

    // Copy to engine directory
    const destBin = join(ENGINE_DIR, "llama-server");
    execSync(`cp "${builtBin}" "${destBin}"`, { stdio: "pipe" });
    chmodSync(destBin, 0o755);

    // Copy shared libraries from build
    const buildBinDir = join(repoDir, "build", "bin");
    const buildLibDir = join(repoDir, "build", "src");
    for (const searchDir of [buildBinDir, buildLibDir]) {
      if (!existsSync(searchDir)) continue;
      for (const libPath of findLibraryFiles(searchDir)) {
        const libName = basename(libPath);
        const dest = join(ENGINE_DIR, libName);
        if (!existsSync(dest)) {
          try {
            execSync(`cp "${libPath}" "${dest}"`, { stdio: "pipe" });
          } catch {
            /* non-fatal */
          }
        }
      }
    }
    createLibSymlinks(ENGINE_DIR);

    // Get version info
    let version = "source-build";
    try {
      version = execSync("git describe --tags --always", {
        cwd: repoDir,
        encoding: "utf-8",
        stdio: "pipe",
      }).trim();
    } catch {
      /* use default */
    }

    await Bun.write(join(ENGINE_DIR, "version.txt"), `${version}\nsource-build (${archDisplay})\n`);

    progress(`Engine built from source: ${version} (${archDisplay})\n`);
    log.info("setup", `llama.cpp built from source: ${version}, CUDA archs: ${cudaArchs}`);

    return destBin;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("setup", `Source build failed: ${msg}`);
    progress(`Source build failed: ${msg}\n`);
    return null;
  }
}
