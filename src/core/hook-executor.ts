// KCode - Hook Execution Engine
// Handles running hook commands, HTTP hooks, agent hooks, and LLM prompt hooks

import { spawn } from "node:child_process";
import type { HookAction, HookConfig, HookEntry, HookMatcher, HookOutput } from "./hook-types";
import { log } from "./logger";
import { evaluatePromptHook } from "./prompt-hooks";

// ─── Constants ──────────────────────────────────────────────────

export const DEFAULT_HOOK_TIMEOUT = 10_000; // 10 seconds (new default)
export const LEGACY_HOOK_TIMEOUT = 30_000; // 30 seconds (legacy default)
const HTTP_TIMEOUT = 10_000; // 10 seconds

/** Default timeout for agent hooks (60 seconds). */
const AGENT_HOOK_TIMEOUT = 60_000;

// ─── Format Detection ───────────────────────────────────────────

/** Check if a config entry is the new HookEntry format */
export function isHookEntry(entry: HookConfig | HookEntry): entry is HookEntry {
  const t = (entry as HookEntry).type;
  return t === "command" || t === "prompt" || t === "http" || t === "agent" || t === "llm-prompt";
}

/** Check if a config entry is the legacy HookConfig format */
export function isLegacyHookConfig(entry: HookConfig | HookEntry): entry is HookConfig {
  return (
    typeof (entry as HookConfig).matcher === "string" && Array.isArray((entry as HookConfig).hooks)
  );
}

// ─── Matching Utilities ─────────────────────────────────────────

/**
 * Safely test a regex pattern against a target string, rejecting
 * patterns with nested quantifiers that can cause catastrophic backtracking (ReDoS).
 */
export function safeRegexTest(pattern: string, target: string): boolean {
  try {
    // Reject patterns longer than 200 chars (reduces attack surface)
    if (pattern.length > 200) return false;

    // Reject obviously dangerous patterns (nested quantifiers)
    if (/([+*])\)?[+*{]|(\{[^}]*\})\)?[+*{]/.test(pattern)) {
      return false; // Reject nested quantifiers like a+* or a{2,}*
    }
    // Reject alternation with overlapping branches: (a|a)*, (ab|ab)+
    if (/\(([^)]+)\|(\1)\)[*+{]/.test(pattern)) {
      return false; // Reject (x|x)* patterns
    }
    // Reject deeply nested groups with quantifiers: ((a+)+)
    if (/\([^)]*\([^)]*[+*]\)[^)]*\)[+*{]/.test(pattern)) {
      return false; // Reject nested group quantifiers
    }
    // Reject excessive backtracking from repeated overlapping char classes
    if (/(\[.*\])[+*]\1[+*]/.test(pattern)) {
      return false;
    }

    // Execute with a timeout guard using a simple length check heuristic
    if (target.length > 10_000) {
      return false; // Don't run regex against very long strings
    }

    const regex = new RegExp(pattern);
    return regex.test(target);
  } catch (err) {
    log.debug("hooks", `Regex test failed for pattern "${pattern}": ${err}`);
    return false;
  }
}

/**
 * Simple glob match for hook matchers.
 * Supports * (any chars except /) and ** (any chars including /).
 */
export function hookGlobMatch(pattern: string, value: string): boolean {
  let regex = pattern.replace(/([.+^${}()|[\]\\])/g, "\\$1");
  regex = regex.replace(/\*\*/g, "<<GLOBSTAR>>");
  regex = regex.replace(/\*/g, "[^/]*");
  regex = regex.replace(/\?/g, "[^/]"); // glob ? = any single non-/ char
  regex = regex.replace(/<<GLOBSTAR>>/g, ".*");
  return new RegExp(`^${regex}$`).test(value);
}

/** Check if a HookMatcher matches the given context */
export function matcherMatches(
  matcher: HookMatcher | undefined,
  toolName: string | undefined,
  context: Record<string, unknown>,
): boolean {
  if (!matcher) return true; // No matcher = match everything

  // Check toolName if specified
  if (matcher.toolName) {
    if (!toolName) return false;
    if (!hookGlobMatch(matcher.toolName, toolName)) return false;
  }

  // Check other property matchers
  for (const [key, pattern] of Object.entries(matcher)) {
    if (key === "toolName") continue; // Already handled
    if (pattern === undefined) continue;
    const value = context[key];
    if (typeof value !== "string") return false;
    if (!hookGlobMatch(pattern, value)) return false;
  }

  return true;
}

// ─── Command Validation ─────────────────────────────────────────

/** Validate a hook command string for obviously dangerous patterns. */
export function validateHookCommand(command: string): boolean {
  const trimmed = command.trim();
  // Block empty commands
  if (!trimmed) return false;
  // Block commands that attempt to download and pipe to shell
  if (/curl\s.*\|\s*(sh|bash|zsh)/.test(trimmed)) return false;
  if (/wget\s.*\|\s*(sh|bash|zsh)/.test(trimmed)) return false;
  // Block reverse shells
  if (/\/dev\/(tcp|udp)\//.test(trimmed)) return false;
  // Block base64-encoded execution (common obfuscation)
  if (/base64\s.*-d\s*\|\s*(sh|bash|zsh)/.test(trimmed)) return false;
  // Block backgrounded network exfiltration
  if (/nc\s+-[^l]*\s+\d+/.test(trimmed) && /\|/.test(trimmed)) return false;
  return true;
}

// ─── Hook Execution ─────────────────────────────────────────────

/** Execute a single hook command, passing context as JSON via stdin. */
export async function executeHookCommand(
  command: string,
  stdinData: string,
  cwd: string,
  timeout: number = LEGACY_HOOK_TIMEOUT,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // Validate hook command before execution
  if (!validateHookCommand(command)) {
    log.warn("hooks", `Blocked suspicious hook command: ${command.slice(0, 100)}`);
    return { exitCode: 1, stdout: "", stderr: "Hook command blocked by security validation" };
  }

  return new Promise((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    // Strip sensitive env vars from hook subprocess environment
    const hookEnv = { ...process.env };
    for (const key of Object.keys(hookEnv)) {
      if (
        /^(KCODE_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|GROQ_API_KEY|DEEPSEEK_API_KEY|TOGETHER_API_KEY|GEMINI_API_KEY)$/i.test(
          key,
        )
      ) {
        delete hookEnv[key];
      }
    }

    const proc = spawn("sh", ["-c", command], {
      cwd,
      timeout,
      env: hookEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    proc.stdout.on("data", (data: Buffer) => stdoutChunks.push(data));
    proc.stderr.on("data", (data: Buffer) => stderrChunks.push(data));

    // Write JSON context to stdin
    proc.stdin.write(stdinData);
    proc.stdin.end();

    proc.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8").trim(),
        stderr: Buffer.concat(stderrChunks).toString("utf-8").trim(),
      });
    });

    proc.on("error", (err) => {
      resolve({
        exitCode: 1,
        stdout: "",
        stderr: err.message,
      });
    });
  });
}

/** Check if a hostname resolves to a private/internal IP. */
function isPrivateHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "metadata.google.internal" || h === "metadata.google") return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  // Cloud provider metadata endpoints (AWS/GCP link-local + Azure wireserver)
  if (h === "168.63.129.16") return true; // Azure Instance Metadata / wireserver
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return true; // AWS VPC carrier-grade NAT (100.64-127.x)
  if (/^0\./.test(h) || h === "0.0.0.0") return true;
  if (h === "::1" || h === "[::1]") return true;
  if (/^fe80:/i.test(h) || /^fd/i.test(h) || /^fc/i.test(h)) return true;
  const v4mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4mapped && isPrivateHostname(v4mapped[1]!)) return true;
  return false;
}

/** Execute an HTTP hook action, posting JSON to the configured URL. */
export async function executeHookHttp(
  action: HookAction,
  jsonData: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const { requirePro } = await import("./pro.js");
  await requirePro("hooks-webhook");

  if (!action.url) {
    return { exitCode: 1, stdout: "", stderr: "HTTP hook missing url" };
  }

  // Enforce network policy — check if the webhook URL is allowed
  const { loadTeamPolicy, enforceWebhookPolicy } = await import("./enterprise/policy.js");
  const policy = loadTeamPolicy();
  if (policy) {
    const netResult = enforceWebhookPolicy(action.url, policy);
    if (!netResult.allowed) {
      log.warn("hooks", `Webhook blocked by network policy: ${action.url} — ${netResult.reason}`);
      return { exitCode: 1, stdout: "", stderr: `Webhook blocked: ${netResult.reason}` };
    }
  }

  // Validate URL protocol
  let parsed: URL;
  try {
    parsed = new URL(action.url);
  } catch (err) {
    log.debug("hooks", `Invalid hook URL "${action.url}": ${err}`);
    return { exitCode: 1, stdout: "", stderr: `Invalid hook URL: ${action.url}` };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { exitCode: 1, stdout: "", stderr: `Hook URL must use http(s): ${action.url}` };
  }

  // Block SSRF to private/internal IPs
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (isPrivateHostname(hostname)) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Hook URL blocked (private/internal): ${action.url}`,
    };
  }

  // Enforce HTTPS when auth headers are present (legacy format protection)
  if (action.headers && parsed.protocol !== "https:") {
    const hasAuth = Object.keys(action.headers).some((k) => k.toLowerCase() === "authorization");
    if (hasAuth) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Hook auth headers require HTTPS, got: ${parsed.protocol}`,
      };
    }
  }

  try {
    const method = (action.method ?? "POST").toUpperCase();
    const httpTimeout = action.timeout ?? HTTP_TIMEOUT;
    const resp = await fetch(action.url, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(action.headers ?? {}),
      },
      body: method !== "GET" ? jsonData : undefined,
      signal: AbortSignal.timeout(httpTimeout),
    });

    const body = await resp.text();
    // Map HTTP status to exit codes: 2xx=0, 403/422=2 (block), other=1
    let exitCode = 0;
    if (resp.status === 403 || resp.status === 422) {
      exitCode = 2; // Block signal
    } else if (!resp.ok) {
      exitCode = 1;
    }

    return { exitCode, stdout: body.slice(0, 64 * 1024), stderr: "" };
  } catch (err) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Execute a hook action (command or http). */
export async function executeHookAction(
  action: HookAction,
  jsonData: string,
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (action.type === "http") {
    return executeHookHttp(action, jsonData);
  }
  if (action.type === "command" && action.command) {
    return executeHookCommand(action.command, jsonData, cwd, action.timeout);
  }
  return { exitCode: 1, stdout: "", stderr: `Unknown hook type: ${action.type}` };
}

/** Expand template placeholders in an agent hook prompt. */
function expandAgentTemplate(
  template: string,
  context: { event?: string; toolName?: string; input?: unknown },
): string {
  return template
    .replace(/\{\{event\}\}/g, context.event ?? "")
    .replace(/\{\{toolName\}\}/g, context.toolName ?? "")
    .replace(/\{\{input\}\}/g, context.input !== undefined ? JSON.stringify(context.input) : "");
}

/**
 * Execute an agent hook by spawning a subagent process.
 * Uses the same CLI pattern as src/tools/agent.ts — spawns `bun run src/index.ts --agent`.
 */
async function executeHookAgent(
  entry: HookEntry,
  jsonData: string,
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const { requirePro } = await import("./pro.js");
  await requirePro("hooks-agent");

  const config = entry.agentConfig;
  if (!config?.prompt) {
    return { exitCode: 1, stdout: "", stderr: "Agent hook missing agentConfig.prompt" };
  }

  // Parse the JSON context to extract template values
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(jsonData);
  } catch (err) {
    log.debug("hooks", `Failed to parse JSON context for agent hook: ${err}`);
  }

  const expandedPrompt = expandAgentTemplate(config.prompt, {
    event: parsed.event as string | undefined,
    toolName: parsed.tool_name as string | undefined,
    input: parsed.tool_input ?? parsed,
  });

  const background = config.background !== false; // default true
  const timeout = config.timeout ?? AGENT_HOOK_TIMEOUT;

  // Build subagent command using the installed binary
  const { findKCodeBinary } = require("./swarm") as typeof import("./swarm");
  const kcodeBin = findKCodeBinary();
  const args: string[] = ["--agent"];
  if (config.model) {
    args.push("-m", config.model);
  }

  const proc = spawn(kcodeBin, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
    timeout: background ? undefined : timeout,
  });

  // Send the expanded prompt via stdin
  proc.stdin.write(expandedPrompt + "\n");
  proc.stdin.end();

  if (background) {
    // Fire and forget — but enforce a max timeout to prevent zombie processes
    const bgTimeout = Math.max(timeout, 300_000); // at least 5 minutes
    const bgTimer = setTimeout(() => {
      try {
        proc.kill();
      } catch (err) {
        log.debug("hooks", `Failed to kill background agent hook: ${err}`);
      }
      log.warn("hooks", `Agent hook (background) killed after ${bgTimeout}ms timeout`);
    }, bgTimeout);
    proc.on("error", (err) => {
      clearTimeout(bgTimer);
      log.warn("hooks", `Agent hook (background) error: ${err.message}`);
    });
    proc.on("close", (code) => {
      clearTimeout(bgTimer);
      if (code !== 0) {
        log.warn("hooks", `Agent hook (background) exited with code ${code}`);
      }
    });
    return { exitCode: 0, stdout: "[agent hook started in background]", stderr: "" };
  }

  // Foreground: await result
  return new Promise((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    proc.stdout.on("data", (data: Buffer) => stdoutChunks.push(data));
    proc.stderr.on("data", (data: Buffer) => stderrChunks.push(data));

    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch (err) {
        log.debug("hooks", `Failed to kill foreground agent hook: ${err}`);
      }
      resolve({ exitCode: 1, stdout: "", stderr: `Agent hook timed out after ${timeout}ms` });
    }, timeout);

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8").trim(),
        stderr: Buffer.concat(stderrChunks).toString("utf-8").trim(),
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout: "", stderr: err.message });
    });
  });
}

/** Execute a new-format HookEntry. */
export async function executeHookEntry(
  entry: HookEntry,
  jsonData: string,
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (entry.type === "prompt") {
    // Prompt hooks inject text — return prompt text as stdout, always succeed
    return { exitCode: 0, stdout: entry.prompt ?? "", stderr: "" };
  }
  if (entry.type === "command" && entry.command) {
    const timeout = entry.timeout ?? DEFAULT_HOOK_TIMEOUT;
    return executeHookCommand(entry.command, jsonData, cwd, timeout);
  }
  if (entry.type === "http") {
    // Enforce HTTPS when auth token is provided to prevent credential leakage
    if (entry.auth && entry.url) {
      try {
        const parsed = new URL(entry.url);
        if (parsed.protocol !== "https:") {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `Hook auth requires HTTPS, got: ${parsed.protocol}`,
          };
        }
      } catch (err) {
        log.debug("hooks", `Invalid hook entry URL "${entry.url}": ${err}`);
        return { exitCode: 1, stdout: "", stderr: `Invalid hook URL: ${entry.url}` };
      }
    }
    // Delegate to executeHookHttp via a HookAction adapter
    const action: HookAction = {
      type: "http",
      url: entry.url,
      method: entry.method,
      headers: {
        ...(entry.headers ?? {}),
        ...(entry.auth ? { Authorization: `Bearer ${entry.auth}` } : {}),
      },
      timeout: entry.timeout,
    };
    return executeHookHttp(action, jsonData);
  }
  if (entry.type === "agent") {
    return executeHookAgent(entry, jsonData, cwd);
  }
  if (entry.type === "llm-prompt" && entry.promptConfig) {
    const result = await evaluatePromptHook(entry.promptConfig, jsonData);
    if (result.decision === "block" || result.decision === "deny") {
      return {
        exitCode: 2,
        stdout: JSON.stringify({ decision: "block", reason: result.reason }),
        stderr: "",
      };
    }
    if (result.decision === "warn") {
      return { exitCode: 0, stdout: result.reason ?? "", stderr: "" };
    }
    return { exitCode: 0, stdout: result.reason ?? "", stderr: "" };
  }
  return { exitCode: 1, stdout: "", stderr: `Unknown hook type: ${entry.type}` };
}

/** Parse hook command output as JSON, with fallback. */
export function parseHookOutput(stdout: string): HookOutput | null {
  if (!stdout) return null;

  try {
    const parsed = JSON.parse(stdout);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.decision === "string" &&
      ["allow", "deny", "block"].includes(parsed.decision)
    ) {
      return parsed as HookOutput;
    }
  } catch (err) {
    log.debug("hooks", `Non-JSON hook output (ignored): ${err}`);
  }

  return null;
}
