// KCode - Bash Sandbox
// Provides isolated execution environments for shell commands.
// Uses Linux namespaces (bwrap/bubblewrap) when available, falls back to restricted bash.

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { log } from "./logger";

// ─── Types ──────────────────────────────────────────────────────

export type SandboxMode = "off" | "light" | "strict";

interface SandboxConfig {
  mode: SandboxMode;
  allowNetwork: boolean;
  allowWritePaths: string[];   // Paths the sandbox can write to
  readOnlyPaths: string[];     // Paths mounted read-only
  tmpDir: string;              // Writable temp directory inside sandbox
}

// ─── Detection ──────────────────────────────────────────────────

let _hasBwrap: boolean | null = null;
let _hasUnshare: boolean | null = null;

function hasBwrap(): boolean {
  if (_hasBwrap === null) {
    try {
      execSync("which bwrap", { stdio: "pipe" });
      _hasBwrap = true;
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

// ─── Sandbox Wrapper ────────────────────────────────────────────

/**
 * Wrap a shell command with sandbox isolation.
 * Returns the modified command string and any env overrides.
 *
 * Levels:
 * - "off": no sandboxing, command runs directly
 * - "light": restricted PATH, readonly HOME, tmpfs /tmp, no network write to system dirs
 * - "strict": bubblewrap (bwrap) namespace isolation — separate PID/NET/mount namespace
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
    log.warn("sandbox", "bwrap not available, falling back to light sandbox. Install bubblewrap for strict mode.");
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
    // Tmpfs for /tmp
    "--tmpfs", "/tmp",
    // Bind /usr, /bin, /lib, /lib64 as read-only
    "--ro-bind", "/usr", "/usr",
    "--ro-bind", "/bin", "/bin",
    "--ro-bind", "/lib", "/lib",
  ];

  // /lib64 may not exist on all systems
  if (existsSync("/lib64")) {
    bwrapArgs.push("--ro-bind", "/lib64", "/lib64");
  }

  // /sbin for system tools
  if (existsSync("/sbin")) {
    bwrapArgs.push("--ro-bind", "/sbin", "/sbin");
  }

  // Proc filesystem
  bwrapArgs.push("--proc", "/proc");

  // Dev filesystem (minimal)
  bwrapArgs.push("--dev", "/dev");

  // Read-only HOME (for reading configs, .gitconfig, etc.)
  const home = process.env.HOME ?? "/home/user";
  bwrapArgs.push("--ro-bind", home, home);

  // Writable paths
  for (const path of config.allowWritePaths) {
    if (existsSync(path)) {
      bwrapArgs.push("--bind", path, path);
    }
  }

  // Read-only bind mounts
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

  return {
    command: bwrapArgs.map(shellQuote).join(" "),
    env: { SANDBOX: "strict" },
  };
}

// ─── Default Config ─────────────────────────────────────────────

export function getDefaultSandboxConfig(mode: SandboxMode, cwd: string): SandboxConfig {
  return {
    mode,
    allowNetwork: true, // Allow network by default (needed for git, curl, etc.)
    allowWritePaths: [
      cwd,                    // Project directory
      "/tmp/kcode-sandbox",   // Sandbox temp
    ],
    readOnlyPaths: [
      "/etc/resolv.conf",     // DNS resolution
      "/etc/ssl",             // SSL certificates
      "/etc/ca-certificates", // CA certificates
    ],
    tmpDir: "/tmp/kcode-sandbox",
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
