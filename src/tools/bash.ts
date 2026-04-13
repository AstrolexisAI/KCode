// KCode - Bash Tool
// Executes shell commands with timeout and sandboxing

import { spawn } from "node:child_process";
import { existsSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  auditGuardsEnabled,
  extractBashGrepPattern,
  extractBashReadTargets,
  extractRedirectionTargets,
  isAuditFilename,
} from "../core/audit-guards";
import { log } from "../core/logger";
import {
  getDefaultSandboxConfig,
  isSandboxAvailable,
  type SandboxMode,
  wrapWithSandbox,
} from "../core/sandbox";
import type { BashInput, ToolDefinition, ToolResult } from "../core/types";

const MAX_TIMEOUT = 600_000; // 10 minutes
const DEFAULT_TIMEOUT = 120_000; // 2 minutes

/**
 * Strip dangerous ANSI escape sequences from command output.
 * Preserves basic SGR color codes (ESC[...m) but removes:
 * - OSC (title bar injection): ESC]...ST
 * - CSI cursor/screen manipulation: ESC[...H, ESC[...J, ESC[...K, etc.
 * - DCS, PM, APC sequences
 */
function stripDangerousEscapes(text: string): string {
  // Remove OSC sequences: ESC ] ... (BEL or ST)
  text = text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
  // Remove DCS: ESC P ... ST
  text = text.replace(/\x1bP[^\x1b]*\x1b\\/g, "");
  // Remove APC: ESC _ ... ST
  text = text.replace(/\x1b_[^\x1b]*\x1b\\/g, "");
  // Remove PM: ESC ^ ... ST
  text = text.replace(/\x1b\^[^\x1b]*\x1b\\/g, "");
  // Remove dangerous CSI (cursor movement, screen clearing) but preserve SGR (colors: ESC[...m)
  text = text.replace(/\x1b\[[0-9;]*[ABCDEFGHJKLMPSTXZfhlnsu]/g, "");
  return text;
}

export const bashDefinition: ToolDefinition = {
  name: "Bash",
  description:
    "Executes a given bash command and returns its output.\n\n" +
    "The working directory persists between commands, but shell state does not. The shell environment is initialized from the user's profile (bash or zsh).\n\n" +
    "IMPORTANT: Avoid using this tool to run `find`, `grep`, `cat`, `head`, `tail`, `sed`, `awk`, or `echo` commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user:\n\n" +
    " - File search: Use Glob (NOT find or ls)\n" +
    " - Content search: Use Grep (NOT grep or rg)\n" +
    " - Read files: Use Read (NOT cat/head/tail)\n" +
    " - Edit files: Use Edit (NOT sed/awk)\n" +
    " - Write files: Use Write (NOT echo >/cat <<EOF)\n" +
    " - Communication: Output text directly (NOT echo/printf)\n\n" +
    "While the Bash tool can do similar things, it's better to use the built-in tools as they provide a better user experience and make it easier to review tool calls and give permission.\n\n" +
    "# Instructions\n" +
    " - If your command will create new directories or files, first use this tool to run `ls` to verify the parent directory exists and is the correct location.\n" +
    " - Always quote file paths that contain spaces with double quotes in your command (e.g., cd \"path with spaces/file.txt\")\n" +
    " - Try to maintain your current working directory throughout the session by using absolute paths and avoiding usage of `cd`. You may use `cd` if the User explicitly requests it.\n" +
    " - This is a non-interactive shell — there is no TTY. Always use non-interactive flags (--yes, -y, --no-input, etc.) for commands that would otherwise prompt for input.\n" +
    " - For commands requiring elevated privileges, use 'sudo <command>' WITHOUT the -S flag — the system will prompt the user securely. NEVER pipe passwords, use here-strings, or pass passwords via variables to sudo.\n" +
    " - You may specify an optional timeout in milliseconds (up to 600000ms / 10 minutes). By default, your command will timeout after 120000ms (2 minutes).\n" +
    " - You can use the `run_in_background` parameter to run the command in the background. Only use this if you don't need the result immediately.",
  input_schema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command to execute" },
      description: { type: "string", description: "Description of what the command does" },
      timeout: { type: "number", description: "Timeout in milliseconds (max 600000)" },
      run_in_background: {
        type: "boolean",
        description: "Run in background, return after initial output",
      },
      sandbox: {
        type: "boolean",
        description:
          "Enable OS-level sandbox isolation via bwrap (defaults to true when bwrap is available and permission mode is not 'auto')",
      },
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

/** Optional callback for streaming output chunks in real-time */
export type BashStreamCallback = (chunk: string) => void;

/** Global stream callback — set by the conversation loop before executing Bash, cleared after */
let _streamCallback: BashStreamCallback | undefined;

export function setBashStreamCallback(cb: BashStreamCallback | undefined): void {
  _streamCallback = cb;
}

// ─── Sudo Password Handling ────────────────────────────────────
/** Callback for prompting user for sudo password (set by UI layer) */
export type SudoPasswordPromptFn = () => Promise<string | null>;

let _sudoPasswordPromptFn: SudoPasswordPromptFn | undefined;
let _cachedSudoPassword: Buffer | null = null;
let _sudoPasswordCacheTime = 0;
const SUDO_PASSWORD_CACHE_TTL = 60 * 1000; // 1 minute (reduced from 5 for security)
let _sudoPromptInFlight: Promise<string | null> | null = null; // mutex for concurrent prompts

export function setSudoPasswordPromptFn(fn: SudoPasswordPromptFn | undefined): void {
  _sudoPasswordPromptFn = fn;
}

/** Convert Buffer back to string for use — caller should avoid retaining the string */
function _getSudoPasswordString(): string | null {
  if (!_cachedSudoPassword) return null;
  return _cachedSudoPassword.toString("utf-8");
}

export function clearSudoPasswordCache(): void {
  // Explicitly zero out the buffer before releasing it
  if (_cachedSudoPassword) {
    _cachedSudoPassword.fill(0);
  }
  _cachedSudoPassword = null;
  _sudoPasswordCacheTime = 0;
  // Clean up any leftover askpass scripts
  try {
    for (const f of readdirSync("/tmp")) {
      if (f.startsWith(".kcode-askpass-")) {
        try {
          unlinkSync(`/tmp/${f}`);
        } catch (err) {
          log.debug("bash", `Failed to clean up askpass script /tmp/${f}: ${err}`);
        }
      }
    }
  } catch (err) {
    log.debug("bash", `Failed to list /tmp for askpass cleanup: ${err}`);
  }
}

// ─── Security Tool Registry ───────────────────────────────────
const SECURITY_TOOLS: Record<string, { category: string; timeout: number; notes: string }> = {
  msfconsole: {
    category: "exploit",
    timeout: 300_000,
    notes: "Use -r script.rc for resource scripts",
  },
  nmap: {
    category: "scanner",
    timeout: 300_000,
    notes: "Use --max-retries and --host-timeout for large scans",
  },
  nikto: { category: "scanner", timeout: 300_000, notes: "Web vulnerability scanner" },
  sqlmap: { category: "exploit", timeout: 300_000, notes: "SQL injection tool" },
  hydra: { category: "bruteforce", timeout: 300_000, notes: "Brute force tool" },
  john: { category: "bruteforce", timeout: 300_000, notes: "Password cracker" },
  hashcat: { category: "bruteforce", timeout: 300_000, notes: "GPU password cracker" },
  aircrack: { category: "wireless", timeout: 300_000, notes: "Wireless security" },
  "aircrack-ng": { category: "wireless", timeout: 300_000, notes: "Wireless security" },
  gobuster: { category: "scanner", timeout: 300_000, notes: "Directory/DNS brute forcer" },
  dirb: { category: "scanner", timeout: 300_000, notes: "Web content scanner" },
  wfuzz: { category: "scanner", timeout: 300_000, notes: "Web fuzzer" },
  masscan: { category: "scanner", timeout: 300_000, notes: "Fast port scanner" },
  responder: { category: "mitm", timeout: 300_000, notes: "LLMNR/NBT-NS poisoner" },
  crackmapexec: { category: "exploit", timeout: 300_000, notes: "SMB/AD exploitation" },
  enum4linux: { category: "scanner", timeout: 300_000, notes: "SMB enumeration" },
  metasploit: { category: "exploit", timeout: 300_000, notes: "Use msfconsole -r script.rc" },
  searchsploit: { category: "scanner", timeout: 120_000, notes: "Exploit database search" },
  setoolkit: { category: "exploit", timeout: 300_000, notes: "Social engineering toolkit" },
  beef: { category: "exploit", timeout: 300_000, notes: "Browser exploitation framework" },
  wireshark: { category: "sniffer", timeout: 300_000, notes: "Network protocol analyzer" },
  tshark: { category: "sniffer", timeout: 300_000, notes: "Terminal network analyzer" },
  tcpdump: { category: "sniffer", timeout: 300_000, notes: "Packet capture" },
};

export async function executeBash(input: Record<string, unknown>): Promise<ToolResult> {
  const { command, timeout, run_in_background, sandbox } = input as unknown as BashInput & {
    sandbox?: boolean;
  };
  const timeoutMs = Math.min(timeout ?? DEFAULT_TIMEOUT, MAX_TIMEOUT);
  const startTime = Date.now();
  const cmdPrefix = command.length > 80 ? command.slice(0, 80) + "..." : command;

  // Record Bash-as-Read and Bash-as-Grep so they count toward the audit
  // reconnaissance minimums. Without this, `cat foo.cpp` via Bash would
  // bypass recordRead() (which is only called from the Read tool) and the
  // model could pile up reads via Bash that never count toward the
  // source-read minimum.
  try {
    const readTargets = extractBashReadTargets(command);
    if (readTargets.length > 0) {
      import("../core/session-tracker.js").then((m) => {
        for (const t of readTargets) m.recordRead(t);
      });
    }
    const grepPattern = extractBashGrepPattern(command);
    if (grepPattern) {
      import("../core/session-tracker.js").then((m) => {
        m.recordGrep();
      });
    }
  } catch {
    /* best-effort tracking */
  }

  // Guard: block shell-redirection writes to audit report filenames.
  // Prevents the model from bypassing the Write tool's audit guards by
  // using `cat > AUDIT_REPORT.md << EOF`, `echo ... > FIXES_SUMMARY.txt`,
  // or `tee FINAL_AUDIT.md`. Skip when audit guards are globally disabled.
  if (auditGuardsEnabled()) try {
    const redirTargets = extractRedirectionTargets(command);
    const auditTargets = redirTargets.filter((t) => isAuditFilename(t));
    if (auditTargets.length > 0) {
      const target = auditTargets[0]!;
      const absTarget = resolve(target);
      const dir = dirname(absTarget);
      // Scan dir for existing audit-named files
      let existing: string | null = null;
      if (existsSync(dir)) {
        try {
          for (const entry of readdirSync(dir)) {
            if (isAuditFilename(entry) && entry !== basename(absTarget)) {
              existing = join(dir, entry);
              break;
            }
          }
        } catch {
          /* dir not readable */
        }
      }
      const bullet = existing
        ? `An audit report already exists at "${existing}". UPDATE it with Edit, don't create companions.`
        : `Use the Write tool to create "${target}" — not Bash redirection. The Write tool enforces audit discipline.`;
      return {
        tool_use_id: "",
        content:
          `BLOCKED — FILE NOT CREATED: Shell redirection to audit-report file ` +
          `"${basename(target)}" is refused. ${bullet}\n\nAudit reports must go ` +
          `through the Write tool, which enforces:\n` +
          `  - at least one Grep reconnaissance pass before the report\n` +
          `  - at least 8 source files Read in full\n` +
          `  - no fabricated "proof of work" checklists\n` +
          `  - no uncited file:line references\n` +
          `  - one authoritative AUDIT_REPORT.md per directory\n\n` +
          `IMPORTANT: The file does NOT exist. Do NOT tell the user that the ` +
          `audit was "created" or "generated" — retry with the Write tool first.`,
        is_error: true,
      };
    }
  } catch {
    /* redirection analysis is best-effort */
  }

  // Guard: block dangerous pkill/killall with broad patterns that could kill system services
  // Matches: pkill -f "serve", pkill serve, killall node, etc. anywhere in the command
  const dangerousKillMatch = command.match(
    /\b(pkill|killall)\s+(?:-\w+\s+)*["']?(serve|server|node|npx|npm|python|bun|java|ruby|llama)["']?/i,
  );
  if (dangerousKillMatch) {
    const pattern = dangerousKillMatch[2];
    log.warn("tool", `Blocked dangerous kill pattern "${pattern}": ${cmdPrefix}`);
    return {
      tool_use_id: "",
      content: `BLOCKED: You used "${dangerousKillMatch[0]}" which matches too broadly and could kill critical system processes (e.g. "serve" matches "llama-server"). Instead use: kill $(lsof -ti :PORT) to kill by port, or pkill -f "python3 -m http.server" with the EXACT full command.`,
      is_error: true,
    };
  }

  // Guard: block ALL password injection to sudo/su — never let the LLM handle passwords
  // Catches: echo X | sudo, printf X | sudo, sudo -S <<< X, sudo -S, any here-string with sudo
  const passwordInjectionBlocked =
    // echo/printf piped to sudo/su
    /\b(echo|printf)\b.*\|\s*(sudo|su)\b/i.test(command) ||
    // here-string (<<<) with sudo anywhere in the command
    /<<<.*\bsudo\b|\bsudo\b.*<<</.test(command) ||
    // LLM manually using -S flag (our system adds -S internally, the LLM should never use it)
    /\bsudo\s+(?:-\w+\s+)*-S\b/.test(command) ||
    /\bsudo\s+-\w*S/.test(command) ||
    // Variable assignment followed by piping to sudo (PASS="x"; echo $PASS | sudo)
    /\b\w+="[^"]*".*\|\s*sudo\b/.test(command) ||
    /\b\w+='[^']*'.*\|\s*sudo\b/.test(command);

  if (passwordInjectionBlocked) {
    log.warn("tool", `Blocked password injection to sudo/su: ${cmdPrefix}`);
    return {
      tool_use_id: "",
      content: `BLOCKED: Detected password injection to sudo/su. Do NOT use -S flag, echo/printf piping, here-strings (<<<), or variable-based password passing with sudo. Instead, use "sudo <command>" normally (without -S) — the system will securely prompt the user for their password via a masked input dialog.`,
      is_error: true,
    };
  }

  // ─── Security tool guardrails ──────────────────────────────────
  // Extract the actual command name, skipping prefixes like sudo, timeout, env, nice, etc.
  const cmdWords = command.trimStart().split(/\s+/);
  let cmdIdx = 0;
  while (cmdIdx < cmdWords.length) {
    const w = cmdWords[cmdIdx];
    if (w === "sudo" || w === "env" || w === "nice") {
      cmdIdx++;
      continue;
    }
    if (w === "timeout" && cmdIdx + 1 < cmdWords.length && /^\d/.test(cmdWords[cmdIdx + 1]!)) {
      cmdIdx += 2;
      continue;
    }
    break;
  }
  const baseSecCmd = cmdWords[cmdIdx] ?? "";
  const secToolInfo = SECURITY_TOOLS[baseSecCmd];
  let effectiveTimeoutMs = timeoutMs;

  if (secToolInfo) {
    log.info("tool", `Security tool detected: ${baseSecCmd} (${secToolInfo.category})`);

    // msfconsole: require resource script mode or -x for non-interactive use
    if (baseSecCmd === "msfconsole" && !command.includes("-r ") && !command.includes("-x ")) {
      return {
        tool_use_id: "",
        content: `BLOCKED: msfconsole must be run in non-interactive mode. Use one of:\n  • msfconsole -q -r script.rc  (resource script)\n  • msfconsole -q -x "commands"  (inline commands)\nCreate an .rc file with your commands first, or use -x with semicolon-separated commands. This shell has no TTY for interactive use.`,
        is_error: true,
      };
    }

    // Override timeout for security tools (they often take longer)
    effectiveTimeoutMs = Math.max(timeoutMs, secToolInfo.timeout);
  }

  // ─── Sudo password handling ────────────────────────────────────
  const containsSudo = /\bsudo\b/.test(command);
  let sudoPassword: string | null = null;

  if (containsSudo) {
    // Check cached password first
    if (_cachedSudoPassword && Date.now() - _sudoPasswordCacheTime < SUDO_PASSWORD_CACHE_TTL) {
      sudoPassword = _getSudoPasswordString();
    } else {
      // Clear expired cache with secure zeroing
      if (_cachedSudoPassword) {
        _cachedSudoPassword.fill(0);
        _cachedSudoPassword = null;
      }
      if (_sudoPasswordPromptFn) {
        // Serialize concurrent sudo prompts to avoid multiple prompts + race on cache
        if (_sudoPromptInFlight) {
          sudoPassword = await _sudoPromptInFlight;
        } else {
          _sudoPromptInFlight = _sudoPasswordPromptFn();
          try {
            sudoPassword = await _sudoPromptInFlight;
          } finally {
            _sudoPromptInFlight = null;
          }
        }
        if (sudoPassword === null) {
          return {
            tool_use_id: "",
            content: "Sudo command cancelled: user did not provide password.",
            is_error: true,
          };
        }
        // Store as Buffer for secure memory handling
        _cachedSudoPassword = Buffer.from(sudoPassword, "utf-8");
        _sudoPasswordCacheTime = Date.now();
      }
    }
    // If no prompt function available, sudo will fail naturally (no TTY)
  }

  // Detect background commands (ending with & OR run_in_background flag)
  // Auto-detect server/daemon commands that would block forever
  const isServerCommand =
    /\b(http\.server|SimpleHTTPServer|serve|live-server|nodemon|uvicorn|gunicorn|flask\s+run|php\s+-S|ruby\s+-run|caddy\s+run|nginx|apache)\b/.test(
      command,
    ) && !/&\s*$/.test(command.trim()); // only if not already backgrounded
  if (isServerCommand) {
    log.info("tool", `Auto-backgrounding server command: ${cmdPrefix}`);
  }

  // Guard: detect server commands using Chrome-blocked ports
  // ONLY applies to actual server commands — NOT to client tools, scripts, or general commands.
  // The `:(\d+)` regex pattern causes false positives on Python/Ruby source code (dict literals,
  // socket constants, etc.), so we restrict this check to identified server commands only.
  if (isServerCommand) {
    const CHROME_BLOCKED_PORTS = new Set([
      1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 77, 79, 87, 95, 101, 102,
      103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 139, 143, 179, 389, 427, 465, 512, 513,
      514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 993, 995, 1719, 1720,
      1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080,
    ]);
    const portMatch = command.match(/(?:-[plP]\s*|--port[= ]\s*|-l\s+|:)(\d{2,5})\b/);
    if (portMatch) {
      const port = parseInt(portMatch[1]!, 10);
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
  }
  const isBackground = run_in_background || /&\s*$/.test(command.trim()) || isServerCommand;

  // ─── Background commands ───────────────────────────────────────
  // Strategy: wrap the command so bash itself handles backgrounding.
  // We run: `( <command> ) > /dev/null 2>&1 &` via nohup-style detach,
  // but first capture initial output for ~3 seconds via a temp file.
  if (isBackground) {
    return new Promise((resolve) => {
      const tmpDir = "/tmp/kcode-bg";
      const tmpLog = `${tmpDir}/bg-${Date.now()}-${require("node:crypto").randomBytes(4).toString("hex")}.log`;

      // For background sudo commands, inject password via SUDO_ASKPASS
      let bgCommand = command;
      if (sudoPassword && containsSudo) {
        const crypto = require("node:crypto") as typeof import("node:crypto");
        const fs = require("node:fs") as typeof import("node:fs");
        // 128-bit UUID entropy, not bruteforceable
        const uid = crypto.randomUUID();
        const bgAskpass = `/tmp/.kcode-askpass-${uid}`;
        // Atomic creation with O_EXCL prevents symlink attacks
        try {
          const fd = fs.openSync(
            bgAskpass,
            fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
            0o600,
          );
          try {
            // Write password directly, no base64 obfuscation
            const script = `#!/bin/sh\nprintf '%s' '${sudoPassword.replace(/'/g, "'\\''")}'\n`;
            fs.writeSync(fd, script);
          } finally {
            fs.closeSync(fd);
          }
        } catch (err) {
          throw new Error(`Failed to create askpass script: ${(err as Error).message}`);
        }
        bgCommand = bgCommand.replace(/\bsudo\b(?!\s+-\S*[AS])/g, "sudo -A");
        bgCommand = `SUDO_ASKPASS=${bgAskpass} ${bgCommand} ; rm -f ${bgAskpass}`;
      }

      // Wrapper script:
      // 1. Start the real command, teeing output to a temp file
      // 2. After the command starts, the parent bash exits
      // The real command keeps running because nohup + disown detaches it
      const wrapper = `
        mkdir -p ${tmpDir}
        nohup bash -c ${shellEscape(bgCommand)} > ${tmpLog} 2>&1 &
        BG_PID=$!
        disown $BG_PID
        echo "PID: $BG_PID"
        sleep 3
        cat ${tmpLog} 2>/dev/null
        rm -f ${tmpLog}
      `;

      const isWin = process.platform === "win32";
      const proc = isWin
        ? spawn("cmd.exe", ["/C", command], {
            cwd: process.cwd(),
            env: { ...process.env },
            timeout: 15_000,
          })
        : spawn("bash", ["-c", wrapper], {
            cwd: process.cwd(),
            env: { ...process.env },
            timeout: 15_000, // 15s max for the wrapper itself
          });

      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];

      proc.stdout.on("data", (data: Buffer) => chunks.push(data));
      proc.stderr.on("data", (data: Buffer) => errChunks.push(data));

      proc.on("close", async (_code) => {
        const stdout = Buffer.concat(chunks).toString("utf-8").trim();
        const stderr = Buffer.concat(errChunks).toString("utf-8").trim();
        const output = stdout + (stderr ? `\n${stderr}` : "");
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        log.debug("tool", `Bash (background) returned in ${duration}s: ${cmdPrefix}`);

        // Operator-mind: when the spawned command is a known long-running
        // server, do not trust the wrapper's "PID: X" output. Probe the
        // server over HTTP and report a real failure if it isn't actually
        // serving traffic. Without this, broken servers silently report
        // success and the model loops re-spawning them.
        try {
          const { verifyBackgroundSpawn, extractPidFromWrapperOutput } = await import(
            "../core/bash-spawn-verifier.js"
          );
          const pid = extractPidFromWrapperOutput(output);
          const verdict = await verifyBackgroundSpawn(command, pid, output, process.cwd());
          if (verdict) {
            if (verdict.ok) {
              resolve({
                tool_use_id: "",
                content: `${output}\n\n✓ ${verdict.report}`,
              });
              return;
            }
            resolve({
              tool_use_id: "",
              content: `${output}\n\n${verdict.report}`,
              is_error: true,
            });
            return;
          }
        } catch (err) {
          log.debug("tool", `bash-spawn-verifier failed (non-fatal): ${err}`);
        }

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
  // Sandbox is enabled when:
  //   1. _sandboxMode is not "off"
  //   2. The sandbox input option is not explicitly false
  //   3. Permission mode "auto" skips sandbox (implies full trust)
  //   4. Sudo commands skip sandbox (sudo needs system access)
  let finalCommand = command;
  let sandboxEnv: Record<string, string> | undefined;
  const useSandbox = sandbox !== false && _sandboxMode !== "off" && !containsSudo;
  if (useSandbox) {
    const sandboxConfig = getDefaultSandboxConfig(_sandboxMode, process.cwd());
    const wrapped = wrapWithSandbox(command, sandboxConfig);
    finalCommand = wrapped.command;
    sandboxEnv = wrapped.env;
  }

  // Rewrite sudo for password injection
  // Heredocs (<<) redirect stdin, which blocks sudo -S password injection.
  // In that case, use SUDO_ASKPASS with a temp script instead.
  const hasHeredoc = /<<[-~]?\s*['"]?\w+['"]?/.test(command);
  let useAskpass = false;

  let askpassPath: string | null = null;

  if (sudoPassword && containsSudo) {
    if (hasHeredoc) {
      // SUDO_ASKPASS approach: heredocs redirect stdin, blocking sudo -S.
      // Write a temp askpass script via Node.js fs (password never in command line).
      useAskpass = true;
      askpassPath = `/tmp/.kcode-askpass-${require("node:crypto").randomBytes(8).toString("hex")}`;
      const b64Pw = Buffer.from(sudoPassword).toString("base64");
      writeFileSync(
        askpassPath,
        `#!/bin/sh\nprintf '%s' "$(printf '%s' '${b64Pw}' | base64 --decode)"\n`,
        { mode: 0o700 },
      );
      const rewrittenCmd = finalCommand.replace(/\bsudo\b(?!\s+-\S*[AS])/g, "sudo -A");
      finalCommand = `SUDO_ASKPASS=${askpassPath} ${rewrittenCmd} ; _krc=$?; rm -f ${askpassPath}; exit $_krc`;
    } else {
      finalCommand = finalCommand.replace(/\bsudo\b(?!\s+-\S*S)/g, "sudo -S");
    }
  }

  // ─── Normal (foreground) commands ──────────────────────────────
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let resolved = false;
    let timedOut = false;

    const isWin = process.platform === "win32";
    const proc = isWin
      ? spawn("cmd.exe", ["/C", finalCommand], {
          cwd: process.cwd(),
          env: { ...process.env, ...sandboxEnv },
        })
      : spawn("bash", ["-c", finalCommand], {
          cwd: process.cwd(),
          env: { ...process.env, ...sandboxEnv },
          detached: true, // create process group so we can kill entire tree
        });

    // Inject sudo password via stdin if available (only when NOT using askpass)
    if (sudoPassword && containsSudo && !useAskpass && proc.stdin) {
      // Count sudo invocations — each sudo -S reads one line from stdin
      const sudoCount = (finalCommand.match(/\bsudo\b/g) ?? []).length;
      const passwordLines = (sudoPassword + "\n").repeat(sudoCount);
      proc.stdin.write(passwordLines);
      proc.stdin.end();
    }

    // Manual timeout that kills the entire process group (bash + all children)
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        // Kill entire process group with SIGKILL (negative PID = process group)
        if (proc.pid) {
          if (process.platform === "win32") {
            try {
              Bun.spawnSync(["taskkill", "/PID", proc.pid.toString(), "/T", "/F"], {
                stdout: "pipe",
                stderr: "pipe",
              });
            } catch (err) {
              log.debug("bash", `Failed to taskkill PID ${proc.pid}: ${err}`);
            }
          } else {
            process.kill(-proc.pid, "SIGKILL");
          }
        }
      } catch (err) {
        log.debug("bash", `Failed to kill process group on timeout: ${err}`);
      }
      // Clean up askpass script on timeout
      if (askpassPath) {
        try {
          unlinkSync(askpassPath);
        } catch (err) {
          log.debug("bash", `Failed to clean up askpass on timeout: ${err}`);
        }
      }
      if (!resolved) {
        resolved = true;
        const stdout = Buffer.concat(chunks).toString("utf-8");
        const stderr = Buffer.concat(errChunks).toString("utf-8");
        const output = stdout + (stderr ? `\n${stderr}` : "");
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        log.warn("tool", `Bash timed out after ${duration}s: ${cmdPrefix}`);
        resolve({
          tool_use_id: "",
          content:
            (output ? output + "\n\n" : "") +
            `TIMED OUT after ${duration}s. The command took too long. If running tests, check for infinite loops or hanging processes. Try adding a timeout flag or running fewer tests.`,
          is_error: true,
        });
      }
    }, effectiveTimeoutMs);

    // Noise filter for streaming — applied in real-time to stderr for security/sudo commands
    const streamNoiseFilter =
      secToolInfo || containsSudo
        ? /^stty:.*(?:Función ioctl|Inappropriate ioctl).*$|^\[sudo\] (?:password for|contraseña para) .*:.*$/gm
        : null;

    const streamCb = _streamCallback;
    proc.stdout.on("data", (data: Buffer) => {
      chunks.push(data);
      if (streamCb) {
        try {
          streamCb(data.toString("utf-8"));
        } catch (err) {
          log.debug("bash", `Stream callback error (stdout): ${err}`);
        }
      }
    });
    proc.stderr.on("data", (data: Buffer) => {
      errChunks.push(data);
      if (streamCb) {
        try {
          let text = data.toString("utf-8");
          if (streamNoiseFilter) {
            text = text
              .replace(streamNoiseFilter, "")
              .replace(/\n{3,}/g, "\n")
              .trim();
            streamNoiseFilter.lastIndex = 0; // reset regex state for next chunk
          }
          if (text) streamCb(text);
        } catch (err) {
          log.debug("bash", `Stream callback error (stderr): ${err}`);
        }
      }
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      // Always clean up askpass script on process exit (belt-and-suspenders with inline rm -f)
      if (askpassPath) {
        try {
          unlinkSync(askpassPath);
        } catch (err) {
          log.debug("bash", `Failed to clean up askpass on close: ${err}`);
        }
      }
      if (resolved) return;
      resolved = true;
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      log.debug("tool", `Bash executed in ${duration}s (exit ${code}): ${cmdPrefix}`);
      const stdout = Buffer.concat(chunks).toString("utf-8");
      let stderr = Buffer.concat(errChunks).toString("utf-8");

      // Filter noise from security tools running without a TTY
      if (secToolInfo || containsSudo) {
        const noisePatterns =
          /^stty:.*Función ioctl.*$|^stty:.*Inappropriate ioctl.*$|^\[sudo\] (?:password for|contraseña para) .*:.*$/gm;
        stderr = stderr
          .replace(noisePatterns, "")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
      }

      const rawOutput = stdout + (stderr ? `\n${stderr}` : "");
      // Strip dangerous terminal escape sequences (title bar injection, cursor manipulation)
      const output = stripDangerousEscapes(rawOutput);

      // Auto-detect project creation: if a scaffold command succeeded and
      // we're still in ~, update the workspace to the new project directory.
      if (code === 0) {
        try {
          const { getToolWorkspace, setToolWorkspace } = require("./workspace");
          const { resolve: resolvePath } = require("node:path");
          const { existsSync, statSync: statSyncFn } = require("node:fs");
          const home = process.env.HOME ?? "";
          const workspace = getToolWorkspace();
          if (home && resolvePath(workspace) === resolvePath(home)) {
            // Check if the command created a project directory
            const scaffoldMatch = command.match(
              /\b(?:bun\s+create|npx\s+create-[\w-]+|npm\s+init)\s+\S+\s+(\S+)/,
            );
            const mkdirMatch = command.match(/\bmkdir\s+(?:-p\s+)?(\S+)/);
            const targetDir = scaffoldMatch?.[1] ?? mkdirMatch?.[1];
            if (targetDir) {
              const fullPath = resolvePath(process.cwd(), targetDir);
              if (existsSync(fullPath) && statSyncFn(fullPath).isDirectory()) {
                setToolWorkspace(fullPath);
                process.chdir(fullPath);
                log.info("tool", `Auto-updated workspace to: ${fullPath}`);
              }
            }
          }
        } catch (err) {
          log.debug("tool", `Workspace auto-detect failed: ${err}`);
        }
      }

      resolve({
        tool_use_id: "",
        content: output || `(exit code ${code})`,
        is_error: code !== 0,
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      if (askpassPath) {
        try {
          unlinkSync(askpassPath);
        } catch (err2) {
          log.debug("bash", `Failed to clean up askpass on error: ${err2}`);
        }
      }
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
