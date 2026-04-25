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
 * Enumerate EVERY source file in the project without applying a cap.
 * The output is the full universe of candidates — the caller then
 * applies ranking + truncation (see selectFilesForAudit). Returned
 * paths are symlink-resolved and root-confined.
 */
export function enumerateSourceFiles(root: string): string[] {
  const out: string[] = [];
  let rootReal: string;
  try {
    rootReal = realpathSync(resolve(root));
  } catch {
    rootReal = resolve(root);
  }
  const rootPrefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep;

  const visitedDirs = new Set<string>();
  const visitedFiles = new Set<string>();
  const stack: string[] = [rootReal];
  visitedDirs.add(rootReal);

  while (stack.length > 0) {
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
        let real: string;
        try {
          real = realpathSync(full);
        } catch {
          continue;
        }
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
        if (real !== rootReal && !real.startsWith(rootPrefix)) continue;
        if (visitedFiles.has(real)) continue;
        visitedFiles.add(real);
        out.push(real);
      }
    }
  }
  return out;
}

/**
 * Rank a file for audit attention. Higher = scan first. Scores are
 * deterministic and only depend on the path (no disk I/O, no LLM).
 *
 * Signals:
 *  + main-code extensions (.c/.cpp/.py/.ts/…) — baseline +50
 *  + security-relevant directories (src/, auth/, crypto/, …) — +30
 *  + "core" / "runtime" / "engine" / "protocol" — +15
 *  - tests / fixtures / examples / docs / generated — strong penalty
 *  - notebooks / configs / auxiliary scripts — soft penalty
 *
 * Paths are compared lower-cased with forward-slash separators so
 * Windows paths still match `src/`.
 */
export function scoreFileForAudit(filePath: string): number {
  const p = filePath.replace(/\\/g, "/").toLowerCase();
  const ext = extname(p);
  let score = 0;

  // Extension bucket.
  if (/\.(c|cc|cpp|cxx|h|hh|hpp|hxx|m|mm|py|rs|go|java|kt|swift|ts|tsx|js|jsx|cs|rb|php)$/.test(ext)) {
    score += 50;
  } else if (/\.(sh|bash|zsh|ps1|pl|lua|r|jl|sql)$/.test(ext)) {
    score += 20;
  } else if (/\.(md|rst|txt|json|yml|yaml|toml|xml|html|css|scss|svg)$/.test(ext)) {
    score -= 20;
  } else if (/\.(ipynb)$/.test(ext)) {
    score -= 20;
  }

  // Security-relevant directory hints (first-class, each worth +30).
  const hotDirs = [
    "/src/", "/lib/", "/core/", "/runtime/", "/engine/",
    "/auth/", "/crypto/", "/security/", "/net/", "/network/",
    "/parser/", "/serialize/", "/deserialize/", "/protocol/",
    "/ipc/", "/rpc/", "/kernel/", "/driver/", "/firmware/",
    // Embedded / flight-software layouts (fprime, NASA cFS, zephyr):
    "/fw/", "/svc/", "/drv/", "/subsystems/", "/bsp/",
    "/deframer/", "/framer/", "/comqueue/", "/telemetry/", "/command/",
  ];
  if (hotDirs.some((d) => p.includes(d))) score += 30;

  // Softer module hints.
  const warmDirs = ["/app/", "/server/", "/api/", "/handler/", "/controller/"];
  if (warmDirs.some((d) => p.includes(d))) score += 15;

  // Penalty zones.
  const coldDirs = [
    "/test/", "/tests/", "/spec/", "/specs/", "/__tests__/",
    "/fixtures/", "/fixture/", "/examples/", "/example/", "/sample/",
    "/samples/", "/demo/", "/demos/", "/docs/", "/doc/", "/tutorial/",
    "/tutorials/", "/benchmark/", "/benchmarks/", "/generated/",
    "/third_party/", "/vendor/", "/node_modules/", "/_generated/",
    // Build-time / tooling — outside the runtime threat model for
    // most flight / embedded / server projects. v313 addition after
    // fprime scan confirmed a false-positive in cmake/autocoder.
    "/cmake/", "/scripts/", "/autocoder/", "/ci/", "/build/",
    "/tools/", "/.github/", "/packaging/", "/installer/",
    // Project-named test trees (FppTestProject, MyAppTests, etc.) —
    // path tokens with `Test` or `Tests` as a subdirectory component
    // are test infrastructure even when the parent dir doesn't match
    // a /tests/ literal. v321 addition after fprime scan confirmed a
    // false-positive in FppTestProject/FppTest/topology/types/.
    "/fpptest", "/fpptestproject", "/testproject", "/testharness",
    "/testutils", "/testtools",
  ];
  if (coldDirs.some((d) => p.includes(d))) score -= 40;
  // Generic test-tree heuristic: any path component that ends with
  // "test" or "tests" (case-insensitive) is treated as test infra.
  // Catches FppTestProject, MyComponentTest, IntegrationTests, etc.
  if (/\/[a-z][a-z0-9-]*tests?\b/i.test(p)) score -= 20;

  // Filenames that suggest tests / fixtures.
  const base = p.split("/").pop() ?? "";
  if (/(^test[_-]|[_-]test\.|\.test\.|\.spec\.|^spec[_-])/.test(base)) score -= 20;
  if (/^mock[_.-]|[_-]mock\.|^stub[_.-]|[_-]stub\./.test(base)) score -= 15;

  return score;
}

/**
 * Adaptive default file cap. Repositories under ~800 source files
 * get the full tree. Medium repos (<3000) get bumped to 1500. Large
 * repos (≥3000) cap at 2000 — that's still ~12× the average 170-file
 * project, and the verifier is the cost bottleneck, not the scanner.
 */
export function defaultMaxFiles(total: number): number {
  if (total <= 800) return total;
  if (total < 3000) return 1500;
  return 2000;
}

/**
 * Apply ranking + truncation to the raw enumeration. Returns both
 * the selected subset and the total so the caller can build a
 * coverage report.
 */
export function selectFilesForAudit(
  all: string[],
  maxFiles: number,
): { selected: string[]; total: number; truncated: boolean; maxFiles: number } {
  if (all.length <= maxFiles) {
    return {
      selected: [...all],
      total: all.length,
      truncated: false,
      maxFiles,
    };
  }
  // Stable sort by score desc, then by path for determinism.
  const ranked = all
    .map((p) => ({ path: p, score: scoreFileForAudit(p) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.path.localeCompare(b.path);
    });
  return {
    selected: ranked.slice(0, maxFiles).map((r) => r.path),
    total: all.length,
    truncated: true,
    maxFiles,
  };
}

/**
 * Legacy wrapper preserved for callers that want a flat list with a
 * hard cap applied in traversal order. Prefer enumerateSourceFiles +
 * selectFilesForAudit for new code — that path yields a coverage
 * report and ranked selection.
 */
export function findSourceFiles(root: string, maxFiles = 500): string[] {
  const all = enumerateSourceFiles(root);
  const { selected } = selectFilesForAudit(all, maxFiles);
  return selected;
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
 * Languages that use C-style double-slash line comments and
 * slash-star block comments. Found by Phase 3's fixture harness:
 * cpp-001 happily matched `(&var)[n]` inside a line comment
 * because the scanner had no comment-awareness at all.
 */
const C_STYLE_COMMENT_LANGS: ReadonlySet<Language> = new Set<Language>([
  "c",
  "cpp",
  "javascript",
  "typescript",
  "go",
  "rust",
  "java",
  "swift",
  "php",
]);

/** Languages that use `#` for line comments. */
const HASH_COMMENT_LANGS: ReadonlySet<Language> = new Set<Language>([
  "python",
  "ruby",
  "bash",
]);

/**
 * Return the 0-based [start, end) ranges of every comment in the
 * source for the given language. Computed once per file and reused
 * across all patterns — O(n) in the content length regardless of
 * how many patterns run.
 *
 * First-pass heuristic: handles line comments (double-slash or
 * hash) and block comments (slash-star). Does NOT try to
 * understand comments inside strings (a line-comment marker inside
 * a string literal will be treated as a comment). Good enough to
 * kill the common fixture regression without requiring a full
 * lexer for every supported language.
 */
export function computeCommentRanges(
  content: string,
  language: Language,
): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const cStyle = C_STYLE_COMMENT_LANGS.has(language);
  const hash = HASH_COMMENT_LANGS.has(language);
  if (!cStyle && !hash) return ranges;

  let i = 0;
  while (i < content.length) {
    const ch = content[i]!;
    // Line comment starters
    if (cStyle && ch === "/" && content[i + 1] === "/") {
      const end = content.indexOf("\n", i + 2);
      const stop = end === -1 ? content.length : end;
      ranges.push([i, stop]);
      i = stop;
      continue;
    }
    if (hash && ch === "#") {
      const end = content.indexOf("\n", i + 1);
      const stop = end === -1 ? content.length : end;
      ranges.push([i, stop]);
      i = stop;
      continue;
    }
    // Block comment
    if (cStyle && ch === "/" && content[i + 1] === "*") {
      const end = content.indexOf("*/", i + 2);
      const stop = end === -1 ? content.length : end + 2;
      ranges.push([i, stop]);
      i = stop;
      continue;
    }
    i++;
  }
  return ranges;
}

/** True when `matchIndex` falls inside any comment range. O(log n)
 * — binary search to stay fast on long files. */
export function isInsideComment(
  ranges: Array<[number, number]>,
  matchIndex: number,
): boolean {
  // Linear scan is fine for typical comment counts; if we see
  // hot-path issues on huge files, swap for binary search.
  for (const [start, end] of ranges) {
    if (matchIndex >= start && matchIndex < end) return true;
    if (start > matchIndex) return false; // ranges are ordered
  }
  return false;
}

/**
 * Apply a single pattern to a file, producing a list of candidate findings.
 */
/**
 * Test-friendly wrapper: run a single pattern against in-memory
 * content as if it lived at `path`. The `bypassPathFilters` flag
 * lets the pattern-fixtures harness in tests/patterns/ assert the
 * regex invariant directly, without applyPattern's
 * test-file / config-file / low-severity suppressions (those are
 * valid in production — and would hide fixture breakage in tests).
 */
export function scanPatternAgainstContent(
  pattern: BugPattern,
  path: string,
  content: string,
  opts: { bypassPathFilters?: boolean } = {},
): Candidate[] {
  return applyPattern(pattern, path, content, opts.bypassPathFilters ?? false);
}

function applyPattern(
  pattern: BugPattern,
  path: string,
  content: string,
  bypassPathFilters = false,
): Candidate[] {
  const lang = getLanguageForFile(path);
  if (!lang || !pattern.languages.includes(lang)) return [];

  const candidates: Candidate[] = [];
  // Pre-compute comment ranges once per file. Kills a whole class
  // of false positives where the pattern regex matches example
  // code inside a `// ...` or `/* ... */` or `#` comment.
  const commentRanges = computeCommentRanges(content, lang);

  // Ensure regex has global flag for iterative matching
  const rex = pattern.regex.global
    ? pattern.regex
    : new RegExp(pattern.regex.source, pattern.regex.flags + "g");
  rex.lastIndex = 0;

  let m: RegExpExecArray | null;
  while ((m = rex.exec(content)) !== null) {
    // Drop matches that fall inside a comment for this language.
    if (isInsideComment(commentRanges, m.index)) {
      if (m.index === rex.lastIndex) rex.lastIndex++;
      continue;
    }
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
    // Pre-filter: skip obvious false positives in web framework code.
    // bypassPathFilters=true is set only by the pattern-fixtures
    // harness — fixtures intentionally live under tests/ and fire
    // low-severity patterns, so the test-file suppression would
    // hide regressions we want to catch.
    if (!bypassPathFilters) {
      const isTestFile = path.includes("test") || path.includes("spec") || path.includes("__tests__");
      const isConfig = path.includes("config") || path.includes(".config.");
      const isGenerated = path.includes(".next/") || path.includes("dist/") || path.includes("build/");
      // Skip low-severity findings in test/config/generated files
      if ((isTestFile || isConfig || isGenerated) && pattern.severity === "low") continue;
      // Skip hardcoded-secret patterns if the value looks like a placeholder
      if (pattern.id.includes("hardcoded") && /changeme|placeholder|example|xxx|YOUR_|TODO/i.test(matched_text)) continue;
    }

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
): {
  files: string[];
  candidates: Candidate[];
  coverage: {
    totalCandidateFiles: number;
    scannedFiles: number;
    skippedByLimit: number;
    truncated: boolean;
    maxFiles: number;
    capSource: "user" | "adaptive";
  };
} {
  // Enumerate first so we know the full universe and can report coverage.
  const all = enumerateSourceFiles(projectRoot);

  const userSetMax = opts?.maxFiles !== undefined;
  const maxFiles = userSetMax ? opts!.maxFiles! : defaultMaxFiles(all.length);
  const capSource: "user" | "adaptive" = userSetMax ? "user" : "adaptive";

  const { selected, total, truncated } = selectFilesForAudit(all, maxFiles);
  const patterns = opts?.patterns ?? getAllPatterns();
  const candidates: Candidate[] = [];

  for (const file of selected) {
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

  return {
    files: selected,
    candidates,
    coverage: {
      totalCandidateFiles: total,
      scannedFiles: selected.length,
      skippedByLimit: total - selected.length,
      truncated,
      maxFiles,
      capSource,
    },
  };
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
