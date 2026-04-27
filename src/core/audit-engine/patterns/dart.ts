// KCode - DART Bug Patterns
// Extracted from the monolithic patterns.ts. See that file for the
// ALL_PATTERNS aggregator and lookup helpers.

import type { BugPattern } from "../types";

export const DART_PATTERNS: BugPattern[] = [
  {
    id: "dart-001-insecure-http",
    title: "HTTP (not HTTPS) URL in production",
    severity: "high",
    languages: ["dart"],
    regex: /Uri\.parse\s*\(\s*['"]http:\/\/(?!localhost|127\.0\.0\.1|10\.)/g,
    explanation: "Using HTTP exposes data to MITM attacks. Use HTTPS in production.",
    verify_prompt: "Is this a dev/local URL or production? If dev, respond FALSE_POSITIVE.",
    cwe: "CWE-319",
    fix_template: "Change http:// to https://.",
  },
  {
    id: "dart-002-hardcoded-key",
    title: "Hardcoded API key in Dart",
    severity: "high",
    languages: ["dart"],
    regex: /(?:apiKey|secretKey|password|token)\s*[:=]\s*['"][A-Za-z0-9+/=_-]{16,}['"]/g,
    explanation:
      "Hardcoded secrets in Dart/Flutter apps can be extracted from the compiled binary.",
    verify_prompt:
      "Is this a real key or placeholder? If real, respond CONFIRMED." +
      "\n\nRespond FALSE_POSITIVE if ANY of these is true:\n" +
      "1. The value is a placeholder ('changeme', 'xxx', 'your-api-key-here', 'TODO', 'REPLACE_ME', 'test')\n" +
      "2. This is in test, example, or documentation code\n" +
      "3. The value is loaded from environment, dart-define, or a secrets manager at runtime\n" +
      "4. The value is a well-known public identifier (not a secret)\n" +
      "Only respond CONFIRMED if the value appears to be a real secret committed to source code in production code.",
    cwe: "CWE-798",
    fix_template: "Use --dart-define=API_KEY=xxx or flutter_dotenv package.",
  },
  {
    id: "dart-003-force-unwrap",
    title: "Force unwrap (!) on nullable type (runtime crash)",
    severity: "medium",
    languages: ["dart"],
    regex: /\b\w+!\s*\.\s*\w+/g,
    explanation:
      "The null assertion operator (!) throws a runtime exception if the value is null. In production Flutter apps, this crashes the entire widget tree.",
    verify_prompt:
      "Is this force unwrap on a value that could realistically be null at runtime? " +
      "If the value is guaranteed non-null by a preceding null check or assert, respond FALSE_POSITIVE. " +
      "If it's on data from JSON parsing, API response, or user input, respond CONFIRMED.",
    cwe: "CWE-476",
    fix_template:
      "Use null-aware operators: value?.property ?? defaultValue, or guard with if (value != null).",
  },
  {
    id: "dart-004-dart-mirrors",
    title: "dart:mirrors in production (breaks tree shaking)",
    severity: "medium",
    languages: ["dart"],
    regex: /import\s+['"]dart:mirrors['"]/g,
    explanation:
      "dart:mirrors disables tree shaking, dramatically increasing app size. It's also unavailable in Flutter and AOT-compiled code, causing runtime failures.",
    verify_prompt:
      "Is this import in production code or test/tooling code? " +
      "If in test helpers or build scripts, respond FALSE_POSITIVE. " +
      "If in production/library code, respond CONFIRMED.",
    cwe: "CWE-400",
    fix_template: "Use code generation (build_runner, json_serializable) instead of dart:mirrors.",
  },
  {
    id: "dart-005-setstate-after-dispose",
    title: "setState after dispose (Flutter memory leak)",
    severity: "high",
    languages: ["dart"],
    regex: /(?:await\s+\w[\w.]*\([^)]*\)|\.then\s*\()[^}]*setState\s*\(/g,
    explanation:
      "Calling setState() after an async operation without checking mounted/disposed state causes 'setState() called after dispose()' error and memory leaks.",
    verify_prompt:
      "Is there a `if (!mounted) return;` or `if (disposed) return;` check before this setState? " +
      "If mounted check exists, respond FALSE_POSITIVE. " +
      "If setState is called after await without mounted check, respond CONFIRMED.",
    cwe: "CWE-672",
    fix_template: "Add guard: if (!mounted) return; before setState() after any async gap.",
  },
  {
    id: "dart-006-future-no-error",
    title: "Future without error handling",
    severity: "medium",
    languages: ["dart"],
    regex:
      /\bFuture\s*\.\s*(?:delayed|wait|forEach)\s*\([^)]*\)(?!\s*\.\s*(?:catchError|onError|then\([^)]*,[^)]*onError))/g,
    explanation:
      "Futures without error handling silently swallow exceptions. Unhandled errors in Flutter can crash the app or leave it in an inconsistent state.",
    verify_prompt:
      "Is this Future wrapped in a try/catch block, or does it have .catchError()/.onError()? " +
      "If error handling exists (try/catch, catchError, runZonedGuarded), respond FALSE_POSITIVE. " +
      "If no error handling, respond CONFIRMED.",
    cwe: "CWE-754",
    fix_template: "Add .catchError((e) => handleError(e)), or wrap in try/catch with await.",
  },
  {
    id: "dart-007-json-null-check",
    title: "Missing null check on JSON map access",
    severity: "medium",
    languages: ["dart"],
    regex: /\bjson\s*\[\s*['"][^'"]+['"]\s*\]\s*(?:as\s+\w+|\.toString\(\)|\.length)/g,
    explanation:
      "Accessing JSON map values without null check throws NoSuchMethodError at runtime if the key is missing. API responses often have missing fields.",
    verify_prompt:
      "Is the JSON key guaranteed to exist (required field, validated schema)? " +
      "If the key is optional or from an external API, respond CONFIRMED. " +
      "If the JSON structure is validated beforehand, respond FALSE_POSITIVE.",
    cwe: "CWE-476",
    fix_template:
      "Use null-safe access: (json['key'] as String?) ?? 'default', or use json_serializable.",
  },
  {
    id: "dart-008-buildcontext-async",
    title: "BuildContext used after async gap",
    severity: "high",
    languages: ["dart"],
    regex:
      /await\s+\w[\w.]*\([^)]*\)\s*;[\s\S]{0,100}?\b(?:Navigator|ScaffoldMessenger|Theme|MediaQuery|showDialog)\s*\.\s*of\s*\(\s*context/g,
    explanation:
      "Using BuildContext after an async gap (await) is unsafe because the widget may have been unmounted. The context may point to a disposed element tree.",
    verify_prompt:
      "Is there a `if (!mounted) return;` or `if (!context.mounted) return;` check between the await and the context usage? " +
      "If mounted check exists, respond FALSE_POSITIVE. " +
      "If context is used directly after await without checking, respond CONFIRMED.",
    cwe: "CWE-672",
    fix_template:
      "Add: if (!mounted) return; // or if (!context.mounted) return; before using context after await.",
  },
  {
    id: "dart-009-http-no-https",
    title: "http.get/post without HTTPS enforcement",
    severity: "high",
    languages: ["dart"],
    regex:
      /\bhttp\.(?:get|post|put|delete|patch)\s*\(\s*(?:Uri\.parse\s*\(\s*)?['"]http:\/\/(?!localhost|127\.0\.0\.1)/g,
    explanation:
      "Making HTTP requests over plaintext HTTP exposes request/response data (including auth tokens, user data) to network attackers.",
    verify_prompt:
      "Is this HTTP call to a local/development server or a production endpoint? " +
      "If localhost or dev environment, respond FALSE_POSITIVE. " +
      "If production traffic over HTTP, respond CONFIRMED.",
    cwe: "CWE-319",
    fix_template: "Change http:// to https:// for all production endpoints.",
  },
  {
    id: "dart-010-string-hardcoded-secret",
    title: "Hardcoded secret string in Dart/Flutter",
    severity: "high",
    languages: ["dart"],
    regex:
      /(?:const|final)\s+\w*(?:secret|key|password|token|auth)\w*\s*=\s*['"][A-Za-z0-9+/=_-]{16,}['"]/gi,
    explanation:
      "Constants containing secrets are compiled into the Dart binary and can be extracted with string analysis tools.",
    verify_prompt:
      "Is this a real secret/API key or a placeholder/test value? " +
      "If it's 'test_key', 'changeme', or clearly a placeholder, respond FALSE_POSITIVE. " +
      "If it looks like a real credential, respond CONFIRMED.",
    cwe: "CWE-798",
    fix_template: "Use String.fromEnvironment('API_KEY') with --dart-define, or flutter_dotenv.",
  },
];
