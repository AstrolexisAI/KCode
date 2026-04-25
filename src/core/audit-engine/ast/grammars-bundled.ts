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

import pythonWasm from "./grammars/tree-sitter-python.wasm" with { type: "file" };

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
];

export function findBundledGrammar(language: string): BundledGrammar | null {
  return BUNDLED_GRAMMARS.find((g) => g.language === language) ?? null;
}
