// KCode - Model File Utilities
// File download, extraction, binary discovery, library management, and PATH installation helpers.
// Extracted from model-manager.ts for modularity.

import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "./logger";
import { kcodeHome } from "./paths";

const KCODE_HOME = kcodeHome();

/** Ensure a directory exists, creating it recursively if needed */
export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Download a file with progress tracking */
export async function downloadFile(
  url: string,
  destPath: string,
  onProgress: (pct: string) => void,
): Promise<void> {
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
export async function extractArchive(archivePath: string, destDir: string): Promise<void> {
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
      // Try tar first (built-in on Windows 10 1803+), then PowerShell fallback
      let extracted = false;

      // Method 1: tar (fastest, most reliable on modern Windows)
      try {
        const tarProc = Bun.spawnSync(["tar", "-xf", archivePath, "-C", destDir], {
          stdout: "pipe",
          stderr: "pipe",
        });
        if (tarProc.exitCode === 0) extracted = true;
      } catch (err) {
        log.debug("model-manager", `tar extraction failed: ${err}`);
      }

      // Method 2: PowerShell Expand-Archive
      if (!extracted) {
        const psProc = Bun.spawnSync(
          [
            "powershell",
            "-NoProfile",
            "-Command",
            `Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force`,
          ],
          { stdout: "pipe", stderr: "pipe" },
        );
        if (psProc.exitCode === 0) extracted = true;
      }

      if (!extracted) {
        throw new Error(`Failed to extract zip on Windows. Tried tar and PowerShell.`);
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
export function findBinaryInDir(dir: string, name: string): string | null {
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
  } catch (err) {
    log.debug("model-manager", `Bun.Glob search failed: ${err}`);
  }

  // Fallback: manual recursive search using readdirSync (always works)
  try {
    const { readdirSync, statSync } = require("node:fs");
    const search = (searchDir: string): string | null => {
      for (const entry of readdirSync(searchDir)) {
        const fullPath = join(searchDir, entry);
        try {
          if (entry === target) {
            const finalPath = join(dir, target);
            if (fullPath !== finalPath) renameSync(fullPath, finalPath);
            return finalPath;
          }
          if (statSync(fullPath).isDirectory()) {
            const found = search(fullPath);
            if (found) return found;
          }
        } catch (err) {
          log.debug("model-manager", `Skipped entry: ${err}`);
        }
      }
      return null;
    };
    return search(dir);
  } catch (err) {
    log.debug("model-manager", `FS operation failed: ${err}`);
  }

  return null;
}

/** Find all shared library files in a directory (cross-platform) */
export function findLibraryFiles(dir: string): string[] {
  const results: string[] = [];
  const patterns =
    process.platform === "darwin"
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
  } catch (err) {
    log.debug("model-manager", `FS operation failed: ${err}`);
  }

  return results;
}

/** Create symlinks for versioned .so files so the dynamic linker can find them.
 *  e.g. libmtmd.so.0.0.8368 → libmtmd.so.0 → libmtmd.so */
export function createLibSymlinks(dir: string): void {
  const { symlinkSync, readdirSync } = require("node:fs");

  try {
    const files = readdirSync(dir) as string[];
    for (const file of files) {
      // Match versioned .so files: libfoo.so.X.Y.Z
      const match = file.match(/^(lib.+\.so)\.(\d+)\.(\d+)\.(\d+)$/);
      if (!match) continue;

      const base = match[1]!; // libfoo.so
      const major = match[2]!; // X
      const soMajor = `${base}.${major}`; // libfoo.so.X

      // Create libfoo.so.X → libfoo.so.X.Y.Z
      if (!existsSync(join(dir, soMajor))) {
        try {
          symlinkSync(file, join(dir, soMajor));
        } catch (err) {
          log.debug("model-manager", `FS operation failed: ${err}`);
        }
      }

      // Create libfoo.so → libfoo.so.X.Y.Z
      if (!existsSync(join(dir, base))) {
        try {
          symlinkSync(file, join(dir, base));
        } catch (err) {
          log.debug("model-manager", `FS operation failed: ${err}`);
        }
      }
    }
  } catch (err) {
    log.debug("model-manager", `FS operation failed: ${err}`);
  }
}

/** Install kcode binary to a PATH directory so it can be run as 'kcode' */
export function installToPath(): string | null {
  const execPath = process.execPath;
  const isWin = process.platform === "win32";
  const binName = isWin ? "kcode.exe" : "kcode";

  // Check if already in PATH
  const whichCmd = isWin ? "where" : "which";
  const whichProc = Bun.spawnSync([whichCmd, "kcode"], { stdout: "pipe", stderr: "pipe" });
  if (whichProc.exitCode === 0) {
    const existing = whichProc.stdout.toString().trim().split("\n")[0]?.trim();
    if (existing && existsSync(existing)) return null; // already installed
  }

  // Platform-specific candidate install locations
  const candidates: string[] = isWin
    ? [
        // Windows: %LOCALAPPDATA%\Programs\KCode\kcode.exe
        join(
          process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
          "Programs",
          "KCode",
          binName,
        ),
        // Fallback: ~/.kcode/bin/kcode.exe (always writable)
        join(KCODE_HOME, "bin", binName),
      ]
    : ["/usr/local/bin/kcode", join(homedir(), ".local", "bin", "kcode")];

  for (const dest of candidates) {
    try {
      const dir = join(dest, "..");
      mkdirSync(dir, { recursive: true });
      copyFileSync(execPath, dest);
      if (!isWin) chmodSync(dest, 0o755);

      // Ensure the install directory is in PATH
      ensureInPath(join(dest, ".."));

      log.info("setup", `Installed kcode to ${dest}`);
      return dest;
    } catch (err) {
      log.debug("model-manager", `Install to ${dest} failed, trying next: ${err}`);
    }
  }

  log.warn("setup", "Could not install kcode to PATH");
  return null;
}

/** Ensure a directory is in PATH (platform-aware) */
export function ensureInPath(dir: string): void {
  const resolvedDir = require("node:path").resolve(dir);
  const sep = process.platform === "win32" ? ";" : ":";
  if (process.env.PATH?.split(sep).some((p) => require("node:path").resolve(p) === resolvedDir))
    return;

  if (process.platform === "win32") {
    // Windows: add to user PATH via reg.exe (persistent, no admin required)
    try {
      const regResult = Bun.spawnSync(["reg", "query", "HKCU\\Environment", "/v", "Path"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const currentPath =
        regResult.exitCode === 0
          ? (regResult.stdout
              .toString()
              .match(/REG_(?:EXPAND_)?SZ\s+(.*)/)?.[1]
              ?.trim() ?? "")
          : "";

      if (!currentPath.toLowerCase().includes(resolvedDir.toLowerCase())) {
        const newPath = currentPath ? `${currentPath};${resolvedDir}` : resolvedDir;
        Bun.spawnSync(
          [
            "reg",
            "add",
            "HKCU\\Environment",
            "/v",
            "Path",
            "/t",
            "REG_EXPAND_SZ",
            "/d",
            newPath,
            "/f",
          ],
          { stdout: "pipe", stderr: "pipe" },
        );
        // Notify running Explorer to pick up the change
        Bun.spawnSync(
          [
            "powershell",
            "-NoProfile",
            "-Command",
            "[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User'), 'User')",
          ],
          { stdout: "pipe", stderr: "pipe" },
        );
      }
    } catch (err) {
      log.debug("model-manager", `FS operation failed: ${err}`);
    }
  } else {
    // Unix: add to shell rc
    const shell = process.env.SHELL ?? "/bin/bash";
    const rcFile = shell.includes("zsh") ? join(homedir(), ".zshrc") : join(homedir(), ".bashrc");

    const exportLine = `export PATH="${resolvedDir}:$PATH"`;
    try {
      const existing = existsSync(rcFile) ? require("node:fs").readFileSync(rcFile, "utf-8") : "";
      if (!existing.includes(resolvedDir)) {
        require("node:fs").appendFileSync(rcFile, `\n# KCode\n${exportLine}\n`);
      }
    } catch (err) {
      log.debug("model-manager", `FS operation failed: ${err}`);
    }
  }
}
