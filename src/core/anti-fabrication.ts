// KCode - Anti-Fabrication Guard (phase 13)
//
// Detects the failure mode where the model, after finishing a task,
// probes file paths that were NEVER mentioned in the conversation and
// don't exist anywhere on disk — i.e. it fabricated them wholesale.
//
// Real session (grok-4.20 after writing nasa-explorer.html):
//   ⚡ Read: lunar-ops/core/bayesian_net.py      ← ENOENT
//   ⚡ Read: lunar-ops/scenarios/co2_buildup.py  ← ENOENT
//   ⚡ Glob: **/*bayesian*                       ← no matches
//   ⚡ Glob: **/*lunar*                          ← no matches
//   ⚡ GitStatus                                 ← error
//   → final message offered "Connect to the lunar Bayesian diagnostic
//     system mentioned in the context" — but nothing lunar/bayesian
//     was EVER mentioned in the user's request.
//
// Hallucinated tool calls waste tokens (cloud and local alike) and
// time. Phase 13 catches them by noticing that (a) the tool failed
// because the path doesn't exist, AND (b) none of the significant
// tokens in that path appear anywhere in prior conversation context.
// When both are true the tool result is augmented with a STOP-this-
// is-fabricated warning that forces the model to reconcile before
// continuing down the fictional path.
//
// Design goals:
//   - Zero overhead on the happy path (tool succeeded).
//   - Cheap token cost on the failure path (warning is 8 lines max).
//   - Conservative false-positive rate: conventional filenames like
//     package.json, tsconfig.json, Cargo.toml, etc. are always
//     allowed even if unmentioned — they are legitimate probes.

// ─── Safe filenames that are always allowed to probe ───────────────
//
// Conventional filenames the LLM legitimately probes on any new
// project without user prompting. Matched by basename only.
const CONVENTIONAL_PROBES = new Set([
  // Node / JavaScript / TypeScript
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "jsconfig.json",
  "bun.lockb",
  "yarn.lock",
  "pnpm-lock.yaml",
  ".npmrc",
  // Config
  "next.config.ts",
  "next.config.js",
  "next.config.mjs",
  "vite.config.ts",
  "vite.config.js",
  "astro.config.mjs",
  "svelte.config.js",
  "tailwind.config.ts",
  "tailwind.config.js",
  "postcss.config.js",
  "postcss.config.mjs",
  "eslint.config.js",
  ".eslintrc.json",
  ".prettierrc",
  ".prettierrc.json",
  // Rust
  "Cargo.toml",
  "Cargo.lock",
  // Python
  "pyproject.toml",
  "requirements.txt",
  "setup.py",
  "setup.cfg",
  "Pipfile",
  "Pipfile.lock",
  // Go
  "go.mod",
  "go.sum",
  // Ruby
  "Gemfile",
  "Gemfile.lock",
  "Rakefile",
  // PHP
  "composer.json",
  "composer.lock",
  // Docs / meta
  "README.md",
  "README.rst",
  "README.txt",
  "README",
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
  "CHANGELOG.md",
  "CHANGELOG",
  "CONTRIBUTING.md",
  // Build / deploy
  "Makefile",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  ".dockerignore",
  ".gitignore",
  ".gitattributes",
  ".env",
  ".env.example",
  ".env.local",
  ".env.production",
  // CI
  ".github/workflows",
  ".gitlab-ci.yml",
  ".travis.yml",
  "ci.yml",
  // Mobile
  "Podfile",
  "Info.plist",
  "AndroidManifest.xml",
  "build.gradle",
  "build.gradle.kts",
  // Platform
  "shell.nix",
  "flake.nix",
  "justfile",
  "Justfile",
]);

// ─── Error patterns that indicate "path doesn't exist" ────────────
const NOT_FOUND_PATTERNS = [
  /ENOENT/i,
  /no such file or directory/i,
  /file not found/i,
  /path .* does not exist/i,
  /not found: /i,
  /could not find/i,
  /no files found matching/i,
];

export function looksLikeNotFound(errorText: string): boolean {
  if (!errorText) return false;
  return NOT_FOUND_PATTERNS.some((re) => re.test(errorText));
}

// ─── Tokenization ─────────────────────────────────────────────────

// Path components that carry no semantic content ("boilerplate" dirs)
// and should be stripped before comparing against conversation history.
const BORING_PATH_SEGMENTS = new Set([
  "",
  ".",
  "..",
  "src",
  "lib",
  "dist",
  "build",
  "public",
  "static",
  "assets",
  "app",
  "pages",
  "components",
  "core",
  "utils",
  "helpers",
  "common",
  "shared",
  "tests",
  "test",
  "spec",
  "specs",
  "__tests__",
  "__mocks__",
  "node_modules",
  "target",
  "out",
  "tmp",
  "temp",
  "cache",
  "home",
  "usr",
  "var",
  "etc",
  "opt",
  "bin",
  "index",
  "main",
  "mod",
]);

// Common file extensions that should not count as significant tokens.
const BORING_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "rs",
  "go",
  "java",
  "rb",
  "php",
  "c",
  "cc",
  "cpp",
  "h",
  "hh",
  "hpp",
  "md",
  "txt",
  "json",
  "yaml",
  "yml",
  "toml",
  "xml",
  "html",
  "css",
  "scss",
  "sass",
  "less",
  "svg",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "pdf",
]);

/**
 * Extract the semantically meaningful tokens from a path. Used to
 * detect whether any part of the path was mentioned in conversation
 * history. Splits on /, _, -, and camelCase; drops extensions, boring
 * segments, and pure digits. Returns lowercase tokens.
 *
 * Example:
 *   extractSignificantTokens("lunar-ops/core/bayesian_net.py")
 *     → ["lunar", "ops", "bayesian", "net"]
 *   extractSignificantTokens("src/components/hero.tsx")
 *     → ["hero"]
 *   extractSignificantTokens("package.json")
 *     → []   (conventional — zero significant tokens)
 */
export function extractSignificantTokens(path: string): string[] {
  if (!path) return [];
  // Strip leading protocol/drive letters just in case
  const clean = path.replace(/^[a-z]:\\/i, "").trim();
  const segments = clean.split(/[\\/]+/);
  const tokens: string[] = [];
  for (const seg of segments) {
    if (!seg) continue;
    if (BORING_PATH_SEGMENTS.has(seg.toLowerCase())) continue;
    // Strip extension from the final segment. Do this before splitting
    // camelCase so `bayesianNet.py` becomes `bayesianNet`.
    const withoutExt = seg.replace(/\.([a-zA-Z0-9]+)$/, (_m, ext: string) => {
      return BORING_EXTENSIONS.has(ext.toLowerCase()) ? "" : `.${ext}`;
    });
    // Split camelCase BEFORE lowercasing so "bayesianNet" → "bayesian Net"
    const split = withoutExt
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2") // HTMLParser → HTML Parser
      .toLowerCase();
    const parts = split.split(/[\s_-]+/).filter((p) => p.length > 1 && !/^\d+$/.test(p));
    for (const p of parts) {
      if (BORING_PATH_SEGMENTS.has(p)) continue;
      tokens.push(p);
    }
  }
  return tokens;
}

// ─── Reference check ───────────────────────────────────────────────

/**
 * Does the given path appear to have been mentioned in the
 * conversation history? Checks whether ANY significant token of the
 * path appears as a substring in any of the provided history entries.
 *
 * Returns true for:
 *   - Conventional filenames (package.json, README.md, etc.) — always
 *   - Paths whose significant tokens all appear in prior messages
 *
 * Returns false for:
 *   - Paths with novel tokens that never appeared in context — these
 *     are candidates for fabrication warnings.
 */
export function wasPathReferenced(path: string, historyTexts: string[]): boolean {
  if (!path) return true; // empty paths aren't fabricated
  const basename = path.split(/[\\/]/).pop() ?? path;
  if (CONVENTIONAL_PROBES.has(basename)) return true;

  const tokens = extractSignificantTokens(path);
  if (tokens.length === 0) {
    // No significant tokens means the path is all boring segments
    // and extension — it's either a conventional probe or close enough.
    return true;
  }

  const historyBlob = historyTexts.join("\n").toLowerCase();
  // Require EVERY significant token to appear somewhere in history.
  // This is strict enough to catch "lunar" / "bayesian" fabrication
  // while permissive enough to accept a real probe where the model
  // guessed one component correctly.
  for (const tok of tokens) {
    if (!historyBlob.includes(tok)) return false;
  }
  return true;
}

// ─── Top-level fabrication check ───────────────────────────────────

export interface FabricationVerdict {
  /** True if the tool result looks like a hallucinated path probe. */
  fabricated: boolean;
  /** The tokens from the path that were NOT found in history. */
  unreferencedTokens: string[];
}

export function isLikelyFabricated(
  attemptedPath: string,
  errorText: string,
  historyTexts: string[],
): FabricationVerdict {
  if (!looksLikeNotFound(errorText)) {
    return { fabricated: false, unreferencedTokens: [] };
  }
  if (!attemptedPath) return { fabricated: false, unreferencedTokens: [] };
  if (wasPathReferenced(attemptedPath, historyTexts)) {
    return { fabricated: false, unreferencedTokens: [] };
  }
  const tokens = extractSignificantTokens(attemptedPath);
  const historyBlob = historyTexts.join("\n").toLowerCase();
  const unreferenced = tokens.filter((t) => !historyBlob.includes(t));
  return { fabricated: true, unreferencedTokens: unreferenced };
}

// ─── Warning formatter ────────────────────────────────────────────

/**
 * Wrap an original tool error content with a strong fabrication
 * warning. The warning is short (9 lines) to stay token-cheap.
 */
export function wrapFabricatedError(
  originalContent: string,
  attemptedPath: string,
  unreferencedTokens: string[],
): string {
  const lines: string[] = [];
  lines.push(originalContent.trimEnd());
  lines.push("");
  lines.push("⚠ POSSIBLE FABRICATION:");
  lines.push(`  The path '${attemptedPath}' does not exist on disk and was NOT`);
  lines.push(
    `  mentioned in this conversation. Significant tokens [${unreferencedTokens.join(", ")}]`,
  );
  lines.push(`  have no match in prior messages or tool results.`);
  lines.push(`  Before probing further or referencing this in your response:`);
  lines.push(`    - Did you invent this path? If yes, STOP and discard it.`);
  lines.push(`    - If you believe it SHOULD exist, ask the user explicitly.`);
  lines.push(`  Do NOT offer follow-up tasks based on fictional files.`);
  return lines.join("\n");
}

// ─── History extractor helper ─────────────────────────────────────

/**
 * Given the current message list from ConversationManager state,
 * return the flat text of every user message and every prior tool
 * result. Used as the "did this path appear anywhere" corpus.
 *
 * We deliberately skip assistant text so that if the MODEL itself
 * previously hallucinated "lunar-ops", that hallucination does not
 * count as evidence — only user-provided and filesystem-provided
 * content is trusted.
 */
export function collectReferenceTexts(
  messages: Array<{ role: string; content: unknown }>,
): string[] {
  const out: string[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        out.push(msg.content);
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          const b = block as { type?: string; text?: string; content?: unknown };
          if (b.type === "text" && typeof b.text === "string") {
            out.push(b.text);
          } else if (b.type === "tool_result") {
            // Tool results inside user messages (Anthropic format)
            if (typeof b.content === "string") out.push(b.content);
            else if (Array.isArray(b.content)) {
              for (const sub of b.content) {
                const s = sub as { type?: string; text?: string };
                if (s.type === "text" && typeof s.text === "string") {
                  out.push(s.text);
                }
              }
            }
          }
        }
      }
    }
  }
  return out;
}
