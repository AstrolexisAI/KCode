// KCode - Bug Pattern Library
//
// Curated patterns for common dangerous code in C/C++. These are the patterns
// that catch real bugs in production code — NOT the patterns LLMs hallucinate.
//
// Each pattern was derived from either:
//   - Bugs found by Claude Code in NASA IDF (network I/O, USB decoders)
//   - CWE/OWASP classics that keep appearing in C code
//   - Language-specific footguns the compiler doesn't catch
//
// When adding a new pattern: write a test case showing what it catches AND
// what it doesn't (false positive guard).

import type { BugPattern } from "./types";

export const CPP_PATTERNS: BugPattern[] = [
  // ── Pointer arithmetic errors ───────────────────────────────────
  {
    id: "cpp-001-ptr-address-index",
    title: "Suspicious pointer arithmetic: (&var)[N]",
    severity: "high",
    languages: ["c", "cpp"],
    regex: /\(\s*&\s*([a-zA-Z_][\w]*)\s*\)\s*\[\s*([a-zA-Z_][\w]*|\d+)\s*\]/g,
    explanation:
      "(&var)[n] treats the address of `var` as the base of an array. For primitive pointers this is the NASA IDF EthernetDevice bug — (&buffer)[bytesTotal] reads memory AFTER the pointer variable on the stack when n > 0. The likely intent is `(char*)buffer + n` or `buffer + n`.",
    verify_prompt:
      "Look at this `(&VAR)[IDX]` expression. Is VAR a pointer or a variable? " +
      "If VAR is a pointer (e.g. `const void *buffer`), then (&buffer)[1] reads " +
      "stack memory after the pointer variable — that's a bug. If VAR is an " +
      "array or the intent is genuinely to index into an array-of-that-thing, " +
      "respond FALSE_POSITIVE. Otherwise show the stack layout and confirm CONFIRMED.",
    cwe: "CWE-125",
    fix_template: "Replace `(&VAR)[IDX]` with `(char*)VAR + IDX` (for pointers) or verify VAR is an array.",
  },

  // ── Unreachable code ────────────────────────────────────────────
  {
    id: "cpp-002-unreachable-after-return",
    title: "Statement after return/throw (unreachable code)",
    severity: "medium",
    languages: ["c", "cpp"],
    // Only match `return X;` and `throw X;` — NOT continue/break.
    // continue/break are almost always inside single-line if() blocks
    // where the NEXT line IS reachable (different branch). Only return
    // and throw reliably indicate the next line is dead code.
    regex:
      /(?:^|\n)\s+(?:return\s+[^;\n]+;|throw\s+[^;\n]+;)\s*\n\s+([a-zA-Z_]\w*\s*(?:=|->|\.|\())/g,
    explanation:
      "Code after `return` or `throw` is unreachable. This is the NASA IDF EthernetDevice bug — `lastPacketArrived = std::time(nullptr);` after a return, so the timeout timestamp never updates.",
    verify_prompt:
      "Is the statement after `return`/`throw`/etc. actually unreachable? " +
      "If the surrounding context has a loop/switch/goto that could make it " +
      "reachable, respond FALSE_POSITIVE. Otherwise confirm and explain the " +
      "side effect being lost.",
    cwe: "CWE-561",
    fix_template: "Move the statement BEFORE the return/throw, or delete if truly dead.",
  },

  // ── Unchecked buffer indexing ───────────────────────────────────
  {
    id: "cpp-003-unchecked-data-index",
    title: "Buffer access with fixed index, no size validation",
    severity: "high",
    languages: ["c", "cpp"],
    // Match READ ACCESSES to data[N]/buffer[N]/buf[N]/packet[N]/msg[N]/
    // payload[N] with fixed index 2-99. Exclude:
    //   - declarations: `char buf[1024]`, `uint8_t data[16]`, std::array<...>, etc.
    //   - indices 0 and 1 (often first-byte protocol IDs, typically validated)
    //   - indices >= 100 (usually declarations of large buffers)
    // Uses negative lookbehind to skip type-qualifier preceded matches.
    regex:
      /(?<!\b(?:char|unsigned|signed|int|short|long|uint8_t|uint16_t|uint32_t|int8_t|int16_t|int32_t|size_t|float|double|bool|void|std::\w+|u_char|u_int8_t|u_int16_t|u_int32_t)\s)(?<!\w)(data|buffer|buf|packet|msg|payload)\s*\[\s*([2-9]|[1-9]\d)\s*\]/g,
    explanation:
      "Accessing `data[N]` with a hardcoded index without first validating size. NASA IDF USB decoders (UsbXBox.cpp, UsbDualShock3/4, UsbWingMan) all access fixed offsets into HID packets without checking packet length. Malformed packet → out-of-bounds read.",
    verify_prompt:
      "Is there a size check in the SAME function before this `[N]` access? " +
      "Look for `if (size < N+1) return`, `if (data.size() <= N) throw`, etc. " +
      "If a size check exists upstream (in caller, in parser), respond NEEDS_CONTEXT " +
      "and describe what check would be needed. If this index runs unconditionally " +
      "on attacker-controlled input, confirm CONFIRMED.",
    cwe: "CWE-125",
    fix_template: "Add `if (container.size() <= N) return;` before the access.",
  },

  // ── Resource leak on error path ─────────────────────────────────
  {
    id: "cpp-004-fd-leak-throw",
    title: "File descriptor opened without closing on error path",
    severity: "medium",
    languages: ["c", "cpp"],
    // Require ASSIGNMENT (= open/socket/fopen) — just a call isn't enough
    // to indicate an owned resource. Then look for throw within ~400 chars
    // WITHOUT a corresponding close/closesocket.
    regex:
      /\b\w+\s*=\s*(?:open|socket|fopen)\s*\([^)]*\)\s*;(?![\s\S]{0,400}?\bclose(?:socket)?\s*\()[\s\S]{0,400}?\bthrow\b/g,
    explanation:
      "An fd/socket opened successfully but thrown-from before close() is called. NASA IDF EthernetDevice::open() and SerialDevice::open() both have this pattern in error paths.",
    verify_prompt:
      "Between the open()/socket()/fopen() and the throw, is the fd closed? " +
      "Also check: is there a RAII wrapper (std::fstream, unique_ptr with deleter)? " +
      "If RAII cleans up, respond FALSE_POSITIVE. Otherwise CONFIRMED.",
    cwe: "CWE-772",
    fix_template: "Either add `close(fd);` before the throw, or wrap in RAII.",
  },

  // ── Integer signedness ──────────────────────────────────────────
  {
    id: "cpp-005-int-returned-as-size",
    title: "Signed int used as size_t (possible signedness bug)",
    severity: "medium",
    languages: ["c", "cpp"],
    regex: /\bint\s+(\w+)\s*=\s*\w+\([^)]*\)\s*;[\s\S]{0,200}?\b(std::vector|std::string|std::array)\s*<[^>]+>\s*\w+\s*\(\s*\1/g,
    explanation:
      "An int (which can be negative) is used as the size argument to a container constructor that expects size_t. If the function returned -1 on error, the cast to size_t produces a huge number → DoS via gigantic allocation.",
    verify_prompt:
      "Does the function returning this int check for < 0 BEFORE the cast to size_t? " +
      "If there's a `if (n < 0) return error` before the container construction, " +
      "respond FALSE_POSITIVE. Otherwise CONFIRMED.",
    cwe: "CWE-195",
    fix_template: "Check `if (n < 0) return error;` before using n as a size.",
  },

  // ── Unsafe string functions ─────────────────────────────────────
  {
    id: "cpp-006-strcpy-family",
    title: "Use of unbounded string function (strcpy/strcat/sprintf/gets)",
    severity: "high",
    languages: ["c", "cpp"],
    regex: /\b(strcpy|strcat|sprintf|gets)\s*\(/g,
    explanation:
      "strcpy/strcat/sprintf/gets have no bounds checking. If the source can exceed the destination size, heap/stack buffer overflow. Use the `_s` or `n` variants.",
    verify_prompt:
      "Is the source length validated before this call? If a guaranteed-short " +
      "literal or validated length exists, respond FALSE_POSITIVE. Otherwise CONFIRMED.",
    cwe: "CWE-120",
    fix_template: "strcpy→strncpy, strcat→strncat, sprintf→snprintf, gets→fgets.",
  },

  // ── Null dereference before check ───────────────────────────────
  {
    id: "cpp-007-deref-before-null-check",
    title: "Pointer dereferenced before null check",
    severity: "high",
    languages: ["c", "cpp"],
    // Match ptr->field followed by if (ptr == NULL) within 100 chars,
    // BUT exclude when there's a return/break/goto between them
    // (those exit the scope, so the null check is for a different path).
    regex: /\b(\w+)\s*->\s*\w+(?![\s\S]{0,100}?\b(?:return|break|goto)\b)[\s\S]{0,100}?\bif\s*\(\s*\1\s*(?:==|!=)\s*(?:NULL|nullptr|0)\s*\)/g,
    explanation:
      "A pointer is dereferenced with `->` and THEN checked for null. If it's ever null, the deref already crashed before the check could help.",
    verify_prompt:
      "Is the null check actually AFTER the deref on the same code path? " +
      "Check for branches, early returns, guarantees the pointer is non-null. " +
      "If check was wrong but deref is guaranteed safe, respond FALSE_POSITIVE. " +
      "Otherwise CONFIRMED.",
    cwe: "CWE-476",
    fix_template: "Move the null check BEFORE the dereference.",
  },

  // ── Memcpy with untrusted size ──────────────────────────────────
  {
    id: "cpp-008-memcpy-untrusted-len",
    title: "memcpy with potentially attacker-controlled length",
    severity: "critical",
    languages: ["c", "cpp"],
    regex: /\bmemcpy\s*\(\s*[^,]+,\s*[^,]+,\s*(\w+->[\w.]+|\w+\.[\w.]+)\s*\)/g,
    explanation:
      "memcpy length from struct field accessed via pointer is often from untrusted network/file input. If length is unbounded, heap buffer overflow.",
    verify_prompt:
      "Is the length field validated against the DESTINATION buffer size before " +
      "this memcpy? If there's a bounds check that ensures len <= dest_size, " +
      "respond FALSE_POSITIVE. Otherwise CONFIRMED.",
    cwe: "CWE-120",
    fix_template: "Add `if (len > dest_size) return error;` before memcpy.",
  },

  // ── TOCTOU file operations ──────────────────────────────────────
  {
    id: "cpp-009-toctou-stat-open",
    title: "TOCTOU: stat/access followed by open (race window)",
    severity: "medium",
    languages: ["c", "cpp"],
    regex: /\b(stat|access|lstat)\s*\([^)]*\)[\s\S]{0,200}?\b(open|fopen)\s*\(/g,
    explanation:
      "Checking file properties with stat()/access() then opening the file separately. An attacker can replace the file between the check and the open (symlink swap) to bypass security.",
    verify_prompt:
      "Does the code use the fd from open() to re-verify properties (fstat), " +
      "or does it rely on the stat() result? If fstat is used after open, " +
      "respond FALSE_POSITIVE. Otherwise CONFIRMED.",
    cwe: "CWE-367",
    fix_template: "Open first, then use fstat() on the fd to check properties.",
  },

  // ── Integer overflow in allocation ──────────────────────────────
  {
    id: "cpp-010-malloc-mul-overflow",
    title: "malloc/new size calculated by multiplication (overflow risk)",
    severity: "high",
    languages: ["c", "cpp"],
    regex: /\b(malloc|calloc|realloc|new)\s*(?:\[?)\s*\(?([a-zA-Z_]\w*)\s*\*\s*sizeof/g,
    explanation:
      "Computing allocation size as `count * sizeof(T)` can overflow if count is untrusted, producing a small allocation followed by large writes → heap overflow.",
    verify_prompt:
      "Is `count` bounded to prevent overflow (e.g. `count < SIZE_MAX/sizeof(T)`)? " +
      "If there's such a check, respond FALSE_POSITIVE. Otherwise CONFIRMED.",
    cwe: "CWE-190",
    fix_template: "Use calloc(count, sizeof(T)) which handles overflow, or add explicit bounds check.",
  },

  // ── Signed/unsigned comparison ──────────────────────────────────
  {
    id: "cpp-011-signed-unsigned-cmp",
    title: "Comparison between signed int and unsigned (size_t) value",
    severity: "low",
    languages: ["c", "cpp"],
    regex: /\b(int|short|char|long)\s+(\w+)\s*=[^;]+;[\s\S]{0,100}?\b\2\s*[<>]=?\s*\w+\.size\(\)/g,
    explanation:
      "Comparing signed int to vec.size() (size_t/unsigned). Compiler converts int to size_t, so -1 becomes a huge number and the comparison misbehaves.",
    verify_prompt:
      "Is the signed variable guaranteed non-negative before this comparison? " +
      "If yes, respond FALSE_POSITIVE. Otherwise CONFIRMED.",
    cwe: "CWE-195",
    fix_template: "Use size_t for the counter, or cast vec.size() to (int) with bounds check.",
  },

  // ── Unvalidated loop bound ──────────────────────────────────────
  {
    id: "cpp-012-loop-unvalidated-bound",
    title: "Loop bound from external input without validation",
    severity: "high",
    languages: ["c", "cpp"],
    regex: /\bfor\s*\(\s*[^;]*;\s*\w+\s*<\s*(\w+->[\w.]+|\w+\.[\w.]+)\s*;/g,
    explanation:
      "Loop bound `i < msg->count` derived from untrusted input. If count is attacker-controlled and unbounded, infinite loop or excessive work.",
    verify_prompt:
      "Is the loop bound validated against a sane maximum before this loop? " +
      "If there's a check like `if (count > MAX) return`, respond FALSE_POSITIVE. " +
      "Otherwise CONFIRMED.",
    cwe: "CWE-606",
    fix_template: "Add `if (bound > MAX_ALLOWED) return error;` before the loop.",
  },
];

// ═══════════════════════════════════════════════════════════════
// Python Patterns
// ═══════════════════════════════════════════════════════════════

export const PYTHON_PATTERNS: BugPattern[] = [
  {
    id: "py-001-eval-exec",
    title: "eval()/exec() with potentially untrusted input",
    severity: "critical",
    languages: ["python"],
    regex: /\b(eval|exec)\s*\(/g,
    explanation:
      "eval() and exec() execute arbitrary Python code. If the argument contains any user/external input, this is a remote code execution vulnerability.",
    verify_prompt:
      "Is the argument to eval()/exec() a hardcoded constant or derived " +
      "entirely from trusted internal sources? If it includes ANY external " +
      "input (request params, file content, env vars, config), respond CONFIRMED. " +
      "If it's a constant string or internal-only, respond FALSE_POSITIVE.",
    cwe: "CWE-95",
    fix_template: "Replace eval() with ast.literal_eval() for data, or remove entirely.",
  },
  {
    id: "py-002-shell-injection",
    title: "Shell command execution with potential injection",
    severity: "critical",
    languages: ["python"],
    regex: /\b(?:os\.system|os\.popen|subprocess\.call|subprocess\.run|subprocess\.Popen)\s*\([^)]*(?:shell\s*=\s*True|f["']|\.format\(|%\s)/g,
    explanation:
      "Running shell commands with shell=True, f-strings, .format(), or % interpolation allows command injection if any part of the command comes from external input.",
    verify_prompt:
      "Does this shell command include ANY external/user input (request params, " +
      "filenames from user, config values)? If the entire command is a hardcoded " +
      "constant, respond FALSE_POSITIVE. If any variable is interpolated, respond CONFIRMED.",
    cwe: "CWE-78",
    fix_template: "Use subprocess.run([...], shell=False) with list of args instead of string.",
  },
  {
    id: "py-003-pickle-deserialize",
    title: "Unsafe deserialization (pickle/marshal/shelve)",
    severity: "critical",
    languages: ["python"],
    regex: /\b(?:pickle\.loads?|marshal\.loads?|shelve\.open)\s*\(/g,
    explanation:
      "pickle.load() deserializes arbitrary Python objects. An attacker can craft a pickle payload that executes arbitrary code on load. Never unpickle untrusted data.",
    verify_prompt:
      "Is the data being unpickled from a TRUSTED source (e.g., local file written " +
      "by the same app, internal cache)? Or could it come from an untrusted source " +
      "(network, user upload, shared storage)? CONFIRMED if untrusted, FALSE_POSITIVE if trusted.",
    cwe: "CWE-502",
    fix_template: "Use json.loads() or a safe serialization format instead of pickle.",
  },
  {
    id: "py-004-sql-injection",
    title: "SQL query with string formatting (injection risk)",
    severity: "high",
    languages: ["python"],
    regex: /\b(?:execute|executemany|raw)\s*\(\s*(?:f["']|["'].*%|["'].*\.format\()/g,
    explanation:
      "SQL queries built with f-strings, % formatting, or .format() are vulnerable to SQL injection. Use parameterized queries instead.",
    verify_prompt:
      "Is this SQL query using string interpolation with ANY external input? " +
      "If the query is entirely hardcoded or uses parameterized placeholders (%s, ?), " +
      "respond FALSE_POSITIVE. If user input is interpolated, respond CONFIRMED.",
    cwe: "CWE-89",
    fix_template: "Use parameterized queries: cursor.execute('SELECT * FROM t WHERE id = %s', (user_id,))",
  },
  {
    id: "py-005-yaml-unsafe-load",
    title: "yaml.load() without safe Loader (code execution)",
    severity: "high",
    languages: ["python"],
    regex: /\byaml\.load\s*\([^)]*(?!\bLoader\b)/g,
    explanation:
      "yaml.load() without Loader=yaml.SafeLoader can execute arbitrary Python code embedded in YAML. Always use yaml.safe_load() or specify SafeLoader.",
    verify_prompt:
      "Does this yaml.load() call specify Loader=yaml.SafeLoader or Loader=yaml.FullLoader? " +
      "If no Loader is specified, respond CONFIRMED. If SafeLoader is used, respond FALSE_POSITIVE.",
    cwe: "CWE-502",
    fix_template: "Replace yaml.load(data) with yaml.safe_load(data).",
  },
  {
    id: "py-006-hardcoded-secret",
    title: "Hardcoded password, secret, or API key",
    severity: "high",
    languages: ["python", "javascript", "typescript"],
    regex: /(?:password|secret|api_key|apikey|token|auth)\s*=\s*["'][^"']{8,}["']/gi,
    explanation:
      "Hardcoded secrets in source code are exposed to anyone with repo access. Use environment variables or a secrets manager.",
    verify_prompt:
      "Is this a REAL secret/password (not a placeholder like 'changeme', not a " +
      "test fixture, not a variable name)? If it looks like a real credential, " +
      "respond CONFIRMED. If it's a placeholder, test value, or example, respond FALSE_POSITIVE.",
    cwe: "CWE-798",
    fix_template: "Move to environment variable: os.environ.get('SECRET_KEY')",
  },
  {
    id: "py-007-assert-security",
    title: "assert used for security check (stripped in optimized mode)",
    severity: "medium",
    languages: ["python"],
    regex: /\bassert\s+.*(?:auth|permission|allowed|admin|role|access|token|password|secret)/gi,
    explanation:
      "Python assert statements are removed when running with -O (optimized mode). Using assert for security checks means the check disappears in production.",
    verify_prompt:
      "Is this assert checking a security-relevant condition (authentication, " +
      "authorization, permissions)? If it's just a development/debug assertion, " +
      "respond FALSE_POSITIVE. If it guards a security boundary, respond CONFIRMED.",
    cwe: "CWE-617",
    fix_template: "Replace assert with: if not condition: raise PermissionError(...)",
  },
  {
    id: "py-008-path-traversal",
    title: "File open with user-controlled path (path traversal)",
    severity: "high",
    languages: ["python"],
    regex: /\bopen\s*\(\s*(?:f["']|.*\+.*|.*\.format\(|.*%\s)/g,
    explanation:
      "Opening files with paths constructed from user input allows path traversal (../../etc/passwd). Always validate and sanitize file paths.",
    verify_prompt:
      "Is the file path constructed from ANY external/user input? If the path " +
      "is entirely hardcoded or from trusted config, respond FALSE_POSITIVE. " +
      "If user input influences the path, respond CONFIRMED.",
    cwe: "CWE-22",
    fix_template: "Use os.path.abspath() + check it starts with expected base directory.",
  },
];

// ═══════════════════════════════════════════════════════════════
// JavaScript / TypeScript Patterns
// ═══════════════════════════════════════════════════════════════

export const JS_PATTERNS: BugPattern[] = [
  {
    id: "js-001-eval",
    title: "eval() with potentially untrusted input",
    severity: "critical",
    languages: ["javascript", "typescript"],
    regex: /\beval\s*\(/g,
    explanation: "eval() executes arbitrary JavaScript. If input is user-controlled, this is XSS/RCE.",
    verify_prompt: "Is the argument entirely hardcoded or internal? If ANY external input reaches eval(), respond CONFIRMED.",
    cwe: "CWE-95",
    fix_template: "Remove eval() or use JSON.parse() for data, Function constructor for controlled cases.",
  },
  {
    id: "js-002-innerhtml",
    title: "innerHTML/outerHTML with dynamic content (XSS)",
    severity: "high",
    languages: ["javascript", "typescript"],
    regex: /\.(innerHTML|outerHTML)\s*=\s*(?!["'`]\s*$)/g,
    explanation: "Setting innerHTML with dynamic content enables XSS. Use textContent or a sanitizer.",
    verify_prompt: "Is the assigned value from user input or external data? If hardcoded HTML, respond FALSE_POSITIVE.",
    cwe: "CWE-79",
    fix_template: "Use element.textContent = value, or DOMPurify.sanitize(html).",
  },
  {
    id: "js-003-prototype-pollution",
    title: "Object merge/assign without prototype pollution guard",
    severity: "high",
    languages: ["javascript", "typescript"],
    regex: /\b(?:Object\.assign|_\.merge|_\.extend|_\.defaultsDeep)\s*\([^,]+,\s*(?:req\.|params\.|body\.|query\.|input)/g,
    explanation: "Merging user input into objects without filtering __proto__, constructor, prototype allows prototype pollution → RCE in some frameworks.",
    verify_prompt: "Does the source object come from untrusted input (request body, query params)? If internal-only, respond FALSE_POSITIVE.",
    cwe: "CWE-1321",
    fix_template: "Filter dangerous keys: delete input.__proto__; delete input.constructor; or use structuredClone().",
  },
  {
    id: "js-004-nosql-injection",
    title: "NoSQL query with user input (injection risk)",
    severity: "high",
    languages: ["javascript", "typescript"],
    regex: /\b(?:find|findOne|updateOne|deleteOne|aggregate)\s*\(\s*\{[^}]*(?:req\.|params\.|body\.|query\.)/g,
    explanation: "MongoDB queries with user-controlled operators ($gt, $ne, $regex) enable NoSQL injection.",
    verify_prompt: "Is user input passed directly as a query filter without sanitization? If parameterized/validated, respond FALSE_POSITIVE.",
    cwe: "CWE-943",
    fix_template: "Validate/cast input types explicitly: { email: String(req.body.email) }",
  },
  {
    id: "js-005-regex-dos",
    title: "Regex with user input (ReDoS risk)",
    severity: "medium",
    languages: ["javascript", "typescript"],
    regex: /new\s+RegExp\s*\(\s*(?:req\.|params\.|body\.|query\.|input|arg|user)/g,
    explanation: "Constructing regex from user input enables ReDoS (catastrophic backtracking). An attacker can send a pattern that hangs the event loop.",
    verify_prompt: "Is the regex pattern from user input? If from internal/hardcoded source, respond FALSE_POSITIVE.",
    cwe: "CWE-1333",
    fix_template: "Use a regex timeout library, or escape user input with escapeRegExp().",
  },
  {
    id: "js-006-hardcoded-secret",
    title: "Hardcoded secret/key in JavaScript/TypeScript",
    severity: "high",
    languages: ["javascript", "typescript"],
    regex: /(?:SECRET|API_KEY|PRIVATE_KEY|PASSWORD|TOKEN|AUTH)\s*[:=]\s*["'][A-Za-z0-9+/=_-]{16,}["']/g,
    explanation: "Hardcoded secrets in source code are exposed to anyone with repo access.",
    verify_prompt: "Is this a real secret or a placeholder/test value? If it looks like a real key (long, random), respond CONFIRMED.",
    cwe: "CWE-798",
    fix_template: "Use process.env.SECRET_KEY or a secrets manager.",
  },
  {
    id: "js-007-command-injection",
    title: "Shell command with template literal (injection)",
    severity: "critical",
    languages: ["javascript", "typescript"],
    regex: /\b(?:exec|execSync|spawn|spawnSync)\s*\(\s*`/g,
    explanation: "Running shell commands with template literals allows injection if any interpolated value is user-controlled.",
    verify_prompt: "Does the template literal include ANY external input? If entirely hardcoded, respond FALSE_POSITIVE.",
    cwe: "CWE-78",
    fix_template: "Use spawn/execFile with array args instead of shell string.",
  },
];

// ═══════════════════════════════════════════════════════════════
// Go Patterns
// ═══════════════════════════════════════════════════════════════

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
];

// ═══════════════════════════════════════════════════════════════
// Rust Patterns
// ═══════════════════════════════════════════════════════════════

export const RUST_PATTERNS: BugPattern[] = [
  {
    id: "rs-001-unsafe-block",
    title: "unsafe block (manual review needed)",
    severity: "medium",
    languages: ["rust"],
    regex: /\bunsafe\s*\{/g,
    explanation: "unsafe blocks bypass Rust's borrow checker. Memory corruption, use-after-free, and data races are possible inside unsafe.",
    verify_prompt: "Is this unsafe block well-documented with a SAFETY comment explaining why it's sound? If properly justified, respond FALSE_POSITIVE. If no safety comment, respond CONFIRMED.",
    cwe: "CWE-787",
    fix_template: "Add a // SAFETY: comment, or refactor to avoid unsafe.",
  },
  {
    id: "rs-002-unwrap-panic",
    title: "unwrap()/expect() on Result/Option (panic risk)",
    severity: "low",
    languages: ["rust"],
    regex: /\.\s*(?:unwrap|expect)\s*\(\s*\)/g,
    explanation: "unwrap() panics on None/Err. In server code, this crashes the process. Use proper error handling with ? operator.",
    verify_prompt: "Is this in application code that should handle errors gracefully, or in test/CLI code where panicking is acceptable? If test code, respond FALSE_POSITIVE.",
    cwe: "CWE-754",
    fix_template: "Replace .unwrap() with .map_err(|e| ...)? or .unwrap_or_default().",
  },
  {
    id: "rs-003-sql-injection",
    title: "SQL query with format! macro (injection risk)",
    severity: "critical",
    languages: ["rust"],
    regex: /\b(?:query|execute)\s*\(\s*&?format!\s*\(/g,
    explanation: "SQL queries built with format!() are vulnerable to injection. Use parameterized queries.",
    verify_prompt: "Is user input interpolated via format!()? If parameterized ($1, ?), respond FALSE_POSITIVE.",
    cwe: "CWE-89",
    fix_template: 'Use sqlx::query("SELECT * FROM t WHERE id = $1").bind(id).',
  },
];

// ═══════════════════════════════════════════════════════════════
// Java Patterns
// ═══════════════════════════════════════════════════════════════

export const JAVA_PATTERNS: BugPattern[] = [
  {
    id: "java-001-sql-injection",
    title: "SQL query with string concatenation",
    severity: "critical",
    languages: ["java"],
    regex: /\b(?:executeQuery|executeUpdate|execute|prepareStatement)\s*\(\s*(?:".*"\s*\+|.*\+\s*")/g,
    explanation: "SQL queries built with string concatenation are vulnerable to injection. Use PreparedStatement with parameterized queries.",
    verify_prompt: "Is user input concatenated into the SQL string? If using PreparedStatement with ?, respond FALSE_POSITIVE.",
    cwe: "CWE-89",
    fix_template: 'Use PreparedStatement: ps = conn.prepareStatement("SELECT * FROM t WHERE id = ?"); ps.setString(1, id);',
  },
  {
    id: "java-002-deserialization",
    title: "Unsafe deserialization (ObjectInputStream)",
    severity: "critical",
    languages: ["java"],
    regex: /\bObjectInputStream\s*\(/g,
    explanation: "Java ObjectInputStream deserializes arbitrary objects. Attackers can craft payloads that execute code on deserialization (Commons Collections gadget chain, etc.).",
    verify_prompt: "Is the input stream from a trusted source (local file, internal service) or untrusted (network, user upload)? CONFIRMED if untrusted.",
    cwe: "CWE-502",
    fix_template: "Use JSON/Protobuf instead, or add a whitelist ObjectInputFilter.",
  },
  {
    id: "java-003-xxe",
    title: "XML parser without XXE protection",
    severity: "high",
    languages: ["java"],
    regex: /\b(?:DocumentBuilderFactory|SAXParserFactory|XMLInputFactory)\.newInstance\s*\(/g,
    explanation: "Default XML parsers in Java are vulnerable to XXE (XML External Entity) attacks. Disable external entities.",
    verify_prompt: "Is setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true) or disallow-doctype-decl set? If protected, respond FALSE_POSITIVE.",
    cwe: "CWE-611",
    fix_template: 'factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);',
  },
  {
    id: "java-004-path-traversal",
    title: "File path from user input (path traversal)",
    severity: "high",
    languages: ["java"],
    regex: /new\s+File\s*\(\s*(?:request\.|param|input|arg)/g,
    explanation: "Creating File objects from user input allows path traversal (../../etc/passwd).",
    verify_prompt: "Is the file path derived from user/external input? If from internal config, respond FALSE_POSITIVE.",
    cwe: "CWE-22",
    fix_template: "Validate path: canonical = new File(base, input).getCanonicalPath(); if (!canonical.startsWith(base)) throw;",
  },
];

// ═══════════════════════════════════════════════════════════════
// Swift Patterns
// ═══════════════════════════════════════════════════════════════

export const SWIFT_PATTERNS: BugPattern[] = [
  {
    id: "swift-001-force-unwrap",
    title: "Force unwrap (!) on Optional (crash risk)",
    severity: "medium",
    languages: ["swift"],
    regex: /\w+!\s*\./g,
    explanation: "Force unwrapping with ! crashes at runtime if the value is nil. Use guard let, if let, or ?? instead.",
    verify_prompt: "Is this force unwrap in production code where nil is a realistic possibility? If the value is guaranteed non-nil (e.g. IBOutlet after viewDidLoad, known-good constant), respond FALSE_POSITIVE.",
    cwe: "CWE-476",
    fix_template: "Replace var! with guard let var = var else { return } or var ?? defaultValue.",
  },
  {
    id: "swift-002-force-try",
    title: "try! force try (crash on error)",
    severity: "medium",
    languages: ["swift"],
    regex: /\btry!\s/g,
    explanation: "try! crashes the app if the function throws. Use do/catch or try? for graceful error handling.",
    verify_prompt: "Is this try! in production code or test code? If the throwing function is guaranteed to succeed (e.g. known-good regex), respond FALSE_POSITIVE. If it could fail at runtime, respond CONFIRMED.",
    cwe: "CWE-754",
    fix_template: "Replace try! with do { try ... } catch { handle error } or try? with default.",
  },
  {
    id: "swift-003-insecure-http",
    title: "HTTP (not HTTPS) URL in production code",
    severity: "high",
    languages: ["swift"],
    regex: /URL\s*\(\s*string:\s*"http:\/\/(?!localhost|127\.0\.0\.1)/g,
    explanation: "Using HTTP instead of HTTPS exposes data to man-in-the-middle attacks. App Transport Security (ATS) blocks this by default on iOS.",
    verify_prompt: "Is this URL for a local development server or a production endpoint? If localhost/dev, respond FALSE_POSITIVE. If production, respond CONFIRMED.",
    cwe: "CWE-319",
    fix_template: "Change http:// to https://.",
  },
  {
    id: "swift-004-keychain-no-access",
    title: "UserDefaults for sensitive data (should use Keychain)",
    severity: "high",
    languages: ["swift"],
    regex: /UserDefaults\b.*(?:password|token|secret|key|credential|auth)/gi,
    explanation: "UserDefaults is stored unencrypted on disk. Sensitive data (passwords, tokens) should use Keychain Services.",
    verify_prompt: "Is the value being stored actually sensitive (password, auth token, API key)? If it's a non-sensitive preference, respond FALSE_POSITIVE.",
    cwe: "CWE-312",
    fix_template: "Use KeychainAccess library or Security framework: SecItemAdd/SecItemCopyMatching.",
  },
  {
    id: "swift-005-hardcoded-secret",
    title: "Hardcoded secret/API key in Swift",
    severity: "high",
    languages: ["swift"],
    regex: /(?:apiKey|secretKey|password|token|authToken)\s*[:=]\s*"[A-Za-z0-9+/=_-]{16,}"/g,
    explanation: "Hardcoded secrets in source code are exposed to anyone with app binary access (strings can be extracted from .ipa).",
    verify_prompt: "Is this a real API key or a placeholder/example? If it looks like a real key (long random string), respond CONFIRMED.",
    cwe: "CWE-798",
    fix_template: "Load from Info.plist (excluded from repo) or a secrets manager.",
  },
  {
    id: "swift-006-webview-js",
    title: "WKWebView with JavaScript enabled loading external content",
    severity: "high",
    languages: ["swift"],
    regex: /WKWebViewConfiguration\b[\s\S]{0,200}?javaScriptEnabled\s*=\s*true/g,
    explanation: "WKWebView with JavaScript enabled loading untrusted content can execute malicious scripts with access to native bridges.",
    verify_prompt: "Does this WebView load external/untrusted URLs? If it only loads local HTML or trusted internal content, respond FALSE_POSITIVE.",
    cwe: "CWE-79",
    fix_template: "Disable JS if not needed, or restrict navigation with WKNavigationDelegate.",
  },
];

// ═══════════════════════════════════════════════════════════════
// Cross-language Patterns (shell, HTML, config, etc.)
// ═══════════════════════════════════════════════════════════════

export const UNIVERSAL_PATTERNS: BugPattern[] = [
  // Shell
  {
    id: "sh-001-eval-injection",
    title: "eval with variable expansion in shell script",
    severity: "critical",
    languages: ["c", "cpp", "python", "javascript", "typescript", "go", "rust", "java"],
    regex: /\beval\s+["']?\$[\{(]/g,
    explanation: "eval with variable expansion in shell enables command injection.",
    verify_prompt: "Is the variable from trusted internal source or user input? CONFIRMED if user-controlled.",
    cwe: "CWE-78",
    fix_template: "Avoid eval in shell. Use direct execution or arrays for args.",
  },
  // Hardcoded IPs / URLs
  {
    id: "uni-001-hardcoded-ip",
    title: "Hardcoded IP address or internal URL",
    severity: "low",
    languages: ["python", "javascript", "typescript", "go", "java", "c", "cpp", "rust"],
    regex: /["']\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d+)?["']/g,
    explanation: "Hardcoded IP addresses make the code environment-dependent and may expose internal infrastructure.",
    verify_prompt: "Is this IP 127.0.0.1/localhost or 0.0.0.0 (standard)? If standard loopback, respond FALSE_POSITIVE. If it's a specific internal/production IP, respond CONFIRMED.",
    cwe: "CWE-798",
    fix_template: "Move to configuration file or environment variable.",
  },
  // TODO/FIXME security markers
  {
    id: "uni-002-security-todo",
    title: "Security-related TODO/FIXME/HACK comment",
    severity: "medium",
    languages: ["python", "javascript", "typescript", "go", "java", "c", "cpp", "rust"],
    regex: /(?:TODO|FIXME|HACK|XXX).*(?:security|auth|password|token|secret|vuln|inject|sanitiz|escap)/gi,
    explanation: "A developer left a security-related TODO. This may indicate a known vulnerability that was deferred.",
    verify_prompt: "Is this TODO about a real security concern that hasn't been addressed? If it's already fixed (comment is stale), respond FALSE_POSITIVE.",
    cwe: "CWE-1035",
    fix_template: "Address the security concern or remove the stale comment.",
  },
];

// ─── Registry ───────────────────────────────────────────────────

const ALL_PATTERNS: BugPattern[] = [
  ...CPP_PATTERNS,
  ...PYTHON_PATTERNS,
  ...JS_PATTERNS,
  ...GO_PATTERNS,
  ...RUST_PATTERNS,
  ...JAVA_PATTERNS,
  ...SWIFT_PATTERNS,
  ...UNIVERSAL_PATTERNS,
];

/**
 * Return all patterns applicable to the given language.
 */
export function getPatternsForLanguage(lang: string): BugPattern[] {
  return ALL_PATTERNS.filter((p) => p.languages.includes(lang as never));
}

/**
 * Look up a pattern by ID.
 */
export function getPatternById(id: string): BugPattern | undefined {
  return ALL_PATTERNS.find((p) => p.id === id);
}

/**
 * All patterns across all languages.
 */
export function getAllPatterns(): BugPattern[] {
  return [...ALL_PATTERNS];
}
