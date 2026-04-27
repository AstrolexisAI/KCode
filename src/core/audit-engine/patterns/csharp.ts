// KCode - CSHARP Bug Patterns
// Extracted from the monolithic patterns.ts. See that file for the
// ALL_PATTERNS aggregator and lookup helpers.

import type { BugPattern } from "../types";

export const CSHARP_PATTERNS: BugPattern[] = [
  {
    id: "cs-001-sql-injection",
    title: "SQL query with string concatenation/interpolation",
    severity: "critical",
    languages: ["csharp"],
    regex: /\b(?:ExecuteNonQuery|ExecuteReader|ExecuteScalar|SqlCommand)\s*\(\s*(?:\$"|".*\+)/g,
    explanation:
      'SQL queries with string interpolation ($"") or concatenation are vulnerable to injection.',
    verify_prompt:
      "Is user input interpolated? If using SqlParameter/@param, respond FALSE_POSITIVE.",
    cwe: "CWE-89",
    fix_template: 'Use SqlCommand with Parameters.AddWithValue("@id", userId).',
  },
  {
    id: "cs-002-deserialization",
    title: "Unsafe deserialization (BinaryFormatter)",
    severity: "critical",
    languages: ["csharp"],
    regex: /\bBinaryFormatter\s*\(\s*\)|\.Deserialize\s*\(/g,
    explanation:
      "BinaryFormatter deserializes arbitrary .NET objects. Microsoft marks it as dangerous — attackers can execute code via crafted payloads.",
    verify_prompt:
      "Is the deserialized data from a trusted source? If from network/user input, respond CONFIRMED." +
      "\n\nRespond FALSE_POSITIVE if ANY of these is true:\n" +
      "1. The data comes from a trusted internal source (local file written by the same app, internal service)\n" +
      "2. A type binder or whitelist restricts deserializable types\n" +
      "3. This is in test code deserializing test fixtures\n" +
      "4. The code is in a migration path being replaced with safe serialization\n" +
      "Only respond CONFIRMED if the deserialized data originates from untrusted input (network, user upload, external API) without type restrictions.",
    cwe: "CWE-502",
    fix_template: "Use System.Text.Json or JsonSerializer instead of BinaryFormatter.",
  },
  {
    id: "cs-003-hardcoded-connection",
    title: "Hardcoded connection string with credentials",
    severity: "high",
    languages: ["csharp"],
    regex: /(?:connectionString|ConnectionString)\s*=\s*"[^"]*(?:Password|Pwd|password)=[^"]+"/gi,
    explanation: "Connection strings with embedded passwords are exposed in source code.",
    verify_prompt:
      "Is this a real connection string with credentials or a placeholder? If real, respond CONFIRMED." +
      "\n\nRespond FALSE_POSITIVE if ANY of these is true:\n" +
      "1. The password is a placeholder ('changeme', 'xxx', 'password', 'TODO', 'REPLACE_ME')\n" +
      "2. This is in test, example, or documentation code\n" +
      "3. The connection string is loaded from configuration/environment at runtime\n" +
      "4. This is a local development connection (localhost with default credentials)\n" +
      "Only respond CONFIRMED if real production credentials are hardcoded in source code.",
    cwe: "CWE-798",
    fix_template: "Use appsettings.json with User Secrets or Azure Key Vault.",
  },

  // ── Async void ─────────────────────────────────────────────────
  {
    id: "cs-004-async-void",
    title: "async void method (fire-and-forget, swallows exceptions)",
    severity: "high",
    languages: ["csharp"],
    regex: /\basync\s+void\s+(?!On\w+|Handle\w+)\w+\s*\(/g,
    explanation:
      "async void methods cannot be awaited and swallow exceptions (they crash the process in non-UI contexts). Only event handlers should be async void.",
    verify_prompt:
      "Is this an event handler (OnClick, OnLoad, HandleX, Button_Click)? " +
      "If it's an event handler, respond FALSE_POSITIVE. " +
      "If it's a regular method that should return Task, respond CONFIRMED.",
    cwe: "CWE-755",
    fix_template: "Change to async Task MethodName() and await at the call site.",
  },

  // ── Task not awaited ───────────────────────────────────────────
  {
    id: "cs-005-task-not-awaited",
    title: "Task-returning method called without await",
    severity: "high",
    languages: ["csharp"],
    regex:
      /(?<!\bawait\s)(?<!\breturn\s)(?<!\bvar\s+\w+\s*=\s*)(?<!\bTask\s+\w+\s*=\s*)\b\w+Async\s*\([^)]*\)\s*;/g,
    explanation:
      "Calling an async method without await means the task runs as fire-and-forget. Exceptions are silently swallowed, and the caller proceeds before the operation completes.",
    verify_prompt:
      "Is the Task being stored in a variable, passed to Task.WhenAll, or otherwise tracked? " +
      "If the result is captured or intentionally fire-and-forget with _ = , respond FALSE_POSITIVE. " +
      "If the Task is completely discarded, respond CONFIRMED.",
    cwe: "CWE-755",
    fix_template: "Add await: await MethodAsync(); or capture: var task = MethodAsync();",
  },

  // ── IDisposable not in using ───────────────────────────────────
  {
    id: "cs-006-disposable-no-using",
    title: "IDisposable object not in using statement",
    severity: "medium",
    languages: ["csharp"],
    regex:
      /(?:new\s+(?:SqlConnection|SqlCommand|HttpClient|StreamReader|StreamWriter|FileStream|MemoryStream|BinaryReader|BinaryWriter|WebClient|TcpClient|SmtpClient)\s*\([^)]*\))(?![\s\S]{0,10}?\busing\b)/g,
    explanation:
      "IDisposable objects not wrapped in a using statement may not be properly disposed, leading to resource leaks (connections, file handles, memory).",
    verify_prompt:
      "Is this IDisposable created inside a using statement or using declaration? " +
      "If using/using var is present, respond FALSE_POSITIVE. " +
      "If the object is created without using and no Dispose() call exists, respond CONFIRMED.",
    cwe: "CWE-772",
    fix_template:
      "Wrap in using: using var conn = new SqlConnection(cs); or using (var conn = new SqlConnection(cs)) { }",
  },

  // ── SQL injection with interpolation ───────────────────────────
  {
    id: "cs-007-sql-interpolation",
    title: "SQL query with string interpolation",
    severity: "critical",
    languages: ["csharp"],
    regex: /\b(?:CommandText|SqlCommand)\s*(?:=|\()\s*\$"/g,
    explanation:
      'SQL queries built with C# string interpolation ($"") are vulnerable to injection. Use SqlParameter for user values.',
    verify_prompt:
      "Is user input interpolated in the SQL string? " +
      "If only constants/config values are interpolated (table names), respond FALSE_POSITIVE. " +
      "If user-controlled values are interpolated, respond CONFIRMED.",
    cwe: "CWE-89",
    fix_template:
      'Use parameters: cmd.Parameters.AddWithValue("@id", userId); with CommandText = "SELECT * FROM t WHERE id = @id";',
  },

  // ── LINQ multiple enumeration ──────────────────────────────────
  {
    id: "cs-008-multiple-enumeration",
    title: "IEnumerable enumerated multiple times (LINQ deferred execution)",
    severity: "low",
    languages: ["csharp"],
    regex:
      /(?:IEnumerable\s*<[^>]+>\s+(\w+)\s*=[\s\S]{0,200}?(?:Where|Select|OrderBy|GroupBy))[\s\S]{0,500}?\1\s*\.\s*\w+[\s\S]{0,200}?\1\s*\.\s*\w+/g,
    explanation:
      "An IEnumerable query is enumerated multiple times. Due to LINQ's deferred execution, each enumeration re-executes the query (database call, file read, computation), causing performance issues or inconsistent results.",
    verify_prompt:
      "Is the IEnumerable materialized (.ToList(), .ToArray()) before multiple accesses? " +
      "If materialized, respond FALSE_POSITIVE. " +
      "If the raw IEnumerable is accessed multiple times, respond CONFIRMED.",
    cwe: "CWE-400",
    fix_template:
      "Materialize the query: var items = query.ToList(); then use items multiple times.",
  },

  // ── Lock on this/typeof ────────────────────────────────────────
  {
    id: "cs-009-lock-this-typeof",
    title: "lock on `this` or `typeof()` (anti-pattern)",
    severity: "medium",
    languages: ["csharp"],
    regex: /\block\s*\(\s*(?:this|typeof\s*\([^)]+\))\s*\)/g,
    explanation:
      "Locking on `this` allows external code to lock on the same object, causing deadlocks. Locking on `typeof()` locks globally across all instances. Both are anti-patterns.",
    verify_prompt:
      "Is the lock target `this` or `typeof()`? " +
      "If locking on a private readonly object field, respond FALSE_POSITIVE. " +
      "If locking on this or typeof, respond CONFIRMED.",
    cwe: "CWE-764",
    fix_template:
      "Use a private lock object: private readonly object _lock = new object(); lock (_lock) { }",
  },

  // ── ConfigureAwait(false) missing ──────────────────────────────
  {
    id: "cs-010-configureawait-missing",
    title: "Missing ConfigureAwait(false) in library code",
    severity: "low",
    languages: ["csharp"],
    regex: /\bawait\s+\w+(?:\.\w+)*\s*\([^)]*\)\s*(?!\.ConfigureAwait)/g,
    explanation:
      "In library code, not using ConfigureAwait(false) captures the synchronization context, which can cause deadlocks when the library is called from UI threads with .Result or .Wait().",
    verify_prompt:
      "Is this code in a library/shared project (not an application entry point, controller, or UI code)? " +
      "If it's application-level code (ASP.NET controller, WPF handler), respond FALSE_POSITIVE. " +
      "If it's library code that could be called from any context, respond CONFIRMED.",
    cwe: "CWE-764",
    fix_template: "Add ConfigureAwait(false): await MethodAsync().ConfigureAwait(false);",
  },

  // ── Nullable reference without check ───────────────────────────
  {
    id: "cs-011-nullable-no-check",
    title: "Nullable reference used without null check",
    severity: "medium",
    languages: ["csharp"],
    regex: /\b(\w+)\?\s+\w+\s*=[\s\S]{0,100}?\b\1\s*\.\s*\w+(?!\s*\?)/g,
    explanation:
      "A variable declared as nullable (Type?) is accessed with . instead of ?. (null-conditional), risking NullReferenceException.",
    verify_prompt:
      "Is there a null check (if (x != null), x is not null, x?.Method()) before this access? " +
      "If null-checked or using null-conditional, respond FALSE_POSITIVE. " +
      "If accessed directly without check, respond CONFIRMED.",
    cwe: "CWE-476",
    fix_template:
      "Use null-conditional: obj?.Method() or add guard: if (obj is not null) { obj.Method(); }",
  },

  // ── Dictionary key not found ───────────────────────────────────
  {
    id: "cs-012-dictionary-key-not-found",
    title: "Dictionary[] access without TryGetValue (KeyNotFoundException risk)",
    severity: "low",
    languages: ["csharp"],
    regex: /\b(?:dictionary|dict|map|lookup|cache|index)\s*\[\s*\w+\s*\](?!\s*=)/gi,
    explanation:
      "Accessing a Dictionary with [] throws KeyNotFoundException if the key doesn't exist. Use TryGetValue or ContainsKey for safe access.",
    verify_prompt:
      "Is there a ContainsKey/TryGetValue check before this access, or is the key guaranteed to exist? " +
      "If checked or guaranteed, respond FALSE_POSITIVE. " +
      "If accessing without validation, respond CONFIRMED.",
    cwe: "CWE-754",
    fix_template:
      "Use TryGetValue: if (dict.TryGetValue(key, out var value)) { ... } or dict.GetValueOrDefault(key).",
  },
];
