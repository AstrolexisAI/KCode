// KCode - HASKELL Bug Patterns
// Extracted from the monolithic patterns.ts. See that file for the
// ALL_PATTERNS aggregator and lookup helpers.

import type { BugPattern } from "../types";

export const HASKELL_PATTERNS: BugPattern[] = [
  {
    id: "hs-001-head-empty-list",
    title: "head on potentially empty list (partial function)",
    severity: "high",
    languages: ["haskell"],
    regex: /\bhead\s+(?!\$\s*(?:filter|map|take|drop|sort)\b)/g,
    explanation:
      "head is a partial function that throws an exception on an empty list. In production Haskell code, calling head on a potentially empty list causes a runtime crash with 'Prelude.head: empty list'.",
    verify_prompt:
      "Is this head call guaranteed to receive a non-empty list? If there's a " +
      "pattern match or null/length check before it, or if the list is known non-empty " +
      "(e.g., NonEmpty type), respond FALSE_POSITIVE. If the list could be empty, respond CONFIRMED.",
    cwe: "CWE-754",
    fix_template: "Use pattern matching: case xs of (x:_) -> x; [] -> defaultValue, or use Data.List.NonEmpty, or listToMaybe.",
  },
  {
    id: "hs-002-fromjust",
    title: "fromJust on potentially Nothing (partial function)",
    severity: "high",
    languages: ["haskell"],
    regex: /\bfromJust\b/g,
    explanation:
      "fromJust is a partial function that throws an exception on Nothing. It defeats the purpose of Maybe by converting a type-safe optional into a runtime crash.",
    verify_prompt:
      "Is fromJust used on a value that is GUARANTEED to be Just? If the Maybe was " +
      "just constructed as Just x, or if isJust was checked immediately before, respond " +
      "FALSE_POSITIVE. If the Maybe comes from a lookup, parse, or external source, respond CONFIRMED.",
    cwe: "CWE-754",
    fix_template: "Use fromMaybe defaultValue x, or pattern match: case mx of Just x -> f x; Nothing -> handleMissing.",
  },
  {
    id: "hs-003-read-no-error",
    title: "read without error handling (partial function)",
    severity: "medium",
    languages: ["haskell"],
    regex: /\bread\s+(?:"|line|input|str|arg|s\b)/g,
    explanation:
      "read is a partial function that throws an exception if the string cannot be parsed. On user input or external data, this causes a runtime crash instead of graceful error handling.",
    verify_prompt:
      "Is read applied to user input or external data? If the string is a known-good " +
      "constant or the result of show, respond FALSE_POSITIVE. If it parses user input, " +
      "file content, or network data, respond CONFIRMED.",
    cwe: "CWE-754",
    fix_template: "Use readMaybe from Text.Read: case readMaybe str of Just n -> use n; Nothing -> handleError.",
  },
  {
    id: "hs-004-unsafe-perform-io",
    title: "unsafePerformIO usage (breaks referential transparency)",
    severity: "high",
    languages: ["haskell"],
    regex: /\bunsafePerformIO\b/g,
    explanation:
      "unsafePerformIO breaks Haskell's purity guarantees and referential transparency. It can cause unpredictable behavior: results may be cached, reordered, or duplicated by the compiler. Only acceptable for top-level FFI bindings or global IORef initialization.",
    verify_prompt:
      "Is this unsafePerformIO used for a well-known safe pattern (top-level global " +
      "IORef/MVar initialization, FFI binding, NOINLINE-annotated constant)? If it " +
      "follows the established safe patterns with NOINLINE pragma, respond FALSE_POSITIVE. " +
      "If used for side effects in pure code, respond CONFIRMED.",
    cwe: "CWE-758",
    fix_template: "Keep the computation in IO monad, or use unsafePerformIO only with {-# NOINLINE #-} for top-level refs.",
  },
  {
    id: "hs-005-space-leak",
    title: "Space leak: lazy accumulator without bang pattern",
    severity: "medium",
    languages: ["haskell"],
    regex: /\bfoldl\s+(?!\')(?!Data\.List\.Strict)/g,
    explanation:
      "foldl (without the strict variant foldl') builds up thunks proportional to the input size, causing O(n) memory usage instead of O(1). This is one of the most common Haskell performance bugs.",
    verify_prompt:
      "Is this foldl used on a potentially large list? If the list is known-small " +
      "(< 100 elements), respond FALSE_POSITIVE. If it processes a file, stream, " +
      "or unbounded input, respond CONFIRMED. Also FALSE_POSITIVE if the accumulator " +
      "is already strict by type (e.g., Int# or strict data type).",
    cwe: "CWE-400",
    fix_template: "Use Data.List.foldl' (strict left fold) instead of foldl.",
  },
  {
    id: "hs-006-missing-show-error",
    title: "Missing deriving (Show) for error types",
    severity: "low",
    languages: ["haskell"],
    regex: /data\s+\w*(?:Error|Exception|Err)\b(?![\s\S]{0,200}?deriving[\s\S]{0,50}?Show)/g,
    explanation:
      "Error types without a Show instance cannot be printed in error messages, making debugging extremely difficult. Exception types also require Show for the Exception typeclass.",
    verify_prompt:
      "Does this error/exception data type derive or have an instance for Show? " +
      "Check both deriving clauses and standalone deriving/instance declarations. " +
      "If Show is provided, respond FALSE_POSITIVE. If missing, respond CONFIRMED.",
    cwe: "CWE-755",
    fix_template: "Add deriving (Show) to the data type, or write a custom Show instance.",
  },
  {
    id: "hs-007-error-control-flow",
    title: "error used for control flow (partial function)",
    severity: "medium",
    languages: ["haskell"],
    regex: /\berror\s+"[^"]+"/g,
    explanation:
      "Using error for control flow creates a partial function that crashes at runtime with an uncatchable exception (in pure code). Use Either, Maybe, or MonadError for recoverable failures.",
    verify_prompt:
      "Is this error call in a code path that should NEVER be reached (genuine " +
      "impossible state), or is it handling a recoverable condition? If it's a truly " +
      "impossible case (e.g., exhaustive pattern match that GHC can't prove), respond " +
      "FALSE_POSITIVE. If it handles user input or recoverable failures, respond CONFIRMED.",
    cwe: "CWE-754",
    fix_template: "Return Either ErrorType ResultType or use throwError from MonadError for recoverable failures.",
  },
  {
    id: "hs-008-string-type",
    title: "String type used instead of Text (performance)",
    severity: "low",
    languages: ["haskell"],
    regex: /\b(?:::?\s*(?:\[Char\]|String)\b|::\s*\w+\s*->\s*String\b|String\s*->)/g,
    explanation:
      "Haskell's String type is a linked list of characters ([Char]), using ~24 bytes per character. For any non-trivial text processing, Data.Text is orders of magnitude faster and uses less memory.",
    verify_prompt:
      "Is this String type in a performance-sensitive context (parsing, network I/O, " +
      "file processing, large text manipulation)? If it's a small internal label, " +
      "error message, or test code, respond FALSE_POSITIVE. If it processes real data, respond CONFIRMED.",
    cwe: "CWE-400",
    fix_template: "Use Data.Text instead of String: import qualified Data.Text as T; and replace String with T.Text.",
  },
];
