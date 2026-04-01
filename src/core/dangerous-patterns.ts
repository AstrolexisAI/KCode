// KCode - Centralized Dangerous Pattern Registry
// Provides a structured registry of dangerous patterns with severity scoring,
// interpreter detection, and wildcard permission rule blocking.
//
// This module complements safety-analysis.ts by adding:
// - Pattern registry with severity levels and categories
// - Interpreter detection (python, node, ruby, perl, php)
// - Dangerous permission rule detection (wildcards in auto mode)
// - Aggregate risk scoring for commands

import { log } from "./logger";

// ─── Types ──────────────────────────────────────────────────────

export type PatternSeverity = "info" | "warning" | "danger" | "critical";
export type PatternCategory =
  | "injection"
  | "shell"
  | "exfiltration"
  | "destruction"
  | "privilege"
  | "interpreter"
  | "redirection"
  | "obfuscation";

export interface DangerousPattern {
  id: string;
  category: PatternCategory;
  severity: PatternSeverity;
  /** Regex to match against the command */
  pattern: RegExp;
  /** Human-readable description */
  description: string;
  /** Suggested remediation */
  remediation?: string;
}

export interface PatternMatch {
  patternId: string;
  category: PatternCategory;
  severity: PatternSeverity;
  description: string;
  remediation?: string;
  /** The matched text */
  match: string;
}

export interface RiskAssessment {
  score: number; // 0-100
  level: "safe" | "low" | "moderate" | "high" | "critical";
  matches: PatternMatch[];
}

// ─── Severity Weights ──────────────────────────────────────────

const SEVERITY_WEIGHTS: Record<PatternSeverity, number> = {
  info: 5,
  warning: 15,
  danger: 35,
  critical: 50,
};

// ─── Pattern Registry ──────────────────────────────────────────

const PATTERN_REGISTRY: DangerousPattern[] = [
  // Interpreter execution
  {
    id: "interp-python",
    category: "interpreter",
    severity: "warning",
    pattern: /\bpython[23]?\s+(?:-c\s+|[\w/.]+\.py)/,
    description: "Python interpreter execution",
    remediation: "Review the Python code being executed",
  },
  {
    id: "interp-node",
    category: "interpreter",
    severity: "warning",
    pattern: /\bnode\s+(?:-e\s+|[\w/.]+\.(?:js|mjs|cjs))/,
    description: "Node.js interpreter execution",
    remediation: "Review the JavaScript code being executed",
  },
  {
    id: "interp-ruby",
    category: "interpreter",
    severity: "warning",
    pattern: /\bruby\s+(?:-e\s+|[\w/.]+\.rb)/,
    description: "Ruby interpreter execution",
    remediation: "Review the Ruby code being executed",
  },
  {
    id: "interp-perl",
    category: "interpreter",
    severity: "warning",
    pattern: /\bperl\s+(?:-e\s+|[\w/.]+\.pl)/,
    description: "Perl interpreter execution",
    remediation: "Review the Perl code being executed",
  },
  {
    id: "interp-php",
    category: "interpreter",
    severity: "warning",
    pattern: /\bphp\s+(?:-r\s+|[\w/.]+\.php)/,
    description: "PHP interpreter execution",
    remediation: "Review the PHP code being executed",
  },

  // Exfiltration patterns
  {
    id: "exfil-curl-post",
    category: "exfiltration",
    severity: "danger",
    pattern: /\bcurl\s+.*(?:-X\s*POST|-d\s|--data\s)/,
    description: "HTTP POST request (potential data exfiltration)",
    remediation: "Verify the destination URL and data being sent",
  },
  {
    id: "exfil-wget-post",
    category: "exfiltration",
    severity: "danger",
    pattern: /\bwget\s+.*--post-(?:data|file)/,
    description: "wget POST request (potential data exfiltration)",
    remediation: "Verify the destination URL and data being sent",
  },
  {
    id: "exfil-nc",
    category: "exfiltration",
    severity: "critical",
    pattern: /\b(?:nc|ncat|netcat)\s+(?:-[a-zA-Z]*\s+)*\d+\.\d+\.\d+\.\d+/,
    description: "Netcat connection to IP address",
    remediation: "Netcat is commonly used for data exfiltration",
  },

  // Obfuscation patterns
  {
    id: "obfusc-base64-exec",
    category: "obfuscation",
    severity: "critical",
    pattern: /\b(?:base64\s+-d|echo\s+.*\|\s*base64\s+-d)\s*\|\s*(?:bash|sh|zsh)/,
    description: "Base64-decoded payload piped to shell",
    remediation: "This is a common attack pattern to hide malicious payloads",
  },
  {
    id: "obfusc-hex-exec",
    category: "obfuscation",
    severity: "critical",
    pattern: /\bprintf\s+['"]\\x[0-9a-fA-F].*\|\s*(?:bash|sh)/,
    description: "Hex-encoded payload piped to shell",
    remediation: "This hides command content from inspection",
  },
  {
    id: "obfusc-eval",
    category: "obfuscation",
    severity: "danger",
    pattern: /\beval\s+["'$]/,
    description: "eval with dynamic content",
    remediation: "eval executes arbitrary code and is a common injection vector",
  },

  // Privilege escalation
  {
    id: "priv-chmod-suid",
    category: "privilege",
    severity: "critical",
    pattern: /\bchmod\s+[ugo]*\+s\b|\bchmod\s+[4267]\d{3}\b/,
    description: "Setting SUID/SGID bit on files",
    remediation: "SUID/SGID bits allow privilege escalation",
  },
  {
    id: "priv-chown-root",
    category: "privilege",
    severity: "danger",
    pattern: /\bchown\s+root[:\s]/,
    description: "Changing file ownership to root",
  },

  // Destruction patterns
  {
    id: "destr-dd",
    category: "destruction",
    severity: "critical",
    pattern: /\bdd\s+.*of=\/dev\/(?:sd|nvme|vd)/,
    description: "dd writing directly to disk device",
    remediation: "This can destroy entire disk contents",
  },
  {
    id: "destr-mkfs",
    category: "destruction",
    severity: "critical",
    pattern: /\bmkfs\b/,
    description: "Filesystem creation (formats disk)",
    remediation: "This destroys all data on the target device",
  },
  {
    id: "destr-shred",
    category: "destruction",
    severity: "danger",
    pattern: /\bshred\s+/,
    description: "Secure file deletion (irrecoverable)",
  },

  // Network/system
  {
    id: "net-iptables",
    category: "privilege",
    severity: "danger",
    pattern: /\b(?:iptables|nftables|ufw)\s+/,
    description: "Firewall modification",
    remediation: "Firewall changes can disrupt network connectivity",
  },
  {
    id: "sys-systemctl",
    category: "privilege",
    severity: "warning",
    pattern: /\bsystemctl\s+(?:stop|disable|mask|kill)\s+/,
    description: "Stopping or disabling system services",
  },
  {
    id: "sys-crontab",
    category: "privilege",
    severity: "warning",
    pattern: /\bcrontab\s+-[er]\b/,
    description: "Modifying system cron jobs",
  },
];

// ─── Pattern Matching ──────────────────────────────────────────

/**
 * Scan a command against all registered dangerous patterns.
 * Returns all matches with severity, category, and remediation info.
 */
export function scanCommand(command: string): PatternMatch[] {
  const matches: PatternMatch[] = [];

  for (const pattern of PATTERN_REGISTRY) {
    const result = pattern.pattern.exec(command);
    if (result) {
      matches.push({
        patternId: pattern.id,
        category: pattern.category,
        severity: pattern.severity,
        description: pattern.description,
        remediation: pattern.remediation,
        match: result[0],
      });
    }
  }

  return matches;
}

/**
 * Compute an aggregate risk score (0-100) for a command.
 * Combines severity weights from all matched patterns.
 */
export function assessRisk(command: string): RiskAssessment {
  const matches = scanCommand(command);

  if (matches.length === 0) {
    return { score: 0, level: "safe", matches };
  }

  // Sum severity weights, capped at 100
  const score = Math.min(
    100,
    matches.reduce((sum, m) => sum + SEVERITY_WEIGHTS[m.severity], 0),
  );

  const level: RiskAssessment["level"] =
    score >= 80 ? "critical" :
    score >= 50 ? "high" :
    score >= 25 ? "moderate" :
    score >= 10 ? "low" : "safe";

  return { score, level, matches };
}

// ─── Permission Rule Validation ────────────────────────────────

/** Patterns that should NEVER be allowed as permission rules in auto mode */
const DANGEROUS_RULE_PATTERNS = [
  /^Bash\(\*\)$/,              // Bash(*) — allows ANY command
  /^Edit\(\*\)$/,              // Edit(*) — allows editing any file
  /^Write\(\*\)$/,             // Write(*) — allows writing any file
  /^Bash\(python:\*\)$/,      // Bash(python:*) — allows any Python execution
  /^Bash\(node:\*\)$/,        // Bash(node:*) — allows any Node execution
  /^Bash\(ruby:\*\)$/,        // Bash(ruby:*) — allows any Ruby execution
  /^Bash\(perl:\*\)$/,        // Bash(perl:*) — allows any Perl execution
  /^Bash\(php:\*\)$/,         // Bash(php:*) — allows any PHP execution
  /^Bash\(curl:\*\)$/,        // Bash(curl:*) — allows any HTTP request
  /^Bash\(wget:\*\)$/,        // Bash(wget:*) — allows any download
  /^Bash\(sudo:\*\)$/,        // Bash(sudo:*) — allows any sudo command
  /^\*$/,                      // * — wildcard all tools
];

/**
 * Check if a permission rule string is dangerously broad.
 * These should be blocked or warned about in auto mode.
 */
export function isDangerousRule(rule: string): { dangerous: boolean; reason?: string } {
  for (const pattern of DANGEROUS_RULE_PATTERNS) {
    if (pattern.test(rule)) {
      return {
        dangerous: true,
        reason: `Rule "${rule}" is too broad for auto mode — it would allow unrestricted execution`,
      };
    }
  }

  // Check for wildcards in tool argument (except read-only tools)
  const SAFE_WILDCARD_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "DiffView", "GitStatus", "GitLog", "ToolSearch"]);
  const toolNameMatch = rule.match(/^(\w+)\(\*\)$/);
  if (toolNameMatch && !SAFE_WILDCARD_TOOLS.has(toolNameMatch[1]!)) {
    return {
      dangerous: true,
      reason: `Rule "${rule}" uses wildcard argument — restrict to specific patterns`,
    };
  }

  return { dangerous: false };
}

/**
 * Validate a set of permission rules for auto mode safety.
 * Returns list of dangerous rules that should be rejected or warned about.
 */
export function validateRulesForAutoMode(rules: string[]): Array<{ rule: string; reason: string }> {
  const violations: Array<{ rule: string; reason: string }> = [];

  for (const rule of rules) {
    const check = isDangerousRule(rule);
    if (check.dangerous && check.reason) {
      violations.push({ rule, reason: check.reason });
    }
  }

  return violations;
}

// ─── Interpreter Detection ─────────────────────────────────────

/** Known script interpreters */
const INTERPRETERS = new Set([
  "python", "python3", "python2",
  "node", "nodejs", "deno", "bun",
  "ruby", "irb",
  "perl", "perl5", "perl6",
  "php",
  "lua", "luajit",
  "Rscript",
]);

/**
 * Detect if a command invokes a script interpreter.
 * Returns the interpreter name if detected, null otherwise.
 */
export function detectInterpreter(command: string): string | null {
  const trimmed = command.trimStart();

  // Handle sudo/env prefix
  let cmd = trimmed;
  if (cmd.startsWith("sudo ")) cmd = cmd.slice(5).trimStart();
  if (cmd.startsWith("env ")) {
    const parts = cmd.split(/\s+/).slice(1);
    for (const part of parts) {
      if (!part.includes("=")) { cmd = parts.slice(parts.indexOf(part)).join(" "); break; }
    }
  }

  const firstToken = cmd.split(/\s+/)[0] ?? "";
  const basename = firstToken.split("/").pop() ?? firstToken;

  if (INTERPRETERS.has(basename)) {
    return basename;
  }

  return null;
}

// ─── Registry Access ───────────────────────────────────────────

/** Get all registered patterns (for /doctor or debugging) */
export function getRegisteredPatterns(): readonly DangerousPattern[] {
  return PATTERN_REGISTRY;
}

/** Get patterns by category */
export function getPatternsByCategory(category: PatternCategory): DangerousPattern[] {
  return PATTERN_REGISTRY.filter((p) => p.category === category);
}

/** Get patterns by minimum severity */
export function getPatternsBySeverity(minSeverity: PatternSeverity): DangerousPattern[] {
  const severityOrder: PatternSeverity[] = ["info", "warning", "danger", "critical"];
  const minIdx = severityOrder.indexOf(minSeverity);
  return PATTERN_REGISTRY.filter(
    (p) => severityOrder.indexOf(p.severity) >= minIdx,
  );
}
