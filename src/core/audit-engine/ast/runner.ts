// KCode - AST runner (v2.10.336)
//
// Bridges AstPattern (declarative S-expression queries) → Candidate
// (the Verification pipeline's input). Lazy-loads `web-tree-sitter`
// at first use so the dependency is OPTIONAL: when it isn't installed,
// AST patterns are silently skipped with a structured stat entry, and
// the rest of the audit (regex patterns, fixer, report) is unaffected.
//
// Once the dep is available + at least one .wasm grammar is bundled,
// the same runner serves AST patterns transparently.

import type { Candidate } from "../types";
import type {
  AstCapture,
  AstNode,
  AstPattern,
  AstRunner,
  AstScanStats,
} from "./types";
// Embed web-tree-sitter's runtime wasm via Bun's `with { type: "file" }`.
// In `bun run` mode this resolves to the path under node_modules; in
// `bun build --compile` mode Bun copies the file into the binary and
// the import returns a path inside the embedded virtual filesystem
// (/$bunfs/...). Either way, Parser.init({ locateFile }) below can
// hand the runtime a real path. v2.10.339.
import runtimeWasm from "web-tree-sitter/web-tree-sitter.wasm" with {
  type: "file",
};

// ── Lazy module + grammar cache ──────────────────────────────────

interface TreeSitterModule {
  Parser: new () => TreeSitterParser;
  Language: {
    load(path: string): Promise<TreeSitterLanguage>;
  };
  Query: new (lang: TreeSitterLanguage, source: string) => TreeSitterQuery;
}

interface TreeSitterParser {
  setLanguage(lang: TreeSitterLanguage): void;
  parse(source: string): TreeSitterTree;
}

interface TreeSitterLanguage {
  // Opaque
  readonly _isLanguage: true;
}

interface TreeSitterTree {
  rootNode: TreeSitterNode;
}

interface TreeSitterNode {
  startIndex: number;
  endIndex: number;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  type: string;
  text: string;
  namedChildCount: number;
  namedChild(i: number): TreeSitterNode | null;
  parent: TreeSitterNode | null;
}

interface TreeSitterQuery {
  matches(node: TreeSitterNode): Array<{
    captures: Array<{ name: string; node: TreeSitterNode }>;
  }>;
}

let _moduleCache: Promise<TreeSitterModule | null> | null = null;
const _grammarCache = new Map<string, Promise<TreeSitterLanguage | null>>();

/** Force-clear caches — for tests. */
export function _resetAstRunnerForTest(): void {
  _moduleCache = null;
  _grammarCache.clear();
}

async function loadModule(): Promise<TreeSitterModule | null> {
  if (_moduleCache) return _moduleCache;
  _moduleCache = (async () => {
    try {
      // The dynamic import lets us ship the audit engine without a
      // hard dependency on web-tree-sitter. When the package is not
      // installed, we degrade silently to "AST patterns disabled".
      const mod = (await import("web-tree-sitter")) as { default?: unknown } & Record<string, unknown>;
      // web-tree-sitter exposes Parser as a top-level export with
      // an .init() static. Initialize once, then return the module.
      const Parser = (mod as { default?: unknown }).default ?? (mod as { Parser?: unknown }).Parser;
      if (typeof Parser === "function" && typeof (Parser as { init?: unknown }).init === "function") {
        // locateFile lets the Emscripten module find its sibling
        // .wasm without relying on the CWD or import.meta.url —
        // critical for the compiled binary (`bun build --compile`),
        // where node_modules doesn't exist on disk and the embedded
        // file lives under /$bunfs/. The runtimeWasm import above
        // resolves to the right path in both modes.
        const init = Parser as unknown as {
          init: (opts?: { locateFile?: (p: string) => string }) => Promise<void>;
        };
        await init.init({
          locateFile: (file: string) => {
            if (file === "web-tree-sitter.wasm") return runtimeWasm;
            return file;
          },
        });
      }
      return mod as unknown as TreeSitterModule;
    } catch {
      return null;
    }
  })();
  return _moduleCache;
}

/**
 * Resolve a tree-sitter grammar (.wasm) for the given language. The
 * wasm file is expected at one of:
 *   1. ${KCODE_GRAMMARS_DIR}/tree-sitter-<lang>.wasm   (env override)
 *   2. ~/.kcode/grammars/tree-sitter-<lang>.wasm       (user-installed)
 *   3. Bundled in src/core/audit-engine/ast/grammars/  (project ships)
 *
 * Future commits will populate the bundled directory. For now,
 * unresolved grammars return null and the runner skips that language.
 */
async function loadGrammar(
  module: TreeSitterModule,
  lang: string,
): Promise<TreeSitterLanguage | null> {
  const cached = _grammarCache.get(lang);
  if (cached) return cached;
  const promise = (async () => {
    const { existsSync } = await import("node:fs");
    const { resolve, join, dirname } = await import("node:path");
    const { homedir } = await import("node:os");

    // Resolution order — first hit wins:
    //   1. KCODE_GRAMMARS_DIR env var (CI override).
    //   2. Bundled grammars/ next to this module (works with
    //      `bun run src/index.ts`; import.meta.dir resolves to
    //      the source path).
    //   3. ~/.kcode/grammars/ — user-installed location, also where
    //      the compiled binary expects to find grammars.
    //   4. Next to the running executable — supports a portable
    //      install where the wasm is shipped beside the binary.
    const execDir = dirname(process.execPath);
    const candidates = [
      process.env.KCODE_GRAMMARS_DIR
        ? join(process.env.KCODE_GRAMMARS_DIR, `tree-sitter-${lang}.wasm`)
        : null,
      resolve(import.meta.dir, "grammars", `tree-sitter-${lang}.wasm`),
      join(homedir(), ".kcode", "grammars", `tree-sitter-${lang}.wasm`),
      join(execDir, "grammars", `tree-sitter-${lang}.wasm`),
    ].filter((p): p is string => p !== null);

    for (const p of candidates) {
      if (existsSync(p)) {
        try {
          return await module.Language.load(p);
        } catch {
          /* try next */
        }
      }
    }
    return null;
  })();
  _grammarCache.set(lang, promise);
  return promise;
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Map a Language id (from BugPattern.languages) to the tree-sitter
 * grammar key. Most map 1:1 except aliases like "javascript" / "js"
 * and the typescript / tsx split — TSX needs its own grammar (the TS
 * grammar can't parse JSX syntax). The `file` arg lets the caller
 * promote a "typescript" pattern to the tsx grammar when the file
 * ends in .tsx; without that, every TSX file would fail to parse and
 * silently contribute zero AST candidates. v2.10.341.
 */
function tsLangFor(language: string, file?: string): string | null {
  if (language === "typescript" && file && file.endsWith(".tsx")) return "tsx";
  const m: Record<string, string> = {
    python: "python",
    javascript: "javascript",
    typescript: "typescript",
    cpp: "cpp",
    c: "c",
    go: "go",
    rust: "rust",
    java: "java",
    ruby: "ruby",
    php: "php",
  };
  return m[language] ?? null;
}

/**
 * Determine the canonical Language id of a file from its extension.
 * Used by the runner to route each file through exactly ONE grammar
 * even when a pattern declares languages: ["javascript", "typescript"]
 * — without this, a .ts file would be parsed by BOTH grammars and
 * any matches would surface twice. v2.10.341.
 *
 * Returns null when the extension isn't AST-supported; the runner
 * skips the file entirely instead of wasting a parse pass.
 */
function fileLanguage(file: string): string | null {
  const lower = file.toLowerCase();
  if (lower.endsWith(".py") || lower.endsWith(".pyi")) return "python";
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs") || lower.endsWith(".jsx")) return "javascript";
  if (lower.endsWith(".ts") || lower.endsWith(".tsx") || lower.endsWith(".mts") || lower.endsWith(".cts")) return "typescript";
  if (lower.endsWith(".go")) return "go";
  if (lower.endsWith(".c") || lower.endsWith(".h")) return "c";
  if (
    lower.endsWith(".cpp") || lower.endsWith(".cc") || lower.endsWith(".cxx") ||
    lower.endsWith(".hpp") || lower.endsWith(".hh") || lower.endsWith(".hxx")
  ) return "cpp";
  if (lower.endsWith(".rs")) return "rust";
  if (lower.endsWith(".java")) return "java";
  if (lower.endsWith(".rb")) return "ruby";
  if (lower.endsWith(".php")) return "php";
  return null;
}

/**
 * Adapt a tree-sitter Node into the AstNode contract we publish to
 * pattern authors. Lets the public types stay narrow even as the
 * upstream binding evolves.
 */
function adaptNode(n: TreeSitterNode): AstNode {
  return {
    startIndex: n.startIndex,
    endIndex: n.endIndex,
    startPosition: n.startPosition,
    endPosition: n.endPosition,
    type: n.type,
    text: n.text,
    namedChildCount: n.namedChildCount,
    namedChild: (i: number) => {
      const c = n.namedChild(i);
      return c ? adaptNode(c) : null;
    },
    get parent() {
      return n.parent ? adaptNode(n.parent) : null;
    },
  };
}

/**
 * Apply a list of AST patterns to a single file's source. Returns
 * candidates + per-pattern stats. When the tree-sitter module or a
 * required grammar is missing, every pattern of that language returns
 * { grammar_loaded: false } and contributes zero candidates — never
 * an exception, never a hang.
 */
export const runAstPatterns: AstRunner = async (patterns, file, content) => {
  const stats: AstScanStats[] = [];
  const candidates: Candidate[] = [];

  if (patterns.length === 0) {
    return { candidates, stats };
  }
  const ts = await loadModule();
  if (!ts) {
    for (const p of patterns) {
      stats.push({
        pattern_id: p.id,
        raw_matches: 0,
        candidates: 0,
        grammar_loaded: false,
        load_error: "web-tree-sitter not installed",
        language: tsLangFor(p.languages[0] ?? "", file) ?? undefined,
      });
    }
    return { candidates, stats };
  }

  // Determine the file's canonical language ONCE from its extension,
  // then run only patterns whose `languages` array includes it. Without
  // this, a pattern with languages: ["javascript", "typescript"]
  // would parse a .ts file with BOTH grammars and emit each finding
  // twice. v2.10.341 — exposed by the typescript bundle.
  const fileLang = fileLanguage(file);
  if (!fileLang) {
    return { candidates, stats };
  }
  // Map pattern language → grammar key. The runner picks tsx for
  // .tsx files even when the pattern says "typescript".
  const grammarKey = tsLangFor(fileLang, file);
  if (!grammarKey) {
    return { candidates, stats };
  }
  const applicable: AstPattern[] = [];
  for (const p of patterns) {
    if (p.languages.includes(fileLang as never)) {
      applicable.push(p);
    }
  }
  if (applicable.length === 0) {
    return { candidates, stats };
  }
  const byLang = new Map<string, AstPattern[]>([[grammarKey, applicable]]);

  for (const [lang, langPatterns] of byLang) {
    const grammar = await loadGrammar(ts, lang);
    if (!grammar) {
      for (const p of langPatterns) {
        stats.push({
          pattern_id: p.id,
          raw_matches: 0,
          candidates: 0,
          grammar_loaded: false,
          load_error: `tree-sitter-${lang}.wasm not found`,
          language: lang,
        });
      }
      continue;
    }

    const parser = new ts.Parser();
    parser.setLanguage(grammar);
    let tree: TreeSitterTree;
    try {
      tree = parser.parse(content);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      for (const p of langPatterns) {
        stats.push({
          pattern_id: p.id,
          raw_matches: 0,
          candidates: 0,
          grammar_loaded: true,
          load_error: `parse failed: ${msg.slice(0, 120)}`,
          language: lang,
        });
      }
      continue;
    }

    for (const pattern of langPatterns) {
      let raw = 0;
      let conf = 0;
      let query: TreeSitterQuery;
      try {
        query = new ts.Query(grammar, pattern.query);
      } catch (err) {
        stats.push({
          pattern_id: pattern.id,
          raw_matches: 0,
          candidates: 0,
          grammar_loaded: true,
          load_error: `query compile failed: ${
            err instanceof Error ? err.message.slice(0, 120) : String(err)
          }`,
          language: lang,
        });
        continue;
      }

      const matches = query.matches(tree.rootNode);
      for (const m of matches) {
        raw++;
        const grouped: Record<string, AstCapture[]> = {};
        for (const cap of m.captures) {
          const arr = grouped[cap.name] ?? [];
          arr.push({ name: cap.name, node: adaptNode(cap.node) });
          grouped[cap.name] = arr;
        }
        const cand = pattern.match(grouped, content, file);
        if (cand) {
          candidates.push(cand);
          conf++;
        }
      }
      stats.push({
        pattern_id: pattern.id,
        raw_matches: raw,
        candidates: conf,
        grammar_loaded: true,
        language: lang,
      });
    }
  }

  return { candidates, stats };
};
