// KCode - Phase 26: Write content scanner
//
// Two complementary scans run on every Write/Edit content:
//
//   1. Secrets detector — BLOCKS the write when the content contains a
//      plausible API key, access token, password, or credential that
//      looks real (not a placeholder). Catches the "model memorized a
//      secret earlier in the session and dumped it into code" failure
//      mode. False positives here are better than accidentally shipping
//      a leaked key.
//
//   2. Debug-statement detector — WARNS (non-blocking) when the content
//      contains leftover console.log / debugger / dbg! / fmt.Println
//      debug statements. Appended to the write-success message so the
//      model sees it and has the option to clean up. Blocking this
//      would be too aggressive because many legitimate files have
//      console.log (tests, CLI tools, demos).
//
// Secrets are blocking; debug is advisory. The scan runs only on
// writes to non-test, non-example source files — a .env.example,
// foo.test.ts, or README.md is allowed to contain literal examples.

import { basename } from "node:path";

// ─── Secret patterns ────────────────────────────────────────────

interface SecretPattern {
  name: string;
  regex: RegExp;
}

/**
 * Well-known credential shapes. Each pattern is anchored tightly
 * enough that random base64-looking strings in comments or docs
 * don't false-positive. All patterns require a minimum length that
 * excludes placeholder tokens like "sk-YOUR_KEY_HERE".
 */
const SECRET_PATTERNS: SecretPattern[] = [
  // OpenAI API key
  { name: "openai-api-key", regex: /\bsk-[A-Za-z0-9]{32,}\b/ },
  // Anthropic API key (note: Anthropic keys start with sk-ant-)
  { name: "anthropic-api-key", regex: /\bsk-ant-[A-Za-z0-9\-_]{80,}\b/ },
  // xAI / Grok API key (observed pattern: xai- followed by 64+ alnum)
  { name: "xai-api-key", regex: /\bxai-[A-Za-z0-9]{64,}\b/ },
  // Google API key
  { name: "google-api-key", regex: /\bAIza[0-9A-Za-z\-_]{35}\b/ },
  // AWS access key ID
  { name: "aws-access-key-id", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  // GitHub personal access token (classic)
  { name: "github-pat", regex: /\bghp_[A-Za-z0-9]{36}\b/ },
  // GitHub fine-grained PAT
  { name: "github-pat-fg", regex: /\bgithub_pat_[A-Za-z0-9_]{82}\b/ },
  // Slack bot token
  { name: "slack-bot-token", regex: /\bxoxb-[A-Za-z0-9\-]{40,}\b/ },
  // Stripe live secret key
  { name: "stripe-secret", regex: /\bsk_live_[A-Za-z0-9]{24,}\b/ },
  // Google OAuth client secret (GOCSPX- prefix)
  { name: "google-oauth-secret", regex: /\bGOCSPX-[A-Za-z0-9_\-]{28,}\b/ },
  // Generic assignment of "api_key" / "apikey" / "access_token" /
  // "auth_token" / "secret_key" followed by a string literal of
  // ≥20 chars. Matches both camelCase and snake_case variants.
  {
    name: "generic-api-key-assignment",
    regex:
      /\b(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|secret[_-]?key|client[_-]?secret)\s*[:=]\s*["']([A-Za-z0-9_\-+/=]{20,})["']/i,
  },
  // Bearer token in source (Authorization header literal)
  { name: "bearer-token", regex: /\bBearer\s+[A-Za-z0-9\-._~+/]{20,}\b/ },
];

/**
 * Placeholder tokens that match our key-shape regexes but are
 * obviously examples. We strip these before scanning so legitimate
 * docs like `sk-YOUR_KEY_HERE` don't trip the detector even if the
 * length happens to match.
 */
const PLACEHOLDER_SUBSTRINGS = [
  "YOUR_",
  "REPLACE_",
  "EXAMPLE", // matches both "EXAMPLE_" and trailing "EXAMPLE" (AWS convention AKIAIOSFODNN7EXAMPLE)
  "DEMO_",
  "DUMMY_",
  "PLACEHOLDER",
  "XXXXXX",
  "xxxxxx",
  "your-",
  "example-",
  "my-key",
];

function looksLikePlaceholder(match: string): boolean {
  for (const p of PLACEHOLDER_SUBSTRINGS) {
    if (match.includes(p)) return true;
  }
  // All-x / all-zero strings
  if (/^(sk-|xai-|AKIA|ghp_)?x+$/i.test(match)) return true;
  if (/^[0-]+$/.test(match)) return true;
  return false;
}

/**
 * Filenames / paths where literal example credentials are allowed.
 * .env.example files frequently ship with fake but shape-correct
 * placeholder keys to document the required variables.
 */
const SECRET_EXEMPT_PATTERNS: RegExp[] = [
  /\.env\.(example|sample|template|dist)$/i,
  /\.env-example$/i,
  /\.env\.test$/i,
  /secrets?\.sample\./i,
  /credentials\.example/i,
  // Docs and readmes are exempted too — we don't want to block a
  // README that shows how to configure an API key
  /README(\.\w+)?$/i,
  /CHANGELOG(\.\w+)?$/i,
  /\.md$/i,
  /\.rst$/i,
];

function pathIsExempt(filePath: string): boolean {
  const name = basename(filePath);
  return SECRET_EXEMPT_PATTERNS.some((re) => re.test(name) || re.test(filePath));
}

export interface SecretHit {
  name: string;
  snippet: string;
  line: number;
}

export interface SecretVerdict {
  hasSecret: boolean;
  hits: SecretHit[];
}

/**
 * Scan file content for plausible secrets. Returns every distinct
 * hit with a truncated snippet and 1-based line number.
 */
export function detectSecrets(
  filePath: string,
  content: string,
): SecretVerdict {
  if (pathIsExempt(filePath)) return { hasSecret: false, hits: [] };

  const hits: SecretHit[] = [];
  const seen = new Set<string>();

  for (const { name, regex } of SECRET_PATTERNS) {
    const globalRegex = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : regex.flags + "g");
    let m: RegExpExecArray | null;
    while ((m = globalRegex.exec(content)) !== null) {
      const full = m[0];
      if (looksLikePlaceholder(full)) continue;
      // Dedup on the matched string itself
      if (seen.has(full)) continue;
      seen.add(full);
      // Compute 1-based line number
      const line = content.slice(0, m.index).split("\n").length;
      const snippet =
        full.length > 60 ? full.slice(0, 20) + "…" + full.slice(-12) : full;
      hits.push({ name, snippet, line });
      if (m.index === globalRegex.lastIndex) globalRegex.lastIndex++;
    }
  }

  return { hasSecret: hits.length > 0, hits };
}

export function buildSecretReport(
  filePath: string,
  verdict: SecretVerdict,
): string {
  const lines: string[] = [];
  lines.push(
    `BLOCKED — FILE NOT CREATED: "${basename(filePath)}" contains ${verdict.hits.length} plausible credential(s).`,
  );
  lines.push("");
  lines.push(`Detected secret(s):`);
  for (const h of verdict.hits.slice(0, 6)) {
    lines.push(`  [${h.name}] line ${h.line}: ${h.snippet}`);
  }
  if (verdict.hits.length > 6) {
    lines.push(`  ...and ${verdict.hits.length - 6} more`);
  }
  lines.push("");
  lines.push(
    `Hardcoding credentials in source files is a production-grade`,
  );
  lines.push(
    `security risk. The user's API keys belong in environment variables,`,
  );
  lines.push(
    `not in HTML/JS/config files that might get committed to git or`,
  );
  lines.push(`shipped to clients.`);
  lines.push("");
  lines.push(`You MUST do ONE of:`);
  lines.push(
    `  a) Replace the literal credential with an env-var reference`,
  );
  lines.push(
    `     (process.env.API_KEY, Deno.env.get("API_KEY"), import.meta.env.VAR,`,
  );
  lines.push(`     etc.) and retry the Write.`);
  lines.push(
    `  b) If this is an example/template file, rename it to`,
  );
  lines.push(
    `     \`.env.example\` / \`config.sample.json\` / similar — those`,
  );
  lines.push(`     paths are exempt from the secret scanner.`);
  lines.push(
    `  c) If the "secret" is actually a public demo key (e.g. NASA`,
  );
  lines.push(
    `     DEMO_KEY, Mapbox public token), replace it with a placeholder`,
  );
  lines.push(
    `     like \`YOUR_API_KEY_HERE\` — placeholders are ignored by the`,
  );
  lines.push(`     scanner.`);
  return lines.join("\n");
}

// ─── Debug statement detector (warning-only) ─────────────────────

interface DebugPattern {
  name: string;
  regex: RegExp;
  /** File extensions this pattern applies to; empty = all. */
  extensions: string[];
}

const DEBUG_PATTERNS: DebugPattern[] = [
  // JavaScript / TypeScript
  {
    name: "console.log",
    regex: /\bconsole\.(?:log|debug|trace|dir)\s*\(/g,
    extensions: [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".html", ".vue", ".svelte", ".astro"],
  },
  {
    name: "debugger",
    regex: /^\s*debugger\s*;?\s*$/gm,
    extensions: [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".html", ".vue", ".svelte", ".astro"],
  },
  // Python
  {
    name: "print()",
    regex: /^\s*print\s*\(/gm,
    extensions: [".py"],
  },
  {
    name: "breakpoint()",
    regex: /\bbreakpoint\s*\(\s*\)/g,
    extensions: [".py"],
  },
  // Rust
  {
    name: "dbg!",
    regex: /\bdbg!\s*\(/g,
    extensions: [".rs"],
  },
  {
    name: "println!",
    regex: /\bprintln!\s*\(/g,
    extensions: [".rs"],
  },
];

/** File patterns where debug statements are expected / acceptable. */
const DEBUG_EXEMPT_PATTERNS: RegExp[] = [
  /\.test\./,
  /\.spec\./,
  /__tests__/,
  /\/tests?\//,
  /\/examples?\//,
  /\/demos?\//,
  /\/fixtures?\//,
  /\/scripts?\//,
  /\/bin\//,
];

export interface DebugHit {
  name: string;
  line: number;
  snippet: string;
}

export interface DebugVerdict {
  hasDebug: boolean;
  hits: DebugHit[];
}

function debugPathIsExempt(filePath: string): boolean {
  return DEBUG_EXEMPT_PATTERNS.some((re) => re.test(filePath));
}

function fileExt(filePath: string): string {
  const i = filePath.lastIndexOf(".");
  return i >= 0 ? filePath.slice(i).toLowerCase() : "";
}

/**
 * Scan file content for debug statements. Non-blocking — callers
 * should append the result as a warning to a successful-write
 * message, not use it as a rejection signal.
 */
export function detectDebugStatements(
  filePath: string,
  content: string,
): DebugVerdict {
  if (debugPathIsExempt(filePath)) return { hasDebug: false, hits: [] };

  const ext = fileExt(filePath);
  const hits: DebugHit[] = [];

  for (const { name, regex, extensions } of DEBUG_PATTERNS) {
    if (extensions.length > 0 && !extensions.includes(ext)) continue;
    const globalRegex = new RegExp(
      regex.source,
      regex.flags.includes("g") ? regex.flags : regex.flags + "g",
    );
    let m: RegExpExecArray | null;
    let count = 0;
    while ((m = globalRegex.exec(content)) !== null) {
      if (count >= 10) break; // cap reports per pattern
      count++;
      const line = content.slice(0, m.index).split("\n").length;
      const lineText = content.split("\n")[line - 1]?.trim() ?? "";
      const snippet = lineText.length > 80 ? lineText.slice(0, 77) + "…" : lineText;
      hits.push({ name, line, snippet });
      if (m.index === globalRegex.lastIndex) globalRegex.lastIndex++;
    }
  }

  return { hasDebug: hits.length > 0, hits };
}

export function buildDebugWarning(verdict: DebugVerdict): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(
    `⚠️  ${verdict.hits.length} debug statement(s) detected in the written content:`,
  );
  for (const h of verdict.hits.slice(0, 6)) {
    lines.push(`   [${h.name}] line ${h.line}: ${h.snippet}`);
  }
  if (verdict.hits.length > 6) {
    lines.push(`   ...and ${verdict.hits.length - 6} more`);
  }
  lines.push("");
  lines.push(
    `   These are non-blocking but usually leftover from development.`,
  );
  lines.push(
    `   Before shipping this file, consider removing them or gating`,
  );
  lines.push(
    `   behind a DEBUG flag. Tests, examples, and scripts/bin/ paths`,
  );
  lines.push(`   are exempt from this check.`);
  return lines.join("\n");
}

// ─── Phase 27.5 (P4-lite): declaration loss detector ────────────
//
// Phase 19 (detectInPlaceShrinkage) catches ≥35% line-count drops.
// Phase 17 (detectSkeletonContent) catches placeholder stubs. The
// gap: a "refactor" that drops 5 functions but keeps the file size
// via added CSS / comments. No placeholders, shrinkage ratio sits
// above 65%, both existing guards stay silent while the model
// silently removed features.
//
// This heuristic counts top-level declarations in both old and new
// content. If the new content has ≥3 fewer declarations AND lost
// ≥30% of what was there, append a non-blocking warning so the
// model can retract or re-add.
//
// Non-blocking because:
//   - merge/consolidation refactors are legitimate use cases
//   - a pure regex is not authoritative about whether "fewer decls
//     means less functionality"
//   - warning + Edit retry is strictly better than incorrectly
//     blocking a legit refactor

interface DeclarationPattern {
  name: string;
  regex: RegExp;
  extensions: string[];
}

const DECLARATION_PATTERNS: DeclarationPattern[] = [
  // JavaScript / TypeScript
  {
    name: "js-function",
    regex: /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+[A-Za-z_$][A-Za-z0-9_$]*/gm,
    extensions: [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"],
  },
  {
    name: "js-class",
    regex: /^\s*(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+[A-Za-z_$][A-Za-z0-9_$]*/gm,
    extensions: [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"],
  },
  {
    name: "ts-interface",
    regex: /^\s*(?:export\s+)?interface\s+[A-Za-z_$][A-Za-z0-9_$]*/gm,
    extensions: [".ts", ".tsx"],
  },
  {
    name: "ts-type-alias",
    regex: /^\s*(?:export\s+)?type\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=/gm,
    extensions: [".ts", ".tsx"],
  },
  // Inline HTML-embedded JS: function decls inside <script> tags.
  // For HTML files we count the same JS patterns but also arrow
  // function consts assigned at module level, since model-generated
  // HTML often uses `const foo = () => {}` as top-level handlers.
  {
    name: "html-script-function",
    regex: /^\s*(?:export\s+)?function\s+[A-Za-z_$][A-Za-z0-9_$]*/gm,
    extensions: [".html", ".htm"],
  },
  {
    name: "html-script-arrow",
    regex:
      /^\s*(?:const|let|var)\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$])\s*=>/gm,
    extensions: [".html", ".htm", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"],
  },
  // Python
  {
    name: "py-def",
    regex: /^\s*def\s+[A-Za-z_][A-Za-z0-9_]*/gm,
    extensions: [".py"],
  },
  {
    name: "py-class",
    regex: /^\s*class\s+[A-Za-z_][A-Za-z0-9_]*/gm,
    extensions: [".py"],
  },
  // Go
  {
    name: "go-func",
    regex: /^\s*func\s+(?:\([^)]+\)\s+)?[A-Za-z_][A-Za-z0-9_]*/gm,
    extensions: [".go"],
  },
  {
    name: "go-type",
    regex: /^\s*type\s+[A-Za-z_][A-Za-z0-9_]*/gm,
    extensions: [".go"],
  },
  // Rust
  {
    name: "rust-fn",
    regex: /^\s*(?:pub\s+(?:\([^)]+\)\s+)?)?(?:async\s+)?fn\s+[A-Za-z_][A-Za-z0-9_]*/gm,
    extensions: [".rs"],
  },
  {
    name: "rust-struct",
    regex: /^\s*(?:pub\s+(?:\([^)]+\)\s+)?)?(?:struct|enum|trait)\s+[A-Za-z_][A-Za-z0-9_]*/gm,
    extensions: [".rs"],
  },
];

function getExt(filePath: string): string {
  const i = filePath.lastIndexOf(".");
  return i >= 0 ? filePath.slice(i).toLowerCase() : "";
}

/**
 * Count top-level declarations (functions, classes, interfaces,
 * types, structs, etc.) in the given content, based on the file
 * extension. Returns 0 for unknown extensions so we don't warn
 * on file types we can't parse cheaply.
 */
export function countDeclarations(
  content: string,
  filePath: string,
): number {
  const ext = getExt(filePath);
  let total = 0;
  for (const { regex, extensions } of DECLARATION_PATTERNS) {
    if (!extensions.includes(ext)) continue;
    const global = new RegExp(
      regex.source,
      regex.flags.includes("g") ? regex.flags : regex.flags + "g",
    );
    const matches = content.match(global);
    if (matches) total += matches.length;
  }
  return total;
}

export interface DeclarationLossVerdict {
  hasLoss: boolean;
  oldCount: number;
  newCount: number;
  lost: number;
  lossRatio: number;
}

/**
 * Compare declaration counts between old and new content. Returns
 * hasLoss=true when:
 *   - old file had ≥5 declarations (skip tiny files)
 *   - new file has ≥3 fewer declarations
 *   - ratio lost/old ≥ 0.3 (dropped ≥30% of declarations)
 *
 * These thresholds are deliberately conservative — a pure
 * rename/consolidation that drops 1-2 functions should NOT warn.
 */
export function detectDeclarationLoss(
  oldContent: string,
  newContent: string,
  filePath: string,
): DeclarationLossVerdict {
  const oldCount = countDeclarations(oldContent, filePath);
  const newCount = countDeclarations(newContent, filePath);
  const lost = oldCount - newCount;
  const lossRatio = oldCount > 0 ? lost / oldCount : 0;
  const hasLoss = oldCount >= 5 && lost >= 3 && lossRatio >= 0.3;
  return { hasLoss, oldCount, newCount, lost, lossRatio };
}

export function buildDeclarationLossWarning(
  verdict: DeclarationLossVerdict,
): string {
  const lines: string[] = [];
  const pct = Math.round(verdict.lossRatio * 100);
  lines.push("");
  lines.push(
    `⚠️  DECLARATION LOSS (non-blocking warning)`,
  );
  lines.push(
    `   Old file had ${verdict.oldCount} top-level declarations` +
      ` (functions, classes, types, structs).`,
  );
  lines.push(
    `   New file has ${verdict.newCount}. You dropped ${verdict.lost}` +
      ` declarations (${pct}%).`,
  );
  lines.push("");
  lines.push(
    `   This could be a legitimate consolidation — merging 5 helpers`,
  );
  lines.push(
    `   into 3 is fine if behavior is preserved. But it could also`,
  );
  lines.push(
    `   mean silently dropped features. Phase 19 didn't fire because`,
  );
  lines.push(
    `   line count is within range; phase 17 didn't fire because there`,
  );
  lines.push(`   are no placeholder stubs. That's the gap this warns about.`);
  lines.push("");
  lines.push(
    `   Before claiming "refactor complete" or "behavior is identical",`,
  );
  lines.push(
    `   either (a) list every function/class that was merged into a`,
  );
  lines.push(
    `   replacement so the user can verify, or (b) re-add the dropped`,
  );
  lines.push(`   declarations.`);
  return lines.join("\n");
}
