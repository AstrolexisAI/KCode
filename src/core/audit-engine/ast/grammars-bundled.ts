// KCode - Bundled tree-sitter grammars (v2.10.339)
//
// `import path from "./...wasm" with { type: "file" }` is resolved by
// Bun two ways:
//   - `bun run`              → path is the absolute source location.
//   - `bun build --compile`  → the asset is embedded into the binary
//                              and the path resolves to a virtual
//                              location readable via node:fs.
//
// Either way, `kcode grammars install` can `Bun.file(path).arrayBuffer()`
// the bytes and write them to ~/.kcode/grammars/, which the runner
// looks at as a first-class user-installed location.
//
// Add a new language:
//   1. Drop the .wasm under ./grammars/
//   2. Append it to BUNDLED_GRAMMARS below
//   3. Add a tsLangFor() entry in runner.ts if the language id differs

import cWasm from "./grammars/tree-sitter-c.wasm" with { type: "file" };
import cppWasm from "./grammars/tree-sitter-cpp.wasm" with { type: "file" };
import goWasm from "./grammars/tree-sitter-go.wasm" with { type: "file" };
import javaWasm from "./grammars/tree-sitter-java.wasm" with { type: "file" };
import javascriptWasm from "./grammars/tree-sitter-javascript.wasm" with { type: "file" };
import phpWasm from "./grammars/tree-sitter-php.wasm" with { type: "file" };
import pythonWasm from "./grammars/tree-sitter-python.wasm" with { type: "file" };
import rubyWasm from "./grammars/tree-sitter-ruby.wasm" with { type: "file" };
import rustWasm from "./grammars/tree-sitter-rust.wasm" with { type: "file" };
import tsxWasm from "./grammars/tree-sitter-tsx.wasm" with { type: "file" };
import typescriptWasm from "./grammars/tree-sitter-typescript.wasm" with { type: "file" };

export interface BundledGrammar {
  /** tree-sitter language key (matches tsLangFor in runner.ts) */
  language: string;
  /** Absolute path resolved by Bun — works in source and compiled modes */
  path: string;
  /** Filename the runner expects under ~/.kcode/grammars/ */
  filename: string;
}

export const BUNDLED_GRAMMARS: readonly BundledGrammar[] = [
  {
    language: "python",
    path: pythonWasm,
    filename: "tree-sitter-python.wasm",
  },
  {
    language: "javascript",
    path: javascriptWasm,
    filename: "tree-sitter-javascript.wasm",
  },
  {
    language: "go",
    path: goWasm,
    filename: "tree-sitter-go.wasm",
  },
  {
    language: "typescript",
    path: typescriptWasm,
    filename: "tree-sitter-typescript.wasm",
  },
  {
    // TSX uses a separate grammar (typescript with JSX). The runner
    // picks "tsx" over "typescript" when the file ends in .tsx; the
    // pattern still declares languages: ["typescript"].
    language: "tsx",
    path: tsxWasm,
    filename: "tree-sitter-tsx.wasm",
  },
  {
    language: "java",
    path: javaWasm,
    filename: "tree-sitter-java.wasm",
  },
  {
    language: "c",
    path: cWasm,
    filename: "tree-sitter-c.wasm",
  },
  {
    language: "cpp",
    path: cppWasm,
    filename: "tree-sitter-cpp.wasm",
  },
  {
    language: "rust",
    path: rustWasm,
    filename: "tree-sitter-rust.wasm",
  },
  {
    language: "ruby",
    path: rubyWasm,
    filename: "tree-sitter-ruby.wasm",
  },
  {
    // The bundled file is the upstream `tree-sitter-php_only` build —
    // it's renamed to tree-sitter-php.wasm so the runner's filename
    // convention (`tree-sitter-${lang}.wasm`) finds it. Pure-PHP
    // files parse cleanly; mixed PHP/HTML files parse via tree-
    // sitter's error recovery. A future revision could bundle the
    // mixed-mode tree-sitter-php grammar separately.
    language: "php",
    path: phpWasm,
    filename: "tree-sitter-php.wasm",
  },
];

export function findBundledGrammar(language: string): BundledGrammar | null {
  return BUNDLED_GRAMMARS.find((g) => g.language === language) ?? null;
}
