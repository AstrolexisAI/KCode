// KCode - Windows Compatibility Shims
// Provides cross-platform shims for Unix-specific operations

import { log } from "./logger";
import { isWindows } from "./platform";

/**
 * Install signal handlers with Windows compatibility.
 * On Unix, SIGTERM and SIGINT work natively.
 * On Windows, SIGTERM is not supported — we listen for SIGINT and process 'exit' instead.
 */
export function installSignalHandlers(cleanup: () => void | Promise<void>): void {
  if (isWindows()) {
    // Windows does not support SIGTERM. Use SIGINT (Ctrl+C) and 'exit' event.
    process.on("SIGINT", () => {
      void Promise.resolve(cleanup()).finally(() => process.exit(0));
    });
    process.on("exit", () => {
      // Synchronous-only cleanup on 'exit' — last chance to clean up
      try {
        cleanup();
      } catch {
        // Swallow errors during exit
      }
    });
  } else {
    process.on("SIGINT", () => {
      void Promise.resolve(cleanup()).finally(() => process.exit(0));
    });
    process.on("SIGTERM", () => {
      void Promise.resolve(cleanup()).finally(() => process.exit(0));
    });
  }
}

/**
 * Cross-platform chmod. On Windows, chmod is a no-op since Windows uses ACLs.
 * On Unix, delegates to fs.chmodSync.
 */
export function chmodCompat(filePath: string, mode: number): void {
  if (isWindows()) {
    log.debug("windows-compat", `chmod is a no-op on Windows: ${filePath} (mode ${mode.toString(8)})`);
    return;
  }
  const { chmodSync } = require("node:fs");
  chmodSync(filePath, mode);
}

/**
 * Cross-platform symlink creation.
 * On Windows, uses directory junctions (which don't require admin privileges)
 * for directories, and hard links for files. Falls back to copy on failure.
 * On Unix, creates a standard symlink.
 */
export function symlinkCompat(target: string, linkPath: string): void {
  const fs = require("node:fs");
  const path = require("node:path");

  if (isWindows()) {
    const resolvedTarget = path.resolve(target);
    try {
      const stat = fs.statSync(resolvedTarget);
      if (stat.isDirectory()) {
        // Use junction for directories — no admin privileges required
        fs.symlinkSync(resolvedTarget, linkPath, "junction");
        log.debug("windows-compat", `Created junction: ${linkPath} -> ${resolvedTarget}`);
      } else {
        // Use hard link for files — no admin privileges required
        try {
          fs.linkSync(resolvedTarget, linkPath);
          log.debug("windows-compat", `Created hard link: ${linkPath} -> ${resolvedTarget}`);
        } catch {
          // Fallback: copy the file if hard link fails (e.g., cross-device)
          fs.copyFileSync(resolvedTarget, linkPath);
          log.debug("windows-compat", `Copied file (hard link failed): ${linkPath} <- ${resolvedTarget}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn("windows-compat", `Symlink fallback failed for ${linkPath}: ${msg}`);
      throw err;
    }
  } else {
    fs.symlinkSync(target, linkPath);
  }
}

/**
 * Cross-platform process kill.
 * On Windows, uses taskkill /T /F to kill the process tree.
 * On Unix, uses process.kill with negative PID for process group.
 */
export function killProcessTree(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  if (isWindows()) {
    try {
      Bun.spawnSync(["taskkill", "/PID", pid.toString(), "/T", "/F"], {
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (err) {
      log.debug("windows-compat", `taskkill failed for PID ${pid}: ${err}`);
    }
  } else {
    try {
      process.kill(-pid, signal);
    } catch (err) {
      log.debug("windows-compat", `kill process group failed for PID ${pid}: ${err}`);
    }
  }
}

/**
 * Returns the appropriate shell command prefix for the current platform.
 * On Windows: ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command"]
 * On Unix: ["bash", "-c"]
 */
export function shellCommand(): [string, ...string[]] {
  if (isWindows()) {
    return ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command"];
  }
  return ["bash", "-c"];
}
