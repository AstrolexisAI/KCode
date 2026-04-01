// KCode - Engine Download (llama.cpp)
// Downloads and installs the llama.cpp inference engine binary.
// Extracted from model-manager.ts for modularity.

import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { HardwareInfo } from "./hardware";
import { log } from "./logger";
import {
  downloadFile,
  ensureDir,
  extractArchive,
  findBinaryInDir,
  findLibraryFiles,
  createLibSymlinks,
} from "./model-file-utils";
import { kcodePath } from "./paths";

const ENGINE_DIR = kcodePath("engine");

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
      require("node:fs").rmSync(ENGINE_DIR, { recursive: true, force: true });
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
    const { readdirSync } = require("node:fs");
    const allFiles = readdirSync(ENGINE_DIR);
    log.info(
      "setup",
      `Extracted to ${ENGINE_DIR}: [${allFiles.slice(0, 20).join(", ")}]${allFiles.length > 20 ? ` ... (${allFiles.length} total)` : ""}`,
    );
    // Also check subdirectories
    for (const f of allFiles) {
      const sub = join(ENGINE_DIR, f);
      try {
        if (require("node:fs").statSync(sub).isDirectory()) {
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
      const { readdirSync } = require("node:fs");
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
  const binDir = join(serverBin, "..");
  const sep = process.platform === "win32" ? "\\" : "/";
  for (const libPath of findLibraryFiles(ENGINE_DIR)) {
    const libName = libPath.split(sep).pop() ?? libPath.split("/").pop()!;
    const dest = join(binDir, libName);
    if (libPath !== dest && !existsSync(dest)) {
      try {
        require("node:fs").renameSync(libPath, dest);
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
