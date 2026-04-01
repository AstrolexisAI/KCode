// Teleport — Transfer sessions between machines.
//
// Export: packages session checkpoint + referenced files + git diff into
//         a compressed JSON blob. Can upload to KCode Cloud or save locally.
//
// Import: restores session from package on another machine.

import { hostname } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { SessionCheckpoint, TeleportPackage } from "./types";

const TELEPORT_VERSION = "1.0.0";

/**
 * Export a session checkpoint as a teleport package.
 */
export async function exportSession(
  session: SessionCheckpoint,
  options: {
    includeGitDiff?: boolean;
    includeFiles?: string[];
    maxFileSize?: number;
  } = {},
): Promise<{ package: TeleportPackage; serialized: string; code: string }> {
  const maxFileSize = options.maxFileSize ?? 100_000; // 100KB default

  // Collect referenced files
  const referencedFiles: Array<{ path: string; content: string }> = [];
  if (options.includeFiles) {
    for (const filePath of options.includeFiles) {
      const absPath = resolve(session.workingDirectory, filePath);
      if (existsSync(absPath)) {
        try {
          const content = readFileSync(absPath, "utf-8");
          if (content.length <= maxFileSize) {
            referencedFiles.push({ path: filePath, content });
          }
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  // Get git diff if requested
  let gitDiff: string | undefined;
  if (options.includeGitDiff) {
    try {
      const proc = Bun.spawn(["git", "diff", "--cached", "--diff-filter=ACMR"], {
        cwd: session.workingDirectory,
        stdout: "pipe",
        stderr: "pipe",
      });
      gitDiff = await new Response(proc.stdout).text();
      await proc.exited;
      if (!gitDiff.trim()) {
        // Try unstaged diff
        const proc2 = Bun.spawn(["git", "diff"], {
          cwd: session.workingDirectory,
          stdout: "pipe",
          stderr: "pipe",
        });
        gitDiff = await new Response(proc2.stdout).text();
        await proc2.exited;
      }
      if (!gitDiff.trim()) gitDiff = undefined;
    } catch {
      gitDiff = undefined;
    }
  }

  const pkg: TeleportPackage = {
    version: TELEPORT_VERSION,
    exportedAt: Date.now(),
    sourceHost: hostname(),
    session,
    gitDiff,
    referencedFiles,
    plan: session.planState,
  };

  const serialized = JSON.stringify(pkg);
  const code = randomBytes(6).toString("hex"); // 12-char hex code for sharing

  return { package: pkg, serialized, code };
}

/**
 * Import a session from a teleport package (serialized JSON).
 */
export function importSession(serialized: string): TeleportPackage {
  let pkg: TeleportPackage;
  try {
    pkg = JSON.parse(serialized) as TeleportPackage;
  } catch {
    throw new Error("Invalid teleport package: malformed JSON");
  }

  // Validate required fields
  if (!pkg.version) throw new Error("Invalid teleport package: missing version");
  if (!pkg.session) throw new Error("Invalid teleport package: missing session");
  if (!pkg.session.conversationId) {
    throw new Error("Invalid teleport package: missing conversationId");
  }

  return pkg;
}

/**
 * Save teleport package to a local file.
 */
export async function saveToFile(
  serialized: string,
  outputPath: string,
): Promise<void> {
  // Compress with gzip
  const compressed = Bun.gzipSync(new TextEncoder().encode(serialized));
  await Bun.write(outputPath, compressed);
}

/**
 * Load teleport package from a local file.
 */
export async function loadFromFile(filePath: string): Promise<TeleportPackage> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    throw new Error(`Teleport file not found: ${filePath}`);
  }

  const data = await file.arrayBuffer();
  let serialized: string;

  try {
    // Try to decompress (gzipped)
    const decompressed = Bun.gunzipSync(new Uint8Array(data));
    serialized = new TextDecoder().decode(decompressed);
  } catch {
    // Might be plain JSON
    serialized = new TextDecoder().decode(data);
  }

  return importSession(serialized);
}

/**
 * Apply referenced files from a teleport package to the local filesystem.
 * Returns the list of files written.
 */
export async function applyFiles(
  pkg: TeleportPackage,
  targetDir: string,
): Promise<string[]> {
  const written: string[] = [];
  for (const { path: relPath, content } of pkg.referencedFiles) {
    const absPath = join(targetDir, relPath);
    await Bun.write(absPath, content);
    written.push(relPath);
  }
  return written;
}

/**
 * Apply git diff from a teleport package.
 */
export async function applyGitDiff(
  pkg: TeleportPackage,
  targetDir: string,
): Promise<boolean> {
  if (!pkg.gitDiff) return false;
  try {
    const proc = Bun.spawn(["git", "apply", "--check"], {
      cwd: targetDir,
      stdin: new TextEncoder().encode(pkg.gitDiff),
      stderr: "pipe",
    });
    await proc.exited;
    if (proc.exitCode !== 0) return false;

    // Apply for real
    const applyProc = Bun.spawn(["git", "apply"], {
      cwd: targetDir,
      stdin: new TextEncoder().encode(pkg.gitDiff),
      stderr: "pipe",
    });
    await applyProc.exited;
    return applyProc.exitCode === 0;
  } catch {
    return false;
  }
}
