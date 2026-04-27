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

  // Git destructive operations — overwrite/discard work
  {
    id: "destr-git-force-push",
    category: "destruction",
    severity: "critical",
    pattern: /\bgit\s+push\s+(?:[^|;&\n]*\s+)?(?:--force(?!-with-lease)\b|-f\b)/,
    description: "git push --force — overwrites remote history irreversibly",
    remediation: "Use --force-with-lease for safer overwrites, or push to a new branch",
  },
  {
    id: "destr-git-reset-hard",
    category: "destruction",
    severity: "critical",
    pattern: /\bgit\s+reset\s+--hard\b/,
    description: "git reset --hard — discards uncommitted work and resets HEAD",
    remediation: "Stash changes first (git stash) or commit before resetting",
  },
  {
    id: "destr-git-clean-force",
    category: "destruction",
    severity: "danger",
    pattern: /\bgit\s+clean\s+-[a-zA-Z]*[fdxX][a-zA-Z]*/,
    description: "git clean -f/-d/-x — removes untracked files and directories",
    remediation: "Run with --dry-run (-n) first to preview what will be removed",
  },
  {
    id: "destr-git-branch-force-delete",
    category: "destruction",
    severity: "danger",
    pattern: /\bgit\s+branch\s+(?:-D\b|--delete\s+--force\b|-d[fF]\b|-[fF]d\b)/,
    description: "git branch -D — force-deletes branch (loses unmerged commits)",
    remediation: "Use -d (lowercase) to require merged status before deletion",
  },
  {
    id: "destr-git-checkout-discard",
    category: "destruction",
    severity: "danger",
    pattern: /\bgit\s+(?:checkout|restore)\s+(?:--\s+\.|--\s+\S+|\.\s*$|\.\s+|--source=\S+\s+\.)/,
    description: "git checkout/restore . — discards working-tree changes",
    remediation: "Stash first (git stash) to preserve changes",
  },
  {
    id: "destr-git-filter-branch",
    category: "destruction",
    severity: "critical",
    pattern: /\bgit\s+filter-(?:branch|repo)\b/,
    description: "git filter-branch/filter-repo — rewrites history (irreversible without backup)",
    remediation: "Make a full repo clone backup before any history rewrite",
  },
  {
    id: "destr-git-reflog-expire",
    category: "destruction",
    severity: "critical",
    pattern: /\bgit\s+reflog\s+expire\s+--expire=now\b|\bgit\s+gc\s+--prune=now\b/,
    description: "git reflog/gc with --expire=now or --prune=now — eliminates the safety net for recovering lost commits",
    remediation: "This is the LAST step of intentional secret removal — never run by default",
  },
  {
    id: "destr-git-update-ref-d",
    category: "destruction",
    severity: "danger",
    pattern: /\bgit\s+update-ref\s+-d\b/,
    description: "git update-ref -d — deletes a ref directly (bypasses branch protection logic)",
  },

  // Cloud destructive APIs — IRREVERSIBLE remote data loss
  // Motivation: 2026-04-25 Cursor/Railway incident where Cursor's agent
  // called Railway's volumeDelete GraphQL mutation in 9 seconds, deleting
  // PocketOS production data + backups (backups were stored in same volume).
  {
    id: "destr-cloud-railway-volume-delete",
    category: "destruction",
    severity: "critical",
    pattern: /\bvolumeDelete\b|\bdeleteVolume\b/,
    description: "Railway/cloud volumeDelete mutation — IRREVERSIBLE storage destruction",
    remediation: "Volume deletion is the exact shape of the 2026 PocketOS incident. Never invoke without explicit human confirmation.",
  },
  {
    id: "destr-cloud-kubectl-delete",
    category: "destruction",
    severity: "critical",
    pattern: /\bkubectl\s+delete\s+(?:namespace|ns|pv|pvc|deployment|deploy|sts|statefulset|all|--all\b)/,
    description: "kubectl delete on namespace/PV/PVC/deployment/statefulset/all — destroys cluster state",
    remediation: "Run with --dry-run=server first; ensure backups exist for stateful resources",
  },
  {
    id: "destr-cloud-aws-s3-rm-recursive",
    category: "destruction",
    severity: "critical",
    pattern: /\baws\s+s3\s+(?:rm|rb)\s+.*--recursive\b|\baws\s+s3\s+rb\s+.*--force\b/,
    description: "aws s3 rm --recursive / s3 rb --force — bulk delete S3 objects/buckets",
    remediation: "Verify bucket versioning and MFA-delete are enabled before bulk delete",
  },
  {
    id: "destr-cloud-aws-ec2-terminate",
    category: "destruction",
    severity: "critical",
    pattern: /\baws\s+ec2\s+(?:terminate-instances|delete-volume|delete-snapshot)\b/,
    description: "aws ec2 terminate-instances / delete-volume / delete-snapshot",
    remediation: "Confirm instance/volume/snapshot is not load-bearing; ensure backups",
  },
  {
    id: "destr-cloud-aws-rds-delete",
    category: "destruction",
    severity: "critical",
    pattern: /\baws\s+rds\s+(?:delete-db-(?:instance|cluster|snapshot))\b/,
    description: "aws rds delete-db-instance/cluster/snapshot — production database destruction",
    remediation: "Take a final snapshot first; verify retention policy",
  },
  {
    id: "destr-cloud-terraform-destroy",
    category: "destruction",
    severity: "critical",
    pattern: /\bterraform\s+(?:destroy|apply\s+(?:-destroy|-replace))\b|\btofu\s+destroy\b/,
    description: "terraform destroy / apply -destroy — removes all managed infrastructure",
    remediation: "Run with -target=<resource> to scope, never blanket destroy in shared workspaces",
  },
  {
    id: "destr-cloud-gh-repo-delete",
    category: "destruction",
    severity: "critical",
    pattern: /\bgh\s+(?:repo\s+delete|api\s+(?:-X\s+)?DELETE\s+\/repos)\b/,
    description: "gh repo delete — deletes a GitHub repository",
    remediation: "Repository deletion has no undo after 90 days; archive instead if possible",
  },
  {
    id: "destr-cloud-gcloud-delete",
    category: "destruction",
    severity: "critical",
    pattern: /\bgcloud\s+(?:compute\s+(?:instances|disks)\s+delete|sql\s+instances\s+delete|projects\s+delete)\b/,
    description: "gcloud compute/sql/projects delete — production resource destruction",
    remediation: "Verify resource is not in production traffic path; ensure snapshots",
  },
  {
    id: "destr-cloud-az-delete",
    category: "destruction",
    severity: "critical",
    pattern: /\baz\s+(?:vm\s+delete|group\s+delete|sql\s+(?:db|server)\s+delete)\b/,
    description: "az vm/group/sql delete — Azure resource destruction",
  },
  {
    id: "destr-cloud-firebase-database-delete",
    category: "destruction",
    severity: "critical",
    pattern: /\bfirebase\s+(?:database:remove|firestore:delete|hosting:disable)\b/,
    description: "firebase database/firestore/hosting destructive ops",
  },
  {
    id: "destr-graphql-delete-mutation",
    category: "destruction",
    severity: "danger",
    pattern: /\bcurl\s+[^|;&\n]*-X\s+(?:POST|DELETE)[^|;&\n]*\b(?:delete|destroy|drop|terminate|wipe|purge|remove)[A-Z]\w+/,
    description: "HTTP API call invoking a destructive mutation by name (delete*/destroy*/drop*/terminate*/wipe*)",
    remediation: "Confirm the destructive remote API call with the user; check that the API token is scoped",
  },
  {
    id: "destr-database-drop",
    category: "destruction",
    severity: "critical",
    pattern: /\b(?:psql|mysql|mongo|mongosh|redis-cli|sqlite3)\s+[^|;&\n]*\b(?:DROP\s+(?:DATABASE|TABLE|SCHEMA)|TRUNCATE\s+TABLE|FLUSHALL|FLUSHDB|drop\(\))/i,
    description: "Database client invoking DROP DATABASE/TABLE/SCHEMA, TRUNCATE, FLUSHALL, or .drop()",
    remediation: "Confirm with user; verify backup exists; run on staging first",
  },
  {
    id: "destr-docker-prune",
    category: "destruction",
    severity: "danger",
    pattern: /\bdocker\s+(?:system\s+prune\s+(?:-a|--all)|volume\s+prune\s+(?:-a|--all|--force))\b/,
    description: "docker system/volume prune --all — deletes unused images, containers, volumes (data loss for unmounted volumes)",
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
    score >= 80
      ? "critical"
      : score >= 50
        ? "high"
        : score >= 25
          ? "moderate"
          : score >= 10
            ? "low"
            : "safe";

  return { score, level, matches };
}

// ─── Permission Rule Validation ────────────────────────────────

/** Patterns that should NEVER be allowed as permission rules in auto mode */
const DANGEROUS_RULE_PATTERNS = [
  /^Bash\(\*\)$/, // Bash(*) — allows ANY command
  /^Edit\(\*\)$/, // Edit(*) — allows editing any file
  /^Write\(\*\)$/, // Write(*) — allows writing any file
  /^Bash\(python:\*\)$/, // Bash(python:*) — allows any Python execution
  /^Bash\(node:\*\)$/, // Bash(node:*) — allows any Node execution
  /^Bash\(ruby:\*\)$/, // Bash(ruby:*) — allows any Ruby execution
  /^Bash\(perl:\*\)$/, // Bash(perl:*) — allows any Perl execution
  /^Bash\(php:\*\)$/, // Bash(php:*) — allows any PHP execution
  /^Bash\(curl:\*\)$/, // Bash(curl:*) — allows any HTTP request
  /^Bash\(wget:\*\)$/, // Bash(wget:*) — allows any download
  /^Bash\(sudo:\*\)$/, // Bash(sudo:*) — allows any sudo command
  /^\*$/, // * — wildcard all tools
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
  const SAFE_WILDCARD_TOOLS = new Set([
    "Read",
    "Glob",
    "Grep",
    "LS",
    "DiffView",
    "GitStatus",
    "GitLog",
    "ToolSearch",
  ]);
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
  "python",
  "python3",
  "python2",
  "node",
  "nodejs",
  "deno",
  "bun",
  "ruby",
  "irb",
  "perl",
  "perl5",
  "perl6",
  "php",
  "lua",
  "luajit",
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
      if (!part.includes("=")) {
        cmd = parts.slice(parts.indexOf(part)).join(" ");
        break;
      }
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
  return PATTERN_REGISTRY.filter((p) => severityOrder.indexOf(p.severity) >= minIdx);
}
