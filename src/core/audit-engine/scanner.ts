// KCode - Audit Scanner
//
// Phase 1 of the audit pipeline: discovery. Scans a project tree with the
// bug pattern library and produces a list of CANDIDATE findings. No model
// calls yet — candidates are just regex matches in files.

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { getAllPatterns } from "./patterns";
import type { BugPattern, Candidate, Language } from "./types";

/**
 * Check if git submodules need initialization.
 */
export function needsSubmoduleInit(projectRoot: string): boolean {
  const gitmodulesPath = join(projectRoot, ".gitmodules");
  if (!existsSync(gitmodulesPath)) return false;

  try {
    const content = readFileSync(gitmodulesPath, "utf-8");
    const paths =
      content
        .match(/path\s*=\s*(.+)/g)
        ?.map((m) => m.replace(/path\s*=\s*/, "").trim()) ?? [];
    return paths.some((p) => {
      const dir = join(projectRoot, p);
      try {
        return readdirSync(dir).length === 0;
      } catch {
        return true;
      }
    });
  } catch {
    return false;
  }
}

/**
 * Initialize git submodules ASYNC so the event loop isn't blocked.
 * execSync blocks setInterval polling, freezing the progress bar.
 */
export function initSubmodulesAsync(projectRoot: string): Promise<boolean> {
  return new Promise((resolve) => {
    const { spawn: spawnProc } = require("node:child_process") as typeof import("node:child_process");
    const proc = spawnProc("git", ["submodule", "update", "--init", "--recursive"], {
      cwd: projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 120_000,
    });
    proc.on("close", (code: number | null) => {
      resolve(code === 0);
    });
    proc.on("error", () => resolve(false));
  });
}

const SOURCE_EXTENSIONS: Record<string, Language> = {
  ".c": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".h": "c", // ambiguous; treat as C (patterns overlap)
  ".hh": "cpp",
  ".hpp": "cpp",
  ".hxx": "cpp",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".js": "javascript",
  ".mjs": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".swift": "swift",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".cs": "csharp",
  ".php": "php",
  ".rb": "ruby",
  ".dart": "dart",
  ".scala": "scala",
  ".sc": "scala",
  ".ex": "elixir",
  ".exs": "elixir",
  ".lua": "lua",
  ".zig": "zig",
  ".hs": "haskell",
  ".lhs": "haskell",
  ".pl": "perl",
  ".pm": "perl",
  ".r": "r",
  ".R": "r",
  ".jl": "julia",
  ".sql": "sql",
  ".m": "matlab",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".ksh": "shell",
};

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "build",
  "dist",
  "target",
  "out",
  ".venv",
  "venv",
  "__pycache__",
  "3rdParty",
  "third_party",
  "vendor",
  "hidapi",
  "hidtest",
  "testgui",
  "pp_data_dump",
  // Flutter generated / ephemeral — plugin symlinks, dart tool cache, ephemeral
  // platform projects. All of this is either vendored plugin code or generated
  // by `flutter pub get`, and should never surface in a user project audit.
  ".dart_tool",
  ".plugin_symlinks",
  "ephemeral",
  ".flutter-plugins",
  ".flutter-plugins-dependencies",
  // iOS / macOS generated
  "Pods",
  "DerivedData",
  "xcuserdata",
  // Android generated
  ".gradle",
  ".idea",
  ".cxx",
  // Other platform junk
  ".kotlin",
  ".mvn",
  // Test directories — findings in test code are low-value noise.
  // Unit test stubs intentionally replicate unsafe patterns (e.g. strcat)
  // and test harnesses control their own inputs.
  "ut_assert",
  "ut-stubs",
  "ut-stubs-alt",
  "ut-coverage",
  "unit-test-coverage",
  "unit-tests",
  "test",
  "tests",
  "__tests__",
  "spec",
  "testing",
  "mock",
  "mocks",
  "fixtures",
  "testcase",
  "testcases",
]);

/**
 * Walk a directory tree and return absolute paths of source files.
 */
export function findSourceFiles(root: string, maxFiles = 500): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0 && out.length < maxFiles) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      let s: ReturnType<typeof statSync>;
      try {
        s = statSync(full);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        stack.push(full);
      } else if (s.isFile()) {
        const ext = extname(entry).toLowerCase();
        if (SOURCE_EXTENSIONS[ext]) {
          out.push(full);
          if (out.length >= maxFiles) break;
        }
      }
    }
  }
  return out;
}

/**
 * Detect languages used in the project (based on file extensions).
 */
export function detectLanguages(files: string[]): Language[] {
  const langs = new Set<Language>();
  for (const f of files) {
    const ext = extname(f).toLowerCase();
    const lang = SOURCE_EXTENSIONS[ext];
    if (lang) langs.add(lang);
  }
  return Array.from(langs);
}

function getLanguageForFile(path: string): Language | null {
  const ext = extname(path).toLowerCase();
  return SOURCE_EXTENSIONS[ext] ?? null;
}

/**
 * Apply a single pattern to a file, producing a list of candidate findings.
 */
function applyPattern(pattern: BugPattern, path: string, content: string): Candidate[] {
  const lang = getLanguageForFile(path);
  if (!lang || !pattern.languages.includes(lang)) return [];

  const candidates: Candidate[] = [];
  // Ensure regex has global flag for iterative matching
  const rex = pattern.regex.global
    ? pattern.regex
    : new RegExp(pattern.regex.source, pattern.regex.flags + "g");
  rex.lastIndex = 0;

  let m: RegExpExecArray | null;
  while ((m = rex.exec(content)) !== null) {
    // Compute the line number of the match
    const before = content.slice(0, m.index);
    const line = before.split("\n").length;
    const matched_text = m[0].split("\n")[0]!.slice(0, 200);
    // 3 lines of context around the match
    const allLines = content.split("\n");
    const startCtx = Math.max(0, line - 3);
    const endCtx = Math.min(allLines.length, line + 3);
    const context = allLines
      .slice(startCtx, endCtx)
      .map((l, i) => `${startCtx + i + 1}: ${l}`)
      .join("\n");
    // Pre-filter: skip obvious false positives in web framework code
    const isTestFile = path.includes("test") || path.includes("spec") || path.includes("__tests__");
    const isConfig = path.includes("config") || path.includes(".config.");
    const isGenerated = path.includes(".next/") || path.includes("dist/") || path.includes("build/");
    // Skip low-severity findings in test/config/generated files
    if ((isTestFile || isConfig || isGenerated) && pattern.severity === "low") continue;
    // Skip hardcoded-secret patterns if the value looks like a placeholder
    if (pattern.id.includes("hardcoded") && /changeme|placeholder|example|xxx|YOUR_|TODO/i.test(matched_text)) continue;

    // Skip matches inside JSX className attributes (Tailwind utility strings
    // like "bg-red-500 p-4 text-white" trigger several patterns as false
    // positives). Only applies to JSX/TSX sources. The check walks backwards
    // from the match to find the nearest attribute boundary on the same line.
    const isJsx = path.endsWith(".tsx") || path.endsWith(".jsx");
    if (isJsx) {
      const lineStart = content.lastIndexOf("\n", m.index - 1) + 1;
      const lineText = content.slice(lineStart, content.indexOf("\n", m.index) === -1 ? content.length : content.indexOf("\n", m.index));
      const offsetInLine = m.index - lineStart;
      const before = lineText.slice(0, offsetInLine);
      // Match is inside className="..." or className={`...`} if the last
      // attribute opener before the match is className and no closing quote
      // has intervened.
      const classNameMatch = before.match(/class(?:Name)?\s*=\s*(["'`])([^"'`]*)$/);
      if (classNameMatch) continue;
      // Also skip if the match sits inside any JSX string attribute that's
      // clearly a Tailwind-ish token list (letters, digits, dashes, slashes,
      // colons, spaces only) — catches className aliases like `class=` or
      // attributes passed through spreads.
      const stringAttr = before.match(/\w+\s*=\s*(["'])([a-zA-Z0-9\s\-:/]*)$/);
      if (stringAttr && /[\s-]/.test(stringAttr[2] ?? "")) continue;
    }

    candidates.push({
      pattern_id: pattern.id,
      severity: pattern.severity,
      file: path,
      line,
      matched_text,
      context,
    });
    // Prevent infinite loop on zero-width matches
    if (m.index === rex.lastIndex) rex.lastIndex++;
  }
  return candidates;
}

/**
 * Scan a whole project: for each source file, apply every applicable pattern,
 * collecting candidate findings.
 */
export function scanProject(
  projectRoot: string,
  opts?: { maxFiles?: number; patterns?: BugPattern[] },
): { files: string[]; candidates: Candidate[] } {
  const files = findSourceFiles(projectRoot, opts?.maxFiles ?? 500);
  const patterns = opts?.patterns ?? getAllPatterns();
  const candidates: Candidate[] = [];

  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    // Skip excessively large files
    if (content.length > 500_000) continue;

    for (const pattern of patterns) {
      const lang = getLanguageForFile(file);
      if (!lang || !pattern.languages.includes(lang)) continue;
      const matches = applyPattern(pattern, file, content);
      candidates.push(...matches);
    }
  }

  return { files, candidates };
}

/**
 * Group candidates by file for more efficient verification.
 */
export function groupCandidatesByFile(candidates: Candidate[]): Map<string, Candidate[]> {
  const byFile = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const arr = byFile.get(c.file) ?? [];
    arr.push(c);
    byFile.set(c.file, arr);
  }
  return byFile;
}

/**
 * Deduplicate candidates by (pattern_id, file). When many matches of the
 * same pattern exist in one file, verify ONE representative and carry
 * the count forward. This keeps verification tractable on large codebases.
 *
 * Returns { dedup, multiples } where `multiples` maps (pattern+file) to
 * the total count of matches in that file.
 */
export function dedupByPatternAndFile(
  candidates: Candidate[],
): { dedup: Candidate[]; multiples: Map<string, number> } {
  const byKey = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const key = `${c.pattern_id}|${c.file}`;
    const arr = byKey.get(key) ?? [];
    arr.push(c);
    byKey.set(key, arr);
  }
  const dedup: Candidate[] = [];
  const multiples = new Map<string, number>();
  for (const [key, arr] of byKey) {
    // Pick the FIRST match as representative
    dedup.push(arr[0]!);
    if (arr.length > 1) multiples.set(key, arr.length);
  }
  return { dedup, multiples };
}

/**
 * Format a candidate for display (file path relative to project root).
 */
export function formatCandidate(candidate: Candidate, projectRoot: string): string {
  const rel = relative(projectRoot, candidate.file);
  return `[${candidate.severity.toUpperCase()}] ${rel}:${candidate.line} — ${candidate.pattern_id}`;
}
