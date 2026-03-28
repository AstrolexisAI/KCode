// KCode - Change Review System
// Classifies changes, detects risks, and suggests post-change actions

import { execSync } from "node:child_process";
import { basename, extname } from "node:path";

// ─── Types ──────────────────────────────────────────────────────

export interface FileChange {
  path: string;
  type: "created" | "modified" | "deleted" | "renamed";
  linesAdded: number;
  linesRemoved: number;
}

export type ChangeCategory =
  | "refactor"
  | "fix"
  | "feature"
  | "test"
  | "config"
  | "docs"
  | "security"
  | "migration"
  | "dependency";

export interface ChangeClassification {
  category: ChangeCategory;
  confidence: number; // 0-1
}

export interface RiskAssessment {
  level: "low" | "medium" | "high" | "critical";
  reasons: string[];
}

export interface ReviewSuggestion {
  icon: string;
  message: string;
  priority: "info" | "warning" | "action";
}

export interface ChangeReview {
  files: FileChange[];
  classification: ChangeClassification;
  risk: RiskAssessment;
  suggestions: ReviewSuggestion[];
  summary: string;
}

// ─── Helpers ────────────────────────────────────────────────────

const TEST_PATTERNS = [
  /\.test\.\w+$/,
  /\.spec\.\w+$/,
  /_test\.\w+$/,
  /^tests?\//,
  /__tests__\//,
];

const DOC_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst", ".adoc"]);

const CONFIG_PATTERNS = [
  /\.env/,
  /\.config\.\w+$/,
  /\.json$/,
  /\.ya?ml$/,
  /\.toml$/,
  /tsconfig/,
  /\.eslintrc/,
  /\.prettierrc/,
  /\.editorconfig/,
  /Makefile$/,
  /\.github\//,
  /\.gitlab-ci/,
  /Jenkinsfile/,
  /\.circleci/,
  /Dockerfile/,
  /docker-compose/,
];

const SECURITY_PATTERNS = [
  /auth/i,
  /permission/i,
  /security/i,
  /secret/i,
  /credential/i,
  /token/i,
  /password/i,
  /crypt/i,
  /oauth/i,
  /jwt/i,
  /\.env/,
  /\.pem$/,
  /\.key$/,
];

const CRITICAL_PATTERNS = [
  /\.env$/,
  /\.env\.\w+$/,
  /secrets?\.\w+$/,
  /credentials?\.\w+$/,
  /api[_-]?keys?\.\w+$/,
  /\.pem$/,
  /\.key$/,
  /Dockerfile/,
  /docker-compose/,
  /\.github\/workflows\//,
  /\.gitlab-ci/,
  /Jenkinsfile/,
  /\.circleci/,
  /sudo/,
];

const HIGH_RISK_PATTERNS = [
  /migration/i,
  /package\.json$/,
  /package-lock\.json$/,
  /yarn\.lock$/,
  /bun\.lockb$/,
  /pnpm-lock/,
  /auth/i,
  /permission/i,
  /security/i,
];

const MIGRATION_PATTERNS = [/migration/i, /migrate/i, /schema/i, /\.sql$/];

function isTestFile(path: string): boolean {
  return TEST_PATTERNS.some((p) => p.test(path));
}

function isDocFile(path: string): boolean {
  return DOC_EXTENSIONS.has(extname(path).toLowerCase());
}

function isConfigFile(path: string): boolean {
  return CONFIG_PATTERNS.some((p) => p.test(path));
}

function isSecurityFile(path: string): boolean {
  return SECURITY_PATTERNS.some((p) => p.test(path));
}

function isMigrationFile(path: string): boolean {
  return MIGRATION_PATTERNS.some((p) => p.test(path));
}

function isDependencyFile(path: string): boolean {
  const name = basename(path);
  return /^(package\.json|package-lock\.json|yarn\.lock|bun\.lockb|pnpm-lock\.ya?ml|Gemfile|Gemfile\.lock|requirements.*\.txt|Pipfile|Pipfile\.lock|go\.sum|go\.mod|Cargo\.lock|Cargo\.toml|composer\.json|composer\.lock)$/.test(
    name,
  );
}

function isPublicApiFile(path: string): boolean {
  return (
    /src\/tools\//.test(path) ||
    /src\/core\/types/.test(path) ||
    /index\.\w+$/.test(basename(path))
  );
}

// ─── Classification ─────────────────────────────────────────────

export function classifyChanges(files: FileChange[]): ChangeClassification {
  if (files.length === 0) {
    return { category: "refactor", confidence: 0.1 };
  }

  const testFiles = files.filter((f) => isTestFile(f.path));
  const docFiles = files.filter((f) => isDocFile(f.path));
  const configFiles = files.filter((f) => isConfigFile(f.path));
  const depFiles = files.filter((f) => isDependencyFile(f.path));
  const securityFiles = files.filter((f) => isSecurityFile(f.path));
  const migrationFiles = files.filter((f) => isMigrationFile(f.path));
  const sourceFiles = files.filter(
    (f) =>
      !isTestFile(f.path) &&
      !isDocFile(f.path) &&
      !isConfigFile(f.path) &&
      !isDependencyFile(f.path),
  );

  // Pure test changes
  if (testFiles.length === files.length) {
    return { category: "test", confidence: 0.95 };
  }

  // Pure doc changes
  if (docFiles.length === files.length) {
    return { category: "docs", confidence: 0.95 };
  }

  // Pure dependency changes
  if (depFiles.length === files.length) {
    return { category: "dependency", confidence: 0.9 };
  }

  // Pure config changes
  if (configFiles.length === files.length) {
    return { category: "config", confidence: 0.85 };
  }

  // Migration files present
  if (migrationFiles.length > 0) {
    return { category: "migration", confidence: 0.85 };
  }

  // Security-related files dominate
  if (securityFiles.length > 0 && securityFiles.length >= files.length / 2) {
    return { category: "security", confidence: 0.8 };
  }

  // Source + tests together
  if (sourceFiles.length > 0 && testFiles.length > 0) {
    const totalAdded = files.reduce((sum, f) => sum + f.linesAdded, 0);
    const sourceAdded = sourceFiles.reduce((sum, f) => sum + f.linesAdded, 0);
    // More new source code than modifications = feature
    if (sourceAdded > totalAdded * 0.5 && files.some((f) => f.type === "created")) {
      return { category: "feature", confidence: 0.75 };
    }
    return { category: "fix", confidence: 0.7 };
  }

  // Source-only changes
  if (sourceFiles.length > 0) {
    // New files = feature
    if (sourceFiles.some((f) => f.type === "created")) {
      return { category: "feature", confidence: 0.65 };
    }
    // Only modifications, no new files = refactor
    if (sourceFiles.every((f) => f.type === "modified")) {
      return { category: "refactor", confidence: 0.6 };
    }
  }

  // Mixed — fallback
  return { category: "feature", confidence: 0.4 };
}

// ─── Risk Assessment ────────────────────────────────────────────

export function assessRisk(files: FileChange[]): RiskAssessment {
  const reasons: string[] = [];
  let level: RiskAssessment["level"] = "low";

  const totalAdded = files.reduce((sum, f) => sum + f.linesAdded, 0);
  const totalRemoved = files.reduce((sum, f) => sum + f.linesRemoved, 0);
  const totalChanged = totalAdded + totalRemoved;

  // Critical checks
  for (const f of files) {
    if (CRITICAL_PATTERNS.some((p) => p.test(f.path))) {
      level = "critical";
      reasons.push(`Critical file modified: ${f.path}`);
    }
  }

  // High-risk checks
  if (level !== "critical") {
    for (const f of files) {
      if (HIGH_RISK_PATTERNS.some((p) => p.test(f.path))) {
        if (level === "low" || level === "medium") level = "high";
        reasons.push(`High-risk file modified: ${f.path}`);
      }
    }
  }

  // Medium risk: many files or many lines
  if (files.length > 5 && level === "low") {
    level = "medium";
    reasons.push(`${files.length} files changed`);
  }
  if (totalChanged > 200 && level === "low") {
    level = "medium";
    reasons.push(`${totalChanged} total lines changed`);
  }

  // Core module changes
  for (const f of files) {
    if (/src\/core\//.test(f.path) && !isTestFile(f.path)) {
      if (level === "low") level = "medium";
      reasons.push(`Core module modified: ${basename(f.path)}`);
    }
  }

  // Low risk: only tests or docs
  if (
    files.every((f) => isTestFile(f.path) || isDocFile(f.path)) &&
    reasons.length === 0
  ) {
    return { level: "low", reasons: ["Tests/docs only"] };
  }

  if (reasons.length === 0) {
    reasons.push("Standard change");
  }

  return { level, reasons };
}

// ─── Suggestions ────────────────────────────────────────────────

export function generateSuggestions(
  files: FileChange[],
  classification: ChangeClassification,
  risk: RiskAssessment,
): ReviewSuggestion[] {
  const suggestions: ReviewSuggestion[] = [];

  const testFiles = files.filter((f) => isTestFile(f.path));
  const sourceFiles = files.filter(
    (f) =>
      !isTestFile(f.path) &&
      !isDocFile(f.path) &&
      !isConfigFile(f.path) &&
      !isDependencyFile(f.path),
  );
  const configFiles = files.filter((f) => isConfigFile(f.path));
  const docFiles = files.filter((f) => isDocFile(f.path));
  const totalChanged =
    files.reduce((sum, f) => sum + f.linesAdded, 0) +
    files.reduce((sum, f) => sum + f.linesRemoved, 0);

  // Code changed without tests
  if (sourceFiles.length > 0 && testFiles.length === 0) {
    suggestions.push({
      icon: "\u26A0",
      message: "Source code changed without corresponding test updates",
      priority: "warning",
    });
  }

  // Public API modified
  if (files.some((f) => isPublicApiFile(f.path))) {
    suggestions.push({
      icon: "\uD83D\uDD17",
      message: "Public API file modified — verify backward compatibility",
      priority: "warning",
    });
  }

  // Config changed without docs
  if (configFiles.length > 0 && docFiles.length === 0) {
    suggestions.push({
      icon: "\uD83D\uDCDD",
      message: "Config changed — consider updating documentation",
      priority: "info",
    });
  }

  // Security-sensitive files
  if (files.some((f) => isSecurityFile(f.path))) {
    suggestions.push({
      icon: "\uD83D\uDD12",
      message: "Security-sensitive file modified — review carefully",
      priority: "action",
    });
  }

  // Migration detected
  if (files.some((f) => isMigrationFile(f.path))) {
    suggestions.push({
      icon: "\uD83D\uDDC3",
      message: "Migration detected — verify rollback procedure",
      priority: "action",
    });
  }

  // Many files changed
  if (files.length > 3) {
    suggestions.push({
      icon: "\uD83E\uDDEA",
      message: "Multiple files changed — consider running full test suite",
      priority: "info",
    });
  }

  // Large change
  if (totalChanged > 300) {
    suggestions.push({
      icon: "\u2702",
      message: `Large change (${totalChanged} lines) — consider splitting into smaller commits`,
      priority: "info",
    });
  }

  // Dependency update
  if (files.some((f) => isDependencyFile(f.path))) {
    suggestions.push({
      icon: "\uD83D\uDCE6",
      message: "Dependencies changed — run install and verify lockfile",
      priority: "action",
    });
  }

  return suggestions;
}

// ─── Git Integration ────────────────────────────────────────────

function parseNameStatus(output: string): FileChange[] {
  const files: FileChange[] = [];
  const lines = output.trim().split("\n").filter(Boolean);

  for (const line of lines) {
    const match = line.match(/^([AMDRC])\d*\t(.+?)(?:\t(.+))?$/);
    if (!match) continue;

    const [, status, filePath, renamedTo] = match;
    let type: FileChange["type"];
    switch (status) {
      case "A":
        type = "created";
        break;
      case "D":
        type = "deleted";
        break;
      case "R":
      case "C":
        type = "renamed";
        break;
      default:
        type = "modified";
    }

    files.push({
      path: renamedTo ?? filePath!,
      type,
      linesAdded: 0,
      linesRemoved: 0,
    });
  }

  return files;
}

function parseDiffStat(output: string, files: FileChange[]): void {
  // Parse numstat output: added\tremoved\tpath
  const lines = output.trim().split("\n").filter(Boolean);
  const statMap = new Map<string, { added: number; removed: number }>();

  for (const line of lines) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const added = parseInt(parts[0]!, 10) || 0;
    const removed = parseInt(parts[1]!, 10) || 0;
    const path = parts[2]!;
    // Handle renames: {old => new} or old => new
    const cleanPath = path.replace(/\{.+? => (.+?)\}/, "$1").replace(/.+ => /, "");
    statMap.set(cleanPath, { added, removed });
  }

  for (const f of files) {
    const stat = statMap.get(f.path);
    if (stat) {
      f.linesAdded = stat.added;
      f.linesRemoved = stat.removed;
    }
  }
}

export async function reviewChanges(
  workingDir?: string,
  staged = false,
): Promise<ChangeReview> {
  const cwd = workingDir ?? process.cwd();
  const diffFlag = staged ? "--cached" : "";

  let nameStatusOutput: string;
  let numstatOutput: string;
  try {
    nameStatusOutput = execSync(`git diff ${diffFlag} --name-status`, {
      cwd,
      encoding: "utf-8",
      timeout: 10000,
    });
    numstatOutput = execSync(`git diff ${diffFlag} --numstat`, {
      cwd,
      encoding: "utf-8",
      timeout: 10000,
    });
  } catch {
    return {
      files: [],
      classification: { category: "refactor", confidence: 0 },
      risk: { level: "low", reasons: ["No changes detected"] },
      suggestions: [],
      summary: "No changes found.",
    };
  }

  const files = parseNameStatus(nameStatusOutput);
  parseDiffStat(numstatOutput, files);

  if (files.length === 0) {
    return {
      files: [],
      classification: { category: "refactor", confidence: 0 },
      risk: { level: "low", reasons: ["No changes detected"] },
      suggestions: [],
      summary: "No changes found.",
    };
  }

  const classification = classifyChanges(files);
  const risk = assessRisk(files);
  const suggestions = generateSuggestions(files, classification, risk);

  const totalAdded = files.reduce((sum, f) => sum + f.linesAdded, 0);
  const totalRemoved = files.reduce((sum, f) => sum + f.linesRemoved, 0);
  const summary = `${files.length} file${files.length !== 1 ? "s" : ""} changed (+${totalAdded} -${totalRemoved}), classified as ${classification.category} (${Math.round(classification.confidence * 100)}% confidence), risk: ${risk.level}`;

  return { files, classification, risk, suggestions, summary };
}

// ─── Formatting ─────────────────────────────────────────────────

const RISK_COLORS: Record<RiskAssessment["level"], string> = {
  low: "\x1b[32m",      // green
  medium: "\x1b[33m",   // yellow
  high: "\x1b[31m",     // red
  critical: "\x1b[35m", // magenta
};

const PRIORITY_MARKERS: Record<ReviewSuggestion["priority"], string> = {
  info: "\x1b[36m",    // cyan
  warning: "\x1b[33m", // yellow
  action: "\x1b[31m",  // red
};

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

export function formatReview(review: ChangeReview): string {
  if (review.files.length === 0) {
    return "  No changes to review.";
  }

  const lines: string[] = [];

  // Header
  lines.push(`${BOLD}  Change Review${RESET}`);
  lines.push(`${DIM}  ${"─".repeat(50)}${RESET}`);

  // Summary
  lines.push(`  ${review.summary}`);
  lines.push("");

  // Classification
  lines.push(
    `  ${BOLD}Category:${RESET} ${review.classification.category} (${Math.round(review.classification.confidence * 100)}% confidence)`,
  );

  // Risk
  const riskColor = RISK_COLORS[review.risk.level];
  lines.push(
    `  ${BOLD}Risk:${RESET} ${riskColor}${review.risk.level.toUpperCase()}${RESET}`,
  );
  for (const reason of review.risk.reasons) {
    lines.push(`    ${DIM}- ${reason}${RESET}`);
  }
  lines.push("");

  // Files
  lines.push(`  ${BOLD}Files (${review.files.length}):${RESET}`);
  const typeIcons: Record<FileChange["type"], string> = {
    created: "+",
    modified: "~",
    deleted: "-",
    renamed: ">",
  };
  for (const f of review.files) {
    const icon = typeIcons[f.type];
    const stat =
      f.linesAdded || f.linesRemoved
        ? ` ${DIM}(+${f.linesAdded} -${f.linesRemoved})${RESET}`
        : "";
    lines.push(`    ${icon} ${f.path}${stat}`);
  }
  lines.push("");

  // Suggestions
  if (review.suggestions.length > 0) {
    lines.push(`  ${BOLD}Suggestions:${RESET}`);
    for (const s of review.suggestions) {
      const color = PRIORITY_MARKERS[s.priority];
      lines.push(`    ${s.icon} ${color}${s.message}${RESET}`);
    }
  }

  return lines.join("\n");
}
