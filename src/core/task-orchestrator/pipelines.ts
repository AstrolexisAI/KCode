// KCode - Task Pipelines
//
// Each task type has a deterministic pipeline that pre-processes
// the user's request into focused context + specific prompt for the LLM.
// The LLM only handles what machines can't: reasoning and generation.

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import type { ClassifiedTask, PipelineResult } from "./types";

const MAX_CONTEXT = 8000; // chars

function run(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, encoding: "utf-8", timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return "";
  }
}

function readSafe(path: string, maxLines = 100): string {
  try {
    const content = readFileSync(path, "utf-8");
    return content.split("\n").slice(0, maxLines).join("\n");
  } catch {
    return "";
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "\n... (truncated)" : s;
}

// ── Debug Pipeline ─────────────────────────────────────────────

export async function debugPipeline(task: ClassifiedTask, cwd: string): Promise<PipelineResult> {
  const steps: PipelineResult["steps"] = [];
  const t0 = Date.now();

  // Step 1: Find relevant files
  const files = task.entities.files ?? [];
  let grepResults = "";
  if (task.entities.error) {
    const errorKeyword = task.entities.error.split(/\s+/)[0] ?? "error";
    grepResults = run(`grep -rn "${errorKeyword}" --include="*.py" --include="*.ts" --include="*.js" --include="*.go" --include="*.rs" --include="*.cpp" -l | head -10`, cwd);
  }
  if (!grepResults && files.length === 0) {
    // Grep for common error indicators
    grepResults = run(`grep -rn "TODO\\|FIXME\\|BUG\\|HACK\\|error\\|Error\\|ERROR" --include="*.py" --include="*.ts" --include="*.js" -l | head -10`, cwd);
  }
  steps.push({ name: "locate_files", output: grepResults || "(no matches)", durationMs: Date.now() - t0 });

  // Step 2: Read the relevant files
  const t1 = Date.now();
  const filesToRead = files.length > 0 ? files : grepResults.split("\n").filter(Boolean).slice(0, 5);
  let fileContents = "";
  for (const f of filesToRead) {
    const fullPath = resolve(cwd, f);
    if (existsSync(fullPath)) {
      fileContents += `\n--- ${f} ---\n${readSafe(fullPath, 80)}\n`;
    }
  }
  steps.push({ name: "read_files", output: `${filesToRead.length} files read`, durationMs: Date.now() - t1 });

  // Step 3: Recent git changes
  const t2 = Date.now();
  const recentChanges = run("git log --oneline -5 2>/dev/null", cwd);
  const gitDiff = run("git diff --stat HEAD~3 2>/dev/null | head -20", cwd);
  steps.push({ name: "git_history", output: recentChanges || "(no git)", durationMs: Date.now() - t2 });

  const context = truncate([
    "## Relevant files",
    fileContents || "(none found)",
    "",
    "## Recent changes",
    recentChanges,
    gitDiff,
    "",
    task.entities.error ? `## Error\n${task.entities.error}` : "",
  ].join("\n"), MAX_CONTEXT);

  return {
    steps,
    context,
    prompt: `The user is debugging an issue: "${task.raw}"\n\nHere is the pre-analyzed context:\n${context}\n\nBased on this context, identify the root cause and suggest a specific fix with file:line references. Be precise — don't guess, cite the code.`,
  };
}

// ── Implement Pipeline ─────────────────────────────────────────

export async function implementPipeline(task: ClassifiedTask, cwd: string): Promise<PipelineResult> {
  const steps: PipelineResult["steps"] = [];
  const t0 = Date.now();

  // Step 1: Detect project framework/language
  const packageJson = existsSync(join(cwd, "package.json")) ? readSafe(join(cwd, "package.json"), 30) : "";
  const pyproject = existsSync(join(cwd, "pyproject.toml")) ? readSafe(join(cwd, "pyproject.toml"), 30) : "";
  const goMod = existsSync(join(cwd, "go.mod")) ? readSafe(join(cwd, "go.mod"), 10) : "";
  const cargoToml = existsSync(join(cwd, "Cargo.toml")) ? readSafe(join(cwd, "Cargo.toml"), 20) : "";
  const framework = packageJson.includes("next") ? "Next.js"
    : packageJson.includes("express") ? "Express"
    : packageJson.includes("fastify") ? "Fastify"
    : pyproject.includes("fastapi") ? "FastAPI"
    : pyproject.includes("django") ? "Django"
    : pyproject.includes("flask") ? "Flask"
    : goMod ? "Go"
    : cargoToml ? "Rust"
    : "unknown";
  steps.push({ name: "detect_framework", output: framework, durationMs: Date.now() - t0 });

  // Step 2: Scan project structure
  const t1 = Date.now();
  const structure = run("find . -type f \\( -name '*.ts' -o -name '*.py' -o -name '*.go' -o -name '*.rs' -o -name '*.java' \\) -not -path '*/node_modules/*' -not -path '*/.git/*' | head -30", cwd);
  steps.push({ name: "project_structure", output: structure || "(empty)", durationMs: Date.now() - t1 });

  // Step 3: Find similar patterns (if adding endpoint, find existing endpoints)
  const t2 = Date.now();
  let existingPatterns = "";
  if (task.raw.match(/endpoint|route|api/i)) {
    existingPatterns = run(`grep -rn "app\\.get\\|app\\.post\\|@app\\.route\\|router\\." --include="*.ts" --include="*.py" --include="*.js" | head -10`, cwd);
  } else if (task.raw.match(/component|page/i)) {
    existingPatterns = run(`grep -rn "export default function\\|export const" --include="*.tsx" --include="*.jsx" | head -10`, cwd);
  }
  steps.push({ name: "existing_patterns", output: existingPatterns || "(none)", durationMs: Date.now() - t2 });

  const context = truncate([
    `## Framework: ${framework}`,
    "",
    "## Project structure",
    structure,
    "",
    existingPatterns ? `## Existing patterns (follow this style)\n${existingPatterns}` : "",
  ].join("\n"), MAX_CONTEXT);

  return {
    steps,
    context,
    prompt: `The user wants to implement: "${task.raw}"\n\nProject context:\n${context}\n\nImplement this following the existing project patterns and conventions. Create the minimum files needed. Use the same framework/style as existing code.`,
  };
}

// ── Review Pipeline ────────────────────────────────────────────

export async function reviewPipeline(task: ClassifiedTask, cwd: string): Promise<PipelineResult> {
  const steps: PipelineResult["steps"] = [];
  const t0 = Date.now();

  // Step 1: Get the diff
  const diff = run("git diff HEAD~1 2>/dev/null || git diff --cached 2>/dev/null || git diff 2>/dev/null", cwd);
  steps.push({ name: "get_diff", output: `${diff.split("\n").length} lines`, durationMs: Date.now() - t0 });

  // Step 2: Get changed files
  const t1 = Date.now();
  const changedFiles = run("git diff --name-only HEAD~1 2>/dev/null || git diff --name-only --cached 2>/dev/null", cwd);
  steps.push({ name: "changed_files", output: changedFiles || "(none)", durationMs: Date.now() - t1 });

  // Step 3: Read the changed files in full
  const t2 = Date.now();
  let fullContent = "";
  for (const f of changedFiles.split("\n").filter(Boolean).slice(0, 5)) {
    const p = resolve(cwd, f);
    if (existsSync(p)) fullContent += `\n--- ${f} ---\n${readSafe(p, 150)}\n`;
  }
  steps.push({ name: "read_changed", output: `${changedFiles.split("\n").filter(Boolean).length} files`, durationMs: Date.now() - t2 });

  const context = truncate([
    "## Diff",
    diff,
    "",
    "## Full file contents",
    fullContent,
  ].join("\n"), MAX_CONTEXT);

  return {
    steps,
    context,
    prompt: `Review these code changes. Check for:\n1. Bugs or logic errors\n2. Security issues\n3. Performance concerns\n4. Style/convention violations\n\nDiff and full files:\n${context}\n\nProvide specific feedback with file:line references.`,
  };
}

// ── Refactor Pipeline ──────────────────────────────────────────

export async function refactorPipeline(task: ClassifiedTask, cwd: string): Promise<PipelineResult> {
  const steps: PipelineResult["steps"] = [];
  const t0 = Date.now();

  const files = task.entities.files ?? [];
  let targets = "";
  if (files.length > 0) {
    for (const f of files.slice(0, 3)) {
      const p = resolve(cwd, f);
      if (existsSync(p)) targets += `\n--- ${f} ---\n${readSafe(p, 200)}\n`;
    }
  }
  steps.push({ name: "read_targets", output: `${files.length} files`, durationMs: Date.now() - t0 });

  // Find complexity indicators
  const t1 = Date.now();
  const longFunctions = files.length > 0 ? run(`wc -l ${files.join(" ")} 2>/dev/null`, cwd) : "";
  steps.push({ name: "complexity_check", output: longFunctions || "(n/a)", durationMs: Date.now() - t1 });

  return {
    steps,
    context: truncate(targets, MAX_CONTEXT),
    prompt: `Refactor this code: "${task.raw}"\n\nCode:\n${truncate(targets, MAX_CONTEXT)}\n\nApply the requested refactoring. Keep the same behavior. Show the minimal changes needed.`,
  };
}

// ── Test Pipeline ──────────────────────────────────────────────

export async function testPipeline(task: ClassifiedTask, cwd: string): Promise<PipelineResult> {
  const steps: PipelineResult["steps"] = [];
  const t0 = Date.now();

  const files = task.entities.files ?? [];
  let sourceCode = "";
  for (const f of files.slice(0, 3)) {
    const p = resolve(cwd, f);
    if (existsSync(p)) sourceCode += `\n--- ${f} ---\n${readSafe(p, 150)}\n`;
  }
  steps.push({ name: "read_source", output: `${files.length} files`, durationMs: Date.now() - t0 });

  // Detect test framework
  const t1 = Date.now();
  const existingTests = run(`find . -name "*.test.*" -o -name "*_test.*" -o -name "test_*" | head -5`, cwd);
  const testFramework = run(`grep -l "jest\\|vitest\\|mocha\\|pytest\\|go test\\|cargo test" package.json pyproject.toml Cargo.toml go.mod 2>/dev/null | head -1`, cwd);
  steps.push({ name: "detect_test_framework", output: testFramework || existingTests || "(none)", durationMs: Date.now() - t1 });

  return {
    steps,
    context: truncate(sourceCode, MAX_CONTEXT),
    prompt: `Write tests for: "${task.raw}"\n\nSource code:\n${truncate(sourceCode, MAX_CONTEXT)}\n\nExisting tests: ${existingTests}\n\nWrite comprehensive tests covering: happy path, edge cases, error cases. Follow the existing test framework and conventions.`,
  };
}

// ── Explain Pipeline ───────────────────────────────────────────

export async function explainPipeline(task: ClassifiedTask, cwd: string): Promise<PipelineResult> {
  const steps: PipelineResult["steps"] = [];
  const t0 = Date.now();

  const files = task.entities.files ?? [];
  let code = "";
  for (const f of files.slice(0, 3)) {
    const p = resolve(cwd, f);
    if (existsSync(p)) code += `\n--- ${f} ---\n${readSafe(p, 200)}\n`;
  }

  // If no specific files, try to understand what they're asking about
  if (!code) {
    const keyword = task.raw.split(/\s+/).filter(w => w.length > 3).slice(0, 3).join("|");
    if (keyword) {
      const matches = run(`grep -rn "${keyword}" --include="*.ts" --include="*.py" --include="*.go" -l | head -5`, cwd);
      for (const f of matches.split("\n").filter(Boolean).slice(0, 3)) {
        const p = resolve(cwd, f);
        if (existsSync(p)) code += `\n--- ${f} ---\n${readSafe(p, 100)}\n`;
      }
    }
  }
  steps.push({ name: "gather_context", output: `${code.split("---").length - 1} files`, durationMs: Date.now() - t0 });

  return {
    steps,
    context: truncate(code, MAX_CONTEXT),
    prompt: `Explain: "${task.raw}"\n\nRelevant code:\n${truncate(code, MAX_CONTEXT)}\n\nExplain clearly and concisely. Use examples if helpful.`,
  };
}

// ── Pipeline Router ────────────────────────────────────────────

export async function runPipeline(task: ClassifiedTask, cwd: string): Promise<PipelineResult | null> {
  switch (task.type) {
    case "debug": return debugPipeline(task, cwd);
    case "implement": return implementPipeline(task, cwd);
    case "review": return reviewPipeline(task, cwd);
    case "refactor": return refactorPipeline(task, cwd);
    case "test": return testPipeline(task, cwd);
    case "explain": return explainPipeline(task, cwd);
    case "audit": return null; // handled by /scan
    case "deploy": return null; // too varied for pipeline
    case "general": return null; // pass-through to LLM
    default: return null;
  }
}
