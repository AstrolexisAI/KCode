// KCode - KOTLIN Bug Patterns
// Extracted from the monolithic patterns.ts. See that file for the
// ALL_PATTERNS aggregator and lookup helpers.

import type { BugPattern } from "../types";

export const KOTLIN_PATTERNS: BugPattern[] = [
  {
    id: "kt-001-force-unwrap",
    title: "Non-null assertion (!!) on nullable type",
    severity: "medium",
    languages: ["kotlin"],
    regex: /\w+!!\./g,
    explanation:
      "!! throws NullPointerException if the value is null. Use safe calls (?.) or elvis (?:) instead.",
    verify_prompt:
      "Is this !! in production code where null is possible? If guaranteed non-null by contract, respond FALSE_POSITIVE.",
    cwe: "CWE-476",
    fix_template: "Replace val!! with val?.method() ?: fallback, or guard with if (val != null).",
  },
  {
    id: "kt-002-sql-injection",
    title: "SQL query with string template",
    severity: "critical",
    languages: ["kotlin"],
    regex: /\b(?:rawQuery|execSQL|query)\s*\(\s*["$]/g,
    explanation: "SQL queries with Kotlin string templates ($var) are vulnerable to injection.",
    verify_prompt: "Is user input interpolated? If parameterized with ?, respond FALSE_POSITIVE.",
    cwe: "CWE-89",
    fix_template: "Use parameterized queries with ? placeholders and selectionArgs array.",
  },

  // ── Not-null assertion in production ───────────────────────────
  {
    id: "kt-003-double-bang-production",
    title: "!! (not-null assertion) in production code path",
    severity: "medium",
    languages: ["kotlin"],
    regex: /\w+!!\s*(?:\.|$)/gm,
    explanation:
      "The !! operator throws KotlinNullPointerException if the value is null. In production code this causes crashes that safe calls (?.) or elvis (?:) would handle gracefully.",
    verify_prompt:
      "Is this !! in production code or in test/example code? " +
      "If the value is guaranteed non-null by language contract (e.g., after a null check, inside a let block), respond FALSE_POSITIVE. " +
      "If it could be null at runtime, respond CONFIRMED.",
    cwe: "CWE-476",
    fix_template:
      'Replace x!! with x?.method() ?: fallback, or guard with requireNotNull(x) { "message" }.',
  },

  // ── lateinit never initialized ─────────────────────────────────
  {
    id: "kt-004-lateinit-uninit",
    title: "lateinit var used without initialization guarantee",
    severity: "high",
    languages: ["kotlin"],
    regex: /lateinit\s+var\s+(\w+)\s*:\s*\w+/g,
    explanation:
      "lateinit var throws UninitializedPropertyAccessException if accessed before initialization. Unlike lazy, there's no compiler guarantee it will be initialized.",
    verify_prompt:
      "Is this lateinit var initialized in a guaranteed lifecycle method (onCreate, setUp, @Before, init block, dependency injection)? " +
      "If initialization is guaranteed before access, respond FALSE_POSITIVE. " +
      "If it could be accessed before initialization (e.g., in a callback, optional path), respond CONFIRMED.",
    cwe: "CWE-457",
    fix_template: "Use val with lazy { }, or nullable var with null check, or by inject() for DI.",
  },

  // ── Coroutine leak ─────────────────────────────────────────────
  {
    id: "kt-005-coroutine-leak",
    title: "Coroutine launch without structured concurrency",
    severity: "medium",
    languages: ["kotlin"],
    regex: /GlobalScope\s*\.\s*launch\b/g,
    explanation:
      "GlobalScope.launch creates coroutines that outlive their parent scope. If the parent is destroyed (Activity, ViewModel), the coroutine keeps running — leaking memory and potentially crashing.",
    verify_prompt:
      "Is GlobalScope used intentionally for application-lifetime work (e.g., singleton initialization, daemon task)? " +
      "If it's in a component with a lifecycle (Activity, Fragment, ViewModel), respond CONFIRMED. " +
      "If it's truly application-scoped, respond FALSE_POSITIVE.",
    cwe: "CWE-772",
    fix_template:
      "Use viewModelScope, lifecycleScope, or a custom CoroutineScope tied to the component's lifecycle.",
  },

  // ── Blocking call in coroutine ─────────────────────────────────
  {
    id: "kt-006-blocking-in-coroutine",
    title: "Blocking call inside coroutine scope",
    severity: "high",
    languages: ["kotlin"],
    regex:
      /(?:suspend\s+fun|launch\s*\{|async\s*\{)[\s\S]{0,300}?\b(?:Thread\.sleep|\.join\(\)|\.get\(\)|\.await\(\))\b/g,
    explanation:
      "Calling Thread.sleep(), Future.get(), or other blocking calls inside a coroutine blocks the dispatcher thread, defeating the purpose of coroutines and potentially freezing the UI or exhausting the thread pool.",
    verify_prompt:
      "Is this blocking call wrapped in withContext(Dispatchers.IO)? " +
      "If dispatched to IO, respond FALSE_POSITIVE. " +
      "If blocking on Main or Default dispatcher, respond CONFIRMED.",
    cwe: "CWE-400",
    fix_template:
      "Use delay() instead of Thread.sleep(), or wrap in withContext(Dispatchers.IO) { }.",
  },

  // ── Platform type null crash ───────────────────────────────────
  {
    id: "kt-007-platform-type-null",
    title: "Java interop return used without null check (platform type)",
    severity: "medium",
    languages: ["kotlin"],
    regex: /\b(?:Java\w+|java\w+)\s*\.\s*\w+\s*\([^)]*\)\s*\.\s*\w+/g,
    explanation:
      "Java methods return platform types (T!) in Kotlin. The compiler doesn't enforce null checks, but the Java method may return null, causing NullPointerException.",
    verify_prompt:
      "Is the Java method annotated with @Nullable/@NonNull? " +
      "If @NonNull or the method contract guarantees non-null, respond FALSE_POSITIVE. " +
      "If the Java method can return null and no safe call (?.) is used, respond CONFIRMED.",
    cwe: "CWE-476",
    fix_template:
      "Use safe call: javaObj.method()?.property, or declare the type as nullable: val x: String? = javaObj.method().",
  },

  // ── Mutable collection exposed ─────────────────────────────────
  {
    id: "kt-008-mutable-collection-exposed",
    title: "Mutable collection returned directly from function/property",
    severity: "low",
    languages: ["kotlin"],
    regex:
      /(?:fun\s+\w+\s*\([^)]*\)\s*(?::\s*(?:Mutable)?List|:\s*(?:Mutable)?Map|:\s*(?:Mutable)?Set)[\s\S]{0,100}?return\s+\w+|get\(\)\s*=\s*(?:_\w+|mutable\w+))/g,
    explanation:
      "Returning a mutable collection directly allows callers to modify the internal state of the class, breaking encapsulation. This can lead to unexpected behavior and bugs.",
    verify_prompt:
      "Does the function/property return a mutable collection directly? " +
      "If it returns .toList(), .toMap(), Collections.unmodifiable*(), or the return type is immutable (List, not MutableList), respond FALSE_POSITIVE. " +
      "If the internal mutable collection is exposed, respond CONFIRMED.",
    cwe: "CWE-495",
    fix_template:
      "Return a defensive copy: return _items.toList(), or use a read-only return type.",
  },

  // ── Hardcoded secrets in Kotlin ────────────────────────────────
  {
    id: "kt-009-hardcoded-secrets",
    title: "Hardcoded password, secret, or API key in Kotlin",
    severity: "high",
    languages: ["kotlin"],
    regex: /(?:password|secret|apiKey|api_key|token|credential|authToken)\s*=\s*"[^"]{8,}"/gi,
    explanation:
      "Hardcoded secrets in Kotlin source code are compiled into bytecode where strings are trivially extractable.",
    verify_prompt:
      'Is this a REAL secret or a placeholder/test value ("changeme", "test123", "TODO")? ' +
      "If it looks like a real credential, respond CONFIRMED. If test/placeholder, respond FALSE_POSITIVE.",
    cwe: "CWE-798",
    fix_template:
      "Use BuildConfig fields, environment variables, or Android Keystore/EncryptedSharedPreferences.",
  },

  // ── SQL injection in Kotlin ────────────────────────────────────
  {
    id: "kt-010-sql-template-injection",
    title: "SQL query with string template interpolation",
    severity: "critical",
    languages: ["kotlin"],
    regex: /\b(?:query|execute|rawQuery|execSQL)\s*\(\s*"[^"]*\$\{?[a-zA-Z]/g,
    explanation:
      "SQL queries using Kotlin string templates ($var or ${expr}) are vulnerable to SQL injection when user input is interpolated.",
    verify_prompt:
      "Is user input interpolated into the SQL string via $ or ${}? " +
      "If using parameterized queries with ? and selectionArgs, respond FALSE_POSITIVE. " +
      "If user-controlled values are template-interpolated, respond CONFIRMED.",
    cwe: "CWE-89",
    fix_template:
      'Use parameterized queries: db.rawQuery("SELECT * FROM t WHERE id = ?", arrayOf(userId)).',
  },

  // ── runBlocking on main thread ─────────────────────────────────
  {
    id: "kt-011-runblocking-main",
    title: "runBlocking on main/UI thread",
    severity: "high",
    languages: ["kotlin"],
    regex: /\brunBlocking\s*(?:\(\s*(?:Dispatchers\.Main)?\s*\))?\s*\{/g,
    explanation:
      "runBlocking blocks the current thread until the coroutine completes. On the main/UI thread, this freezes the application and can trigger ANR (Application Not Responding).",
    verify_prompt:
      "Is this runBlocking called on the main/UI thread (e.g., in an Activity, Fragment, or Composable function)? " +
      "If it's in a background thread, test code, or main() function of a CLI app, respond FALSE_POSITIVE. " +
      "If it's on the UI thread, respond CONFIRMED.",
    cwe: "CWE-400",
    fix_template: "Use lifecycleScope.launch or viewModelScope.launch instead of runBlocking.",
  },

  // ── GlobalScope usage ──────────────────────────────────────────
  {
    id: "kt-012-globalscope",
    title: "GlobalScope usage (unstructured concurrency)",
    severity: "medium",
    languages: ["kotlin"],
    regex: /\bGlobalScope\s*\.\s*(?:launch|async)\b/g,
    explanation:
      "GlobalScope creates coroutines with application-wide lifetime that are not cancelled when the calling component is destroyed. This leads to resource leaks and potential crashes.",
    verify_prompt:
      "Is GlobalScope used for a truly application-lifetime task (e.g., singleton background work, process-level daemon)? " +
      "If it's in a component with a shorter lifecycle (Activity, ViewModel, request handler), respond CONFIRMED. " +
      "If genuinely application-scoped, respond FALSE_POSITIVE.",
    cwe: "CWE-772",
    fix_template:
      "Use a CoroutineScope tied to the component lifecycle: viewModelScope, lifecycleScope, or custom scope with SupervisorJob().",
  },
];
