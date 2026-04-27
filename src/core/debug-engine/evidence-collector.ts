// KCode - Debug Evidence Collector
//
// Machine phase: gathers ALL evidence about a bug BEFORE the LLM sees it.
// The LLM receives a focused diagnostic package, not raw "figure it out".

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import type { DebugContext, ErrorPattern } from "./types";

function run(cmd: string, cwd: string, timeout = 10_000): string {
  try {
    return execSync(cmd, {
      cwd,
      encoding: "utf-8",
      timeout,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return "";
  }
}

function readSafe(path: string, maxLines = 150): string {
  try {
    return readFileSync(path, "utf-8").split("\n").slice(0, maxLines).join("\n");
  } catch {
    return "";
  }
}

// ── Error Pattern Detection ────────────────────────────────────

const ERROR_PATTERNS: Array<{ type: ErrorPattern["type"]; regex: RegExp }> = [
  { type: "try-catch", regex: /\bcatch\s*\(.*\)\s*\{/g },
  { type: "throw", regex: /\bthrow\s+(?:new\s+)?\w+/g },
  {
    type: "error-log",
    regex: /\bconsole\.error\s*\(|\.error\s*\(|log\.error\s*\(|logging\.error\s*\(/g,
  },
  { type: "todo-fixme", regex: /\/\/\s*(?:TODO|FIXME|BUG|HACK|XXX)\b/gi },
  { type: "assert", regex: /\bassert\s*[.(]/g },
  { type: "return-null", regex: /return\s+(?:null|None|nil|undefined)\s*;/g },
  { type: "exception", regex: /raise\s+\w+|throw\s+new\s+\w+Error/g },
];

function findErrorPatterns(content: string, filePath: string): ErrorPattern[] {
  const patterns: ErrorPattern[] = [];
  const lines = content.split("\n");

  for (const ep of ERROR_PATTERNS) {
    ep.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ep.regex.exec(content)) !== null) {
      const lineNum = content.slice(0, m.index).split("\n").length;
      patterns.push({
        file: filePath,
        line: lineNum,
        type: ep.type,
        code: lines[lineNum - 1]?.trim() ?? "",
      });
      if (m.index === ep.regex.lastIndex) ep.regex.lastIndex++;
    }
  }

  return patterns;
}

// ── Test File Detection ────────────────────────────────────────

function findTestFiles(filePath: string, cwd: string): string[] {
  const base = basename(filePath, extname(filePath));
  const ext = extname(filePath);
  const dir = dirname(filePath);

  const candidates = [
    join(dir, `${base}.test${ext}`),
    join(dir, `${base}.spec${ext}`),
    join(dir, `${base}_test${ext}`),
    join(dir, `test_${base}${ext}`),
    join(dir, "__tests__", `${base}${ext}`),
    join(dir, "__tests__", `${base}.test${ext}`),
    // Python
    join(dir, `test_${base}.py`),
    join(dirname(dir), "tests", `test_${base}.py`),
    // Go
    join(dir, `${base}_test.go`),
  ];

  const found: string[] = [];
  for (const c of candidates) {
    const full = resolve(cwd, c);
    if (existsSync(full)) found.push(c);
  }

  // Also grep for files importing the target
  if (found.length === 0) {
    const grepResult = run(
      `grep -rl "${base}" --include="*test*" --include="*spec*" -l 2>/dev/null | head -5`,
      cwd,
    );
    if (grepResult) found.push(...grepResult.split("\n").filter(Boolean));
  }

  return found;
}

// ── Caller Detection ───────────────────────────────────────────

function findCallers(filePath: string, cwd: string): string[] {
  const base = basename(filePath, extname(filePath));
  const result = run(
    `grep -rn "import.*${base}\\|require.*${base}\\|from.*${base}" --include="*.ts" --include="*.js" --include="*.py" --include="*.go" -l 2>/dev/null | head -10`,
    cwd,
  );
  return result
    ? result
        .split("\n")
        .filter(Boolean)
        .map((f) => relative(cwd, resolve(cwd, f)))
    : [];
}

// ── Main Evidence Collector ────────────────────────────────────

export interface CollectOptions {
  /** Files mentioned by user */
  files: string[];
  /** Error message from user (stack trace, error text) */
  errorMessage?: string;
  /** User's full natural language request */
  userRequest?: string;
  /** Working directory */
  cwd: string;
  /** Progress callback */
  onStep?: (step: string) => void;
}

export async function collectEvidence(opts: CollectOptions): Promise<DebugContext> {
  const { files, errorMessage, cwd } = opts;
  const step = opts.onStep ?? (() => {});

  // Step 0: Machine pattern matching on user description
  let matchedPatterns: import("./debug-patterns").DebugPattern[] = [];
  let smartKeywords: string[] = [];
  if (opts.userRequest) {
    const { matchDebugPatterns, extractSearchKeywords } = await import("./debug-patterns.js");
    matchedPatterns = matchDebugPatterns(opts.userRequest);
    smartKeywords = extractSearchKeywords(opts.userRequest);
    if (matchedPatterns.length > 0) {
      step(`Detected behavior pattern: ${matchedPatterns[0]!.id}`);
    }
  }

  // Step 1: Resolve target files
  step("Resolving target files...");
  let targetFiles = files.map((f) => resolve(cwd, f)).filter((f) => existsSync(f));

  // If no files specified, try to find them from the error message
  if (targetFiles.length === 0 && errorMessage) {
    const fileRefs = errorMessage.match(/[\w./-]+\.\w+(?::\d+)?/g) ?? [];
    for (const ref of fileRefs) {
      const cleanRef = ref.split(":")[0]!;
      const full = resolve(cwd, cleanRef);
      if (existsSync(full) && !targetFiles.includes(full)) {
        targetFiles.push(full);
      }
    }
  }

  // If still no files, use smart pattern-based search
  if (targetFiles.length === 0 && matchedPatterns.length > 0) {
    step("Smart search using behavior pattern...");
    const pat = matchedPatterns[0]!;
    const globArgs = pat.searchStrategy.fileGlobs.map((g) => `--include="${g}"`).join(" ");
    for (const gp of pat.searchStrategy.grepPatterns.slice(0, 6)) {
      const grepResult = run(`grep -rn "${gp}" ${globArgs} -l 2>/dev/null | head -3`, cwd);
      if (grepResult) {
        for (const f of grepResult.split("\n").filter(Boolean)) {
          const full = resolve(cwd, f);
          if (existsSync(full) && !targetFiles.includes(full)) targetFiles.push(full);
        }
      }
      if (targetFiles.length >= 5) break;
    }
  }

  // Smart keyword search from user description
  if (targetFiles.length === 0 && smartKeywords.length > 0) {
    step("Searching by keywords...");
    for (const kw of smartKeywords.slice(0, 4)) {
      const grepResult = run(
        `grep -rn "${kw}" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.py" --include="*.go" -l 2>/dev/null | head -3`,
        cwd,
      );
      if (grepResult) {
        for (const f of grepResult.split("\n").filter(Boolean)) {
          const full = resolve(cwd, f);
          if (existsSync(full) && !targetFiles.includes(full)) targetFiles.push(full);
        }
      }
      if (targetFiles.length >= 5) break;
    }
  }

  // Fallback: grep for error keyword from error message
  if (targetFiles.length === 0 && errorMessage) {
    step("Searching for error source...");
    const keyword = errorMessage.split(/[\s:]+/).find((w) => w.length > 4) ?? "error";
    const grepResult = run(
      `grep -rn "${keyword}" --include="*.ts" --include="*.js" --include="*.py" --include="*.go" --include="*.cpp" -l 2>/dev/null | head -5`,
      cwd,
    );
    if (grepResult) {
      targetFiles = grepResult
        .split("\n")
        .filter(Boolean)
        .map((f) => resolve(cwd, f));
    }
  }

  // Step 2: Read file contents
  step("Reading source files...");
  const fileContents = new Map<string, string>();
  for (const f of targetFiles.slice(0, 5)) {
    fileContents.set(relative(cwd, f), readSafe(f));
  }

  // Step 3: Find error patterns in files
  step("Detecting error patterns...");
  const errorPatterns: ErrorPattern[] = [];
  for (const [relPath, content] of fileContents) {
    errorPatterns.push(...findErrorPatterns(content, relPath));
  }

  // Step 4: Git blame on error lines
  step("Analyzing git history...");
  let blame = "";
  for (const ep of errorPatterns.slice(0, 5)) {
    const b = run(
      `git blame -L ${Math.max(1, ep.line - 2)},${ep.line + 2} -- "${ep.file}" 2>/dev/null`,
      cwd,
    );
    if (b) blame += `\n${ep.file}:${ep.line}:\n${b}\n`;
  }

  // Step 5: Recent changes
  step("Checking recent changes...");
  const recentFiles = targetFiles.map((f) => `"${relative(cwd, f)}"`).join(" ");
  const recentChanges = recentFiles
    ? run(`git log --oneline -10 -- ${recentFiles} 2>/dev/null`, cwd)
    : run("git log --oneline -10 2>/dev/null", cwd);

  // Step 6: Find test files
  step("Finding related tests...");
  const testFiles: string[] = [];
  for (const f of targetFiles) {
    testFiles.push(...findTestFiles(relative(cwd, f), cwd));
  }

  // Step 7: Run tests if found
  let testOutput: string | undefined;
  if (testFiles.length > 0) {
    step("Running related tests...");
    const testFile = testFiles[0]!;
    // Detect test runner
    if (existsSync(join(cwd, "package.json"))) {
      testOutput = run(
        `npx jest "${testFile}" --no-coverage 2>&1 || npx vitest run "${testFile}" 2>&1 || bun test "${testFile}" 2>&1`,
        cwd,
        30_000,
      );
    } else if (testFile.endsWith(".py")) {
      testOutput = run(`python -m pytest "${testFile}" -x 2>&1`, cwd, 30_000);
    } else if (testFile.endsWith("_test.go")) {
      testOutput = run(`go test -run ".*" "./${dirname(testFile)}" 2>&1`, cwd, 30_000);
    }
    if (testOutput) testOutput = testOutput.slice(0, 3000); // cap
  }

  // Step 8: Find callers
  step("Finding callers...");
  const callers: string[] = [];
  for (const f of targetFiles) {
    callers.push(...findCallers(relative(cwd, f), cwd));
  }

  // Step 9: Machine pre-diagnosis using code signals
  let machineDiagnosis: string | undefined;
  if (matchedPatterns.length > 0) {
    step("Analyzing code signals...");
    const pat = matchedPatterns[0]!;
    const signals: string[] = [];
    for (const [, content] of fileContents) {
      for (const sig of pat.searchStrategy.codeSignals) {
        if (sig.pattern.test(content)) {
          signals.push(`• ${sig.meaning} → ${sig.likely_fix}`);
        }
      }
    }
    if (signals.length > 0) {
      machineDiagnosis = `**Pattern: ${pat.id}**\n${pat.diagnosis}\n\n**Code signals found:**\n${signals.join("\n")}`;
    } else {
      machineDiagnosis = `**Pattern: ${pat.id}**\n${pat.diagnosis}`;
    }
  }

  return {
    targetFiles: targetFiles.map((f) => relative(cwd, f)),
    fileContents,
    errorPatterns,
    recentChanges,
    blame,
    testFiles,
    testOutput,
    callers,
    errorMessage,
    machineDiagnosis,
  };
}

// ── Format Evidence for LLM ────────────────────────────────────

export function formatEvidenceForLLM(ctx: DebugContext): string {
  const parts: string[] = [];

  parts.push("# Debug Evidence Package\n");

  if (ctx.machineDiagnosis) {
    parts.push(`## Machine Pre-Diagnosis\n${ctx.machineDiagnosis}\n`);
  }

  if (ctx.errorMessage) {
    parts.push(`## Error reported by user\n\`\`\`\n${ctx.errorMessage}\n\`\`\`\n`);
  }

  // File contents
  parts.push("## Source files\n");
  for (const [path, content] of ctx.fileContents) {
    const lines = content.split("\n");
    const numbered = lines.map((l, i) => `${i + 1}: ${l}`).join("\n");
    parts.push(`### ${path}\n\`\`\`\n${numbered}\n\`\`\`\n`);
  }

  // Error patterns found
  if (ctx.errorPatterns.length > 0) {
    parts.push("## Error patterns detected (by machine)\n");
    for (const ep of ctx.errorPatterns.slice(0, 15)) {
      parts.push(`- **${ep.type}** at ${ep.file}:${ep.line}: \`${ep.code}\``);
    }
    parts.push("");
  }

  // Test output
  if (ctx.testOutput) {
    parts.push(`## Test output\n\`\`\`\n${ctx.testOutput.slice(0, 2000)}\n\`\`\`\n`);
  }

  // Git history
  if (ctx.recentChanges) {
    parts.push(`## Recent changes to these files\n\`\`\`\n${ctx.recentChanges}\n\`\`\`\n`);
  }

  // Blame
  if (ctx.blame) {
    parts.push(`## Git blame on error lines\n\`\`\`\n${ctx.blame.slice(0, 1500)}\n\`\`\`\n`);
  }

  // Callers
  if (ctx.callers.length > 0) {
    parts.push(
      `## Files that import/call this code\n${ctx.callers.map((c) => `- ${c}`).join("\n")}\n`,
    );
  }

  // Test files
  if (ctx.testFiles.length > 0) {
    parts.push(`## Related test files\n${ctx.testFiles.map((t) => `- ${t}`).join("\n")}\n`);
  }

  return parts.join("\n");
}

/**
 * Build the focused LLM prompt from evidence.
 * The LLM receives pre-analyzed context and a SPECIFIC question.
 */
export function buildDebugPrompt(ctx: DebugContext, userRequest: string): string {
  const evidence = formatEvidenceForLLM(ctx);

  return `You are debugging a code issue. The machine has already gathered evidence for you.

USER REQUEST: "${userRequest}"

${evidence}

INSTRUCTIONS:
1. Identify the ROOT CAUSE with exact file:line
2. Explain WHY it's a bug (not just WHAT)
3. Provide a MINIMAL fix (smallest change that resolves the issue)
4. If test output shows failures, your fix must make those tests pass

Respond in this format:
ROOT_CAUSE: file:line — one sentence
EXPLANATION: why this happens
FIX:
\`\`\`
exact code change (old → new)
\`\`\`
CONFIDENCE: high/medium/low`;
}
