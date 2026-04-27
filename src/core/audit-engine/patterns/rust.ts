// KCode - RUST Bug Patterns
// Extracted from the monolithic patterns.ts. See that file for the
// ALL_PATTERNS aggregator and lookup helpers.

import type { BugPattern } from "../types";

export const RUST_PATTERNS: BugPattern[] = [
  {
    id: "rs-001-unsafe-block",
    title: "unsafe block (manual review needed)",
    severity: "medium",
    languages: ["rust"],
    regex: /\bunsafe\s*\{/g,
    explanation:
      "unsafe blocks bypass Rust's borrow checker. Memory corruption, use-after-free, and data races are possible inside unsafe.",
    verify_prompt:
      "Is this unsafe block well-documented with a SAFETY comment explaining why it's sound? If properly justified, respond FALSE_POSITIVE. If no safety comment, respond CONFIRMED.",
    cwe: "CWE-787",
    fix_template: "Add a // SAFETY: comment, or refactor to avoid unsafe.",
  },
  {
    id: "rs-002-unwrap-panic",
    title: "unwrap()/expect() on Result/Option (panic risk)",
    severity: "low",
    languages: ["rust"],
    regex: /\.\s*(?:unwrap|expect)\s*\(\s*\)/g,
    explanation:
      "unwrap() panics on None/Err. In server code, this crashes the process. Use proper error handling with ? operator.",
    verify_prompt:
      "Is this in application code that should handle errors gracefully, or in test/CLI code where panicking is acceptable? If test code, respond FALSE_POSITIVE.",
    cwe: "CWE-754",
    fix_template: "Replace .unwrap() with .map_err(|e| ...)? or .unwrap_or_default().",
  },
  {
    id: "rs-003-sql-injection",
    title: "SQL query with format! macro (injection risk)",
    severity: "critical",
    languages: ["rust"],
    regex: /\b(?:query|execute)\s*\(\s*&?format!\s*\(/g,
    explanation:
      "SQL queries built with format!() are vulnerable to injection. Use parameterized queries.",
    verify_prompt:
      "Is user input interpolated via format!()? If parameterized ($1, ?), respond FALSE_POSITIVE.",
    cwe: "CWE-89",
    fix_template: 'Use sqlx::query("SELECT * FROM t WHERE id = $1").bind(id).',
  },

  // ── .unwrap() in non-test code ────────────────────────────────
  {
    id: "rs-004-unwrap-non-test",
    title: ".unwrap() in non-test production code",
    severity: "medium",
    languages: ["rust"],
    regex: /(?<!#\[test\][\s\S]{0,500})\.\s*unwrap\s*\(\s*\)/g,
    explanation:
      ".unwrap() panics on None/Err, crashing the process. In server or library code this is unacceptable — a single bad input kills the service.",
    verify_prompt:
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      "1. Is this in a test file (#[cfg(test)] module or tests/ directory)? → FALSE_POSITIVE\n" +
      "2. Is this in main() where panic is acceptable for fatal startup errors? → FALSE_POSITIVE\n" +
      "3. Is the unwrap on a value that is statically guaranteed (e.g., Regex::new on a literal)? → FALSE_POSITIVE\n" +
      "4. Is there a comment explaining why unwrap is safe here? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if this is in library/server code where the value could be None/Err at runtime.",
    cwe: "CWE-754",
    fix_template: "Replace .unwrap() with ? operator, .unwrap_or_default(), or .map_err(|e| ...)?.",
  },

  // ── .expect() without meaningful message ──────────────────────
  {
    id: "rs-005-expect-no-message",
    title: ".expect() with generic or empty message",
    severity: "low",
    languages: ["rust"],
    regex:
      /\.expect\s*\(\s*"(?:failed|error|unexpected|should not happen|impossible|bug|todo|fixme|unreachable|panic|oops|crash)"\s*\)/gi,
    explanation:
      '.expect() should provide a meaningful error message explaining WHY the value should be present. Generic messages like "failed" give no debugging context when the panic occurs in production logs.',
    verify_prompt:
      "Does the .expect() message explain the specific condition that was expected? " +
      'If the message is descriptive (e.g., "database connection must be initialized before query"), ' +
      'respond FALSE_POSITIVE. If it\'s generic ("failed", "error", "should not happen"), respond CONFIRMED.',
    cwe: "CWE-754",
    fix_template: 'Use a descriptive message: .expect("config file must exist after init phase")',
  },

  // ── unsafe without SAFETY comment ─────────────────────────────
  {
    id: "rs-006-unsafe-no-safety",
    title: "unsafe block without // SAFETY: comment",
    severity: "medium",
    languages: ["rust"],
    regex: /(?<!\/{2}\s*SAFETY:[^\n]*\n\s*)\bunsafe\s*\{/g,
    explanation:
      "Rust convention requires a `// SAFETY:` comment before every unsafe block explaining why the invariants are upheld. Missing comments indicate the author may not have verified safety.",
    verify_prompt:
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      "1. Is there a // SAFETY: comment on the line(s) immediately before the unsafe block? → FALSE_POSITIVE\n" +
      "2. Is this in a well-known FFI wrapper where safety is documented at module level? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if the unsafe block has no safety justification comment.",
    cwe: "CWE-787",
    fix_template: "Add a // SAFETY: comment explaining why the invariants are upheld.",
  },

  // ── Arc<Mutex> vs Arc<RwLock> ─────────────────────────────────
  {
    id: "rs-007-arc-mutex-read-heavy",
    title: "Arc<Mutex<T>> used where Arc<RwLock<T>> may be better",
    severity: "low",
    languages: ["rust"],
    regex: /Arc\s*<\s*Mutex\s*<[^>]+>\s*>/g,
    explanation:
      "Arc<Mutex<T>> serializes all access (reads AND writes). If the data is read-heavy with infrequent writes, Arc<RwLock<T>> allows concurrent reads and significantly improves throughput.",
    verify_prompt:
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      "1. Is the data mostly written to (not read-heavy)? → FALSE_POSITIVE\n" +
      "2. Is the lock held for very short durations where RwLock overhead isn't worth it? → FALSE_POSITIVE\n" +
      "3. Is the Mutex protecting a resource that requires exclusive access (e.g., socket, file)? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if the data is clearly read-heavy and would benefit from concurrent reads.",
    cwe: "CWE-1050",
    fix_template:
      "Replace Mutex with RwLock: Arc<RwLock<T>>. Use .read() for shared access, .write() for exclusive.",
  },

  // ── Blocking in async ─────────────────────────────────────────
  {
    id: "rs-008-blocking-in-async",
    title: "Blocking call inside async function",
    severity: "high",
    languages: ["rust"],
    regex:
      /async\s+fn\s+\w+[\s\S]{0,500}?(?:std::thread::sleep|std::fs::\w+|std::net::\w+|\.read_to_string|\.write_all)\s*\(/g,
    explanation:
      "Calling std::thread::sleep, std::fs, or std::net (blocking I/O) inside an async function blocks the executor thread. This starves other tasks on the same runtime, causing latency spikes or deadlocks.",
    verify_prompt:
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      "1. Is this wrapped in tokio::task::spawn_blocking() or equivalent? → FALSE_POSITIVE\n" +
      "2. Is the async runtime configured with multi-threaded scheduler AND this is rare? → FALSE_POSITIVE\n" +
      "3. Is this using the async version (tokio::fs, tokio::time::sleep, tokio::net)? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if a blocking call is made directly in an async context without spawn_blocking.",
    cwe: "CWE-400",
    fix_template: "Use tokio::time::sleep, tokio::fs, or wrap in spawn_blocking(|| { ... }).await.",
  },

  // ── clone() in loop ───────────────────────────────────────────
  {
    id: "rs-009-clone-in-loop",
    title: "clone() on potentially large type inside loop",
    severity: "low",
    languages: ["rust"],
    regex: /\bfor\b[\s\S]{0,200}?\{[\s\S]{0,300}?\.clone\s*\(\s*\)/g,
    explanation:
      "Calling .clone() inside a loop creates a deep copy on every iteration. For large structs, Vecs, or Strings, this is an O(n*m) allocation pattern that kills performance.",
    verify_prompt:
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      "1. Is the cloned type small/cheap (e.g., Arc, Rc, i32, bool)? → FALSE_POSITIVE\n" +
      "2. Is the loop bounded to a small number of iterations? → FALSE_POSITIVE\n" +
      "3. Can the clone be replaced with a borrow (&T) or Cow? → If yes, respond CONFIRMED.\n" +
      "Only respond CONFIRMED if the cloned data is large and the loop is hot.",
    cwe: "CWE-1050",
    fix_template:
      "Use references (&T), Cow<T>, or Arc<T> instead of cloning. Move allocation outside the loop.",
  },

  // ── Missing Send + Sync on async return ───────────────────────
  {
    id: "rs-010-async-send-sync",
    title: "Async function return not Send (cannot spawn across threads)",
    severity: "medium",
    languages: ["rust"],
    regex:
      /async\s+fn\s+\w+[^{]*->\s*(?:impl\s+Future|Box\s*<\s*dyn\s+Future)(?![\s\S]{0,50}?Send)/g,
    explanation:
      "Async functions that return impl Future without a Send bound cannot be spawned with tokio::spawn() or used in multi-threaded executors. This causes confusing compile errors downstream.",
    verify_prompt:
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      '1. Is this explicitly single-threaded (e.g., LocalSet, #[tokio::main(flavor = "current_thread")])? → FALSE_POSITIVE\n' +
      "2. Does the return type already include + Send? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if the future is used in a multi-threaded context without Send bound.",
    cwe: "CWE-704",
    fix_template:
      "Add Send bound: -> impl Future<Output = T> + Send, or use Pin<Box<dyn Future + Send>>.",
  },

  // ── Hardcoded secrets ─────────────────────────────────────────
  {
    id: "rs-011-hardcoded-secrets",
    title: "Hardcoded password, secret, or API key in Rust code",
    severity: "high",
    languages: ["rust"],
    regex: /(?:password|secret|api_key|apikey|token|auth_token)\s*(?::|=)\s*"[^"]{8,}"/gi,
    explanation:
      "Hardcoded credentials in source code are exposed to anyone with repo access. Compiled binaries also contain string literals that can be extracted.",
    verify_prompt:
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      '1. Is the value a placeholder like "changeme", "TODO", "test", or "example"? → FALSE_POSITIVE\n' +
      "2. Is this in test code or documentation? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if it looks like a real credential in production code.",
    cwe: "CWE-798",
    fix_template: 'Use std::env::var("SECRET_KEY") or a config/secrets manager.',
  },

  // ── Panic in Drop ─────────────────────────────────────────────
  {
    id: "rs-012-panic-in-drop",
    title: "Potential panic inside Drop implementation",
    severity: "high",
    languages: ["rust"],
    regex:
      /impl\s+Drop\s+for\s+\w+[\s\S]{0,300}?(?:\.unwrap\(\)|\.expect\(|panic!\(|unreachable!\()/g,
    explanation:
      "Panicking inside a Drop implementation causes a double panic if the Drop runs during stack unwinding from another panic. This aborts the process immediately with no cleanup.",
    verify_prompt:
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      "1. Is the unwrap/expect on a value that is statically guaranteed to succeed? → FALSE_POSITIVE\n" +
      "2. Is there a std::thread::panicking() check before the panic-able code? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if the Drop impl can panic on a fallible operation.",
    cwe: "CWE-754",
    fix_template:
      "Use if let Ok(v) = ... or .unwrap_or_else(|_| default) instead of unwrap/expect in Drop.",
  },

  // ── Unbounded Vec from user input ─────────────────────────────
  {
    id: "rs-013-unbounded-vec",
    title: "Vec grown from untrusted input without capacity limit",
    severity: "high",
    languages: ["rust"],
    regex:
      /(?:Vec::with_capacity|Vec::new)\s*\([^)]*\)[\s\S]{0,300}?(?:\.push|\.extend|\.append)\s*\([^)]*(?:input|request|body|payload|data|recv|read)/g,
    explanation:
      "Growing a Vec from untrusted input without a maximum capacity allows an attacker to trigger OOM by sending a large payload. The program allocates until it crashes.",
    verify_prompt:
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      "1. Is there a maximum length check before the loop/extend? → FALSE_POSITIVE\n" +
      "2. Is the Vec pre-allocated with a bounded capacity? → FALSE_POSITIVE\n" +
      "3. Is the input from a trusted source (not network/user)? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if untrusted input drives unbounded Vec growth.",
    cwe: "CWE-789",
    fix_template: "Add a capacity limit: if data.len() > MAX_SIZE { return Err(...) }",
  },

  // ── mem::transmute ────────────────────────────────────────────
  {
    id: "rs-014-mem-transmute",
    title: "mem::transmute usage (type-punning, UB risk)",
    severity: "high",
    languages: ["rust"],
    regex: /\bmem::transmute\s*[:<(]/g,
    explanation:
      "mem::transmute reinterprets bits of one type as another without any checks. It can easily cause undefined behavior if the source and target types have different sizes, alignments, or validity invariants.",
    verify_prompt:
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      "1. Is this transmuting between types with identical layout (e.g., repr(C) newtypes)? → FALSE_POSITIVE\n" +
      "2. Is there a // SAFETY: comment with a sound justification? → FALSE_POSITIVE\n" +
      "3. Can this be replaced with safe alternatives (as, From, TryFrom, bytemuck)? → If yes, CONFIRMED.\n" +
      "Only respond CONFIRMED if the transmute is unjustified or can be replaced with safe code.",
    cwe: "CWE-843",
    fix_template:
      "Use safe alternatives: `as` casts, From/TryFrom, bytemuck::cast, or pointer::cast.",
  },

  // ── String formatting in SQL ──────────────────────────────────
  {
    id: "rs-015-format-sql",
    title: "SQL query with format!/format_args! (injection risk)",
    severity: "critical",
    languages: ["rust"],
    regex: /\b(?:query|execute|raw_sql)\s*\(\s*&?(?:format!\s*\(|format_args!\s*\()/g,
    explanation:
      "Building SQL queries with format!() or string concatenation bypasses parameterized query protection. User input in the formatted string enables SQL injection.",
    verify_prompt:
      "Is user/external input interpolated into the SQL via format!()? If the query uses " +
      "bind parameters ($1, ?, :name) instead of string interpolation, respond FALSE_POSITIVE. " +
      "If user input is formatted into the SQL string, respond CONFIRMED.",
    cwe: "CWE-89",
    fix_template:
      'Use parameterized queries: sqlx::query("SELECT * FROM t WHERE id = $1").bind(id).',
  },
];
