// KCode - Command Safety Analysis
// Detects dangerous patterns: command injection, pipe-to-shell, redirections, quote desync, etc.

import type { PermissionResult } from "./permissions";
import { resolve, isAbsolute } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { log } from "./logger";

// ─── Shell Detection ────────────────────────────────────────────

/** Shells that should not be invoked directly */
const SHELL_BINARIES = new Set([
  "sh", "bash", "zsh", "fish", "csh", "tcsh", "ksh", "dash",
  "/bin/sh", "/bin/bash", "/bin/zsh", "/usr/bin/sh", "/usr/bin/bash",
  "/usr/bin/zsh", "/usr/bin/env",
]);

// ─── Command Parsing ────────────────────────────────────────────

/** Extract the base command (first token) from a shell command string */
export function extractCommandPrefix(command: string): string {
  const trimmed = command.trimStart();
  // Handle env prefix: env VAR=val cmd → cmd
  if (trimmed.startsWith("env ")) {
    const parts = trimmed.split(/\s+/).slice(1);
    // Skip VAR=val pairs
    for (const part of parts) {
      if (!part.includes("=")) return part;
    }
  }
  // Handle sudo prefix
  if (trimmed.startsWith("sudo ")) {
    const afterSudo = trimmed.slice(5).trimStart();
    return afterSudo.split(/\s+/)[0] ?? "";
  }
  return trimmed.split(/\s+/)[0] ?? "";
}

// ─── Detection Functions ────────────────────────────────────────

/** Detect command injection patterns */
export function detectCommandInjection(command: string): string | null {
  // Backtick substitution — always dangerous (injection vector)
  if (/`[^`]+`/.test(command)) {
    return "Command contains backtick injection";
  }

  // Subshell via ( )
  // Only flag if it looks like a subshell, not just grouping in arguments
  if (/;\s*\(/.test(command) || /\|\s*\(/.test(command) || /^\s*\(/.test(command)) {
    return "Command contains subshell invocation";
  }

  return null;
}

/** Detect $() command substitution — moderate risk, not injection */
export function detectCommandSubstitution(command: string): string | null {
  if (/\$\(/.test(command)) {
    return "Command contains $() substitution";
  }
  return null;
}

/** Detect dangerous redirections */
export function detectDangerousRedirections(command: string): string | null {
  // Skip redirections inside quotes
  const unquoted = stripQuotedStrings(command);

  // Overwrite redirection to important files
  if (/>\s*\/etc\//.test(unquoted) || />\s*\/dev\/sd/.test(unquoted)) {
    return "Command redirects to sensitive system path";
  }

  // General write redirection (>, >>)
  if (/>{1,2}\s*\S/.test(unquoted)) {
    return "Command contains output redirection";
  }

  return null;
}

/** Detect pipe-to-shell patterns like `curl url | bash` */
export function detectPipeToShell(command: string): string | null {
  // Strip quoted strings so we don't match pipes inside quotes
  const unquoted = stripQuotedStrings(command);

  // Split on unquoted pipe characters
  const segments = unquoted.split("|");
  if (segments.length < 2) return null;

  // Check each segment after the first
  for (let i = 1; i < segments.length; i++) {
    const segment = segments[i].trimStart();
    const prefix = extractCommandPrefix(segment);
    const basename = prefix.split("/").pop() ?? prefix;

    // Direct shell: ... | bash, ... | sh, etc.
    if (SHELL_BINARIES.has(prefix) || SHELL_BINARIES.has(basename)) {
      return `Command pipes to shell: ${basename}`;
    }

    // sudo shell: ... | sudo bash, ... | sudo sh, etc.
    if (prefix === "sudo") {
      const afterSudo = segment.replace(/^\s*sudo\s+/, "");
      const sudoTarget = afterSudo.split(/\s+/)[0] ?? "";
      const sudoBasename = sudoTarget.split("/").pop() ?? sudoTarget;
      if (SHELL_BINARIES.has(sudoTarget) || SHELL_BINARIES.has(sudoBasename)) {
        return `Command pipes to shell: sudo ${sudoBasename}`;
      }
    }
  }

  return null;
}

/** Detect direct shell invocation */
export function detectShellInvocation(command: string): string | null {
  const prefix = extractCommandPrefix(command);
  const basename = prefix.split("/").pop() ?? prefix;

  if (SHELL_BINARIES.has(prefix) || SHELL_BINARIES.has(basename)) {
    // Allow "bash -c 'simple'" but flag "bash" alone or "bash script.sh"
    const trimmed = command.trimStart();
    const afterCmd = trimmed.slice(prefix.length).trimStart();
    if (!afterCmd.startsWith("-c ")) {
      return `Direct shell invocation: ${basename}`;
    }
  }

  return null;
}

/** Detect quote desync patterns in comments */
export function detectQuoteDesync(command: string): string | null {
  // Look for unmatched quotes that could indicate injection via comments
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    }

    // If we hit a # outside quotes, anything after is a comment
    if (ch === "#" && !inSingle && !inDouble) {
      const remainder = command.slice(i + 1);
      // Check if the comment contains unmatched quotes
      const singleCount = (remainder.match(/'/g) ?? []).length;
      const doubleCount = (remainder.match(/"/g) ?? []).length;
      if (singleCount % 2 !== 0 || doubleCount % 2 !== 0) {
        return "Unmatched quotes in comment may indicate injection attempt";
      }
      break; // Rest is comment, stop analysis
    }
  }

  if (inSingle || inDouble) {
    return "Command has unmatched quotes";
  }

  return null;
}

// ─── Utility ────────────────────────────────────────────────────

/** Strip quoted strings to analyze the unquoted portions */
function stripQuotedStrings(command: string): string {
  // Replace single-quoted strings
  let result = command.replace(/'[^']*'/g, "''");
  // Replace double-quoted strings (handle escaped quotes)
  result = result.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  return result;
}

/**
 * Detect commands that aren't real shell commands — symbolic expressions,
 * math formulas, or pseudo-code that the model confused with Bash.
 */
export function detectNonShellExpression(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;

  // Contains Unicode mathematical operators that don't exist in shell
  if (/[×÷≤≥≠∈∉∀∃∅∇∑∏∫≈∞±]/.test(trimmed)) {
    return `Non-shell expression: contains mathematical symbols`;
  }

  // Bare identifier comparison (e.g. "compactThreshold < currentTokens")
  if (/^[a-zA-Z_]\w*\s*[<>=!]+\s*[a-zA-Z_]\w*$/.test(trimmed)) {
    return `Non-shell expression: looks like a comparison, not a command`;
  }

  // Identifier × identifier (symbolic multiplication)
  if (/[a-zA-Z_]\w*\s*×\s*[a-zA-Z_]\w*/.test(trimmed)) {
    return `Non-shell expression: contains symbolic multiplication (×)`;
  }

  // PascalCase function call without $() — likely pseudo-code
  // Extract the identifier before any parenthesis
  const funcMatch = trimmed.match(/^([A-Z][a-zA-Z]+)\s*\(/);
  if (funcMatch && !trimmed.includes("$(")) {
    const funcName = funcMatch[1];
    const shellLikePascal = new Set(["Test", "Set", "New", "Get", "Install", "Remove", "Start", "Stop"]);
    if (!shellLikePascal.has(funcName)) {
      return `Non-shell expression: looks like a function call, not a shell command`;
    }
  }

  return null;
}

// ─── Destructive Removal Detection ─────────────────────────────

/**
 * Detect recursive directory deletion that could destroy user work.
 * Blocks `rm -rf`, `rm -r`, and similar destructive patterns on
 * non-trivial paths. Does NOT block removal of individual files
 * or clearly temporary paths.
 */
export function detectDestructiveRemoval(command: string): string | null {
  // Match rm with any flag combination that includes both -r and -f
  // Covers: rm -rf, rm -fr, rm -rfv, rm -rvf, rm -frv, etc.
  const rmRecursiveForce = /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|\brm\s+-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*/;
  if (!rmRecursiveForce.test(command)) return null;

  // Extract target: skip `rm`, skip all flag groups (-rf, -v, etc.), take the rest
  const match = command.match(/\brm\s+(?:-[a-zA-Z]+\s+)+(.+)/);
  if (!match) return null;

  const targets = match[1].trim();

  // Allow removal of clearly safe targets
  const safePatterns = [
    /^node_modules\/?$/,           // node_modules cleanup
    /^\.next\/?$/,                 // Next.js build cache
    /^dist\/?$/,                   // build output
    /^build\/?$/,                  // build output
    /^\.cache\/?$/,                // generic cache
    /^__pycache__\/?$/,            // Python cache
    /^\.turbo\/?$/,                // Turborepo cache
    /^coverage\/?$/,               // test coverage
    /^tmp\/?$|^\/tmp\//,           // temp directories
  ];

  if (safePatterns.some(p => p.test(targets))) return null;

  return `Bash safety issue: destructive removal (rm -rf) of "${targets.slice(0, 60)}". This requires explicit user confirmation`;
}

// ─── Full Analysis ──────────────────────────────────────────────

/** Full bash command safety analysis */
export function analyzeBashCommand(command: string): {
  safe: boolean;
  issues: string[];
  riskLevel: "safe" | "moderate" | "dangerous";
} {
  const issues: string[] = [];

  const injection = detectCommandInjection(command);
  if (injection) issues.push(injection);

  const substitution = detectCommandSubstitution(command);
  if (substitution) issues.push(substitution);

  const redirection = detectDangerousRedirections(command);
  if (redirection) issues.push(redirection);

  const shellInvoke = detectShellInvocation(command);
  if (shellInvoke) issues.push(shellInvoke);

  const quoteDesync = detectQuoteDesync(command);
  if (quoteDesync) issues.push(quoteDesync);

  const pipeToShell = detectPipeToShell(command);
  if (pipeToShell) issues.push(pipeToShell);

  const nonShell = detectNonShellExpression(command);
  if (nonShell) issues.push(nonShell);

  const destructiveRm = detectDestructiveRemoval(command);
  if (destructiveRm) issues.push(destructiveRm);

  let riskLevel: "safe" | "moderate" | "dangerous" =
    issues.length === 0 ? "safe" :
    issues.some((i) =>
      i.includes("injection") || i.includes("shell invocation") || i.includes("sensitive system path") || i.includes("pipes to shell") || i.includes("destructive removal")
    )
      ? "dangerous"
      : "moderate";

  // Sudo commands are at least moderate risk
  if (/\bsudo\b/.test(command) && riskLevel === "safe") {
    riskLevel = "moderate";
  }

  return { safe: issues.length === 0, issues, riskLevel };
}

// ─── Write Validation ───────────────────────────────────────────

export function validateFileWritePath(filePath: string, workingDirectory: string, additionalDirs?: string[]): PermissionResult {
  if (!isAbsolute(filePath)) {
    return {
      allowed: false,
      reason: `File path must be absolute, got: ${filePath}`,
    };
  }

  let resolved = resolve(filePath);

  // Resolve symlinks to prevent directory traversal via symlink chains
  try {
    if (existsSync(resolved)) {
      // File exists — resolve the full path including the final component
      // This prevents symlink attacks where the file itself is a symlink
      // (e.g., /tmp/project/secret.txt -> /etc/passwd)
      resolved = realpathSync(resolved);
    } else {
      // File doesn't exist yet — resolve the parent directory only
      const dir = resolved.split("/").slice(0, -1).join("/");
      if (dir && existsSync(dir)) {
        const realDir = realpathSync(dir);
        const basename = resolved.split("/").pop() ?? "";
        resolved = realDir + "/" + basename;
        // Check if the resolved basename itself is a symlink (TOCTOU-safe check)
        // The file doesn't exist yet, but a dangling symlink could be present
        try {
          const { lstatSync } = require("node:fs") as typeof import("node:fs");
          const lstat = lstatSync(resolve(realDir, basename));
          if (lstat.isSymbolicLink()) {
            // Dangling symlink — resolve its target to prevent symlink-based traversal
            const target = require("node:fs").readlinkSync(resolve(realDir, basename));
            const { resolve: pathResolve, isAbsolute: pathIsAbsolute } = require("node:path") as typeof import("node:path");
            const resolvedTarget = pathIsAbsolute(target) ? target : pathResolve(realDir, target);
            resolved = resolvedTarget;
          }
        } catch (err) {
          log.debug("permissions", `Symlink check failed for ${resolve(realDir, basename)}: ${err}`);
        }
      }
    }
  } catch (err) {
    log.debug("permissions", `Realpath resolution failed for ${filePath}: ${err}`);
  }

  // Block writes to system directories (checked first for specific error messages)
  const PROTECTED_DIRS = [
    "/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64",
    "/boot", "/proc", "/sys", "/dev", "/var/run", "/var/lock",
  ];
  for (const dir of PROTECTED_DIRS) {
    if (resolved.startsWith(dir + "/") || resolved === dir) {
      return {
        allowed: false,
        reason: `Write blocked: "${resolved}" is in a protected system directory`,
      };
    }
  }

  // Block writes to sensitive home directory dotfiles/dirs
  const home = process.env.HOME ?? "/root";
  const SENSITIVE_HOME_PATTERNS = [
    ".ssh", ".gnupg", ".gpg", ".aws", ".azure", ".kube", ".docker",
    ".config/gcloud", ".config/gh",
    ".npmrc", ".pypirc", ".netrc", ".git-credentials",
  ];
  for (const pattern of SENSITIVE_HOME_PATTERNS) {
    const fullPath = `${home}/${pattern}`;
    if (resolved.startsWith(fullPath + "/") || resolved === fullPath) {
      return {
        allowed: false,
        reason: `Write blocked: "${pattern}" contains sensitive credentials`,
      };
    }
  }

  // Block writes outside the working directory (unless explicitly to /tmp or an additional dir)
  const inAdditionalDir = additionalDirs?.some((d) => resolved.startsWith(d)) ?? false;
  if (!resolved.startsWith(workingDirectory) && !resolved.startsWith("/tmp") && !inAdditionalDir) {
    return {
      allowed: false,
      reason: `Write blocked: path "${resolved}" is outside working directory "${workingDirectory}"`,
    };
  }

  // Block writes to dotfiles that control shell/tool behavior
  const basename = resolved.split("/").pop() ?? "";
  const sensitiveFiles = [
    ".env", ".env.local", ".env.production",
    ".bashrc", ".zshrc", ".profile", ".bash_profile", ".zprofile",
    ".gitconfig", ".gitignore_global",
  ];
  if (sensitiveFiles.includes(basename)) {
    return {
      allowed: false,
      reason: `Write blocked: "${basename}" is a sensitive configuration file`,
    };
  }

  return { allowed: true };
}
