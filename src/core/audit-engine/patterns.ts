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

import type { BugPattern } from "./types";
import { CPP_PATTERNS } from "./patterns/cpp";
import { PYTHON_PATTERNS } from "./patterns/python";
import { JS_PATTERNS } from "./patterns/js";
import { GO_PATTERNS } from "./patterns/go";
import { RUST_PATTERNS } from "./patterns/rust";
import { JAVA_PATTERNS } from "./patterns/java";
import { SWIFT_PATTERNS } from "./patterns/swift";
import { KOTLIN_PATTERNS } from "./patterns/kotlin";
import { CSHARP_PATTERNS } from "./patterns/csharp";
import { PHP_PATTERNS } from "./patterns/php";
import { RUBY_PATTERNS } from "./patterns/ruby";
import { DART_PATTERNS } from "./patterns/dart";
import { ELIXIR_PATTERNS } from "./patterns/elixir";
import { LUA_PATTERNS } from "./patterns/lua";
import { SQL_PATTERNS } from "./patterns/sql";
import { SCALA_PATTERNS } from "./patterns/scala";
import { HASKELL_PATTERNS } from "./patterns/haskell";
import { ZIG_PATTERNS } from "./patterns/zig";
import { FRAMEWORK_PATTERNS } from "./patterns/framework";
import { UNIVERSAL_PATTERNS } from "./patterns/universal";
// v2.10.314 expansion packs
import { CRYPTO_PATTERNS } from "./patterns/crypto";
import { INJECTION_PATTERNS } from "./patterns/injection";
import { DESERIALIZE_PATTERNS } from "./patterns/deserialize";
import { FLIGHT_SOFTWARE_PATTERNS } from "./patterns/flight-software";

// Re-export every per-language array so existing imports keep working.
export {
  CPP_PATTERNS,
  PYTHON_PATTERNS,
  JS_PATTERNS,
  GO_PATTERNS,
  RUST_PATTERNS,
  JAVA_PATTERNS,
  SWIFT_PATTERNS,
  KOTLIN_PATTERNS,
  CSHARP_PATTERNS,
  PHP_PATTERNS,
  RUBY_PATTERNS,
  DART_PATTERNS,
  ELIXIR_PATTERNS,
  LUA_PATTERNS,
  SQL_PATTERNS,
  SCALA_PATTERNS,
  HASKELL_PATTERNS,
  ZIG_PATTERNS,
  FRAMEWORK_PATTERNS,
  UNIVERSAL_PATTERNS,
  CRYPTO_PATTERNS,
  INJECTION_PATTERNS,
  DESERIALIZE_PATTERNS,
  FLIGHT_SOFTWARE_PATTERNS,
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
];

/** Return all patterns applicable to the given language. */
export function getPatternsForLanguage(lang: string): BugPattern[] {
  return ALL_PATTERNS.filter((p) => p.languages.includes(lang as never));
}

/** Look up a pattern by ID. */
export function getPatternById(id: string): BugPattern | undefined {
  return ALL_PATTERNS.find((p) => p.id === id);
}

/** All patterns across all languages. */
export function getAllPatterns(): BugPattern[] {
  return [...ALL_PATTERNS];
}
