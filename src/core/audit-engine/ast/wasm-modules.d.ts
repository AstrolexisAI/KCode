// Ambient module declarations for `.wasm` imports used by the AST
// runner. Bun resolves `import path from "...wasm" with { type: "file" }`
// to a string at build time, but TypeScript doesn't ship a default
// declaration for that pattern — so without these, tsc errors with
// TS2307 ("Cannot find module") even though the runtime is happy.
//
// Scope is narrow on purpose: we declare only the specific files the
// AST runner imports, so adding a stray .wasm import elsewhere can't
// silently bypass type-checking.

declare module "*.wasm" {
  const path: string;
  export default path;
}
