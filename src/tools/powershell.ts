// KCode - PowerShell Tool
// Executes PowerShell commands on Windows, falls back to Bash on Unix

import { spawn } from "node:child_process";
import { log } from "../core/logger";
import { isWindows } from "../core/platform";
import type { BashInput, ToolDefinition, ToolResult } from "../core/types";

const MAX_TIMEOUT = 600_000; // 10 minutes
const DEFAULT_TIMEOUT = 120_000; // 2 minutes

export const powershellDefinition: ToolDefinition = {
  name: "PowerShell",
  description:
    "Execute a PowerShell command on Windows or a shell command on Unix. On Windows, uses powershell.exe -NoProfile -NonInteractive -Command. On other platforms, falls back to bash -c. Use this tool when you need Windows-native command execution.",
  input_schema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command to execute" },
      description: { type: "string", description: "Description of what the command does" },
      timeout: { type: "number", description: "Timeout in milliseconds (max 600000)" },
    },
    required: ["command"],
  },
};

// ─── Dangerous PowerShell Patterns ──────────────────────────────

/**
 * Patterns that indicate potentially destructive PowerShell commands.
 * Each entry has a regex and a human-readable description.
 */
const DANGEROUS_PS_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  {
    pattern: /\bRemove-Item\b.*-Recurse\b.*-Force\b/i,
    description: "Remove-Item -Recurse -Force (recursive forced deletion)",
  },
  {
    pattern: /\bRemove-Item\b.*-Force\b.*-Recurse\b/i,
    description: "Remove-Item -Force -Recurse (recursive forced deletion)",
  },
  {
    pattern: /\bStop-Process\b.*-Force\b/i,
    description: "Stop-Process -Force (forced process termination)",
  },
  {
    pattern: /\bFormat-Volume\b/i,
    description: "Format-Volume (disk formatting)",
  },
  {
    pattern: /\bClear-Disk\b/i,
    description: "Clear-Disk (disk wipe)",
  },
  {
    pattern: /\bInitialize-Disk\b/i,
    description: "Initialize-Disk (disk initialization)",
  },
  {
    pattern: /\bStop-Computer\b/i,
    description: "Stop-Computer (system shutdown)",
  },
  {
    pattern: /\bRestart-Computer\b/i,
    description: "Restart-Computer (system reboot)",
  },
  {
    pattern: /\bSet-ExecutionPolicy\s+Unrestricted\b/i,
    description: "Set-ExecutionPolicy Unrestricted (disabling script safety)",
  },
  {
    pattern: /\bDisable-WindowsOptionalFeature\b/i,
    description: "Disable-WindowsOptionalFeature (disabling Windows features)",
  },
  {
    pattern: /\bRemove-Partition\b/i,
    description: "Remove-Partition (partition deletion)",
  },
  {
    pattern: /\bStop-Service\b.*-Force\b/i,
    description: "Stop-Service -Force (forced service stop)",
  },
  {
    pattern: /\bInvoke-Expression\b/i,
    description: "Invoke-Expression (arbitrary code execution via string eval)",
  },
  {
    pattern: /\biex\b\s/i,
    description: "iex (alias for Invoke-Expression)",
  },
  {
    pattern: /\bNew-Object\s+Net\.WebClient\b.*DownloadString\b/i,
    description: "Download and execute remote script pattern",
  },
  {
    pattern: /\breg\s+delete\b/i,
    description: "reg delete (registry deletion)",
  },
  {
    pattern: /\bRemove-ItemProperty\b.*HKLM/i,
    description: "Remove-ItemProperty on HKLM (system registry modification)",
  },
];

/**
 * Analyze a PowerShell command for dangerous patterns.
 * Returns null if safe, or a description of the danger if detected.
 */
export function analyzePowerShellSafety(command: string): string | null {
  for (const { pattern, description } of DANGEROUS_PS_PATTERNS) {
    if (pattern.test(command)) {
      return description;
    }
  }
  return null;
}

/**
 * Detect the platform and return the shell executable and arguments.
 */
export function getShellArgs(command: string): { shell: string; args: string[] } {
  if (isWindows()) {
    return {
      shell: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", command],
    };
  }
  return {
    shell: "bash",
    args: ["-c", command],
  };
}

export async function executePowerShell(input: Record<string, unknown>): Promise<ToolResult> {
  const { command, timeout } = input as unknown as BashInput;
  const timeoutMs = Math.min(timeout ?? DEFAULT_TIMEOUT, MAX_TIMEOUT);
  const startTime = Date.now();
  const cmdPrefix = command.length > 80 ? command.slice(0, 80) + "..." : command;

  // Safety check for dangerous PowerShell patterns (only on Windows)
  if (isWindows()) {
    const danger = analyzePowerShellSafety(command);
    if (danger) {
      log.warn("tool", `Blocked dangerous PowerShell command: ${danger} — ${cmdPrefix}`);
      return {
        tool_use_id: "",
        content: `BLOCKED: Detected dangerous PowerShell operation: ${danger}. This command requires explicit user approval. Please confirm you want to proceed.`,
        is_error: true,
      };
    }
  }

  const { shell, args } = getShellArgs(command);

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let resolved = false;
    let timedOut = false;

    const proc = spawn(shell, args, {
      cwd: process.cwd(),
      env: { ...process.env },
      ...(isWindows() ? {} : { detached: true }),
    });

    // Manual timeout that kills the process
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (proc.pid) {
          if (isWindows()) {
            try {
              Bun.spawnSync(["taskkill", "/PID", proc.pid.toString(), "/T", "/F"], {
                stdout: "pipe",
                stderr: "pipe",
              });
            } catch (err) {
              log.debug("powershell", `Failed to taskkill PID ${proc.pid}: ${err}`);
            }
          } else {
            process.kill(-proc.pid, "SIGKILL");
          }
        }
      } catch (err) {
        log.debug("powershell", `Failed to kill process on timeout: ${err}`);
      }
      if (!resolved) {
        resolved = true;
        const stdout = Buffer.concat(chunks).toString("utf-8");
        const stderr = Buffer.concat(errChunks).toString("utf-8");
        const output = stdout + (stderr ? `\n${stderr}` : "");
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        log.warn("tool", `PowerShell timed out after ${duration}s: ${cmdPrefix}`);
        resolve({
          tool_use_id: "",
          content:
            (output ? output + "\n\n" : "") +
            `TIMED OUT after ${duration}s. The command took too long.`,
          is_error: true,
        });
      }
    }, timeoutMs);

    proc.stdout.on("data", (data: Buffer) => {
      chunks.push(data);
    });
    proc.stderr.on("data", (data: Buffer) => {
      errChunks.push(data);
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (resolved) return;
      resolved = true;
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      log.debug("tool", `PowerShell executed in ${duration}s (exit ${code}): ${cmdPrefix}`);
      const stdout = Buffer.concat(chunks).toString("utf-8");
      const stderr = Buffer.concat(errChunks).toString("utf-8");
      const output = stdout + (stderr ? `\n${stderr}` : "");

      resolve({
        tool_use_id: "",
        content: output || `(exit code ${code})`,
        is_error: code !== 0,
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      if (resolved) return;
      resolved = true;
      resolve({
        tool_use_id: "",
        content: `Error: ${err.message}`,
        is_error: true,
      });
    });
  });
}
