// KCode - Bash Tool
// Executes shell commands with timeout and sandboxing

import { spawn } from "node:child_process";
import type { ToolDefinition, ToolResult, BashInput } from "../core/types";
import { log } from "../core/logger";
import { wrapWithSandbox, getDefaultSandboxConfig, type SandboxMode } from "../core/sandbox";

const MAX_TIMEOUT = 600_000; // 10 minutes
const DEFAULT_TIMEOUT = 120_000; // 2 minutes

export const bashDefinition: ToolDefinition = {
  name: "Bash",
  description: "Execute a shell command and return its output. IMPORTANT: This is a non-interactive shell — there is no TTY. Always use non-interactive flags (--yes, -y, --no-input, --default, etc.) for commands that prompt for input (e.g. npx create-next-app --yes, npm init -y). If a command has no non-interactive flag, pipe defaults via echo or use heredocs.",
  input_schema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command to execute" },
      description: { type: "string", description: "Description of what the command does" },
      timeout: { type: "number", description: "Timeout in milliseconds (max 600000)" },
      run_in_background: { type: "boolean", description: "Run in background, return after initial output" },
    },
    required: ["command"],
  },
};

// Sandbox mode — set via KCODE_SANDBOX env var or --sandbox flag
let _sandboxMode: SandboxMode = (process.env.KCODE_SANDBOX as SandboxMode) ?? "off";

export function setSandboxMode(mode: SandboxMode): void {
  _sandboxMode = mode;
  log.info("sandbox", `Sandbox mode set to: ${mode}`);
}

export function getSandboxMode(): SandboxMode {
  return _sandboxMode;
}

export async function executeBash(input: Record<string, unknown>): Promise<ToolResult> {
  const { command, timeout, run_in_background } = input as BashInput;
  const timeoutMs = Math.min(timeout ?? DEFAULT_TIMEOUT, MAX_TIMEOUT);
  const startTime = Date.now();
  const cmdPrefix = command.length > 80 ? command.slice(0, 80) + "..." : command;

  // Guard: block dangerous pkill/killall with broad patterns that could kill system services
  // Matches: pkill -f "serve", pkill serve, killall node, etc. anywhere in the command
  const dangerousKillMatch = command.match(/\b(pkill|killall)\s+(?:-\w+\s+)*["']?(serve|server|node|npx|npm|python|bun|java|ruby|llama)["']?/i);
  if (dangerousKillMatch) {
    const pattern = dangerousKillMatch[2];
    log.warn("tool", `Blocked dangerous kill pattern "${pattern}": ${cmdPrefix}`);
    return {
      tool_use_id: "",
      content: `BLOCKED: You used "${dangerousKillMatch[0]}" which matches too broadly and could kill critical system processes (e.g. "serve" matches "llama-server"). Instead use: kill $(lsof -ti :PORT) to kill by port, or pkill -f "python3 -m http.server" with the EXACT full command.`,
      is_error: true,
    };
  }

  // Guard: detect server commands using Chrome-blocked ports or ports below 10000
  // Chrome blocks these ports: https://chromium.googlesource.com/chromium/src/+/refs/heads/main/net/base/port_util.cc
  const CHROME_BLOCKED_PORTS = new Set([
    1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 77, 79,
    87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135,
    139, 143, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540,
    548, 554, 556, 563, 587, 601, 636, 993, 995, 1719, 1720, 1723, 2049, 3659,
    4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080,
  ]);
  const portMatch = command.match(/(?:-[plP]\s*|--port[= ]\s*|-l\s+|:)(\d{2,5})\b/);
  if (portMatch) {
    const port = parseInt(portMatch[1], 10);
    if (CHROME_BLOCKED_PORTS.has(port)) {
      return {
        tool_use_id: "",
        content: `BLOCKED: Port ${port} is blocked by Chrome/Chromium browsers (ERR_UNSAFE_PORT). The browser will refuse to connect. Use a different port (e.g. ${port < 10000 ? 10001 : port + 1}).`,
        is_error: true,
      };
    }
    if (port > 0 && port < 10000) {
      // Warn but don't block — some ports below 10000 work fine
      log.warn("tool", `Server command using port ${port} (below 10000): ${cmdPrefix}`);
    }
  }

  // Detect background commands (ending with & OR run_in_background flag)
  // Auto-detect server/daemon commands that would block forever
  const isServerCommand = /\b(http\.server|SimpleHTTPServer|serve|live-server|nodemon|uvicorn|gunicorn|flask\s+run|php\s+-S|ruby\s+-run|caddy\s+run|nginx|apache)\b/.test(command)
    && !/&\s*$/.test(command.trim()); // only if not already backgrounded
  if (isServerCommand) {
    log.info("tool", `Auto-backgrounding server command: ${cmdPrefix}`);
  }
  const isBackground = run_in_background || /&\s*$/.test(command.trim()) || isServerCommand;

  // ─── Background commands ───────────────────────────────────────
  // Strategy: wrap the command so bash itself handles backgrounding.
  // We run: `( <command> ) > /dev/null 2>&1 &` via nohup-style detach,
  // but first capture initial output for ~3 seconds via a temp file.
  if (isBackground) {
    return new Promise((resolve) => {
      const tmpDir = '/tmp/kcode-bg';
      const tmpLog = `${tmpDir}/bg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`;

      // Wrapper script:
      // 1. Start the real command, teeing output to a temp file
      // 2. After the command starts, the parent bash exits
      // The real command keeps running because nohup + disown detaches it
      const wrapper = `
        mkdir -p ${tmpDir}
        nohup bash -c ${shellEscape(command)} > ${tmpLog} 2>&1 &
        BG_PID=$!
        disown $BG_PID
        echo "PID: $BG_PID"
        sleep 3
        cat ${tmpLog} 2>/dev/null
        rm -f ${tmpLog}
      `;

      const proc = spawn("bash", ["-c", wrapper], {
        cwd: process.cwd(),
        env: { ...process.env },
        timeout: 15_000, // 15s max for the wrapper itself
      });

      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];

      proc.stdout.on("data", (data: Buffer) => chunks.push(data));
      proc.stderr.on("data", (data: Buffer) => errChunks.push(data));

      proc.on("close", (code) => {
        const stdout = Buffer.concat(chunks).toString("utf-8").trim();
        const stderr = Buffer.concat(errChunks).toString("utf-8").trim();
        const output = stdout + (stderr ? `\n${stderr}` : "");
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        log.debug("tool", `Bash (background) returned in ${duration}s: ${cmdPrefix}`);
        resolve({
          tool_use_id: "",
          content: output || "(background process started)",
        });
      });

      proc.on("error", (err) => {
        resolve({
          tool_use_id: "",
          content: `Error starting background command: ${err.message}`,
          is_error: true,
        });
      });
    });
  }

  // ─── Apply sandbox wrapping ────────────────────────────────────
  let finalCommand = command;
  let sandboxEnv: Record<string, string> | undefined;
  if (_sandboxMode !== "off") {
    const sandboxConfig = getDefaultSandboxConfig(_sandboxMode, process.cwd());
    const wrapped = wrapWithSandbox(command, sandboxConfig);
    finalCommand = wrapped.command;
    sandboxEnv = wrapped.env;
  }

  // ─── Normal (foreground) commands ──────────────────────────────
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let resolved = false;
    let timedOut = false;

    const proc = spawn("bash", ["-c", finalCommand], {
      cwd: process.cwd(),
      env: { ...process.env, ...sandboxEnv },
      detached: true, // create process group so we can kill entire tree
    });

    // Manual timeout that kills the entire process group (bash + all children)
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        // Kill entire process group with SIGKILL (negative PID = process group)
        if (proc.pid) process.kill(-proc.pid, "SIGKILL");
      } catch { /* already dead */ }
      if (!resolved) {
        resolved = true;
        const stdout = Buffer.concat(chunks).toString("utf-8");
        const stderr = Buffer.concat(errChunks).toString("utf-8");
        const output = stdout + (stderr ? `\n${stderr}` : "");
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        log.warn("tool", `Bash timed out after ${duration}s: ${cmdPrefix}`);
        resolve({
          tool_use_id: "",
          content: (output ? output + "\n\n" : "") + `TIMED OUT after ${duration}s. The command took too long. If running tests, check for infinite loops or hanging processes. Try adding a timeout flag or running fewer tests.`,
          is_error: true,
        });
      }
    }, timeoutMs);

    proc.stdout.on("data", (data: Buffer) => chunks.push(data));
    proc.stderr.on("data", (data: Buffer) => errChunks.push(data));

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (resolved) return;
      resolved = true;
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      log.debug("tool", `Bash executed in ${duration}s (exit ${code}): ${cmdPrefix}`);
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

/** Escape a string for use inside single quotes in a shell command */
function shellEscape(s: string): string {
  // Replace ' with '\'' (end quote, escaped quote, start quote)
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
