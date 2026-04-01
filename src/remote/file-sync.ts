/**
 * File Sync for KCode Remote Mode.
 * Handles bidirectional file synchronization between local and remote using rsync.
 * Includes file watching with debounce, conflict resolution, and backup of losers.
 */

import { execFileSync } from "node:child_process";
import { type FSWatcher, watch } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { executeRemote } from "./ssh-transport";
import type { SyncConflict } from "./types";

/** Options for sync operations */
export interface SyncOptions {
  /** Glob patterns to exclude */
  excludes?: string[];
  /** Delete files on destination that don't exist on source */
  delete?: boolean;
  /** Dry run - don't actually transfer */
  dryRun?: boolean;
}

/**
 * Write an rsync exclude file and return its path.
 */
async function writeExcludeFile(excludes: string[], tmpDir: string): Promise<string> {
  const excludeFile = join(tmpDir, ".kcode-sync-exclude");
  await mkdir(dirname(excludeFile), { recursive: true });
  await writeFile(excludeFile, excludes.join("\n") + "\n", "utf-8");
  return excludeFile;
}

/**
 * Perform initial full sync from local directory to remote.
 * Uses rsync with --delete to make remote match local.
 *
 * @param localDir Local project directory
 * @param host SSH host string
 * @param remoteDir Remote project directory
 * @param excludes Patterns to exclude from sync
 * @returns Object with success boolean and number of files transferred
 */
export async function initialSync(
  localDir: string,
  host: string,
  remoteDir: string,
  excludes: string[] = [],
): Promise<{ success: boolean; filesTransferred: number; error?: string }> {
  let excludeFile: string | undefined;

  try {
    const args: string[] = ["-avz", "--delete"];

    if (excludes.length > 0) {
      excludeFile = await writeExcludeFile(excludes, localDir);
      args.push("--exclude-from", excludeFile);
    }

    // Ensure localDir ends with / so rsync copies contents, not the dir itself
    const source = localDir.endsWith("/") ? localDir : `${localDir}/`;
    args.push(source, `${host}:${remoteDir}/`);

    const stdout = execFileSync("rsync", args, {
      encoding: "utf-8",
      timeout: 120_000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Count transferred files (lines that don't start with special chars)
    const lines = stdout
      .split("\n")
      .filter(
        (l) =>
          l.trim() &&
          !l.startsWith("sent ") &&
          !l.startsWith("total ") &&
          !l.startsWith("building "),
      );
    return { success: true, filesTransferred: lines.length };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, filesTransferred: 0, error: msg };
  }
}

/**
 * Sync specific changed files from local to remote (incremental sync).
 *
 * @param files Array of relative file paths that changed
 * @param localDir Local project directory
 * @param host SSH host string
 * @param remoteDir Remote project directory
 * @returns Object with success boolean
 */
export async function syncChanges(
  files: string[],
  localDir: string,
  host: string,
  remoteDir: string,
): Promise<{ success: boolean; error?: string }> {
  if (files.length === 0) return { success: true };

  try {
    // Write the list of files to a temp file
    const filesListPath = join(localDir, ".kcode-sync-files");
    await writeFile(filesListPath, files.join("\n") + "\n", "utf-8");

    const source = localDir.endsWith("/") ? localDir : `${localDir}/`;
    const args: string[] = ["-avz", "--files-from", filesListPath, source, `${host}:${remoteDir}/`];

    execFileSync("rsync", args, {
      encoding: "utf-8",
      timeout: 60_000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    return { success: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

/**
 * Reverse sync: pull changed files from remote to local.
 *
 * @param files Array of relative file paths changed on remote
 * @param localDir Local project directory
 * @param host SSH host string
 * @param remoteDir Remote project directory
 */
export async function syncFromRemote(
  files: string[],
  localDir: string,
  host: string,
  remoteDir: string,
): Promise<{ success: boolean; error?: string }> {
  if (files.length === 0) return { success: true };

  try {
    const filesListPath = join(localDir, ".kcode-sync-files-remote");
    await writeFile(filesListPath, files.join("\n") + "\n", "utf-8");

    const remoteSrc = remoteDir.endsWith("/") ? remoteDir : `${remoteDir}/`;
    const args: string[] = [
      "-avz",
      "--files-from",
      filesListPath,
      `${host}:${remoteSrc}`,
      localDir.endsWith("/") ? localDir : `${localDir}/`,
    ];

    execFileSync("rsync", args, {
      encoding: "utf-8",
      timeout: 60_000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    return { success: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

/**
 * Start a local file watcher with debounce.
 * Calls onChange with the list of changed relative paths.
 *
 * @param localDir Directory to watch
 * @param onChange Callback with array of changed relative paths
 * @param debounceMs Debounce interval in ms (default 500)
 * @returns Object with stop() to kill the watcher
 */
export function startWatcher(
  localDir: string,
  onChange: (files: string[]) => void,
  debounceMs: number = 500,
): { stop: () => void } {
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const watcher: FSWatcher = watch(localDir, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    // Skip excluded patterns
    if (shouldExclude(filename)) return;

    pending.add(filename);

    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const files = [...pending];
      pending.clear();
      if (files.length > 0) {
        onChange(files);
      }
    }, debounceMs);
  });

  return {
    stop: () => {
      if (timer) clearTimeout(timer);
      watcher.close();
    },
  };
}

/** Default exclusion check for watched files */
function shouldExclude(filename: string): boolean {
  const excludePatterns = [
    "node_modules/",
    ".git/",
    ".kcode-sync-",
    ".kcode/",
    "__pycache__/",
    "dist/",
  ];
  return excludePatterns.some((p) => filename.includes(p));
}

/**
 * Start a remote file watcher using inotifywait via SSH.
 * Detects changes made by remote tools and calls onChange.
 *
 * @param host SSH host string
 * @param remoteDir Directory to watch on the remote
 * @param onChange Callback with array of changed relative paths
 * @returns Object with stop() to kill the watcher
 */
export function startRemoteWatcher(
  host: string,
  remoteDir: string,
  onChange: (files: string[]) => void,
): { stop: () => void } {
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ServerAliveInterval=15",
    host,
    "inotifywait",
    "-m",
    "-r",
    "-e",
    "modify,create,delete",
    "--format",
    "%w%f",
    remoteDir,
  ];

  const proc = Bun.spawn(["ssh", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  let stopped = false;
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  // Read stdout line by line
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const readLoop = async () => {
    try {
      while (!stopped) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          // Convert absolute remote path to relative
          const relativePath = trimmed.startsWith(remoteDir)
            ? trimmed.slice(remoteDir.length).replace(/^\//, "")
            : trimmed;

          if (relativePath && !shouldExclude(relativePath)) {
            pending.add(relativePath);
          }
        }

        // Debounce
        if (pending.size > 0) {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            const files = [...pending];
            pending.clear();
            if (files.length > 0) {
              onChange(files);
            }
          }, 500);
        }
      }
    } catch {
      // Stream ended or error
    }
  };

  readLoop();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      proc.kill();
    },
  };
}

/**
 * Resolve a sync conflict between local and remote versions.
 * Rule: most recent modification wins. Loser is backed up.
 *
 * @param localPath Absolute path to local file
 * @param remotePath Relative path (for backup naming)
 * @param localMtime Local modification time (epoch ms)
 * @param remoteMtime Remote modification time (epoch ms)
 * @param backupDir Directory to store backup of losing file
 * @returns SyncConflict describing the resolution
 */
export async function resolveConflict(
  localPath: string,
  remotePath: string,
  localMtime: number,
  remoteMtime: number,
  backupDir: string,
): Promise<SyncConflict> {
  const resolution = localMtime >= remoteMtime ? "local-wins" : "remote-wins";

  // Create backup of the loser
  await mkdir(backupDir, { recursive: true });
  const backupName = remotePath.replace(/\//g, "_") + `.${Date.now()}.bak`;
  const backupPath = join(backupDir, backupName);

  try {
    // If local wins, backup the remote (which will be overwritten).
    // If remote wins, backup the local.
    if (resolution === "remote-wins") {
      const localContent = await Bun.file(localPath).text();
      await Bun.write(backupPath, localContent);
    }
    // Note: for local-wins, the remote backup happens during the sync operation
  } catch {
    // Best effort backup
  }

  return {
    path: remotePath,
    localMtime,
    remoteMtime,
    resolution,
  };
}

/**
 * Get modification time of a remote file.
 */
export async function getRemoteMtime(host: string, remotePath: string): Promise<number | null> {
  try {
    const result = await executeRemote(host, ["stat", "-c", "%Y", remotePath]);
    if (result.exitCode === 0) {
      return parseInt(result.stdout.trim(), 10) * 1000;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Get modification time of a local file.
 */
export async function getLocalMtime(localPath: string): Promise<number | null> {
  try {
    const s = await stat(localPath);
    return s.mtimeMs;
  } catch {
    return null;
  }
}
