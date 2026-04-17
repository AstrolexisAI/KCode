// KCode - GO Bug Patterns
// Extracted from the monolithic patterns.ts. See that file for the
// ALL_PATTERNS aggregator and lookup helpers.

import type { BugPattern } from "../types";

export const GO_PATTERNS: BugPattern[] = [
  {
    id: "go-001-sql-injection",
    title: "SQL query with string concatenation/formatting",
    severity: "critical",
    languages: ["go"],
    regex: /\b(?:db\.(?:Query|Exec|QueryRow)|tx\.(?:Query|Exec))\s*\(\s*(?:fmt\.Sprintf|.*\+)/g,
    explanation: "SQL queries built with fmt.Sprintf or string concatenation are vulnerable to injection. Use parameterized queries ($1, ?).",
    verify_prompt: "Is user input interpolated into the SQL string? If parameterized (?, $1), respond FALSE_POSITIVE.",
    cwe: "CWE-89",
    fix_template: 'db.Query("SELECT * FROM users WHERE id = $1", userID)',
  },
  {
    id: "go-002-unsafe-pointer",
    title: "unsafe.Pointer conversion (memory safety bypass)",
    severity: "high",
    languages: ["go"],
    regex: /\bunsafe\.Pointer\s*\(/g,
    explanation: "unsafe.Pointer bypasses Go's type system and memory safety guarantees. Can cause memory corruption, use-after-free, and buffer overflows.",
    verify_prompt: "Is this unsafe.Pointer usage in performance-critical code with proper bounds checking? Or is it used carelessly? If well-guarded, respond FALSE_POSITIVE.",
    cwe: "CWE-787",
    fix_template: "Avoid unsafe.Pointer where possible. Use encoding/binary for byte manipulation.",
  },
  {
    id: "go-003-command-injection",
    title: "exec.Command with user input",
    severity: "critical",
    languages: ["go"],
    regex: /\bexec\.Command\s*\(\s*(?:fmt\.Sprintf|.*\+)/g,
    explanation: "Building command strings from user input enables command injection.",
    verify_prompt: "Does the command include ANY external input? If entirely hardcoded, respond FALSE_POSITIVE.",
    cwe: "CWE-78",
    fix_template: "Pass args as separate parameters: exec.Command(binary, arg1, arg2).",
  },
  {
    id: "go-004-error-ignored",
    title: "Error return value ignored",
    severity: "medium",
    languages: ["go"],
    regex: /[^,\s]\s*:?=\s*\w+\.\w+\([^)]*\)\s*\n\s*(?!if\s+err)/g,
    explanation: "Ignoring error return values in Go can lead to silent failures, data corruption, and security bypasses.",
    verify_prompt: "Is the error from this function call being checked on the next line or within the same expression? If checked, respond FALSE_POSITIVE.",
    cwe: "CWE-252",
    fix_template: "Always check: if err != nil { return err }",
  },
  {
    id: "go-005-tls-skip-verify",
    title: "TLS InsecureSkipVerify enabled",
    severity: "high",
    languages: ["go"],
    regex: /InsecureSkipVerify\s*:\s*true/g,
    explanation: "Disabling TLS certificate verification allows man-in-the-middle attacks.",
    verify_prompt: "Is this in test code or production code? If test-only, respond FALSE_POSITIVE. If production, respond CONFIRMED.",
    cwe: "CWE-295",
    fix_template: "Remove InsecureSkipVerify: true, or use proper CA certificates.",
  },

  // ── Unchecked error return ────────────────────────────────────
  {
    id: "go-006-blank-error",
    title: "Error return assigned to blank identifier",
    severity: "medium",
    languages: ["go"],
    regex: /\w+\s*,\s*_\s*:?=\s*\w+(?:\.\w+)*\s*\([^)]*\)/g,
    explanation:
      "Assigning the error return to `_` silently discards it. The calling code continues as if the operation succeeded, leading to data corruption or silent failures.",
    verify_prompt:
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      "1. Is the function known to never return a meaningful error (e.g. bytes.Buffer.Write)? → FALSE_POSITIVE\n" +
      "2. Is this in test code or a code example? → FALSE_POSITIVE\n" +
      "3. Is there a comment explaining why the error is intentionally ignored? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if the function can fail in production AND the error is silently discarded.",
    cwe: "CWE-252",
    fix_template: "Replace `val, _ := foo()` with `val, err := foo(); if err != nil { return err }`.",
  },

  // ── Goroutine leak ────────────────────────────────────────────
  {
    id: "go-007-goroutine-leak",
    title: "Goroutine launched without context or done channel",
    severity: "medium",
    languages: ["go"],
    regex: /\bgo\s+func\s*\([^)]*\)\s*\{(?![\s\S]{0,300}?(?:ctx\.Done|<-done|<-quit|<-stop|context\.))/g,
    explanation:
      "A goroutine launched without a context.Done() or done channel has no way to be signaled to stop. If the parent exits or the goroutine blocks on I/O, it leaks forever, consuming memory and OS threads.",
    verify_prompt:
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      "1. Does the goroutine body contain a select with ctx.Done() or a done/quit channel? → FALSE_POSITIVE\n" +
      "2. Is the goroutine doing a short, bounded operation (e.g., fire-and-forget log)? → FALSE_POSITIVE\n" +
      "3. Is there a WaitGroup or errgroup ensuring the goroutine is joined? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if the goroutine runs indefinitely with no cancellation mechanism.",
    cwe: "CWE-404",
    fix_template: "Pass a context.Context and select on ctx.Done() to allow graceful shutdown.",
  },

  // ── Defer in loop ─────────────────────────────────────────────
  {
    id: "go-008-defer-in-loop",
    title: "defer inside a loop (resource accumulation)",
    severity: "medium",
    languages: ["go"],
    regex: /\bfor\b[\s\S]{0,100}?\{[\s\S]{0,300}?\bdefer\b/g,
    explanation:
      "defer inside a for loop delays cleanup until the enclosing function returns, not until the loop iteration ends. Resources (file handles, locks, connections) accumulate until the function exits, potentially exhausting limits.",
    verify_prompt:
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      "1. Is the loop body wrapped in an immediately-invoked function (func() { defer ... }())? → FALSE_POSITIVE\n" +
      "2. Is the loop guaranteed to run a small fixed number of iterations? → FALSE_POSITIVE\n" +
      "3. Is the deferred call lightweight (e.g., mutex.Unlock with no allocation)? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if the loop can run many iterations and defer accumulates heavyweight resources.",
    cwe: "CWE-772",
    fix_template: "Move the body into a helper function so defer runs per iteration, or close explicitly.",
  },

  // ── Nil map write ─────────────────────────────────────────────
  {
    id: "go-009-nil-map-write",
    title: "Write to nil map (runtime panic)",
    severity: "high",
    languages: ["go"],
    regex: /\bvar\s+(\w+)\s+map\s*\[[^\]]+\][^\n=]*\n(?![\s\S]{0,200}?\1\s*=\s*make)[\s\S]{0,200}?\1\s*\[/g,
    explanation:
      "Declaring a map variable with `var m map[K]V` initializes it to nil. Writing to a nil map causes a runtime panic. The map must be initialized with make() before use.",
    verify_prompt:
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      "1. Is the map initialized with make() or a literal before the write? → FALSE_POSITIVE\n" +
      "2. Is the map only read from (not written to)? → FALSE_POSITIVE\n" +
      "3. Is there a nil check before the write? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if the map is declared as nil and written to without initialization.",
    cwe: "CWE-476",
    fix_template: "Initialize with `m = make(map[K]V)` before writing, or use a map literal.",
  },

  // ── Race condition ────────────────────────────────────────────
  {
    id: "go-010-race-shared-var",
    title: "Shared variable accessed in goroutine without synchronization",
    severity: "high",
    languages: ["go"],
    regex: /\bgo\s+func\s*\([^)]*\)\s*\{[\s\S]{0,300}?(\w+)\s*(?:\+\+|--|(?:\+|-)=|=(?!=))[\s\S]{0,50}?\}\s*\(/g,
    explanation:
      "A variable from the outer scope is modified inside a goroutine without a mutex, atomic, or channel. This is a data race — undefined behavior in Go, detectable with `go test -race`.",
    verify_prompt:
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      "1. Is the variable protected by a sync.Mutex or sync.RWMutex? → FALSE_POSITIVE\n" +
      "2. Is it using atomic operations (atomic.AddInt64, etc.)? → FALSE_POSITIVE\n" +
      "3. Is the variable a channel or only accessed after a WaitGroup.Wait()? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if the variable is shared and modified without synchronization.",
    cwe: "CWE-362",
    fix_template: "Use sync.Mutex, atomic operations, or channels to synchronize access.",
  },

  // ── Context not propagated ────────────────────────────────────
  {
    id: "go-011-context-not-propagated",
    title: "HTTP handler ignoring request context",
    severity: "medium",
    languages: ["go"],
    regex: /func\s+\w*\s*\(\s*\w+\s+http\.ResponseWriter\s*,\s*(\w+)\s+\*http\.Request\s*\)[\s\S]{0,500}?(?:http\.Get|http\.Post|http\.Do|sql\.Query|sql\.Exec)\s*\(/g,
    explanation:
      "An HTTP handler makes outbound calls (HTTP, SQL) without passing the request's context. When the client disconnects, the downstream call continues wasting resources instead of being cancelled.",
    verify_prompt:
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      "1. Is req.Context() passed to the outbound call? → FALSE_POSITIVE\n" +
      "2. Is the outbound call to a local/fast resource where cancellation doesn't matter? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if a slow outbound call ignores the request context.",
    cwe: "CWE-404",
    fix_template: "Use req.Context(): http.NewRequestWithContext(req.Context(), ...) or db.QueryContext(req.Context(), ...).",
  },

  // ── Infinite recursion ────────────────────────────────────────
  {
    id: "go-012-infinite-recursion",
    title: "Function calls itself without visible base case",
    severity: "high",
    languages: ["go"],
    regex: /func\s+(\w+)\s*\([^)]*\)[^{]*\{(?![\s\S]{0,200}?\b(?:if|switch|case|return)\b)[\s\S]{0,300}?\b\1\s*\(/g,
    explanation:
      "A function calls itself without a visible base case (no if/switch/return before the recursive call). This will cause a stack overflow at runtime.",
    verify_prompt:
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      "1. Is there a base case (if, switch, or early return) before the recursive call? → FALSE_POSITIVE\n" +
      "2. Is this an intentional wrapper that delegates to a different overload? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if there is no terminating condition visible.",
    cwe: "CWE-674",
    fix_template: "Add a base case: if condition { return } before the recursive call.",
  },

  // ── Hardcoded credentials ─────────────────────────────────────
  {
    id: "go-013-hardcoded-credentials",
    title: "Hardcoded password, secret, or API key in Go code",
    severity: "high",
    languages: ["go"],
    regex: /(?:password|secret|apiKey|api_key|token|auth)\s*(?::=|=)\s*"[^"]{8,}"/gi,
    explanation:
      "Hardcoded credentials in source code are exposed to anyone with repo access. Secrets should come from environment variables, config files, or a secrets manager.",
    verify_prompt:
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      "1. Is the value a placeholder like \"changeme\", \"TODO\", \"xxx\", or \"test\"? → FALSE_POSITIVE\n" +
      "2. Is this in test code or example code? → FALSE_POSITIVE\n" +
      "3. Is it a non-secret identifier (e.g., a header name, env var name)? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if it looks like a real credential embedded in production code.",
    cwe: "CWE-798",
    fix_template: "Use os.Getenv(\"SECRET_KEY\") or a secrets manager.",
  },

  // ── Unbuffered channel deadlock ───────────────────────────────
  {
    id: "go-014-unbuffered-channel-deadlock",
    title: "Unbuffered channel send/receive in same goroutine",
    severity: "high",
    languages: ["go"],
    regex: /(\w+)\s*:=\s*make\s*\(\s*chan\s+[^,)]+\)[\s\S]{0,200}?\1\s*<-[\s\S]{0,100}?<-\s*\1/g,
    explanation:
      "Sending to and receiving from an unbuffered channel in the same goroutine deadlocks. The send blocks waiting for a receiver, but the receiver is after the send in the same goroutine.",
    verify_prompt:
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      "1. Is the channel buffered (make(chan T, N) with N > 0)? → FALSE_POSITIVE\n" +
      "2. Is the send/receive in different goroutines? → FALSE_POSITIVE\n" +
      "3. Is this inside a select statement with a default case? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if both send and receive happen in the same goroutine on an unbuffered channel.",
    cwe: "CWE-833",
    fix_template: "Use a buffered channel: make(chan T, 1), or move send/receive to separate goroutines.",
  },

  // ── WaitGroup misuse ──────────────────────────────────────────
  {
    id: "go-015-waitgroup-add-after-go",
    title: "sync.WaitGroup.Add() called after goroutine launch",
    severity: "high",
    languages: ["go"],
    regex: /\bgo\s+(?:func\b|\w+\()[\s\S]{0,100}?\.Add\s*\(\s*1\s*\)/g,
    explanation:
      "Calling wg.Add(1) after `go func()` creates a race condition. The goroutine may call wg.Done() before Add(1) runs, causing a negative WaitGroup counter panic.",
    verify_prompt:
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      "1. Is wg.Add(1) called BEFORE the go statement? → FALSE_POSITIVE\n" +
      "2. Is wg.Add(N) called once before a loop that launches N goroutines? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if Add is called after or inside the goroutine.",
    cwe: "CWE-362",
    fix_template: "Move wg.Add(1) to BEFORE the go statement.",
  },

  // ── HTTP response body not closed ─────────────────────────────
  {
    id: "go-016-http-body-not-closed",
    title: "HTTP response body not closed (connection leak)",
    severity: "medium",
    languages: ["go"],
    regex: /(?:http\.(?:Get|Post|Head))\s*\([^)]*\)[\s\S]{0,300}?(?![\s\S]{0,300}?\.Body\.Close\s*\(\))/g,
    explanation:
      "Not closing the HTTP response body leaks the underlying TCP connection. The transport cannot reuse it, eventually exhausting file descriptors or connection pool.",
    verify_prompt:
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      "1. Is resp.Body.Close() called (directly or via defer) after the HTTP call? → FALSE_POSITIVE\n" +
      "2. Is the error checked and returned before body access (body is nil on error)? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if the response body is used but never closed.",
    cwe: "CWE-772",
    fix_template: "Add `defer resp.Body.Close()` immediately after the nil-error check.",
  },

  // ── Slice append capacity trap ────────────────────────────────
  {
    id: "go-017-slice-append-shared",
    title: "Append to slice from function argument (shared backing array)",
    severity: "medium",
    languages: ["go"],
    regex: /func\s+\w+\s*\([^)]*(\w+)\s+\[\]\w+[^)]*\)[\s\S]{0,300}?\1\s*=\s*append\s*\(\s*\1\s*,/g,
    explanation:
      "Appending to a slice parameter may modify the caller's backing array if there's spare capacity, causing silent data corruption. The caller doesn't see the new length but their data is overwritten.",
    verify_prompt:
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      "1. Is the function documented to intentionally mutate the slice? → FALSE_POSITIVE\n" +
      "2. Is the slice copied first (copy() or append([]T{}, s...))? → FALSE_POSITIVE\n" +
      "3. Is the result returned and assigned by the caller? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if the function appends to the parameter without returning the result.",
    cwe: "CWE-119",
    fix_template: "Copy first: local := make([]T, len(s)); copy(local, s); then append to local.",
  },

  // ── fmt.Sprintf in hot path ───────────────────────────────────
  {
    id: "go-018-sprintf-hot-path",
    title: "fmt.Sprintf in performance-critical loop",
    severity: "low",
    languages: ["go"],
    regex: /\bfor\b[\s\S]{0,200}?\{[\s\S]{0,300}?fmt\.Sprintf\s*\(/g,
    explanation:
      "fmt.Sprintf allocates on every call. In tight loops this creates significant GC pressure. Use strconv, strings.Builder, or pre-allocated buffers.",
    verify_prompt:
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      "1. Is this loop bounded to a small number of iterations (< 100)? → FALSE_POSITIVE\n" +
      "2. Is this in initialization code, not a hot path? → FALSE_POSITIVE\n" +
      "3. Is the Sprintf result needed for error formatting (rare path)? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if this is in a high-frequency loop where allocation matters.",
    fix_template: "Use strconv.Itoa/FormatFloat, or strings.Builder for concatenation.",
  },

  // ── os.Exit in library code ───────────────────────────────────
  {
    id: "go-019-os-exit-library",
    title: "os.Exit() in library/non-main package",
    severity: "medium",
    languages: ["go"],
    regex: /\bos\.Exit\s*\(\s*\d+\s*\)/g,
    explanation:
      "os.Exit() in library code terminates the entire process, bypassing deferred cleanup, running goroutines, and any error handling the caller might have. Libraries should return errors, not exit.",
    verify_prompt:
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      "1. Is this in a main package (package main)? → FALSE_POSITIVE\n" +
      "2. Is this in a CLI tool's root command handler? → FALSE_POSITIVE\n" +
      "3. Is this in a test file (TestMain)? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if os.Exit is called in a library/utility package.",
    cwe: "CWE-705",
    fix_template: "Return an error instead of calling os.Exit(). Let the caller decide how to handle it.",
  },

  // ── Loop variable captured by goroutine ───────────────────────
  {
    id: "go-020-loop-var-goroutine",
    title: "Loop variable captured by goroutine closure (pre-Go 1.22)",
    severity: "medium",
    languages: ["go"],
    regex: /\bfor\s+(?:\w+\s*,\s*)?(\w+)\s*:?=\s*range\b[\s\S]{0,200}?\bgo\s+func\s*\([^)]*\)\s*\{[\s\S]{0,200}?\b\1\b/g,
    explanation:
      "Before Go 1.22, the loop variable is shared across all iterations. Goroutines capturing it by closure all see the LAST value. In Go 1.22+ with GOEXPERIMENT=loopvar this is fixed, but older code is affected.",
    verify_prompt:
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      "1. Is the variable passed as a goroutine argument (go func(v T) { ... }(v))? → FALSE_POSITIVE\n" +
      "2. Is there a `v := v` shadow inside the loop before the goroutine? → FALSE_POSITIVE\n" +
      "3. Is the project using Go 1.22+ with loopvar semantics? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if the loop variable is captured by closure without shadowing.",
    cwe: "CWE-362",
    fix_template: "Shadow the variable: `v := v` before the go statement, or pass it as a goroutine argument.",
  },
];
