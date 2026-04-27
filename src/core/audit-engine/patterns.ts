// KCode - Bug Pattern Library (aggregator)
//
// The 256 curated patterns are split by language into one file per
// language under ./patterns/. This file re-exports them and builds
// the ALL_PATTERNS array + the lookup helpers. If you're adding a
// new pattern:
//
//   1. Put it in the appropriate ./patterns/<lang>.ts.
//   2. If it's a new language, create ./patterns/<lang>.ts, add an
//      export line below, and spread it into ALL_PATTERNS.
//   3. Add positive + negative fixtures under tests/patterns/.
//
// Historical note: these lived in a single 4409-line file until
// v2.10.131. The split was mechanical — no logic changed. The
// patterns themselves still carry their NASA-IDF provenance in
// their explanation/verify_prompt text.

import { C_CPP_AST_PATTERNS } from "./ast/c-cpp-patterns";
import { GO_AST_PATTERNS } from "./ast/go-patterns";
import { JAVA_AST_PATTERNS } from "./ast/java-patterns";
import { JAVASCRIPT_AST_PATTERNS } from "./ast/javascript-patterns";
import { PHP_AST_PATTERNS } from "./ast/php-patterns";
// v2.10.351 — AST pattern aggregator. The verifier looks up
// patterns by id via getPatternById(); without registering AST
// patterns here, every AST candidate ended up in needs_context with
// "Unknown pattern id". The fix: extend getPatternById to also
// search the AST-pattern registry. AstPattern carries the same
// title / severity / explanation / verify_prompt fields the
// verifier consumes — only the runtime shape (regex vs query+match)
// differs.
import { PYTHON_AST_PATTERNS } from "./ast/python-patterns";
import { RUBY_AST_PATTERNS } from "./ast/ruby-patterns";
import { RUST_AST_PATTERNS } from "./ast/rust-patterns";
import type { AstPattern } from "./ast/types";
import { TYPESCRIPT_AST_PATTERNS } from "./ast/typescript-patterns";
// v2.10.370 — F9 vendible packs
import { AI_ML_PATTERNS } from "./patterns/ai-ml";
// P2.1 (v2.10.389) — Cloud / IaC at-rest pack.
import { CLOUD_PATTERNS } from "./patterns/cloud";
import { CPP_PATTERNS } from "./patterns/cpp";
// v2.10.314 expansion packs
import { CRYPTO_PATTERNS } from "./patterns/crypto";
import { CSHARP_PATTERNS } from "./patterns/csharp";
import { DART_PATTERNS } from "./patterns/dart";
import { DESERIALIZE_PATTERNS } from "./patterns/deserialize";
// P2.3 (v2.10.391) — Django framework pack.
import { DJANGO_PATTERNS } from "./patterns/django";
import { ELIXIR_PATTERNS } from "./patterns/elixir";
// P2.3 (v2.10.391) — Express framework pack.
import { EXPRESS_PATTERNS } from "./patterns/express";
// P2.3 (v2.10.391) — FastAPI framework pack.
import { FASTAPI_PATTERNS } from "./patterns/fastapi";
import { FLIGHT_SOFTWARE_PATTERNS } from "./patterns/flight-software";
import { FRAMEWORK_PATTERNS } from "./patterns/framework";
import { GO_PATTERNS } from "./patterns/go";
import { HASKELL_PATTERNS } from "./patterns/haskell";
import { INJECTION_PATTERNS } from "./patterns/injection";
import { JAVA_PATTERNS } from "./patterns/java";
import { JS_PATTERNS } from "./patterns/js";
import { KOTLIN_PATTERNS } from "./patterns/kotlin";
// P2.3 (v2.10.391) — Laravel framework pack.
import { LARAVEL_PATTERNS } from "./patterns/laravel";
import { LUA_PATTERNS } from "./patterns/lua";
// P2.3 (v2.10.391) — Next.js framework starter (web pack).
import { NEXTJS_PATTERNS } from "./patterns/nextjs";
import { PHP_PATTERNS } from "./patterns/php";
import { PYTHON_PATTERNS } from "./patterns/python";
// P2.3 (v2.10.391) — Rails framework pack.
import { RAILS_PATTERNS } from "./patterns/rails";
import { RUBY_PATTERNS } from "./patterns/ruby";
import { RUST_PATTERNS } from "./patterns/rust";
import { SCALA_PATTERNS } from "./patterns/scala";
// P2.3 (v2.10.391) — Spring framework pack.
import { SPRING_PATTERNS } from "./patterns/spring";
import { SQL_PATTERNS } from "./patterns/sql";
// P2.2 (v2.10.389) — Supply-chain pack.
import { SUPPLY_CHAIN_PATTERNS } from "./patterns/supply-chain";
import { SWIFT_PATTERNS } from "./patterns/swift";
import { UNIVERSAL_PATTERNS } from "./patterns/universal";
import { ZIG_PATTERNS } from "./patterns/zig";
import type { BugPattern } from "./types";

// Re-export every per-language array so existing imports keep working.
export {
  AI_ML_PATTERNS,
  CLOUD_PATTERNS,
  CPP_PATTERNS,
  CRYPTO_PATTERNS,
  CSHARP_PATTERNS,
  DART_PATTERNS,
  DESERIALIZE_PATTERNS,
  DJANGO_PATTERNS,
  ELIXIR_PATTERNS,
  EXPRESS_PATTERNS,
  FASTAPI_PATTERNS,
  FLIGHT_SOFTWARE_PATTERNS,
  FRAMEWORK_PATTERNS,
  GO_PATTERNS,
  HASKELL_PATTERNS,
  INJECTION_PATTERNS,
  JAVA_PATTERNS,
  JS_PATTERNS,
  KOTLIN_PATTERNS,
  LARAVEL_PATTERNS,
  LUA_PATTERNS,
  NEXTJS_PATTERNS,
  PHP_PATTERNS,
  PYTHON_PATTERNS,
  RAILS_PATTERNS,
  RUBY_PATTERNS,
  RUST_PATTERNS,
  SCALA_PATTERNS,
  SPRING_PATTERNS,
  SQL_PATTERNS,
  SUPPLY_CHAIN_PATTERNS,
  SWIFT_PATTERNS,
  UNIVERSAL_PATTERNS,
  ZIG_PATTERNS,
};

export const ALL_PATTERNS: BugPattern[] = [
  ...CPP_PATTERNS,
  ...PYTHON_PATTERNS,
  ...JS_PATTERNS,
  ...GO_PATTERNS,
  ...RUST_PATTERNS,
  ...JAVA_PATTERNS,
  ...SWIFT_PATTERNS,
  ...KOTLIN_PATTERNS,
  ...CSHARP_PATTERNS,
  ...PHP_PATTERNS,
  ...RUBY_PATTERNS,
  ...DART_PATTERNS,
  ...ELIXIR_PATTERNS,
  ...LUA_PATTERNS,
  ...SQL_PATTERNS,
  ...SCALA_PATTERNS,
  ...HASKELL_PATTERNS,
  ...ZIG_PATTERNS,
  ...FRAMEWORK_PATTERNS,
  ...UNIVERSAL_PATTERNS,
  ...CRYPTO_PATTERNS,
  ...INJECTION_PATTERNS,
  ...DESERIALIZE_PATTERNS,
  ...FLIGHT_SOFTWARE_PATTERNS,
  ...AI_ML_PATTERNS,
  ...CLOUD_PATTERNS,
  ...SUPPLY_CHAIN_PATTERNS,
  ...NEXTJS_PATTERNS,
  ...FASTAPI_PATTERNS,
  ...EXPRESS_PATTERNS,
  ...DJANGO_PATTERNS,
  ...RAILS_PATTERNS,
  ...SPRING_PATTERNS,
  ...LARAVEL_PATTERNS,
];

/** Return all patterns applicable to the given language. */
export function getPatternsForLanguage(lang: string): BugPattern[] {
  return ALL_PATTERNS.filter((p) => p.languages.includes(lang as never));
}

/** All bundled AST patterns — searched by getPatternById() so the
 *  verifier can resolve `<lang>-ast-NNN-*` ids the same way it
 *  resolves regex pattern ids. v2.10.351. */
const ALL_AST_PATTERNS: AstPattern[] = [
  ...PYTHON_AST_PATTERNS,
  ...JAVASCRIPT_AST_PATTERNS,
  ...TYPESCRIPT_AST_PATTERNS,
  ...GO_AST_PATTERNS,
  ...JAVA_AST_PATTERNS,
  ...C_CPP_AST_PATTERNS,
  ...RUST_AST_PATTERNS,
  ...RUBY_AST_PATTERNS,
  ...PHP_AST_PATTERNS,
];

/**
 * The fields verifier.ts consumes from a pattern. BugPattern AND
 * AstPattern both satisfy this — same id/title/severity/explanation/
 * verify_prompt naming. Returning a structural subset keeps the
 * return type honest about which fields callers can rely on across
 * regex and AST patterns. v2.10.351.
 */
export type LookupPattern = Pick<
  BugPattern,
  | "id"
  | "title"
  | "severity"
  | "explanation"
  | "verify_prompt"
  | "cwe"
  | "fix_template"
  | "languages"
>;

/** Look up a pattern by ID — searches both regex and AST registries. */
export function getPatternById(id: string): LookupPattern | undefined {
  const regex = ALL_PATTERNS.find((p) => p.id === id);
  if (regex) return regex;
  const ast = ALL_AST_PATTERNS.find((p) => p.id === id);
  if (ast) {
    return {
      id: ast.id,
      title: ast.title,
      severity: ast.severity,
      explanation: ast.explanation,
      verify_prompt: ast.verify_prompt,
      cwe: ast.cwe,
      fix_template: ast.fix_template,
      languages: ast.languages,
    };
  }
  return undefined;
}

/** All patterns across all languages. */
export function getAllPatterns(): BugPattern[] {
  return [...ALL_PATTERNS];
}
