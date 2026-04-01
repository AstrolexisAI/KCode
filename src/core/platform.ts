// KCode - Platform Detection Utilities
// Cross-platform helpers for Windows, macOS, and Linux compatibility

import { homedir } from "node:os";

/**
 * Returns true if the current platform is Windows.
 */
export function isWindows(): boolean {
  return process.platform === "win32";
}

/**
 * Returns true if the current platform is macOS.
 */
export function isMacOS(): boolean {
  return process.platform === "darwin";
}

/**
 * Returns true if the current platform is Linux.
 */
export function isLinux(): boolean {
  return process.platform === "linux";
}

/**
 * Returns the user's home directory.
 * Uses USERPROFILE on Windows, HOME elsewhere, with os.homedir() as fallback.
 */
export function homeDir(): string {
  if (isWindows()) {
    return process.env.USERPROFILE ?? homedir();
  }
  return process.env.HOME ?? homedir();
}

/**
 * Returns the null device path for the current platform.
 * NUL on Windows, /dev/null elsewhere.
 */
export function nullDevice(): string {
  return isWindows() ? "NUL" : "/dev/null";
}

/**
 * Returns the PATH separator for the current platform.
 * Semicolon (;) on Windows, colon (:) elsewhere.
 */
export function pathSeparator(): string {
  return isWindows() ? ";" : ":";
}

/**
 * Returns the default shell name for the current platform.
 * "powershell" on Windows, derived from SHELL env var elsewhere (defaults to "bash").
 */
export function shellName(): string {
  if (isWindows()) {
    return "powershell";
  }
  const shell = process.env.SHELL ?? "/bin/bash";
  // Extract shell name from path (e.g., /usr/bin/zsh -> zsh)
  const parts = shell.split("/");
  return parts[parts.length - 1] ?? "bash";
}

/**
 * Returns the appropriate line ending for the current platform.
 * CRLF on Windows, LF elsewhere.
 */
export function lineEnding(): string {
  return isWindows() ? "\r\n" : "\n";
}

/**
 * Returns the KCode config directory path (~/.kcode).
 */
export function kcodeConfigDir(): string {
  const { join } = require("node:path");
  return join(homeDir(), ".kcode");
}
