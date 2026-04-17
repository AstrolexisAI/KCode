// KCode - Audit Scanner
//
// Phase 1 of the audit pipeline: discovery. Scans a project tree with the
// bug pattern library and produces a list of CANDIDATE findings. No model
// calls yet — candidates are just regex matches in files.

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
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

// Directories matched by exact name at any depth. This is the coarse
// first-pass filter — if a folder in the walk is literally one of these,
// the entire subtree is skipped.
const SKIP_DIRS = new Set([
  // Universal VCS / IDE / build roots
  ".git",
  ".hg",
  ".svn",
  ".idea",
  ".vscode",
  ".vs",
  "build",
  "dist",
  "out",
  "target",
  // JavaScript / TypeScript ecosystem
  "node_modules",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".parcel-cache",
  ".vuepress",
  ".docusaurus",
  ".cache",
  "coverage",
  ".nyc_output",
  // Python ecosystem
  ".venv",
  "venv",
  "env",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  "site-packages",
  // Ruby ecosystem
  ".bundle",
  // Elixir / Erlang
  "_build",
  "deps",
  ".elixir_ls",
  // Scala / SBT
  ".bloop",
  ".metals",
  // Haskell
  ".stack-work",
  "dist-newstyle",
  // Rust — already has target above
  // Go — already has vendor below
  // C / C++
  "CMakeFiles",
  ".ccls-cache",
  "cmake-build-debug",
  "cmake-build-release",
  "cmake-build-relwithdebinfo",
  // Third-party / vendored
  "3rdParty",
  "third_party",
  "vendor",
  "Godeps",
  // Project-specific noise we've seen before
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
  ".build", // Swift Package Manager
  ".swiftpm",
  // Android generated
  ".gradle",
  ".cxx",
  // Other JVM platform junk
  ".kotlin",
  ".mvn",
  // .NET
  "bin",
  "obj",
  "packages",
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

// Substrings matched against the full relative path. Used when the noisy
// directory is *not* a literal top-level name but rather a path segment
// under some user directory (e.g. "src/generated/..." or ".../build/intermediates/...").
const SKIP_PATH_SUBSTRINGS: readonly string[] = [
  "/generated/",
  "/.generated/",
  "/_generated/",
  "/build/intermediates/",
  "/build/generated/",
  "/autogen/",
  "/auto-generated/",
];

// Regex matched against the basename of each file. Captures generated-file
// conventions that language toolchains emit even inside user-authored trees.
const SKIP_FILENAME_PATTERNS: readonly RegExp[] = [
  // Minified / bundled JS / CSS
  /\.min\.(js|mjs|css)$/i,
  /\.bundle\.js$/i,
  /\.chunk\.js$/i,
  // Source maps are non-source anyway but guard against weird extensions
  /\.map$/i,
  // Dart code-gen (build_runner, freezed, json_serializable)
  /\.g\.dart$/,
  /\.freezed\.dart$/,
  /\.gr\.dart$/,
  /\.config\.dart$/,
  // Python generated — protobuf, grpc, swig
  /_pb2?\.py$/,
  /_pb2_grpc\.py$/,
  // Go generated — protobuf, mocks, stringer
  /\.pb\.go$/,
  /\.pb\.gw\.go$/,
  /_mock\.go$/,
  /_string\.go$/, // stringer
  // C / C++ generated — Qt moc, flex/bison, protobuf
  /^moc_.*\.(cc|cpp|cxx)$/,
  /^ui_.*\.h$/,
  /\.pb\.(cc|cpp|h)$/,
  /^lex\..*\.c$/,
  /\.tab\.(c|h)$/,
  // C# generated — Windows Forms / Xaml designer
  /\.designer\.cs$/i,
  /\.g\.cs$/i,
  /\.g\.i\.cs$/i,
  // Swift generated
  /^Generated.*\.swift$/,
  // Java / Kotlin generated
  /_Factory\.java$/,
  /_MembersInjector\.java$/,
  /Dagger.*\.java$/,
  // Rust macro expansions / build-script output usually land under target/
  // which is already in SKIP_DIRS.
  // TypeScript / JavaScript declaration files for bundled libs
  /\.d\.ts\.map$/,
];

/**
 * Heuristic: is this file minified / machine-generated?
 *
 * Looks at the longest line. Real source code almost never has lines longer
 * than ~1000 characters; minified JS/CSS routinely has single lines of 100KB+.
 * Threshold of 5000 is conservative enough to avoid false positives on
 * generated SQL schemas or long strings.
 */
function looksMinified(content: string): boolean {
  if (content.length < 5000) return false; // small files can't be meaningfully minified
  let maxLine = 0;
  let lineStart = 0;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10 /* \n */) {
      const len = i - lineStart;
      if (len > maxLine) maxLine = len;
      lineStart = i + 1;
    }
  }
  const tailLen = content.length - lineStart;
  if (tailLen > maxLine) maxLine = tailLen;
  return maxLine > 5000;
}

function isSkippedFilename(basename: string): boolean {
  for (const rex of SKIP_FILENAME_PATTERNS) {
    if (rex.test(basename)) return true;
  }
  return false;
}

function isSkippedPath(fullPath: string): boolean {
  // Normalize separators so the same substrings work on Windows-style paths.
  const p = fullPath.replace(/\\/g, "/");
  for (const needle of SKIP_PATH_SUBSTRINGS) {
    if (p.includes(needle)) return true;
  }
  return false;
}

/**
 * Walk a directory tree and return absolute paths of source files.
 *
 * Symlink safety:
 *   - Every directory is resolved via `realpath` so cyclic symlinks
 *     (a→b→a, link→., etc.) are detected and only traversed once.
 *   - Every resolved path is required to stay inside the resolved
 *     project root. A symlink that points outside the project
 *     (`my-lib -> /etc/ssh/...`) is silently skipped instead of
 *     leaking files outside the audit scope.
 *   - File symlinks are resolved the same way before being emitted,
 *     so the audit never double-reports the same file via two aliases.
 */
export function findSourceFiles(root: string, maxFiles = 500): string[] {
  const out: string[] = [];
  // Resolve the project root once. If realpath fails (broken link,
  // missing dir) fall back to the plain absolute path.
  let rootReal: string;
  try {
    rootReal = realpathSync(resolve(root));
  } catch {
    rootReal = resolve(root);
  }
  // rootPrefix is what we compare every resolved descendant against.
  // Appending the separator avoids `/home/foo` matching `/home/foo-evil`.
  const rootPrefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep;

  const visitedDirs = new Set<string>();
  const visitedFiles = new Set<string>();
  const stack: string[] = [rootReal];
  visitedDirs.add(rootReal);

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
        if (isSkippedPath(full + "/")) continue;
        // Resolve the real path before descending — this is how we
        // both break symlink cycles and prevent escaping the project
        // root through a symlink into /etc or $HOME.
        let real: string;
        try {
          real = realpathSync(full);
        } catch {
          continue;
        }
        // Root-confinement: the resolved directory must equal the
        // project root itself OR be strictly inside it.
        if (real !== rootReal && !real.startsWith(rootPrefix)) continue;
        if (visitedDirs.has(real)) continue;
        visitedDirs.add(real);
        stack.push(real);
      } else if (s.isFile()) {
        const ext = extname(entry).toLowerCase();
        if (!SOURCE_EXTENSIONS[ext]) continue;
        if (isSkippedFilename(entry)) continue;
        if (isSkippedPath(full)) continue;
        let real: string;
        try {
          real = realpathSync(full);
        } catch {
          continue;
        }
        // Same root confinement for file symlinks: never report a file
        // whose real path is outside the audited project.
        if (real !== rootReal && !real.startsWith(rootPrefix)) continue;
        if (visitedFiles.has(real)) continue;
        visitedFiles.add(real);
        out.push(real);
        if (out.length >= maxFiles) break;
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
/**
 * Test-friendly wrapper: run a single pattern against in-memory content
 * as if it lived at `path`. Identical semantics to the per-file loop in
 * scanProject(), but exposed so the pattern-fixtures harness in
 * tests/patterns/ can assert "this fixture must / must not match".
 */
export function scanPatternAgainstContent(
  pattern: BugPattern,
  path: string,
  content: string,
): Candidate[] {
  return applyPattern(pattern, path, content);
}

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
    // Skip minified / machine-generated files that slipped past filename
    // and path filters. These produce massive false-positive counts because
    // their single long lines match many regexes accidentally.
    if (looksMinified(content)) continue;

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
