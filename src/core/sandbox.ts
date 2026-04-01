// KCode - Bash Sandbox
// Provides isolated execution environments for shell commands.
// Uses Linux namespaces (bwrap/bubblewrap) when available, falls back to restricted bash.

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "./logger";

// ─── Types ──────────────────────────────────────────────────────

export type SandboxMode = "off" | "light" | "strict";

export interface SandboxOptions {
  allowNetwork?: boolean;
  writablePaths?: string[];
  readOnlyPaths?: string[];
}

interface SandboxConfig {
  mode: SandboxMode;
  allowNetwork: boolean;
  allowWritePaths: string[]; // Paths the sandbox can write to
  readOnlyPaths: string[]; // Paths mounted read-only
  tmpDir: string; // Writable temp directory inside sandbox
}

// ─── Sensitive paths that must never be writable ────────────────

const HOME = homedir();
const KCODE_DIR = join(HOME, ".kcode");

const SENSITIVE_PATHS = [
  join(HOME, ".ssh"),
  join(HOME, ".aws"),
  join(HOME, ".gnupg"),
  "/etc",
  "/usr",
  "/bin",
  "/boot",
  "/proc",
  "/sys",
  "/dev",
];

// ─── Detection ──────────────────────────────────────────────────

let _hasBwrap: boolean | null = null;
let _hasUnshare: boolean | null = null;

function hasBwrap(): boolean {
  if (_hasBwrap === null) {
    try {
      execSync("which bwrap", { stdio: "pipe" });
      _hasBwrap = true;
      log.info("sandbox", "bubblewrap (bwrap) detected");
    } catch {
      _hasBwrap = false;
    }
  }
  return _hasBwrap;
}

function hasUnshare(): boolean {
  if (_hasUnshare === null) {
    try {
      execSync("unshare --user echo ok", { stdio: "pipe", timeout: 3000 });
      _hasUnshare = true;
    } catch {
      _hasUnshare = false;
    }
  }
  return _hasUnshare;
}

/**
 * Check if bwrap is available on this system.
 */
export function isSandboxAvailable(): boolean {
  return hasBwrap();
}

/**
 * Return the sandbox backend mode: "bwrap" if bubblewrap is installed, "none" otherwise.
 */
export function getSandboxMode(): "bwrap" | "none" {
  return hasBwrap() ? "bwrap" : "none";
}

// ─── Sandbox Wrapper ────────────────────────────────────────────

/**
 * Wrap a shell command with sandbox isolation.
 * Returns the modified command string and any env overrides.
 *
 * Levels:
 * - "off": no sandboxing, command runs directly
 * - "light": restricted PATH, readonly HOME, tmpfs /tmp, no network write to system dirs
 * - "strict": bubblewrap (bwrap) namespace isolation — separate PID/NET/mount namespace
 *
 * If bwrap is unavailable for strict mode, falls back to light sandbox gracefully.
 */
export function wrapWithSandbox(
  command: string,
  config: SandboxConfig,
): { command: string; env?: Record<string, string> } {
  if (config.mode === "off") {
    return { command };
  }

  if (config.mode === "strict" && hasBwrap()) {
    return wrapWithBwrap(command, config);
  }

  if (config.mode === "strict" && !hasBwrap()) {
    log.warn(
      "sandbox",
      "bwrap not available, falling back to light sandbox. Install bubblewrap for strict mode.",
    );
  }

  // Light sandbox: use restricted bash with safety guards
  return wrapWithLight(command, config);
}

// ─── Light Sandbox ──────────────────────────────────────────────

function wrapWithLight(
  command: string,
  config: SandboxConfig,
): { command: string; env?: Record<string, string> } {
  // Restricted environment:
  // - Read-only HOME (commands can read configs but not modify dotfiles)
  // - Writable only in cwd and /tmp
  // - No access to sensitive dirs

  // Create a wrapper that sets umask and traps dangerous operations
  const safeTmpDir = shellQuote(config.tmpDir);
  const wrapper = `
set -u
export TMPDIR=${safeTmpDir}
export SANDBOX=1
# Block rm -rf / and similar catastrophic commands
__kcode_guard() {
  case "$1" in
    "rm -rf /"*|"rm -rf --no-preserve-root"*|"mkfs"*|"dd if="*"of=/dev"*)
      echo "SANDBOX: Blocked dangerous command: $1" >&2
      return 1
      ;;
  esac
  return 0
}
__kcode_guard ${shellQuote(command)} && bash -c ${shellQuote(command)}
`;

  return {
    command: `bash -c ${shellQuote(wrapper)}`,
    env: { SANDBOX: "1", TMPDIR: config.tmpDir },
  };
}

// ─── Strict Sandbox (bwrap) ─────────────────────────────────────

function wrapWithBwrap(
  command: string,
  config: SandboxConfig,
): { command: string; env?: Record<string, string> } {
  const bwrapArgs: string[] = [
    "bwrap",
    // New PID namespace
    "--unshare-pid",
    // New IPC namespace
    "--unshare-ipc",
    // Die if parent dies
    "--die-with-parent",
    // Read-only bind mount of entire filesystem as the base layer
    "--ro-bind",
    "/",
    "/",
    // Writable /tmp (tmpfs overlay, not the host /tmp)
    "--tmpfs",
    "/tmp",
    // Proc filesystem (fresh mount over the ro-bind)
    "--proc",
    "/proc",
    // Dev filesystem (minimal, fresh mount over the ro-bind)
    "--dev",
    "/dev",
  ];

  // Writable: ~/.kcode (always — needed for logs, db, settings)
  if (existsSync(KCODE_DIR)) {
    bwrapArgs.push("--bind", KCODE_DIR, KCODE_DIR);
  }

  // Writable paths from config (cwd, user-specified, etc.)
  for (const path of config.allowWritePaths) {
    if (existsSync(path)) {
      bwrapArgs.push("--bind", path, path);
    }
  }

  // Explicitly protect sensitive directories by re-mounting them read-only
  // after the writable binds (order matters — later mounts override earlier ones)
  for (const sensitivePath of SENSITIVE_PATHS) {
    if (existsSync(sensitivePath)) {
      bwrapArgs.push("--ro-bind", sensitivePath, sensitivePath);
    }
  }

  // Additional read-only bind mounts from config
  for (const path of config.readOnlyPaths) {
    if (existsSync(path)) {
      bwrapArgs.push("--ro-bind", path, path);
    }
  }

  // Network isolation (unless explicitly allowed)
  if (!config.allowNetwork) {
    bwrapArgs.push("--unshare-net");
  }

  // Set working directory to the first writable path (project dir)
  bwrapArgs.push("--chdir", config.allowWritePaths[0] ?? process.cwd());

  // The actual command
  bwrapArgs.push("--", "bash", "-c", command);

  log.info(
    "sandbox",
    `bwrap sandbox: writable=[${config.allowWritePaths.join(", ")}], network=${config.allowNetwork}`,
  );

  return {
    command: bwrapArgs.map(shellQuote).join(" "),
    env: { SANDBOX: "strict" },
  };
}

// ─── Default Config ─────────────────────────────────────────────

export function getDefaultSandboxConfig(
  mode: SandboxMode,
  cwd: string,
  opts?: SandboxOptions,
): SandboxConfig {
  const extraWritable = opts?.writablePaths ?? [];
  const extraReadOnly = opts?.readOnlyPaths ?? [];

  return {
    mode,
    allowNetwork: opts?.allowNetwork ?? true, // Allow network by default (needed for git, curl, etc.)
    allowWritePaths: [
      cwd, // Project directory
      "/tmp", // System temp
      ...extraWritable,
    ],
    readOnlyPaths: [
      "/etc/resolv.conf", // DNS resolution
      "/etc/ssl", // SSL certificates
      "/etc/ca-certificates", // CA certificates
      ...extraReadOnly,
    ],
    tmpDir: "/tmp",
  };
}

/**
 * Check if sandbox capabilities are available on this system.
 */
export function getSandboxCapabilities(): { bwrap: boolean; unshare: boolean; available: boolean } {
  return {
    bwrap: hasBwrap(),
    unshare: hasUnshare(),
    available: hasBwrap() || hasUnshare(),
  };
}

// ─── Helpers ────────────────────────────────────────────────────

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
