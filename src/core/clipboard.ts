// KCode - Clipboard Integration
// Copy text to system clipboard using available CLI tools

// ─── Clipboard Command Detection ────────────────────────────────

const CLIPBOARD_COMMANDS = [
  { command: "xclip", args: ["-selection", "clipboard"] },
  { command: "xsel", args: ["--clipboard", "--input"] },
  { command: "wl-copy", args: [] },
];

/**
 * Detect which clipboard command is available on this system.
 * Returns the command name or null if none found.
 */
export function getClipboardCommand(): string | null {
  for (const { command } of CLIPBOARD_COMMANDS) {
    try {
      const result = Bun.spawnSync(["which", command], {
        stdout: "pipe",
        stderr: "pipe",
      });
      if (result.exitCode === 0) {
        return command;
      }
    } catch {
      // Command not found, try next
    }
  }
  return null;
}

// ─── Copy to Clipboard ─────────────────────────────────────────

/**
 * Copy text to the system clipboard.
 * Tries xclip, xsel, and wl-copy in order.
 * @returns true if text was successfully copied, false otherwise
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  for (const { command, args } of CLIPBOARD_COMMANDS) {
    try {
      const proc = Bun.spawn([command, ...args], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });

      // Write text to stdin
      proc.stdin.write(text);
      proc.stdin.flush();
      proc.stdin.end();

      // Wait for the process to finish
      const exitCode = await proc.exited;

      if (exitCode === 0) {
        return true;
      }
    } catch {
      // Command failed or not found, try next
    }
  }

  return false;
}
