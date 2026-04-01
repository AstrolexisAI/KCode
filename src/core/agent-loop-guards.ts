// KCode - Agent Loop Guards
// Extracted from conversation.ts — loop safety logic, dedup, pattern detection, schema validation

import { readFileSync } from "node:fs";
import { log } from "./logger";

// ─── Constants ───────────────────────────────────────────────────

export const MAX_AGENT_TURNS = 25;
export const MAX_CONSECUTIVE_DENIALS = 2;
export const LOOP_PATTERN_THRESHOLD = 3;
export const LOOP_PATTERN_HARD_STOP = 5;
export const MAX_LOOP_PATTERNS = 200;

// ─── Bash Loop Pattern Extraction ────────────────────────────────

/**
 * Extract a semantic "pattern key" from a Bash command to detect loops.
 * Groups commands by their base tool/binary (e.g., all nmap calls -> "nmap",
 * all smbclient calls -> "smbclient"). This catches cases where the model
 * keeps running the same type of scan with slightly different IPs or flags.
 */
export function extractBashLoopPattern(command: string): string | null {
  const trimmed = command.trim();
  // Strip leading "for ... do" loops — extract the inner command
  let inner = trimmed;
  const forMatch = trimmed.match(/^for\s+\w+\s+in\s+[^;]+;\s*do\s+(.+?)\s*;\s*done/s);
  if (forMatch) inner = forMatch[1]!;
  // Also handle: for ... ; do echo "==="; <command> ... done
  const forMatch2 = inner.match(/echo\s+["'][^"']*["'];\s*(.+)/);
  if (forMatch2) inner = forMatch2[1]!;

  // Strip leading comments (lines starting with #) — LLMs often add descriptive comments
  // before the actual command, which would otherwise match as "bash:#"
  inner = inner.replace(/^(\s*#[^\n]*\n)+/g, "").trim();
  // Also strip inline leading comment on single-line commands
  if (inner.startsWith("#")) {
    const newlineIdx = inner.indexOf("\n");
    if (newlineIdx !== -1) {
      inner = inner.slice(newlineIdx + 1).trim();
    } else {
      return null; // Pure comment, no command to pattern-match
    }
  }

  // Strip variable assignments at the start (e.g. MISSING="" FOO=bar)
  inner = inner.replace(/^(\s*\w+="[^"]*"\s*\n?)+/g, "").trim();
  inner = inner.replace(/^(\s*\w+='[^']*'\s*\n?)+/g, "").trim();

  // For piped commands (echo X | socat Y), use BOTH source and sink command names + target IP.
  // This prevents false loop detection when sending different payloads to different IoT devices.
  // e.g. "echo ... | socat - UDP:192.168.1.146:38899" -> "bash:echo|socat@192.168.1.146"
  const pipeMatch = inner.match(/^(\S+)\s+.*?\|\s*(\S+)/);
  if (pipeMatch) {
    const sourceCmd = pipeMatch[1]!.replace(/^.*\//, "");
    const sinkCmd = pipeMatch[2]!.replace(/^.*\//, "");
    // Extract target IP from the sink side of the pipe
    const pipeRest = inner.slice(inner.indexOf("|") + 1);
    const pipeIpMatch = pipeRest.match(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/);
    const pipeSuffix = pipeIpMatch ? `@${pipeIpMatch[1]}` : "";
    return `bash:${sourceCmd}|${sinkCmd}${pipeSuffix}`;
  }

  // Extract the base binary/command (first word that looks like a tool)
  const words = inner.trim().split(/\s+/);
  const skipPrefixes = new Set(["sudo", "nohup", "env", "bash", "-c", "sh", "timeout"]);
  let baseCmd = "";
  for (const w of words) {
    if (
      skipPrefixes.has(w) ||
      w.startsWith("-") ||
      w.startsWith("$") ||
      w.startsWith('"') ||
      w.startsWith("'") ||
      w.startsWith("#")
    )
      continue;
    baseCmd = w.replace(/^.*\//, ""); // strip path prefix
    break;
  }

  if (!baseCmd) return null;

  // Group related tools into categories
  const SCAN_TOOLS = new Set([
    "nmap",
    "masscan",
    "zmap",
    "netcat",
    "nc",
    "nbtscan",
    "nmblookup",
    "nikto",
    "gobuster",
    "dirb",
    "wfuzz",
    "sqlmap",
    "searchsploit",
    "enum4linux",
  ]);
  const SMB_TOOLS = new Set([
    "smbclient",
    "smbmap",
    "rpcclient",
    "crackmapexec",
    "impacket-smbclient",
  ]);
  const HTTP_TOOLS = new Set(["curl", "wget", "httpie", "http"]);
  const SSH_TOOLS = new Set(["ssh", "sshpass", "scp", "sftp"]);
  const EXPLOIT_TOOLS = new Set([
    "dcomexec",
    "psexec",
    "wmiexec",
    "atexec",
    "smbexec",
    "secretsdump",
    "msfconsole",
    "hydra",
    "medusa",
    "impacket-smbexec",
    "impacket-psexec",
    "impacket-wmiexec",
    "impacket-dcomexec",
    "impacket-atexec",
    "impacket-secretsdump",
    "setoolkit",
    "beef",
    "responder",
  ]);
  const BRUTE_TOOLS = new Set(["hashcat", "john", "aircrack-ng", "aircrack", "hydra", "medusa"]);

  // Extract target host/IP for more specific pattern grouping
  const ipMatch = inner.match(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/);
  const targetSuffix = ipMatch ? `@${ipMatch[1]}` : "";

  if (SCAN_TOOLS.has(baseCmd)) return `network-scan${targetSuffix}`;
  if (SMB_TOOLS.has(baseCmd)) return `smb-probe${targetSuffix}`;
  if (HTTP_TOOLS.has(baseCmd)) return `http-request${targetSuffix}`;
  if (SSH_TOOLS.has(baseCmd)) return `ssh-access${targetSuffix}`;
  if (EXPLOIT_TOOLS.has(baseCmd)) return `exploit-attempt${targetSuffix}`;
  if (BRUTE_TOOLS.has(baseCmd)) return `bruteforce-attempt${targetSuffix}`;

  // For python3/python scripts, use the script name instead of "python3"
  if ((baseCmd === "python3" || baseCmd === "python") && words.length > 1) {
    for (const w of words.slice(1)) {
      if (w.startsWith("-")) continue;
      // Heredocs (python3 << 'EOF') are always unique inline scripts — skip loop detection
      if (w.startsWith("<")) return null;
      // Extract script name from path (e.g. ~/.local/bin/dcomexec.py -> dcomexec)
      const scriptName = w.replace(/^.*\//, "").replace(/\.py$/, "");
      if (scriptName) {
        if (EXPLOIT_TOOLS.has(scriptName)) return "exploit-attempt";
        return `bash:${scriptName}`;
      }
    }
  }

  // Heredocs with any command are generally unique — skip loop detection
  // e.g. "ruby << 'EOF'", "bash << 'HEREDOC'", "node << 'JS'"
  if (/<<[-~]?\s*['"]?\w+['"]?/.test(inner)) return null;

  // For file-writing commands (cat/tee with redirect), include target filename
  // to avoid false loop detection when creating multiple different files
  if ((baseCmd === "cat" || baseCmd === "tee") && /[>]|<</.test(inner)) {
    const fileMatch = inner.match(/>\s*(\S+)|<<.*?\n.*?\n.*?>\s*(\S+)/);
    if (fileMatch) {
      const targetFile = fileMatch[1] ?? fileMatch[2];
      if (targetFile) return `bash:${baseCmd}@${targetFile}`;
    }
  }

  // For other tools, just use the binary name
  return `bash:${baseCmd}`;
}

// ─── JSON Schema Validation ──────────────────────────────────────

/**
 * Lightweight JSON Schema Validator.
 * Validates basic JSON Schema constraints without pulling in Ajv (~150KB).
 * Covers: type, required, properties, enum, minimum, maximum, minLength, maxLength, pattern, items.
 */
export function validateJsonSchema(
  data: unknown,
  schema: Record<string, unknown>,
  path = "$",
): string[] {
  const errors: string[] = [];

  // type check
  if (schema.type) {
    const schemaType = schema.type as string;
    const actualType = Array.isArray(data) ? "array" : data === null ? "null" : typeof data;
    if (schemaType === "integer") {
      if (typeof data !== "number" || !Number.isInteger(data)) {
        errors.push(`${path}: expected integer, got ${actualType}`);
        return errors;
      }
    } else if (actualType !== schemaType) {
      errors.push(`${path}: expected ${schemaType}, got ${actualType}`);
      return errors;
    }
  }

  // enum
  if (schema.enum && Array.isArray(schema.enum)) {
    if (!(schema.enum as unknown[]).includes(data)) {
      errors.push(`${path}: value must be one of [${(schema.enum as unknown[]).join(", ")}]`);
    }
  }

  // string constraints
  if (typeof data === "string") {
    if (typeof schema.minLength === "number" && data.length < schema.minLength) {
      errors.push(`${path}: string length ${data.length} < minLength ${schema.minLength}`);
    }
    if (typeof schema.maxLength === "number" && data.length > schema.maxLength) {
      errors.push(`${path}: string length ${data.length} > maxLength ${schema.maxLength}`);
    }
    if (typeof schema.pattern === "string") {
      try {
        // Guard against ReDoS: reject patterns with known catastrophic backtracking constructs
        if (/(\([^)]*[+*][^)]*\))[+*]/.test(schema.pattern) || schema.pattern.length > 200) {
          errors.push(`${path}: regex pattern rejected (potential ReDoS or too long)`);
        } else if (!new RegExp(schema.pattern).test(data)) {
          errors.push(`${path}: string does not match pattern "${schema.pattern}"`);
        }
      } catch {
        errors.push(`${path}: invalid regex pattern "${schema.pattern}"`);
      }
    }
  }

  // number constraints
  if (typeof data === "number") {
    if (typeof schema.minimum === "number" && data < schema.minimum) {
      errors.push(`${path}: ${data} < minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && data > schema.maximum) {
      errors.push(`${path}: ${data} > maximum ${schema.maximum}`);
    }
  }

  // object constraints
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    if (schema.required && Array.isArray(schema.required)) {
      for (const key of schema.required as string[]) {
        if (!(key in obj)) {
          errors.push(`${path}: missing required property "${key}"`);
        }
      }
    }
    if (schema.properties && typeof schema.properties === "object") {
      for (const [key, propSchema] of Object.entries(
        schema.properties as Record<string, Record<string, unknown>>,
      )) {
        if (key in obj) {
          errors.push(...validateJsonSchema(obj[key], propSchema, `${path}.${key}`));
        }
      }
    }
  }

  // array constraints
  if (Array.isArray(data)) {
    if (typeof schema.minItems === "number" && data.length < schema.minItems) {
      errors.push(`${path}: array length ${data.length} < minItems ${schema.minItems}`);
    }
    if (typeof schema.maxItems === "number" && data.length > schema.maxItems) {
      errors.push(`${path}: array length ${data.length} > maxItems ${schema.maxItems}`);
    }
    if (schema.items && typeof schema.items === "object") {
      for (let i = 0; i < data.length; i++) {
        errors.push(
          ...validateJsonSchema(data[i], schema.items as Record<string, unknown>, `${path}[${i}]`),
        );
      }
    }
  }

  return errors;
}

// ─── Loop Pattern State ──────────────────────────────────────────

export interface LoopPatternEntry {
  count: number;
  warned: boolean;
  redirects: number;
  examples: string[];
}

/**
 * Mutable state container for agent loop guard tracking.
 * Created fresh for each agent loop invocation.
 */
export class LoopGuardState {
  consecutiveDenials = 0;
  inlineWarningCount = 0;
  forceStopLoop = false;
  maxTokensContinuations = 0;
  jsonSchemaRetries = 0;
  emptyEndTurnCount = 0;
  truncationRetries = 0;
  lastEmptyType?: "thinking_only" | "tools_only" | "thinking_and_tools" | "no_output";
  readonly crossTurnSigs = new Map<string, number>();
  readonly loopPatterns = new Map<string, LoopPatternEntry>();
  /** Track error fingerprints to block retrying the same failing technique */
  readonly errorFingerprints = new Map<string, number>();
  /** Set of "burned" fingerprints that should not be retried */
  readonly burnedFingerprints = new Set<string>();

  // Pre-computed tool filter sets
  readonly managedDisallowedSet: Set<string>;
  readonly allowedToolsSet: Set<string> | null;
  readonly disallowedToolsSet: Set<string> | null;

  constructor(
    managedDisallowedTools?: string[],
    allowedTools?: string[],
    disallowedTools?: string[],
  ) {
    this.managedDisallowedSet = new Set(managedDisallowedTools?.map((t) => t.toLowerCase()));
    this.allowedToolsSet = allowedTools?.length
      ? new Set(allowedTools.map((t) => t.toLowerCase()))
      : null;
    this.disallowedToolsSet = disallowedTools?.length
      ? new Set(disallowedTools.map((t) => t.toLowerCase()))
      : null;
  }

  /**
   * Record a tool error. Returns true if this fingerprint is now "burned"
   * (2+ failures with the same root cause → should not be retried).
   */
  recordToolError(toolName: string, errorMessage: string): boolean {
    // Normalize error to a canonical fingerprint
    const normalized = errorMessage
      .replace(/\/[^\s"']+/g, "<path>") // normalize paths
      .replace(/\d+/g, "N") // normalize numbers
      .replace(/["'][^"']*["']/g, "<str>") // normalize strings
      .slice(0, 100); // cap length
    const fp = `${toolName}|${normalized}`;

    const count = (this.errorFingerprints.get(fp) ?? 0) + 1;
    this.errorFingerprints.set(fp, count);

    if (count >= 2) {
      this.burnedFingerprints.add(fp);
      return true;
    }
    return false;
  }

  /**
   * Check if a tool call matches a burned error fingerprint.
   */
  isErrorBurned(toolName: string, errorMessage: string): boolean {
    const normalized = errorMessage
      .replace(/\/[^\s"']+/g, "<path>")
      .replace(/\d+/g, "N")
      .replace(/["'][^"']*["']/g, "<str>")
      .slice(0, 100);
    return this.burnedFingerprints.has(`${toolName}|${normalized}`);
  }

  /**
   * Track a cross-turn tool call signature. Returns the count BEFORE incrementing.
   * Skips tracking for Write/Edit (rewriting same file with different content is normal).
   */
  trackCrossTurnSig(toolName: string, sig: string): number {
    if (toolName === "Write" || toolName === "Edit") return 0;
    const count = this.crossTurnSigs.get(sig) ?? 0;
    this.crossTurnSigs.set(sig, count + 1);
    // Cap to prevent unbounded growth
    if (this.crossTurnSigs.size > MAX_LOOP_PATTERNS) {
      const first = this.crossTurnSigs.keys().next().value;
      if (first) this.crossTurnSigs.delete(first);
    }
    return count;
  }

  /**
   * Track a loop pattern for Bash commands. Returns the entry after incrementing.
   */
  trackLoopPattern(pattern: string, command: string): LoopPatternEntry {
    const entry = this.loopPatterns.get(pattern) ?? {
      count: 0,
      warned: false,
      redirects: 0,
      examples: [],
    };
    entry.count++;
    if (entry.examples.length < 3) entry.examples.push(command.slice(0, 80));
    this.loopPatterns.set(pattern, entry);

    // Evict oldest entries if over cap
    if (this.loopPatterns.size > MAX_LOOP_PATTERNS) {
      const firstKey = this.loopPatterns.keys().next().value;
      if (firstKey) this.loopPatterns.delete(firstKey);
    }

    return entry;
  }

  /**
   * Reset Bash/Read dedup counters after an Edit/Write succeeds.
   * This allows legitimate test-fix-test cycles.
   */
  resetAfterFileEdit(): void {
    for (const [key] of this.crossTurnSigs) {
      if (key.startsWith("Bash:") || key.startsWith("Read:")) {
        this.crossTurnSigs.delete(key);
      }
    }
    this.inlineWarningCount = 0;
  }
}

/**
 * Build a dedup key for a tool call.
 */
export function buildDedupKey(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "Bash") {
    return String(input.command ?? "").slice(0, 120);
  } else if (toolName === "Read") {
    // Include offset+limit so reading different ranges of the same file isn't treated as duplicate
    const fp = String(input.file_path ?? "");
    const off = input.offset ?? 0;
    const lim = input.limit ?? 0;
    return `${fp}:${off}:${lim}`;
  } else {
    return String(
      input.file_path ?? input.pattern ?? input.query ?? JSON.stringify(input).slice(0, 120),
    );
  }
}

/**
 * Validate JSON schema for model output. Returns null if valid or no schema,
 * or a retry message string if the output failed validation.
 */
export function validateModelOutput(
  fullText: string,
  jsonSchemaConfig: string | undefined,
  jsonSchemaRetries: number,
): { retryMessage: string | null; shouldAccept: boolean } {
  if (!jsonSchemaConfig) return { retryMessage: null, shouldAccept: true };

  try {
    const schema = jsonSchemaConfig.startsWith("{")
      ? JSON.parse(jsonSchemaConfig)
      : JSON.parse(readFileSync(jsonSchemaConfig, "utf-8"));
    // Strip markdown code fences that models often wrap JSON in
    let jsonText = fullText.trim();
    const fenceMatch = jsonText.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
    if (fenceMatch) jsonText = fenceMatch[1]!.trim();
    const parsed = JSON.parse(jsonText);
    const errors = validateJsonSchema(parsed, schema);
    if (errors.length > 0) {
      if (jsonSchemaRetries >= 3) {
        log.warn(
          "llm",
          `JSON schema validation failed after ${jsonSchemaRetries} retries, accepting output as-is`,
        );
        return { retryMessage: null, shouldAccept: true };
      }
      log.warn(
        "llm",
        `JSON schema validation failed (attempt ${jsonSchemaRetries + 1}/3): ${errors.join(", ")}`,
      );
      return {
        retryMessage: `[SYSTEM] Your JSON output failed schema validation:\n${errors.join("\n")}\n\nFix the output to match the required schema. Return ONLY valid JSON, no markdown fences.`,
        shouldAccept: false,
      };
    }
  } catch (e) {
    if (e instanceof SyntaxError) {
      if (jsonSchemaRetries >= 3) {
        log.warn(
          "llm",
          `JSON parse failed after ${jsonSchemaRetries} retries, accepting output as-is`,
        );
        return { retryMessage: null, shouldAccept: true };
      }
      log.warn("llm", `JSON parse failed (attempt ${jsonSchemaRetries + 1}/3): ${e.message}`);
      return {
        retryMessage: `[SYSTEM] Your output is not valid JSON: ${e.message}\n\nReturn ONLY valid JSON matching the required schema. Do NOT wrap in markdown code fences.`,
        shouldAccept: false,
      };
    }
    // Schema parsing error — skip validation
  }

  return { retryMessage: null, shouldAccept: true };
}
