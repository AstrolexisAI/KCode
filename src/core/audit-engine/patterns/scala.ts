// KCode - SCALA Bug Patterns
// Extracted from the monolithic patterns.ts. See that file for the
// ALL_PATTERNS aggregator and lookup helpers.

import type { BugPattern } from "../types";

export const SCALA_PATTERNS: BugPattern[] = [
  {
    id: "scala-001-sql-injection",
    title: "SQL with string interpolation",
    severity: "critical",
    languages: ["scala"],
    regex: /\b(?:sql|SQL)\s*"""[^"]*\$\{/g,
    explanation: "Scala SQL string interpolation with ${} is vulnerable to injection.",
    verify_prompt: "Is user input interpolated? If using #$param (Slick) or ? placeholders, respond FALSE_POSITIVE.",
    cwe: "CWE-89",
    fix_template: "Use parameterized queries: sql\"SELECT * FROM t WHERE id = $id\" (Slick's safe interpolation).",
  },

  // ── Option.get ─────────────────────────────────────────────────
  {
    id: "scala-002-option-get",
    title: ".get on Option (throws NoSuchElementException)",
    severity: "high",
    languages: ["scala"],
    regex: /\b\w+\s*\.\s*get\b(?!\s*\()/g,
    explanation:
      "Calling .get on an Option throws NoSuchElementException if the Option is None. This defeats the purpose of using Option for null safety.",
    verify_prompt:
      "Is .get called on an Option type? " +
      "If it's called on a Map (map.get(key) returns Option — that's fine) or the Option is guaranteed Some by prior pattern match/isDefined check, respond FALSE_POSITIVE. " +
      "If .get is called on an Option without checking, respond CONFIRMED.",
    cwe: "CWE-476",
    fix_template: "Use .getOrElse(default), pattern matching, .map/.flatMap, or .fold(ifEmpty)(ifPresent).",
  },

  // ── Blocking in Future ─────────────────────────────────────────
  {
    id: "scala-003-blocking-future",
    title: "Blocking call inside Future (thread pool starvation)",
    severity: "high",
    languages: ["scala"],
    regex: /Future\s*\{[\s\S]{0,300}?\b(?:Thread\.sleep|Await\.result|\.get\b|synchronized)\b/g,
    explanation:
      "Blocking calls (Thread.sleep, Await.result, synchronized) inside a Future block the execution context thread, potentially starving the thread pool and causing deadlocks.",
    verify_prompt:
      "Is this Future using a dedicated blocking execution context (e.g., ExecutionContext.fromExecutor, blocking { })? " +
      "If using scala.concurrent.blocking or a dedicated pool, respond FALSE_POSITIVE. " +
      "If blocking on the default execution context, respond CONFIRMED.",
    cwe: "CWE-400",
    fix_template: "Wrap blocking code in scala.concurrent.blocking { }, or use a separate ExecutionContext for blocking I/O.",
  },

  // ── Mutable variable in concurrent context ─────────────────────
  {
    id: "scala-004-mutable-concurrent",
    title: "var used in concurrent/shared context",
    severity: "medium",
    languages: ["scala"],
    regex: /\bvar\s+\w+\s*(?::\s*\w+)?\s*=[\s\S]{0,300}?\b(?:Future|Actor|Thread|Runnable|Executor|parallel)\b/g,
    explanation:
      "Mutable variables (var) shared across concurrent contexts (Futures, Actors, threads) cause race conditions. Scala idiom prefers immutable values.",
    verify_prompt:
      "Is this var accessed from multiple concurrent contexts (Futures, Actors, threads)? " +
      "If it's local to a single-threaded scope or protected by synchronization/AtomicReference, respond FALSE_POSITIVE. " +
      "If shared without protection, respond CONFIRMED.",
    cwe: "CWE-362",
    fix_template: "Use val with AtomicReference, Ref (Cats Effect), or Actor message passing instead of shared var.",
  },

  // ── Non-exhaustive pattern match ───────────────────────────────
  {
    id: "scala-005-nonexhaustive-match",
    title: "Pattern match potentially non-exhaustive (missing case)",
    severity: "medium",
    languages: ["scala"],
    regex: /\bmatch\s*\{(?:(?!\bcase\s+_\s*=>)[\s\S])*?\}/g,
    explanation:
      "A pattern match without a wildcard case (_) or covering all sealed trait members throws MatchError at runtime for unhandled cases.",
    verify_prompt:
      "Does this match expression cover ALL cases of a sealed trait/enum, or include a wildcard (case _ =>) catch-all? " +
      "If exhaustive or has a wildcard, respond FALSE_POSITIVE. " +
      "If cases could be missed at runtime, respond CONFIRMED.",
    cwe: "CWE-754",
    fix_template: "Add a catch-all case: case _ => handleDefault(), or cover all sealed subtypes.",
  },

  // ── Implicit conversion confusion ──────────────────────────────
  {
    id: "scala-006-implicit-conversion",
    title: "Implicit conversion may cause unexpected behavior",
    severity: "low",
    languages: ["scala"],
    regex: /\bimplicit\s+def\s+\w+\s*\([^)]+\)\s*:\s*\w+/g,
    explanation:
      "Implicit conversions silently convert types, making code harder to reason about and introducing subtle bugs when the wrong conversion is applied.",
    verify_prompt:
      "Is this implicit conversion well-documented and narrowly scoped (e.g., value class wrapper, DSL builder)? " +
      "If it's a broad type-to-type conversion (e.g., String to Int, or between unrelated domain types), respond CONFIRMED. " +
      "If narrowly scoped and intentional, respond FALSE_POSITIVE.",
    cwe: "CWE-704",
    fix_template: "Use extension methods (Scala 3) or explicit conversion methods instead of implicit def.",
  },

  // ── Try.get without handling Failure ────────────────────────────
  {
    id: "scala-007-try-get",
    title: "Try.get without handling Failure case",
    severity: "high",
    languages: ["scala"],
    regex: /\bTry\s*[\[({][\s\S]{0,200}?\.get\b/g,
    explanation:
      "Calling .get on a Try throws the contained exception if it's a Failure. This defeats Try's purpose of safe error handling.",
    verify_prompt:
      "Is .get called on a Try without prior isSuccess check or pattern matching? " +
      "If the Try is matched/checked before .get, respond FALSE_POSITIVE. " +
      "If .get is called unconditionally, respond CONFIRMED.",
    cwe: "CWE-755",
    fix_template: "Use .getOrElse(default), .recover { case e => fallback }, .toOption, or pattern matching.",
  },

  // ── Akka unhandled message ─────────────────────────────────────
  {
    id: "scala-008-akka-unhandled",
    title: "Akka Actor receive without catch-all (unhandled messages)",
    severity: "medium",
    languages: ["scala"],
    regex: /\bdef\s+receive\s*(?::\s*Receive)?\s*=\s*\{(?:(?!\bcase\s+_\s*=>)[\s\S])*?\}/g,
    explanation:
      "An Akka Actor's receive block without a catch-all case drops unhandled messages silently (published to eventStream as UnhandledMessage). This makes debugging difficult.",
    verify_prompt:
      "Does the receive block include a catch-all case (case _ => or case msg => unhandled(msg))? " +
      "If a catch-all exists, respond FALSE_POSITIVE. " +
      "If messages could be silently dropped, respond CONFIRMED.",
    cwe: "CWE-754",
    fix_template: "Add catch-all: case msg => log.warning(s\"Unhandled message: $msg\"); unhandled(msg)",
  },

  // ── SQL injection in Slick/Doobie ──────────────────────────────
  {
    id: "scala-009-sql-string-concat",
    title: "SQL injection via string concatenation in Slick/Doobie",
    severity: "critical",
    languages: ["scala"],
    regex: /\b(?:sql|fr|fr0|query)\s*(?:"""|\()\s*[^)]*\+\s*\w+/g,
    explanation:
      "Concatenating variables into SQL strings in Slick or Doobie bypasses the safe interpolation. Use the framework's built-in interpolation which auto-parameterizes.",
    verify_prompt:
      "Is the SQL string built with + concatenation including user input? " +
      "If using Slick's sql\"...${param}\" or Doobie's fr\"...${param}\" (which auto-parameterize), respond FALSE_POSITIVE. " +
      "If string concatenation is used, respond CONFIRMED.",
    cwe: "CWE-89",
    fix_template: "Use framework interpolation: sql\"SELECT * FROM t WHERE id = ${userId}\" (Slick auto-parameterizes).",
  },

  // ── Null usage in Scala ────────────────────────────────────────
  {
    id: "scala-010-null-usage",
    title: "null usage (anti-pattern in Scala)",
    severity: "low",
    languages: ["scala"],
    regex: /(?:\b\w+\s*(?:==|!=)\s*null\b|\b(?:val|var)\s+\w+\s*(?::\s*\w+)?\s*=\s*null\b|\breturn\s+null\b)/g,
    explanation:
      "Using null in Scala is an anti-pattern. Scala provides Option, Try, and Either for representing absence or failure. Null breaks type safety and leads to NullPointerException.",
    verify_prompt:
      "Is null used for Java interop (calling/implementing Java APIs that require null)? " +
      "If required for Java interop, respond FALSE_POSITIVE. " +
      "If null is used in pure Scala code where Option/Try/Either would be appropriate, respond CONFIRMED.",
    cwe: "CWE-476",
    fix_template: "Use Option(value) instead of null checks, None instead of null, and .map/.getOrElse for transformations.",
  },
];
