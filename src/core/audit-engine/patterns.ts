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
    regex:
      /(?<!\b(?:char|unsigned|signed|int|short|long|uint8_t|uint16_t|uint32_t|int8_t|int16_t|int32_t|size_t|float|double|bool|void|std::\w+|u_char|u_int8_t|u_int16_t|u_int32_t)\s)(?<!\w)(data|buffer|buf|packet|msg|payload)\s*\[\s*([2-9]|[1-9]\d)\s*\]/g,
    explanation:
      "Accessing `data[N]` with a hardcoded index without first validating size. Malformed input → out-of-bounds read.",
    verify_prompt:
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      "1. Is the buffer a FIXED-SIZE local array (e.g. `char buf[16]`) where sizeof >= N+1? → FALSE_POSITIVE\n" +
      "2. Is there an `if (len < N)` or `if (bytes < N)` check BEFORE this access in the same function? → FALSE_POSITIVE\n" +
      "3. Is the buffer filled by a function that guarantees minimum size (e.g. MD5 always outputs 16 bytes)? → FALSE_POSITIVE\n" +
      "4. Is this a compile-time constant buffer with known size (e.g. MD5_DIGEST_LENGTH)? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if the buffer size comes from UNTRUSTED external input " +
      "(network packet, file, user data) AND no size check exists before the access.",
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
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      "1. Is the source a short string LITERAL (e.g. \"key:\", \"(*)\", \"sometime\")? → FALSE_POSITIVE\n" +
      "2. Is there a malloc/calloc BEFORE this call that allocates strlen(src)+1 or more? → FALSE_POSITIVE\n" +
      "3. Is the destination a fixed-size buffer AND the source is a known-short constant? → FALSE_POSITIVE\n" +
      "4. Is this in test code, example code, or documentation? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if the source is from UNTRUSTED external input (network, file, user) " +
      "AND no allocation or size check accounts for it.",
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
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      "1. Is the length validated with `if (len > max)` or `MIN(len, max)` before memcpy? → FALSE_POSITIVE\n" +
      "2. Is the destination allocated with the SAME length (e.g. `dst = malloc(len)`)? → FALSE_POSITIVE\n" +
      "3. Is the length a sizeof() expression or compile-time constant? → FALSE_POSITIVE\n" +
      "4. Is this copying between two fields of the SAME struct (internal copy)? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if the length comes from UNTRUSTED input AND neither " +
      "the destination size nor a bounds check constrains it.",
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
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      "1. Is the loop bound set from a TRUSTED source (hardware, kernel, compile-time constant)? → FALSE_POSITIVE\n" +
      "2. Is there a `if (bound > MAX)` check before this loop? → FALSE_POSITIVE\n" +
      "3. Does the loop body have an early `break` or `return` that limits iterations? → FALSE_POSITIVE\n" +
      "4. Is the bound from a struct that was ALREADY validated during parsing? → FALSE_POSITIVE\n" +
      "5. Is this iterating over an internally-allocated array whose size matches the bound? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if the bound comes from UNTRUSTED external input (network, file, " +
      "ASN.1, protocol field) AND no upstream validation caps it.",
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
      "Is the argument to eval()/exec() derived from external/untrusted input? " +
      "Respond CONFIRMED only if the argument includes user request params, " +
      "HTTP body, query strings, websocket messages, or database values that " +
      "originate from users. " +
      "Respond FALSE_POSITIVE for ALL of the following safe patterns: " +
      "(1) exec(open('hardcoded/local/path.py').read()) — simulation framework " +
      "convention (NASA Trick, Matlab, etc.) for including local config scripts; " +
      "(2) eval() or exec() on a hardcoded string literal; " +
      "(3) exec() in test harness, conftest.py, or fixture setup; " +
      "(4) eval() in CLI/REPL tools that intentionally run user expressions " +
      "in a sandbox (e.g., IPython, Jupyter, debugger); " +
      "(5) exec(compile(...)) patterns from code-generation or template engines " +
      "where the source is an internal template, not user input; " +
      "(6) eval/exec in migration scripts, build scripts, or setup.py; " +
      "(7) exec() where the file path being opened is a relative hardcoded " +
      "string constant (not computed from variables or user input). " +
      "The key question: does an ATTACKER control the string being eval'd/exec'd? " +
      "If the string comes entirely from files the developer controls, it's safe.",
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
  {
    id: "py-009-pickle-untrusted",
    title: "pickle.load() on untrusted data (arbitrary code execution)",
    severity: "critical",
    languages: ["python"],
    regex: /\bpickle\.loads?\s*\(\s*(?:request|data|payload|body|content|recv|read|input)/g,
    explanation:
      "pickle.load() on data from network, user upload, or any untrusted source allows arbitrary code execution. An attacker can craft a pickle payload that runs shell commands on deserialization.",
    verify_prompt:
      "Is the data passed to pickle.load() from an UNTRUSTED source (network, " +
      "user upload, API response, shared storage)? If the pickle data is from a " +
      "local file written only by the same application, respond FALSE_POSITIVE. " +
      "If from any external source, respond CONFIRMED.",
    cwe: "CWE-502",
    fix_template: "Use json.loads() or a safe serialization format. If pickle is required, use hmac-signed pickles with a secret key.",
  },
  {
    id: "py-010-assert-validation",
    title: "assert used for input validation (stripped in -O mode)",
    severity: "medium",
    languages: ["python"],
    regex: /\bassert\s+(?:isinstance|len|type|int|str|float|0\s*<|0\s*<=|\w+\s*(?:>|<|>=|<=|!=|==)\s*\d)/g,
    explanation:
      "assert statements are removed when Python runs with -O (optimized) or -OO flags. Using assert for input validation means the check disappears in production.",
    verify_prompt:
      "Is this assert validating external input or function arguments that could " +
      "be wrong at runtime? If it's a debug-only invariant that documents assumptions " +
      "and is never exposed to external data, respond FALSE_POSITIVE. If it guards " +
      "against bad input, respond CONFIRMED.",
    cwe: "CWE-617",
    fix_template: "Replace assert with: if not condition: raise ValueError('...')",
  },
  {
    id: "py-011-eq-without-hash",
    title: "__eq__ defined without __hash__ (breaks sets/dicts)",
    severity: "medium",
    languages: ["python"],
    regex: /def\s+__eq__\s*\(\s*self[\s\S]{0,500}?(?!def\s+__hash__)/g,
    explanation:
      "Defining __eq__ without __hash__ makes the class unhashable in Python 3. Objects cannot be used in sets or as dict keys, and may cause subtle bugs if inherited __hash__ produces inconsistent results.",
    verify_prompt:
      "Does this class define __eq__ but NOT __hash__? Check the full class body. " +
      "If __hash__ is defined elsewhere in the class, respond FALSE_POSITIVE. " +
      "If the class is intentionally unhashable (e.g. mutable container), respond " +
      "FALSE_POSITIVE. If __hash__ is missing and the object may be used in sets/dicts, respond CONFIRMED.",
    cwe: "CWE-697",
    fix_template: "Add __hash__ that returns hash of the same fields used in __eq__, or set __hash__ = None explicitly.",
  },
  {
    id: "py-012-mutable-default-arg",
    title: "Mutable default argument (shared between calls)",
    severity: "medium",
    languages: ["python"],
    regex: /def\s+\w+\s*\([^)]*(?::\s*(?:list|dict|set)\s*=\s*(?:\[\]|\{\}|set\(\))|=\s*(?:\[\]|\{\}))/g,
    explanation:
      "Mutable default arguments (def foo(x=[])) are created once and shared across all calls. Appending to them accumulates state between invocations, causing hard-to-debug issues.",
    verify_prompt:
      "Is this default argument a mutable object (list, dict, set) that gets modified " +
      "inside the function? If the function never mutates the default (only reads), " +
      "respond FALSE_POSITIVE. If it appends/modifies the default, respond CONFIRMED.",
    cwe: "CWE-665",
    fix_template: "Use None as default and create inside: def foo(x=None): x = x if x is not None else []",
  },
  {
    id: "py-013-bare-except",
    title: "Bare except: catches SystemExit and KeyboardInterrupt",
    severity: "medium",
    languages: ["python"],
    regex: /\bexcept\s*:/g,
    explanation:
      "A bare except: clause catches ALL exceptions including SystemExit (sys.exit()), KeyboardInterrupt (Ctrl+C), and GeneratorExit. This can prevent clean shutdown and make the program unkillable.",
    verify_prompt:
      "Is this a bare except: (no exception type specified)? If it catches a specific " +
      "exception type like except Exception: or except ValueError:, respond FALSE_POSITIVE. " +
      "If it's truly bare except:, respond CONFIRMED.",
    cwe: "CWE-396",
    fix_template: "Replace except: with except Exception: to allow SystemExit and KeyboardInterrupt to propagate.",
  },
  {
    id: "py-014-late-binding-closure",
    title: "Late binding closure in loop (captures variable reference)",
    severity: "medium",
    languages: ["python"],
    regex: /for\s+(\w+)\s+in\s+[\s\S]{0,100}?(?:lambda\s*[^:]*:\s*\1\b|lambda\s*:\s*\1\b)/g,
    explanation:
      "Closures in Python capture variables by reference, not value. A lambda defined inside a loop that references the loop variable will use the FINAL value of that variable when called, not the value at the time of definition.",
    verify_prompt:
      "Does the lambda/closure reference a loop variable without binding it as a " +
      "default argument? If the variable is bound via default arg (lambda x=x: ...), " +
      "respond FALSE_POSITIVE. If it references the loop variable directly, respond CONFIRMED.",
    cwe: "CWE-758",
    fix_template: "Bind via default arg: lambda i=i: i, or use functools.partial().",
  },
  {
    id: "py-015-os-system-user-input",
    title: "os.system() with user-controlled input",
    severity: "critical",
    languages: ["python"],
    regex: /\bos\.system\s*\(\s*(?:f["']|.*\+|.*\.format\(|.*%\s)/g,
    explanation:
      "os.system() runs commands through the shell. If any part of the command string comes from user input, this is a command injection vulnerability.",
    verify_prompt:
      "Does the command string include ANY external/user input? If the entire command " +
      "is a hardcoded constant with no interpolation, respond FALSE_POSITIVE. " +
      "If any variable is interpolated, respond CONFIRMED.",
    cwe: "CWE-78",
    fix_template: "Use subprocess.run([...], shell=False) with a list of arguments.",
  },
  {
    id: "py-016-tempfile-mktemp",
    title: "tempfile.mktemp() race condition (use mkstemp)",
    severity: "medium",
    languages: ["python"],
    regex: /\btempfile\.mktemp\s*\(/g,
    explanation:
      "tempfile.mktemp() returns a filename but does not create it, creating a TOCTOU race condition. An attacker can create a symlink at that path between mktemp() and open(), leading to symlink attacks.",
    verify_prompt:
      "Is this code using tempfile.mktemp() to generate a temporary filename? " +
      "If it uses mkstemp(), NamedTemporaryFile, or TemporaryDirectory instead, " +
      "respond FALSE_POSITIVE. If mktemp(), respond CONFIRMED.",
    cwe: "CWE-377",
    fix_template: "Use tempfile.mkstemp() (returns fd+name atomically) or tempfile.NamedTemporaryFile().",
  },
  {
    id: "py-017-hardcoded-secret-assign",
    title: "Hardcoded secret or API key in assignment",
    severity: "high",
    languages: ["python"],
    regex: /(?:api_key|api_secret|aws_secret|private_key|database_password|db_password)\s*=\s*["'][A-Za-z0-9+/=_-]{12,}["']/gi,
    explanation:
      "Hardcoded secrets in source code are exposed to anyone with repository access and persist in git history even after deletion.",
    verify_prompt:
      "Is this a REAL secret or a placeholder (e.g. 'your-key-here', 'changeme', " +
      "'xxx', 'test')? If it looks like a real credential (long, random string), " +
      "respond CONFIRMED. If placeholder or test, respond FALSE_POSITIVE.",
    cwe: "CWE-798",
    fix_template: "Use os.environ.get('API_KEY') or a secrets manager (AWS Secrets Manager, Vault).",
  },
  {
    id: "py-018-re-no-raw-string",
    title: "re.compile/re.match without raw string (backslash issues)",
    severity: "low",
    languages: ["python"],
    regex: /\bre\.(?:compile|match|search|findall|sub)\s*\(\s*"(?:[^"]*\\[dDwWsSbB])/g,
    explanation:
      "Using regular strings instead of raw strings (r'...') with regex causes backslash escaping confusion. Python processes \\d as an escape sequence before re sees it. Use r'\\d' instead of '\\\\d'.",
    verify_prompt:
      "Is this regex using a regular string (not r'...') with backslash sequences " +
      "like \\d, \\w, \\s? If it uses a raw string r'...', respond FALSE_POSITIVE. " +
      "If the backslashes are doubled correctly (\\\\d), respond FALSE_POSITIVE. " +
      "If single backslashes in a non-raw string, respond CONFIRMED.",
    cwe: "CWE-185",
    fix_template: "Use raw strings: re.compile(r'\\d+') instead of re.compile('\\\\d+')",
  },
  {
    id: "py-019-fstring-logging",
    title: "f-string in logging call (always evaluates)",
    severity: "low",
    languages: ["python"],
    regex: /\blogger\.(?:debug|info|warning|error|critical)\s*\(\s*f["']/g,
    explanation:
      "Using f-strings in logging always evaluates the string even if the log level is disabled. This wastes CPU on string formatting and can cause errors if the interpolated values are expensive or have side effects. Use lazy % formatting.",
    verify_prompt:
      "Is this a logging call using an f-string? If the string is simple and cheap, " +
      "respond FALSE_POSITIVE. If it involves expensive computation (database queries, " +
      "serialization, repr of large objects), respond CONFIRMED.",
    cwe: "CWE-400",
    fix_template: "Use lazy formatting: logger.debug('Value: %s', expensive_value) instead of logger.debug(f'Value: {expensive_value}')",
  },
  {
    id: "py-020-global-keyword",
    title: "global keyword usage (code smell, shared mutable state)",
    severity: "low",
    languages: ["python"],
    regex: /^\s*global\s+\w+/gm,
    explanation:
      "The global keyword creates shared mutable state that makes code harder to test, reason about, and maintain. It can cause subtle bugs in multi-threaded code and makes dependency injection impossible.",
    verify_prompt:
      "Is this global used for a legitimate module-level state pattern? " +
      "Respond FALSE_POSITIVE for any of: " +
      "(1) module-level logger, (2) configuration / settings cache, " +
      "(3) singleton lazy-init (e.g., `_instance`, `_client`, `_pool`), " +
      "(4) circuit breaker state (`_circuit_open_until`, `_failure_count`, `_last_failure`), " +
      "(5) rate limiter / token bucket state, " +
      "(6) connection pool / HTTP session reuse, " +
      "(7) feature flag cache or hot-reloaded config, " +
      "(8) memoization / LRU cache implementation, " +
      "(9) test fixtures or pytest monkeypatch setup. " +
      "These are all well-known Python patterns where module-level state is idiomatic. " +
      "Only respond CONFIRMED if the global is used to pass arbitrary state between " +
      "unrelated functions in a way that suggests the code should have been a class.",
    cwe: "CWE-1054",
    fix_template: "Pass the value as a function parameter, use a class to encapsulate state, or use a module-level constant.",
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
    verify_prompt: "Is the argument entirely hardcoded or internal? If ANY external input reaches eval(), respond CONFIRMED." +
      "\n\nRespond FALSE_POSITIVE if ANY of these is true:\n" +
      "1. The argument is a compile-time constant or hardcoded string literal\n" +
      "2. The input comes from a trusted internal source (not user/network input)\n" +
      "3. This is in test/example/documentation code\n" +
      "4. The eval is used for JSON.parse fallback on a validated string\n" +
      "Only respond CONFIRMED if user-controlled or external input can reach the eval() argument.",
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
    verify_prompt: "Is this a real secret or a placeholder/test value? If it looks like a real key (long, random), respond CONFIRMED." +
      "\n\nRespond FALSE_POSITIVE if ANY of these is true:\n" +
      "1. The value is a placeholder ('changeme', 'xxx', 'your-api-key-here', 'TODO', 'REPLACE_ME')\n" +
      "2. This is in test, example, or documentation code\n" +
      "3. The value is loaded from an environment variable (process.env.X)\n" +
      "4. The value is a well-known public key or non-secret identifier\n" +
      "Only respond CONFIRMED if the value appears to be a real secret committed to source code in production code.",
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
  {
    id: "js-008-prototype-pollution-bracket",
    title: "Prototype pollution via bracket notation with user key",
    severity: "high",
    languages: ["javascript", "typescript"],
    regex: /\w+\[\s*(?:req\.|params\.|body\.|query\.|input|key|prop|name|field)\w*\s*\]\s*=/g,
    explanation:
      "Setting object properties via bracket notation with a user-controlled key allows prototype pollution. An attacker can set __proto__.isAdmin = true to affect all objects.",
    verify_prompt:
      "Is the key (property name) from user/external input? Check if __proto__, " +
      "constructor, or prototype keys are filtered. If there's a hasOwnProperty check " +
      "or allowlist, respond FALSE_POSITIVE. If user controls the key without filtering, respond CONFIRMED.",
    cwe: "CWE-1321",
    fix_template: "Validate keys: if (['__proto__', 'constructor', 'prototype'].includes(key)) return; or use Map instead of plain objects.",
  },
  {
    id: "js-009-redos-nested-quantifier",
    title: "ReDoS: regex with nested quantifiers on user input",
    severity: "high",
    languages: ["javascript", "typescript"],
    regex: /new\s+RegExp\s*\([^)]*\)[\s\S]{0,100}?\.(?:test|match|exec)\s*\(\s*(?:req\.|params\.|body\.|query\.|input|user)/g,
    explanation:
      "Regex with nested quantifiers (e.g., (a+)+, (a|b)*c) on user input can cause catastrophic backtracking (ReDoS), freezing the event loop for minutes or hours.",
    verify_prompt:
      "Does this regex run on user-controlled input? If the input is from a trusted " +
      "source or the regex has no nested quantifiers/alternation, respond FALSE_POSITIVE. " +
      "If user input hits a complex regex, respond CONFIRMED.",
    cwe: "CWE-1333",
    fix_template: "Use re2 library for safe regex, or add input length limits and timeouts.",
  },
  {
    id: "js-010-innerhtml-xss",
    title: "innerHTML assignment with dynamic content (XSS)",
    severity: "high",
    languages: ["javascript", "typescript"],
    regex: /\.innerHTML\s*(?:=|\+=)\s*(?!["'`]\s*;)(?:.*\+|`[^`]*\$\{)/g,
    explanation:
      "Assigning dynamic content to innerHTML enables XSS. Attacker-controlled HTML can execute scripts, steal cookies, and hijack sessions.",
    verify_prompt:
      "Is the assigned value constructed from user input or external data? " +
      "If it's entirely hardcoded HTML or sanitized with DOMPurify, respond FALSE_POSITIVE. " +
      "If any user data is concatenated or interpolated, respond CONFIRMED.",
    cwe: "CWE-79",
    fix_template: "Use textContent for text, or sanitize: el.innerHTML = DOMPurify.sanitize(html).",
  },
  {
    id: "js-011-eval-new-function",
    title: "new Function() with user input (code execution)",
    severity: "critical",
    languages: ["javascript", "typescript"],
    regex: /\bnew\s+Function\s*\(\s*(?:req\.|params\.|body\.|query\.|input|user|arg|data)/g,
    explanation:
      "new Function() creates a function from a string, equivalent to eval(). If the string contains user input, this is remote code execution.",
    verify_prompt:
      "Is the string passed to new Function() from user/external input? " +
      "If entirely hardcoded or from trusted internal source, respond FALSE_POSITIVE. " +
      "If any user data is interpolated, respond CONFIRMED.",
    cwe: "CWE-95",
    fix_template: "Avoid new Function() with dynamic strings. Use a safe expression parser or sandbox.",
  },
  {
    id: "js-012-event-listener-leak",
    title: "addEventListener without corresponding removeEventListener",
    severity: "low",
    languages: ["javascript", "typescript"],
    regex: /addEventListener\s*\(\s*["'][^"']+["']\s*,\s*(?:function|\([^)]*\)\s*=>|[a-zA-Z_]\w*)\s*\)/g,
    explanation:
      "Adding event listeners without removing them causes memory leaks, especially in SPAs where components mount/unmount. Each re-render adds another listener.",
    verify_prompt:
      "Is this addEventListener in a component or context that gets destroyed/unmounted? " +
      "If there's a corresponding removeEventListener in a cleanup/destroy/unmount handler, " +
      "respond FALSE_POSITIVE. If the listener is added repeatedly without cleanup, respond CONFIRMED.",
    cwe: "CWE-401",
    fix_template:
      "Store reference and remove in cleanup: const handler = () => {}; el.addEventListener('click', handler); // later: el.removeEventListener('click', handler);",
  },
  {
    id: "js-013-loose-equality",
    title: "Loose equality (==) instead of strict equality (===)",
    severity: "low",
    languages: ["javascript", "typescript"],
    regex: /[^!=<>]==[^=]/g,
    explanation:
      "The == operator performs type coercion, leading to surprising results: '' == false, 0 == '', null == undefined. This causes subtle bugs in conditionals.",
    verify_prompt:
      "Is this == comparison intentional for type coercion (e.g., x == null to check " +
      "both null and undefined)? If it's an intentional null-check idiom, respond " +
      "FALSE_POSITIVE. If it's comparing values that should use strict equality, respond CONFIRMED.",
    cwe: "CWE-697",
    fix_template: "Use === for strict equality, or == null specifically for null/undefined checks.",
  },
  {
    id: "js-014-json-parse-no-catch",
    title: "JSON.parse without try/catch (crash on invalid input)",
    severity: "medium",
    languages: ["javascript", "typescript"],
    regex: /(?<!try\s*\{[\s\S]{0,200}?)JSON\.parse\s*\(\s*(?:req\.|body\.|data|input|response|text|content)/g,
    explanation:
      "JSON.parse() throws SyntaxError on invalid JSON. Without try/catch, malformed input crashes the process or rejects the promise unhandled.",
    verify_prompt:
      "Is this JSON.parse() wrapped in a try/catch block? Check the surrounding " +
      "context (may be in an outer try block). If properly caught, respond FALSE_POSITIVE. " +
      "If no error handling exists, respond CONFIRMED.",
    cwe: "CWE-754",
    fix_template: "Wrap in try/catch: try { const obj = JSON.parse(data); } catch (e) { /* handle */ }",
  },
  {
    id: "js-015-promise-no-catch",
    title: "Promise chain without .catch() (unhandled rejection)",
    severity: "medium",
    languages: ["javascript", "typescript"],
    regex: /\.then\s*\([^)]+\)\s*(?:;|\n)(?!\s*\.catch)/g,
    explanation:
      "A Promise .then() chain without .catch() leads to unhandled promise rejections. In Node.js, unhandled rejections crash the process by default.",
    verify_prompt:
      "Does this promise chain have a .catch() handler anywhere in the chain? " +
      "If there's a .catch() further down, or it's inside an async function with try/catch, " +
      "respond FALSE_POSITIVE. If no error handler exists, respond CONFIRMED.",
    cwe: "CWE-755",
    fix_template: "Add .catch(err => { /* handle */ }) at the end of the chain, or use async/await with try/catch.",
  },
  {
    id: "js-016-open-redirect",
    title: "window.location set from user input (open redirect)",
    severity: "medium",
    languages: ["javascript", "typescript"],
    regex: /(?:window\.location|location\.href|location\.assign|location\.replace)\s*(?:=|\()\s*(?:req\.|params\.|query\.|input|user|data|url)/g,
    explanation:
      "Setting window.location from user-controlled input enables open redirect attacks. An attacker can craft a URL that redirects users to a phishing site.",
    verify_prompt:
      "Is the redirect URL from user/external input? If the URL is hardcoded or " +
      "validated against an allowlist of domains, respond FALSE_POSITIVE. " +
      "If user controls the full URL, respond CONFIRMED.",
    cwe: "CWE-601",
    fix_template:
      "Validate redirect URL against allowlist: const allowed = ['/dashboard', '/home']; if (allowed.includes(url)) location.href = url;",
  },
  {
    id: "js-017-hardcoded-secret-inline",
    title: "Hardcoded secret or API key in JavaScript/TypeScript",
    severity: "high",
    languages: ["javascript", "typescript"],
    regex: /(?:api[_-]?key|api[_-]?secret|auth[_-]?token|private[_-]?key)\s*[:=]\s*["'][A-Za-z0-9+/=_\-]{20,}["']/gi,
    explanation:
      "Hardcoded API keys and secrets in source code are exposed in git history, build artifacts, and client-side bundles. They can be extracted and abused.",
    verify_prompt:
      "Is this a REAL API key/secret or a placeholder/test value (e.g. 'test-key', " +
      "'your-api-key-here', 'sk-test-...')? If it looks like a real credential, " +
      "respond CONFIRMED. If placeholder or test, respond FALSE_POSITIVE.",
    cwe: "CWE-798",
    fix_template: "Use process.env.API_KEY or a secrets manager. Never commit real keys.",
  },
  {
    id: "js-018-document-write",
    title: "document.write() usage (XSS vector, performance issue)",
    severity: "medium",
    languages: ["javascript", "typescript"],
    regex: /\bdocument\.write(?:ln)?\s*\(/g,
    explanation:
      "document.write() can inject arbitrary HTML/scripts into the page. Called after page load, it replaces the entire document. It's both an XSS vector and a performance anti-pattern.",
    verify_prompt:
      "Is the argument to document.write() from user/external input? If entirely " +
      "hardcoded (e.g. analytics snippet), respond FALSE_POSITIVE. If dynamic " +
      "content or if called after DOMContentLoaded, respond CONFIRMED.",
    cwe: "CWE-79",
    fix_template: "Use DOM APIs: document.createElement() + appendChild(), or element.textContent for text.",
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

  // ── .unwrap() in non-test code ────────────────────────────────
  {
    id: "rs-004-unwrap-non-test",
    title: ".unwrap() in non-test production code",
    severity: "medium",
    languages: ["rust"],
    regex: /(?<!\#\[test\][\s\S]{0,500})\.\s*unwrap\s*\(\s*\)/g,
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
    regex: /\.expect\s*\(\s*"(?:failed|error|unexpected|should not happen|impossible|bug|todo|fixme|unreachable|panic|oops|crash)"\s*\)/gi,
    explanation:
      ".expect() should provide a meaningful error message explaining WHY the value should be present. Generic messages like \"failed\" give no debugging context when the panic occurs in production logs.",
    verify_prompt:
      "Does the .expect() message explain the specific condition that was expected? " +
      "If the message is descriptive (e.g., \"database connection must be initialized before query\"), " +
      "respond FALSE_POSITIVE. If it's generic (\"failed\", \"error\", \"should not happen\"), respond CONFIRMED.",
    cwe: "CWE-754",
    fix_template: "Use a descriptive message: .expect(\"config file must exist after init phase\")",
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
    fix_template: "Replace Mutex with RwLock: Arc<RwLock<T>>. Use .read() for shared access, .write() for exclusive.",
  },

  // ── Blocking in async ─────────────────────────────────────────
  {
    id: "rs-008-blocking-in-async",
    title: "Blocking call inside async function",
    severity: "high",
    languages: ["rust"],
    regex: /async\s+fn\s+\w+[\s\S]{0,500}?(?:std::thread::sleep|std::fs::\w+|std::net::\w+|\.read_to_string|\.write_all)\s*\(/g,
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
    fix_template: "Use references (&T), Cow<T>, or Arc<T> instead of cloning. Move allocation outside the loop.",
  },

  // ── Missing Send + Sync on async return ───────────────────────
  {
    id: "rs-010-async-send-sync",
    title: "Async function return not Send (cannot spawn across threads)",
    severity: "medium",
    languages: ["rust"],
    regex: /async\s+fn\s+\w+[^{]*->\s*(?:impl\s+Future|Box\s*<\s*dyn\s+Future)(?![\s\S]{0,50}?Send)/g,
    explanation:
      "Async functions that return impl Future without a Send bound cannot be spawned with tokio::spawn() or used in multi-threaded executors. This causes confusing compile errors downstream.",
    verify_prompt:
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      "1. Is this explicitly single-threaded (e.g., LocalSet, #[tokio::main(flavor = \"current_thread\")])? → FALSE_POSITIVE\n" +
      "2. Does the return type already include + Send? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if the future is used in a multi-threaded context without Send bound.",
    fix_template: "Add Send bound: -> impl Future<Output = T> + Send, or use Pin<Box<dyn Future + Send>>.",
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
      "1. Is the value a placeholder like \"changeme\", \"TODO\", \"test\", or \"example\"? → FALSE_POSITIVE\n" +
      "2. Is this in test code or documentation? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if it looks like a real credential in production code.",
    cwe: "CWE-798",
    fix_template: "Use std::env::var(\"SECRET_KEY\") or a config/secrets manager.",
  },

  // ── Panic in Drop ─────────────────────────────────────────────
  {
    id: "rs-012-panic-in-drop",
    title: "Potential panic inside Drop implementation",
    severity: "high",
    languages: ["rust"],
    regex: /impl\s+Drop\s+for\s+\w+[\s\S]{0,300}?(?:\.unwrap\(\)|\.expect\(|panic!\(|unreachable!\()/g,
    explanation:
      "Panicking inside a Drop implementation causes a double panic if the Drop runs during stack unwinding from another panic. This aborts the process immediately with no cleanup.",
    verify_prompt:
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      "1. Is the unwrap/expect on a value that is statically guaranteed to succeed? → FALSE_POSITIVE\n" +
      "2. Is there a std::thread::panicking() check before the panic-able code? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if the Drop impl can panic on a fallible operation.",
    cwe: "CWE-754",
    fix_template: "Use if let Ok(v) = ... or .unwrap_or_else(|_| default) instead of unwrap/expect in Drop.",
  },

  // ── Unbounded Vec from user input ─────────────────────────────
  {
    id: "rs-013-unbounded-vec",
    title: "Vec grown from untrusted input without capacity limit",
    severity: "high",
    languages: ["rust"],
    regex: /(?:Vec::with_capacity|Vec::new)\s*\([^)]*\)[\s\S]{0,300}?(?:\.push|\.extend|\.append)\s*\([^)]*(?:input|request|body|payload|data|recv|read)/g,
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
    fix_template: "Use safe alternatives: `as` casts, From/TryFrom, bytemuck::cast, or pointer::cast.",
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
    fix_template: "Use parameterized queries: sqlx::query(\"SELECT * FROM t WHERE id = $1\").bind(id).",
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
    verify_prompt: "Is the input stream from a trusted source (local file, internal service) or untrusted (network, user upload)? CONFIRMED if untrusted." +
      "\n\nRespond FALSE_POSITIVE if ANY of these is true:\n" +
      "1. The data comes from a trusted internal source (local file written by the same app, internal service)\n" +
      "2. An ObjectInputFilter or class whitelist is configured before deserialization\n" +
      "3. This is in test code deserializing test fixtures\n" +
      "4. The stream is wrapped in a filtering/validating decorator\n" +
      "Only respond CONFIRMED if the deserialized data originates from untrusted input (network, user upload, external API) without filtering.",
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

  // ── NullPointerException risk ──────────────────────────────────
  {
    id: "java-005-nullable-method-call",
    title: "Method call on nullable return without null check",
    severity: "high",
    languages: ["java"],
    regex: /\b(?:get|find|lookup|search|fetch|load|resolve|query)\w*\s*\([^)]*\)\s*\.\s*\w+\s*\(/g,
    explanation:
      "Calling a method on the return value of a get/find/lookup without checking for null first. If the lookup returns null, this throws NullPointerException.",
    verify_prompt:
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      "1. Does the method have a @NonNull/@NotNull annotation on its return type? → FALSE_POSITIVE\n" +
      "2. Is the return value an Optional that is being unwrapped with .get()? (separate pattern) → FALSE_POSITIVE\n" +
      "3. Is there a null check on the same variable earlier in the method? → FALSE_POSITIVE\n" +
      "4. Does the method contract guarantee non-null (e.g., getOrDefault, computeIfAbsent)? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if the method can return null AND no check exists.",
    cwe: "CWE-476",
    fix_template: "Add null check: Object result = getX(); if (result != null) { result.method(); }",
  },

  // ── Resource leak ──────────────────────────────────────────────
  {
    id: "java-006-resource-leak",
    title: "InputStream/Connection not in try-with-resources",
    severity: "medium",
    languages: ["java"],
    regex: /\b(?:InputStream|OutputStream|FileReader|FileWriter|BufferedReader|BufferedWriter|Connection|Statement|ResultSet|Socket|RandomAccessFile)\s+\w+\s*=\s*(?:new\s|.*\.(?:open|get|create))\s*[^;]*;(?![\s\S]{0,50}?\btry\b)/g,
    explanation:
      "A closeable resource is assigned but not wrapped in try-with-resources. If an exception is thrown before close(), the resource leaks.",
    verify_prompt:
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      "1. Is the resource declared inside a try-with-resources statement? → FALSE_POSITIVE\n" +
      "2. Is there a finally block that closes this resource? → FALSE_POSITIVE\n" +
      "3. Is the resource returned from the method (caller's responsibility)? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if the resource is opened, used, and no close mechanism exists.",
    cwe: "CWE-772",
    fix_template: "Wrap in try-with-resources: try (var stream = new FileInputStream(f)) { ... }",
  },

  // ── SQL injection in PreparedStatement ─────────────────────────
  {
    id: "java-007-sql-concat-prepared",
    title: "String concatenation in PreparedStatement SQL",
    severity: "critical",
    languages: ["java"],
    regex: /prepareStatement\s*\(\s*["'].*["']\s*\+/g,
    explanation:
      "Using string concatenation inside prepareStatement() defeats the purpose of parameterized queries. The concatenated part is still vulnerable to SQL injection.",
    verify_prompt:
      "Is user input being concatenated into the SQL string inside prepareStatement()? " +
      "If only constants (table names, column names) are concatenated, respond FALSE_POSITIVE. " +
      "If user-controlled values are concatenated, respond CONFIRMED.",
    cwe: "CWE-89",
    fix_template: "Use ? placeholders for ALL user values: prepareStatement(\"SELECT * FROM t WHERE id = ?\");",
  },

  // ── ConcurrentModificationException ────────────────────────────
  {
    id: "java-008-concurrent-modification",
    title: "Modifying collection while iterating",
    severity: "high",
    languages: ["java"],
    regex: /for\s*\(\s*\w+(?:\s*<[^>]*>)?\s+\w+\s*:\s*(\w+)\s*\)[\s\S]{0,300}?\1\s*\.(?:add|remove|clear)\s*\(/g,
    explanation:
      "Modifying a collection (add/remove/clear) while iterating over it with a for-each loop throws ConcurrentModificationException at runtime.",
    verify_prompt:
      "Is the collection being modified the SAME collection being iterated? " +
      "If they are different collections (e.g., iterating copy, modifying original), respond FALSE_POSITIVE. " +
      "If same collection, respond CONFIRMED.",
    cwe: "CWE-362",
    fix_template: "Use Iterator.remove(), or collect items to remove and process after the loop, or use ConcurrentHashMap/CopyOnWriteArrayList.",
  },

  // ── Thread-unsafe singleton ────────────────────────────────────
  {
    id: "java-009-unsafe-singleton",
    title: "Lazy singleton without synchronization (race condition)",
    severity: "medium",
    languages: ["java"],
    regex: /if\s*\(\s*instance\s*==\s*null\s*\)\s*\{?\s*\n?\s*instance\s*=\s*new\b/g,
    explanation:
      "Lazy initialization of a singleton without synchronized or volatile allows two threads to create separate instances, breaking the singleton guarantee and causing subtle bugs.",
    verify_prompt:
      "Is this null-check + assignment inside a synchronized block, or is the field declared volatile with double-checked locking? " +
      "If properly synchronized, respond FALSE_POSITIVE. If unprotected, respond CONFIRMED.",
    cwe: "CWE-362",
    fix_template: "Use double-checked locking with volatile, or an enum singleton, or holder class pattern.",
  },

  // ── Hardcoded credentials ──────────────────────────────────────
  {
    id: "java-010-hardcoded-creds",
    title: "Hardcoded password, secret, or API key in Java",
    severity: "high",
    languages: ["java"],
    regex: /(?:password|passwd|secret|apiKey|api_key|token|credential)\s*=\s*"[^"]{8,}"/gi,
    explanation:
      "Hardcoded credentials in Java source code are exposed to anyone with access to the compiled class files (strings are stored in plaintext in .class files).",
    verify_prompt:
      "Is this a REAL secret (not a placeholder like \"changeme\", not a test fixture, not an empty/example value)? " +
      "If it looks like a real credential, respond CONFIRMED. If test/placeholder, respond FALSE_POSITIVE.",
    cwe: "CWE-798",
    fix_template: "Load from environment: System.getenv(\"API_KEY\") or use a secrets vault.",
  },

  // ── Insecure deserialization ───────────────────────────────────
  {
    id: "java-011-insecure-deserialize",
    title: "ObjectInputStream from untrusted source",
    severity: "critical",
    languages: ["java"],
    regex: /new\s+ObjectInputStream\s*\(\s*(?:request\.|socket\.|conn\.|input|stream|is\b)/g,
    explanation:
      "Creating ObjectInputStream from network/request streams deserializes arbitrary objects. Attackers can execute code via gadget chains (Commons Collections, Spring, etc.).",
    verify_prompt:
      "Is the InputStream from a network source (HTTP request, socket, RMI)? " +
      "If from a trusted local file written by the same application, respond FALSE_POSITIVE. " +
      "If from any network/untrusted source, respond CONFIRMED.",
    cwe: "CWE-502",
    fix_template: "Use JSON/Protobuf for network data, or add ObjectInputFilter to whitelist allowed classes.",
  },

  // ── Path traversal ─────────────────────────────────────────────
  {
    id: "java-012-path-traversal-string",
    title: "User input in File path without sanitization",
    severity: "high",
    languages: ["java"],
    regex: /new\s+File\s*\(\s*(?:.*\+\s*(?:param|input|request|user|name|path|filename))/gi,
    explanation:
      "Constructing File paths with unsanitized user input allows path traversal attacks (../../etc/passwd).",
    verify_prompt:
      "Is the user input validated/sanitized before being used in the File path? " +
      "Check for: canonical path comparison, regex filtering of ../, whitelist validation. " +
      "If validated, respond FALSE_POSITIVE. If raw user input, respond CONFIRMED.",
    cwe: "CWE-22",
    fix_template: "Validate: String safe = new File(base, input).getCanonicalPath(); if (!safe.startsWith(baseDir)) throw new SecurityException();",
  },

  // ── XXE injection ──────────────────────────────────────────────
  {
    id: "java-013-xxe-transformer",
    title: "XML TransformerFactory without disabling external entities",
    severity: "high",
    languages: ["java"],
    regex: /TransformerFactory\.newInstance\s*\(\s*\)/g,
    explanation:
      "Default TransformerFactory configuration allows XML external entities, enabling XXE attacks that can read local files or perform SSRF.",
    verify_prompt:
      "Is the TransformerFactory configured with setAttribute to disable external entities (ACCESS_EXTERNAL_DTD, ACCESS_EXTERNAL_STYLESHEET set to \"\")? " +
      "If protected, respond FALSE_POSITIVE. If default configuration, respond CONFIRMED.",
    cwe: "CWE-611",
    fix_template: "factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD, \"\"); factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_STYLESHEET, \"\");",
  },

  // ── Log injection ──────────────────────────────────────────────
  {
    id: "java-014-log-injection",
    title: "Unsanitized user input in log message",
    severity: "medium",
    languages: ["java"],
    regex: /\b(?:log|logger|LOG)\s*\.\s*(?:info|warn|error|debug|trace)\s*\(\s*(?:"[^"]*"\s*\+\s*(?:request|param|input|user|req\.))/gi,
    explanation:
      "Logging unsanitized user input allows log injection/forging. Attackers can inject newlines to create fake log entries or exploit log parsing tools.",
    verify_prompt:
      "Is user input being concatenated into the log message? " +
      "If using parameterized logging (logger.info(\"msg {}\", param)), respond FALSE_POSITIVE. " +
      "If string concatenation with user input, respond CONFIRMED.",
    cwe: "CWE-117",
    fix_template: "Use parameterized logging: logger.info(\"User login: {}\", sanitize(username));",
  },

  // ── Infinite loop ──────────────────────────────────────────────
  {
    id: "java-015-infinite-loop",
    title: "while(true) or for(;;) without break/return condition",
    severity: "medium",
    languages: ["java"],
    regex: /(?:while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\))\s*\{(?:(?!\b(?:break|return|throw)\b)[\s\S]){0,500}?\}/g,
    explanation:
      "An infinite loop without a break, return, or throw will hang the thread indefinitely. This can cause DoS or resource exhaustion.",
    verify_prompt:
      "Does this loop body contain a break, return, throw, or System.exit() that provides an exit condition? " +
      "If an exit condition exists but the regex didn't capture it (long body), respond FALSE_POSITIVE. " +
      "If genuinely no exit condition, respond CONFIRMED.",
    cwe: "CWE-835",
    fix_template: "Add an explicit break/return condition, or use a bounded loop with a max iteration count.",
  },

  // ── equals without hashCode ────────────────────────────────────
  {
    id: "java-016-equals-no-hashcode",
    title: "equals() overridden without hashCode()",
    severity: "medium",
    languages: ["java"],
    regex: /public\s+boolean\s+equals\s*\(\s*Object\b(?![\s\S]{0,500}?public\s+int\s+hashCode\s*\(\s*\))/g,
    explanation:
      "Overriding equals() without hashCode() violates the Object contract. Objects that are equals() will have different hash codes, causing failures in HashMap, HashSet, and other hash-based collections.",
    verify_prompt:
      "Does this class also override hashCode()? Search the entire class, not just nearby lines. " +
      "If hashCode() is overridden (possibly further down in the file), respond FALSE_POSITIVE. " +
      "If only equals() is overridden, respond CONFIRMED.",
    cwe: "CWE-697",
    fix_template: "Add @Override public int hashCode() { return Objects.hash(field1, field2); } consistent with equals().",
  },

  // ── Mutable static field ───────────────────────────────────────
  {
    id: "java-017-mutable-static",
    title: "Mutable static field (thread-safety risk)",
    severity: "medium",
    languages: ["java"],
    regex: /static\s+(?!final\b)(?:(?:private|public|protected)\s+)?(?:List|Map|Set|Collection|ArrayList|HashMap|HashSet|TreeMap|LinkedList|Queue|Deque)\s*<[^>]*>\s+\w+\s*=/g,
    explanation:
      "A non-final static collection field can be modified by any thread without synchronization, causing race conditions, ConcurrentModificationExceptions, or data corruption.",
    verify_prompt:
      "Is this static field properly synchronized (synchronized access, ConcurrentHashMap, Collections.synchronizedX, or volatile)? " +
      "If thread-safe access is ensured, respond FALSE_POSITIVE. If unprotected, respond CONFIRMED.",
    cwe: "CWE-362",
    fix_template: "Make field final with an unmodifiable collection, or use ConcurrentHashMap/CopyOnWriteArrayList.",
  },

  // ── Catching generic Exception ─────────────────────────────────
  {
    id: "java-018-catch-generic-exception",
    title: "Catching generic Exception instead of specific type",
    severity: "low",
    languages: ["java"],
    regex: /\bcatch\s*\(\s*(?:Exception|Throwable)\s+\w+\s*\)/g,
    explanation:
      "Catching Exception or Throwable swallows all exceptions including programming errors (NullPointerException, ClassCastException) that should propagate. This hides bugs and makes debugging difficult.",
    verify_prompt:
      "Is this a top-level catch-all handler (e.g., main method, thread run, request handler) where catching broadly is intentional? " +
      "If it's a legitimate catch-all at a boundary, respond FALSE_POSITIVE. " +
      "If it's in business logic catching Exception to suppress errors, respond CONFIRMED.",
    cwe: "CWE-396",
    fix_template: "Catch specific exceptions: catch (IOException | SQLException e) { ... }",
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
    verify_prompt: "Is this a real API key or a placeholder/example? If it looks like a real key (long random string), respond CONFIRMED." +
      "\n\nRespond FALSE_POSITIVE if ANY of these is true:\n" +
      "1. The value is a placeholder ('changeme', 'xxx', 'your-api-key-here', 'TODO', 'REPLACE_ME', 'test')\n" +
      "2. This is in test, example, or documentation code\n" +
      "3. The value is loaded from environment, plist, keychain, or a secrets manager\n" +
      "4. The value is a well-known public identifier (not a secret)\n" +
      "Only respond CONFIRMED if the value appears to be a real secret committed to source code in production code.",
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
  {
    id: "swift-007-force-unwrap-production",
    title: "Force unwrap (!) in production code path",
    severity: "high",
    languages: ["swift"],
    regex: /\b(?:let|var)\s+\w+\s*=\s*\w+!\s*$/gm,
    explanation:
      "Force unwrapping optionals with ! crashes at runtime with a fatal error if the value is nil. In production code paths, this creates fragile code that crashes instead of handling errors gracefully.",
    verify_prompt:
      "Is this force unwrap in production code where nil is a realistic possibility? " +
      "If the value is guaranteed non-nil by the language (e.g., IBOutlet after viewDidLoad, " +
      "known-good constant, or immediately after a nil check), respond FALSE_POSITIVE. " +
      "If nil could occur at runtime, respond CONFIRMED.",
    cwe: "CWE-476",
    fix_template: "Use guard let unwrapped = optional else { return } or if let, or provide a default with ??.",
  },
  {
    id: "swift-008-retain-cycle",
    title: "Retain cycle: strong reference in closure without [weak self]",
    severity: "medium",
    languages: ["swift"],
    regex: /\{\s*(?!\[(?:weak|unowned)\s+self\])(?:\([^)]*\)\s*(?:->.*?)?\s*in\s+)?[^}]*\bself\./g,
    explanation:
      "Closures that capture self strongly can create retain cycles, causing memory leaks. If self holds a strong reference to the closure (directly or through a chain), neither will be deallocated.",
    verify_prompt:
      "Does this closure capture self strongly AND is self likely to hold a reference " +
      "to this closure (e.g., stored in a property, passed to a long-lived handler)? " +
      "If the closure is short-lived (e.g., DispatchQueue.main.async, map/filter), " +
      "respond FALSE_POSITIVE. If it's stored as a property or completion handler, respond CONFIRMED.",
    cwe: "CWE-401",
    fix_template: "Add [weak self] or [unowned self] capture list: { [weak self] in guard let self else { return } ... }",
  },
  {
    id: "swift-009-main-thread-violation",
    title: "UI update from background thread",
    severity: "high",
    languages: ["swift"],
    regex: /DispatchQueue\.global\b[\s\S]{0,300}?(?:\.text\s*=|\.isHidden\s*=|\.alpha\s*=|\.image\s*=|\.reloadData\(\)|\.setTitle\(|\.backgroundColor\s*=|\.frame\s*=|\.addSubview\()/g,
    explanation:
      "Updating UIKit/AppKit views from a background queue causes undefined behavior: visual glitches, crashes, or data corruption. All UI updates must happen on the main thread.",
    verify_prompt:
      "Is this UI update inside a DispatchQueue.global() or background queue block? " +
      "If it's wrapped in DispatchQueue.main.async { } inside the background block, " +
      "respond FALSE_POSITIVE. If the UI update happens directly on the background queue, respond CONFIRMED.",
    cwe: "CWE-362",
    fix_template: "Wrap UI updates: DispatchQueue.main.async { self.label.text = result }",
  },
  {
    id: "swift-010-force-try-production",
    title: "Force try (try!) in production code",
    severity: "high",
    languages: ["swift"],
    regex: /\btry!\s+\w+/g,
    explanation:
      "try! crashes the app with a fatal error if the called function throws. In production, use do/catch to handle errors gracefully instead of crashing.",
    verify_prompt:
      "Is this try! in production code? If the throwing function is GUARANTEED to succeed " +
      "(e.g., compiling a known-good regex literal, decoding a bundled resource), respond " +
      "FALSE_POSITIVE. If it could fail at runtime with user data, respond CONFIRMED.",
    cwe: "CWE-754",
    fix_template: "Use do { try expression } catch { handle error } or try? with a default value.",
  },
  {
    id: "swift-011-force-cast",
    title: "Force cast (as!) without safety check",
    severity: "medium",
    languages: ["swift"],
    regex: /\bas!\s+\w+/g,
    explanation:
      "Force casting with as! crashes at runtime if the cast fails. Use conditional cast (as?) with proper handling instead.",
    verify_prompt:
      "Is this as! cast guaranteed to succeed (e.g., casting from a known type, " +
      "dequeuing a registered cell)? If the type is guaranteed by the system, " +
      "respond FALSE_POSITIVE. If the source type could be wrong at runtime, respond CONFIRMED.",
    cwe: "CWE-704",
    fix_template: "Use conditional cast: guard let typed = value as? TargetType else { return }",
  },
  {
    id: "swift-012-unowned-dealloc",
    title: "Unowned reference to potentially deallocated object",
    severity: "high",
    languages: ["swift"],
    regex: /\[unowned\s+self\][\s\S]{0,300}?(?:DispatchQueue|Timer|URLSession|NotificationCenter|after\(deadline)/g,
    explanation:
      "Unowned references crash if the referenced object is deallocated. Using [unowned self] in async callbacks (network requests, timers, delayed dispatch) is dangerous because self may be deallocated before the callback fires.",
    verify_prompt:
      "Could self be deallocated before this async callback executes? If the closure " +
      "is guaranteed to complete while self is alive (e.g., synchronous operation), " +
      "respond FALSE_POSITIVE. If it's async (network, timer, delayed), respond CONFIRMED.",
    cwe: "CWE-416",
    fix_template: "Use [weak self] instead of [unowned self] for async callbacks: { [weak self] in guard let self else { return } }",
  },
  {
    id: "swift-013-missing-main-actor",
    title: "Missing @MainActor annotation on UI-related class",
    severity: "medium",
    languages: ["swift"],
    regex: /class\s+\w+(?:ViewController|View|Cell|Controller)\s*(?::\s*\w+)?\s*\{(?![\s\S]{0,50}?@MainActor)/g,
    explanation:
      "UI-related classes (ViewControllers, Views, Cells) should be annotated with @MainActor to ensure all property access and method calls happen on the main thread. Without it, concurrent access from Swift concurrency can cause data races.",
    verify_prompt:
      "Is this a UIKit/SwiftUI class that accesses UI elements? If the class " +
      "has @MainActor on the class declaration or inherits from a @MainActor class, " +
      "respond FALSE_POSITIVE. If it's a plain data model, respond FALSE_POSITIVE. " +
      "If it's a UI class without @MainActor, respond CONFIRMED.",
    cwe: "CWE-362",
    fix_template: "Add @MainActor annotation: @MainActor class MyViewController: UIViewController { }",
  },
  {
    id: "swift-014-hardcoded-secret-swift",
    title: "Hardcoded secret or API key in Swift source",
    severity: "high",
    languages: ["swift"],
    regex: /(?:apiKey|secretKey|password|authToken|privateKey|accessToken)\s*[:=]\s*"[A-Za-z0-9+/=_\-]{16,}"/g,
    explanation:
      "Hardcoded secrets in Swift source code can be extracted from the compiled binary using the strings command. Anyone with access to the .ipa/.app can recover them.",
    verify_prompt:
      "Is this a REAL API key/secret or a placeholder/example? If it looks like a " +
      "real credential (long random string), respond CONFIRMED. If placeholder, " +
      "test value, or loaded from Info.plist/Keychain, respond FALSE_POSITIVE.",
    cwe: "CWE-798",
    fix_template: "Load from Info.plist (excluded from repo), Keychain, or a remote config service.",
  },
  {
    id: "swift-015-missing-async-error-handling",
    title: "Missing error handling in async/await",
    severity: "medium",
    languages: ["swift"],
    regex: /\bawait\s+\w+[\s\S]{0,50}?(?:(?!\btry\b)(?!\bcatch\b)(?!\bdo\b).){50}/g,
    explanation:
      "Async/await calls to throwing functions without try/catch will propagate errors silently. In non-throwing contexts, this may cause compile errors or unhandled failures.",
    verify_prompt:
      "Is this await call inside a do/catch block or is the containing function " +
      "marked as throws? If error handling exists (try/catch, Task with error handling), " +
      "respond FALSE_POSITIVE. If no error handling, respond CONFIRMED.",
    cwe: "CWE-755",
    fix_template: "Wrap in do/catch: do { let result = try await fetchData() } catch { handleError(error) }",
  },
];

// ═══════════════════════════════════════════════════════════════
// Kotlin Patterns
// ═══════════════════════════════════════════════════════════════

export const KOTLIN_PATTERNS: BugPattern[] = [
  {
    id: "kt-001-force-unwrap",
    title: "Non-null assertion (!!) on nullable type",
    severity: "medium",
    languages: ["kotlin"],
    regex: /\w+!!\./g,
    explanation: "!! throws NullPointerException if the value is null. Use safe calls (?.) or elvis (?:) instead.",
    verify_prompt: "Is this !! in production code where null is possible? If guaranteed non-null by contract, respond FALSE_POSITIVE.",
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
    fix_template: "Replace x!! with x?.method() ?: fallback, or guard with requireNotNull(x) { \"message\" }.",
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
    fix_template: "Use viewModelScope, lifecycleScope, or a custom CoroutineScope tied to the component's lifecycle.",
  },

  // ── Blocking call in coroutine ─────────────────────────────────
  {
    id: "kt-006-blocking-in-coroutine",
    title: "Blocking call inside coroutine scope",
    severity: "high",
    languages: ["kotlin"],
    regex: /(?:suspend\s+fun|launch\s*\{|async\s*\{)[\s\S]{0,300}?\b(?:Thread\.sleep|\.join\(\)|\.get\(\)|\.await\(\))\b/g,
    explanation:
      "Calling Thread.sleep(), Future.get(), or other blocking calls inside a coroutine blocks the dispatcher thread, defeating the purpose of coroutines and potentially freezing the UI or exhausting the thread pool.",
    verify_prompt:
      "Is this blocking call wrapped in withContext(Dispatchers.IO)? " +
      "If dispatched to IO, respond FALSE_POSITIVE. " +
      "If blocking on Main or Default dispatcher, respond CONFIRMED.",
    cwe: "CWE-400",
    fix_template: "Use delay() instead of Thread.sleep(), or wrap in withContext(Dispatchers.IO) { }.",
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
    fix_template: "Use safe call: javaObj.method()?.property, or declare the type as nullable: val x: String? = javaObj.method().",
  },

  // ── Mutable collection exposed ─────────────────────────────────
  {
    id: "kt-008-mutable-collection-exposed",
    title: "Mutable collection returned directly from function/property",
    severity: "low",
    languages: ["kotlin"],
    regex: /(?:fun\s+\w+\s*\([^)]*\)\s*(?::\s*(?:Mutable)?List|:\s*(?:Mutable)?Map|:\s*(?:Mutable)?Set)[\s\S]{0,100}?return\s+\w+|get\(\)\s*=\s*(?:_\w+|mutable\w+))/g,
    explanation:
      "Returning a mutable collection directly allows callers to modify the internal state of the class, breaking encapsulation. This can lead to unexpected behavior and bugs.",
    verify_prompt:
      "Does the function/property return a mutable collection directly? " +
      "If it returns .toList(), .toMap(), Collections.unmodifiable*(), or the return type is immutable (List, not MutableList), respond FALSE_POSITIVE. " +
      "If the internal mutable collection is exposed, respond CONFIRMED.",
    cwe: "CWE-495",
    fix_template: "Return a defensive copy: return _items.toList(), or use a read-only return type.",
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
      "Is this a REAL secret or a placeholder/test value (\"changeme\", \"test123\", \"TODO\")? " +
      "If it looks like a real credential, respond CONFIRMED. If test/placeholder, respond FALSE_POSITIVE.",
    cwe: "CWE-798",
    fix_template: "Use BuildConfig fields, environment variables, or Android Keystore/EncryptedSharedPreferences.",
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
    fix_template: "Use parameterized queries: db.rawQuery(\"SELECT * FROM t WHERE id = ?\", arrayOf(userId)).",
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
    fix_template: "Use a CoroutineScope tied to the component lifecycle: viewModelScope, lifecycleScope, or custom scope with SupervisorJob().",
  },
];

// ═══════════════════════════════════════════════════════════════
// C# Patterns
// ═══════════════════════════════════════════════════════════════

export const CSHARP_PATTERNS: BugPattern[] = [
  {
    id: "cs-001-sql-injection",
    title: "SQL query with string concatenation/interpolation",
    severity: "critical",
    languages: ["csharp"],
    regex: /\b(?:ExecuteNonQuery|ExecuteReader|ExecuteScalar|SqlCommand)\s*\(\s*(?:\$"|".*\+)/g,
    explanation: "SQL queries with string interpolation ($\"\") or concatenation are vulnerable to injection.",
    verify_prompt: "Is user input interpolated? If using SqlParameter/@param, respond FALSE_POSITIVE.",
    cwe: "CWE-89",
    fix_template: "Use SqlCommand with Parameters.AddWithValue(\"@id\", userId).",
  },
  {
    id: "cs-002-deserialization",
    title: "Unsafe deserialization (BinaryFormatter)",
    severity: "critical",
    languages: ["csharp"],
    regex: /\bBinaryFormatter\s*\(\s*\)|\.Deserialize\s*\(/g,
    explanation: "BinaryFormatter deserializes arbitrary .NET objects. Microsoft marks it as dangerous — attackers can execute code via crafted payloads.",
    verify_prompt: "Is the deserialized data from a trusted source? If from network/user input, respond CONFIRMED." +
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
    verify_prompt: "Is this a real connection string with credentials or a placeholder? If real, respond CONFIRMED." +
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
    regex: /(?<!\bawait\s)(?<!\breturn\s)(?<!\bvar\s+\w+\s*=\s*)(?<!\bTask\s+\w+\s*=\s*)\b\w+Async\s*\([^)]*\)\s*;/g,
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
    regex: /(?:new\s+(?:SqlConnection|SqlCommand|HttpClient|StreamReader|StreamWriter|FileStream|MemoryStream|BinaryReader|BinaryWriter|WebClient|TcpClient|SmtpClient)\s*\([^)]*\))(?![\s\S]{0,10}?\busing\b)/g,
    explanation:
      "IDisposable objects not wrapped in a using statement may not be properly disposed, leading to resource leaks (connections, file handles, memory).",
    verify_prompt:
      "Is this IDisposable created inside a using statement or using declaration? " +
      "If using/using var is present, respond FALSE_POSITIVE. " +
      "If the object is created without using and no Dispose() call exists, respond CONFIRMED.",
    cwe: "CWE-772",
    fix_template: "Wrap in using: using var conn = new SqlConnection(cs); or using (var conn = new SqlConnection(cs)) { }",
  },

  // ── SQL injection with interpolation ───────────────────────────
  {
    id: "cs-007-sql-interpolation",
    title: "SQL query with string interpolation",
    severity: "critical",
    languages: ["csharp"],
    regex: /\b(?:CommandText|SqlCommand)\s*(?:=|\()\s*\$"/g,
    explanation:
      "SQL queries built with C# string interpolation ($\"\") are vulnerable to injection. Use SqlParameter for user values.",
    verify_prompt:
      "Is user input interpolated in the SQL string? " +
      "If only constants/config values are interpolated (table names), respond FALSE_POSITIVE. " +
      "If user-controlled values are interpolated, respond CONFIRMED.",
    cwe: "CWE-89",
    fix_template: "Use parameters: cmd.Parameters.AddWithValue(\"@id\", userId); with CommandText = \"SELECT * FROM t WHERE id = @id\";",
  },

  // ── LINQ multiple enumeration ──────────────────────────────────
  {
    id: "cs-008-multiple-enumeration",
    title: "IEnumerable enumerated multiple times (LINQ deferred execution)",
    severity: "low",
    languages: ["csharp"],
    regex: /(?:IEnumerable\s*<[^>]+>\s+(\w+)\s*=[\s\S]{0,200}?(?:Where|Select|OrderBy|GroupBy))[\s\S]{0,500}?\1\s*\.\s*\w+[\s\S]{0,200}?\1\s*\.\s*\w+/g,
    explanation:
      "An IEnumerable query is enumerated multiple times. Due to LINQ's deferred execution, each enumeration re-executes the query (database call, file read, computation), causing performance issues or inconsistent results.",
    verify_prompt:
      "Is the IEnumerable materialized (.ToList(), .ToArray()) before multiple accesses? " +
      "If materialized, respond FALSE_POSITIVE. " +
      "If the raw IEnumerable is accessed multiple times, respond CONFIRMED.",
    cwe: "CWE-400",
    fix_template: "Materialize the query: var items = query.ToList(); then use items multiple times.",
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
    fix_template: "Use a private lock object: private readonly object _lock = new object(); lock (_lock) { }",
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
    fix_template: "Use null-conditional: obj?.Method() or add guard: if (obj is not null) { obj.Method(); }",
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
    fix_template: "Use TryGetValue: if (dict.TryGetValue(key, out var value)) { ... } or dict.GetValueOrDefault(key).",
  },
];

// ═══════════════════════════════════════════════════════════════
// PHP Patterns
// ═══════════════════════════════════════════════════════════════

export const PHP_PATTERNS: BugPattern[] = [
  {
    id: "php-001-sql-injection",
    title: "SQL query with variable interpolation",
    severity: "critical",
    languages: ["php"],
    regex: /\b(?:mysql_query|mysqli_query|->query)\s*\(\s*["'].*\$/g,
    explanation: "SQL queries with PHP variable interpolation ($var) are vulnerable to injection.",
    verify_prompt: "Is user input interpolated? If using prepared statements (bind_param), respond FALSE_POSITIVE.",
    cwe: "CWE-89",
    fix_template: "Use prepared statements: $stmt = $pdo->prepare('SELECT * FROM t WHERE id = ?'); $stmt->execute([$id]);",
  },
  {
    id: "php-002-eval",
    title: "eval() with dynamic input",
    severity: "critical",
    languages: ["php"],
    regex: /\beval\s*\(\s*\$/g,
    explanation: "eval() executes arbitrary PHP code. If input is user-controlled, this is RCE.",
    verify_prompt: "Is the argument from user input? If hardcoded/internal, respond FALSE_POSITIVE.",
    cwe: "CWE-95",
    fix_template: "Remove eval(). Use specific functions for the intended operation.",
  },
  {
    id: "php-003-file-include",
    title: "Dynamic file include (LFI/RFI)",
    severity: "critical",
    languages: ["php"],
    regex: /\b(?:include|require|include_once|require_once)\s*\(\s*\$/g,
    explanation: "Including files from user input enables Local/Remote File Inclusion attacks.",
    verify_prompt: "Is the path from user input? If from internal config/constant, respond FALSE_POSITIVE.",
    cwe: "CWE-98",
    fix_template: "Whitelist allowed files: $allowed = ['page1', 'page2']; if (in_array($input, $allowed)) include($input.'.php');",
  },
  {
    id: "php-004-xss",
    title: "Unescaped output (XSS)",
    severity: "high",
    languages: ["php"],
    regex: /echo\s+\$(?:_GET|_POST|_REQUEST|_COOKIE)\s*\[/g,
    explanation: "Echoing superglobal variables directly enables XSS. Always escape output.",
    verify_prompt: "Is htmlspecialchars() or equivalent applied before output? If escaped, respond FALSE_POSITIVE.",
    cwe: "CWE-79",
    fix_template: "echo htmlspecialchars($_GET['param'], ENT_QUOTES, 'UTF-8');",
  },
  {
    id: "php-005-sql-superglobal",
    title: "SQL injection via $_GET/$_POST in query",
    severity: "critical",
    languages: ["php"],
    regex: /\b(?:query|execute|prepare)\s*\([^)]*\$_(?:GET|POST|REQUEST)\s*\[/g,
    explanation:
      "Superglobal variables ($_GET, $_POST) used directly in SQL queries without parameterization enable SQL injection.",
    verify_prompt:
      "Is the superglobal value passed through a prepared statement with bind_param or execute([...])? " +
      "If parameterized, respond FALSE_POSITIVE. If interpolated into SQL string, respond CONFIRMED.",
    cwe: "CWE-89",
    fix_template: "$stmt = $pdo->prepare('SELECT * FROM t WHERE id = ?'); $stmt->execute([$_GET['id']]);",
  },
  {
    id: "php-006-unserialize",
    title: "unserialize() with untrusted data",
    severity: "critical",
    languages: ["php"],
    regex: /\bunserialize\s*\(\s*\$(?:_GET|_POST|_REQUEST|_COOKIE|input|data|body)/g,
    explanation:
      "unserialize() with user-controlled data enables PHP Object Injection. Attackers craft serialized payloads that trigger __wakeup/__destruct chains for RCE.",
    verify_prompt:
      "Is the serialized data from an untrusted source (request, cookie, user upload)? " +
      "If from trusted internal cache with HMAC verification, respond FALSE_POSITIVE. " +
      "If from user input without signature check, respond CONFIRMED.",
    cwe: "CWE-502",
    fix_template: "Use json_decode() instead of unserialize(), or pass allowed_classes: ['ClassName'] option.",
  },
  {
    id: "php-007-path-traversal",
    title: "Path traversal via $_GET/$_POST in file operations",
    severity: "high",
    languages: ["php"],
    regex: /\b(?:file_get_contents|fopen|readfile|file)\s*\([^)]*\$_(?:GET|POST|REQUEST)\s*\[/g,
    explanation:
      "Using $_GET/$_POST in file operations allows path traversal (../../etc/passwd). Attacker can read arbitrary files on the server.",
    verify_prompt:
      "Is the path validated (basename(), realpath() + prefix check)? " +
      "If the path is sanitized before use, respond FALSE_POSITIVE. " +
      "If user input goes directly to file operation, respond CONFIRMED.",
    cwe: "CWE-22",
    fix_template: "$path = basename($_GET['file']); readfile('/safe/dir/' . $path);",
  },
  {
    id: "php-008-csrf-no-token",
    title: "POST handler without CSRF token validation",
    severity: "medium",
    languages: ["php"],
    regex: /\$_SERVER\s*\[\s*['"]REQUEST_METHOD['"]\s*\]\s*===?\s*['"]POST['"](?![\s\S]{0,300}?(?:csrf|token|nonce|verify))/gi,
    explanation:
      "POST handler without CSRF token validation. An attacker can craft a form on another site that submits to this endpoint on behalf of an authenticated user.",
    verify_prompt:
      "Does this POST handler validate a CSRF token (hidden field, header, or session check) " +
      "within the handler body? If token is checked, respond FALSE_POSITIVE. " +
      "If this is an API endpoint using Bearer tokens (not cookies), respond FALSE_POSITIVE. " +
      "If no CSRF protection exists, respond CONFIRMED.",
    cwe: "CWE-352",
    fix_template: "Add CSRF token: if ($_POST['csrf_token'] !== $_SESSION['csrf_token']) die('CSRF');",
  },
  {
    id: "php-009-type-juggling",
    title: "Loose comparison (==) with security-sensitive value",
    severity: "medium",
    languages: ["php"],
    regex: /\$(?:password|token|hash|secret|api_key)\s*==\s*(?!\s*=)/g,
    explanation:
      "PHP loose comparison (==) causes type juggling. '0e123' == '0e456' is true, 0 == 'any-string' is true. This breaks password/token comparisons.",
    verify_prompt:
      "Is this a security-sensitive comparison (password, token, hash, API key)? " +
      "If it's a non-security comparison (feature flag, pagination), respond FALSE_POSITIVE. " +
      "If comparing credentials/tokens with ==, respond CONFIRMED.",
    cwe: "CWE-697",
    fix_template: "Use strict comparison (===) or hash_equals() for timing-safe comparison.",
  },
  {
    id: "php-010-extract-user-input",
    title: "extract() with user input (variable injection)",
    severity: "high",
    languages: ["php"],
    regex: /\bextract\s*\(\s*\$_(?:GET|POST|REQUEST|COOKIE)/g,
    explanation:
      "extract() creates local variables from array keys. With user input, attackers can overwrite any variable including $isAdmin, $authenticated, etc.",
    verify_prompt:
      "Is extract() called on user-controlled data ($_GET, $_POST, $_REQUEST)? " +
      "If called with EXTR_SKIP or EXTR_PREFIX_ALL flag, respond FALSE_POSITIVE. " +
      "If called without protection on superglobals, respond CONFIRMED.",
    cwe: "CWE-621",
    fix_template: "Access values explicitly: $name = $_POST['name']; or use extract($data, EXTR_SKIP);",
  },
  {
    id: "php-011-shell-exec",
    title: "Shell execution with user input",
    severity: "critical",
    languages: ["php"],
    regex: /\b(?:shell_exec|exec|system|passthru|popen|proc_open)\s*\([^)]*\$_(?:GET|POST|REQUEST)/g,
    explanation:
      "Passing user input to shell execution functions enables command injection. Attacker can chain commands with ; | && etc.",
    verify_prompt:
      "Is the user input escaped with escapeshellarg()/escapeshellcmd() before use? " +
      "If properly escaped, respond FALSE_POSITIVE. " +
      "If raw superglobal goes to shell function, respond CONFIRMED.",
    cwe: "CWE-78",
    fix_template: "$output = shell_exec('ls ' . escapeshellarg($_GET['dir']));",
  },
  {
    id: "php-012-hardcoded-credentials",
    title: "Hardcoded credentials in PHP",
    severity: "high",
    languages: ["php"],
    regex: /\$(?:password|db_pass|secret|api_key|auth_token)\s*=\s*['"][A-Za-z0-9!@#$%^&*+/=_-]{8,}['"]\s*;/g,
    explanation:
      "Hardcoded credentials in source code are exposed to anyone with repo access and persist in version history even after removal.",
    verify_prompt:
      "Is this a real credential or a placeholder/example (e.g., 'changeme', 'your-key-here')? " +
      "If placeholder or test fixture, respond FALSE_POSITIVE. " +
      "If it looks like a real password/key, respond CONFIRMED.",
    cwe: "CWE-798",
    fix_template: "$password = getenv('DB_PASSWORD'); or use .env with vlucas/phpdotenv.",
  },
  {
    id: "php-013-weak-hash-password",
    title: "md5/sha1 used for password hashing",
    severity: "high",
    languages: ["php"],
    regex: /\b(?:md5|sha1)\s*\(\s*\$(?:password|pass|pwd|user_pass)/g,
    explanation:
      "md5/sha1 are fast hashes unsuitable for passwords. GPU cracking breaks them trivially. Use password_hash() with bcrypt/argon2.",
    verify_prompt:
      "Is md5/sha1 being used to hash a PASSWORD specifically? " +
      "If used for a non-security purpose (checksum, cache key, file hash), respond FALSE_POSITIVE. " +
      "If hashing a password or credential, respond CONFIRMED.",
    cwe: "CWE-328",
    fix_template: "$hash = password_hash($password, PASSWORD_DEFAULT); // bcrypt by default",
  },
  {
    id: "php-014-print-xss",
    title: "print/printf of user input without escaping (XSS)",
    severity: "high",
    languages: ["php"],
    regex: /\b(?:print|printf)\s*\(?[^)]*\$_(?:GET|POST|REQUEST|COOKIE)\s*\[/g,
    explanation:
      "Printing user input without htmlspecialchars() enables reflected XSS attacks.",
    verify_prompt:
      "Is the output HTML-escaped with htmlspecialchars() or htmlentities()? " +
      "If escaped, respond FALSE_POSITIVE. If raw output, respond CONFIRMED.",
    cwe: "CWE-79",
    fix_template: "print htmlspecialchars($_GET['name'], ENT_QUOTES, 'UTF-8');",
  },
  {
    id: "php-015-backtick-injection",
    title: "Backtick operator with user input (command injection)",
    severity: "critical",
    languages: ["php"],
    regex: /`[^`]*\$_(?:GET|POST|REQUEST)[^`]*`/g,
    explanation:
      "PHP backtick operator executes shell commands. With user input interpolated, this is command injection.",
    verify_prompt:
      "Is user input interpolated inside backticks? " +
      "If the entire command is a hardcoded constant, respond FALSE_POSITIVE. " +
      "If superglobals appear inside backticks, respond CONFIRMED.",
    cwe: "CWE-78",
    fix_template: "Use escapeshellarg(): $out = shell_exec('cmd ' . escapeshellarg($_GET['arg']));",
  },
];

// ═══════════════════════════════════════════════════════════════
// Ruby Patterns
// ═══════════════════════════════════════════════════════════════

export const RUBY_PATTERNS: BugPattern[] = [
  {
    id: "rb-001-eval",
    title: "eval/send with dynamic input",
    severity: "critical",
    languages: ["ruby"],
    regex: /\b(?:eval|send|public_send|instance_eval|class_eval)\s*\(\s*(?:params|request|input)/g,
    explanation: "eval/send with user input enables arbitrary code execution.",
    verify_prompt: "Is the argument from user input? If internal/constant, respond FALSE_POSITIVE.",
    cwe: "CWE-95",
    fix_template: "Use a whitelist: ALLOWED_METHODS.include?(method_name) && obj.public_send(method_name)",
  },
  {
    id: "rb-002-sql-injection",
    title: "SQL with string interpolation",
    severity: "critical",
    languages: ["ruby"],
    regex: /\b(?:where|find_by_sql|execute|select)\s*\(\s*"/g,
    explanation: "ActiveRecord/SQL with string interpolation is vulnerable to injection.",
    verify_prompt: "Is user input interpolated via #{}? If using ? placeholders, respond FALSE_POSITIVE.",
    cwe: "CWE-89",
    fix_template: "User.where('email = ?', params[:email]) instead of string interpolation.",
  },
  {
    id: "rb-003-yaml-unsafe",
    title: "YAML.load with untrusted input",
    severity: "critical",
    languages: ["ruby"],
    regex: /\bYAML\.load\s*\(/g,
    explanation: "YAML.load in Ruby can execute arbitrary code. Use YAML.safe_load instead.",
    verify_prompt: "Is the YAML from untrusted source? If from internal config file, respond FALSE_POSITIVE.",
    cwe: "CWE-502",
    fix_template: "YAML.safe_load(data, permitted_classes: [Symbol])",
  },
  {
    id: "rb-004-send-user-input",
    title: "send()/public_send() with user-controlled method name",
    severity: "critical",
    languages: ["ruby"],
    regex: /\b(?:send|public_send)\s*\(\s*(?:params\[|request\.|input|user_)/g,
    explanation:
      "send() invokes any method by name. With user input, attackers can call private/destructive methods like system(), exec(), or delete_all.",
    verify_prompt:
      "Is the method name from user input (params, request, form data)? " +
      "If from a hardcoded symbol or internal constant, respond FALSE_POSITIVE. " +
      "If user-controlled, respond CONFIRMED.",
    cwe: "CWE-95",
    fix_template: "Whitelist: SAFE = %w[name email]; obj.public_send(method) if SAFE.include?(method)",
  },
  {
    id: "rb-005-mass-assignment",
    title: "Mass assignment without strong parameters",
    severity: "high",
    languages: ["ruby"],
    regex: /\.(?:new|create|update|update_attributes|assign_attributes)\s*\(\s*params(?!\s*\.\s*(?:require|permit))/g,
    explanation:
      "Passing params directly to model methods without permit/require allows attackers to set any column (is_admin, role, etc.).",
    verify_prompt:
      "Is params passed directly without .require().permit()? " +
      "If strong parameters are used (params.require(:user).permit(:name)), respond FALSE_POSITIVE. " +
      "If raw params hash, respond CONFIRMED.",
    cwe: "CWE-915",
    fix_template: "User.new(params.require(:user).permit(:name, :email))",
  },
  {
    id: "rb-006-system-backtick",
    title: "system()/backticks with user input (command injection)",
    severity: "critical",
    languages: ["ruby"],
    regex: /\b(?:system|%x)\s*(?:\(?\s*["'].*#\{|.*params|.*request)/g,
    explanation:
      "system(), %x{}, or backticks with interpolated user input enables OS command injection.",
    verify_prompt:
      "Does the shell command include user input via #{} interpolation or concatenation? " +
      "If the command is entirely hardcoded, respond FALSE_POSITIVE. " +
      "If user input is interpolated, respond CONFIRMED.",
    cwe: "CWE-78",
    fix_template: "Use array form: system('ls', '-la', user_input) which avoids shell interpretation.",
  },
  {
    id: "rb-007-open-redirect",
    title: "Open redirect (redirect_to with user input)",
    severity: "medium",
    languages: ["ruby"],
    regex: /\bredirect_to\s*\(?\s*(?:params\[|request\.|input|url)/g,
    explanation:
      "redirect_to with user-controlled URL enables open redirect attacks (phishing). Attacker sends a link to your site that redirects to their malicious site.",
    verify_prompt:
      "Is the redirect URL from user input (params, query string, form)? " +
      "If redirecting to a hardcoded internal path or using only_path: true, respond FALSE_POSITIVE. " +
      "If user-controlled URL, respond CONFIRMED.",
    cwe: "CWE-601",
    fix_template: "Validate URL: redirect_to(params[:url]) only if URI(params[:url]).host == request.host",
  },
  {
    id: "rb-008-hardcoded-secrets",
    title: "Hardcoded secrets in Ruby",
    severity: "high",
    languages: ["ruby"],
    regex: /(?:secret_key|api_key|password|token|auth_token)\s*=\s*['"][A-Za-z0-9+/=_-]{12,}['"]/g,
    explanation:
      "Hardcoded secrets in source code are exposed to anyone with repo access and persist in git history.",
    verify_prompt:
      "Is this a real secret or a placeholder/example value? " +
      "If test fixture or placeholder (e.g., 'changeme', 'test_token'), respond FALSE_POSITIVE. " +
      "If it looks like a real credential, respond CONFIRMED.",
    cwe: "CWE-798",
    fix_template: "Use ENV['SECRET_KEY'] or Rails credentials (rails credentials:edit).",
  },
  {
    id: "rb-009-marshal-load",
    title: "Marshal.load with untrusted data",
    severity: "critical",
    languages: ["ruby"],
    regex: /\bMarshal\.load\s*\(/g,
    explanation:
      "Marshal.load deserializes arbitrary Ruby objects. Attackers can craft payloads that execute code on deserialization, similar to Java deserialization attacks.",
    verify_prompt:
      "Is the data being deserialized from a trusted source (internal cache, same-app storage) " +
      "or untrusted (network, user upload, cookie, shared storage)? " +
      "If trusted with integrity check, respond FALSE_POSITIVE. " +
      "If untrusted, respond CONFIRMED.",
    cwe: "CWE-502",
    fix_template: "Use JSON.parse() or YAML.safe_load() instead of Marshal.load.",
  },
  {
    id: "rb-010-sql-interpolation",
    title: "SQL injection via string interpolation in where clause",
    severity: "critical",
    languages: ["ruby"],
    regex: /\.where\s*\(\s*"[^"]*#\{/g,
    explanation:
      "String interpolation (#{}) inside ActiveRecord .where() bypasses parameterization. User input in the interpolated value enables SQL injection.",
    verify_prompt:
      "Does the #{} expression contain user input (params, request data)? " +
      "If the interpolated value is a constant or internal variable, respond FALSE_POSITIVE. " +
      "If user-controlled, respond CONFIRMED.",
    cwe: "CWE-89",
    fix_template: "User.where('email = ?', user_email) — use ? placeholders.",
  },
  {
    id: "rb-011-instance-eval-untrusted",
    title: "instance_eval/class_eval with untrusted string",
    severity: "critical",
    languages: ["ruby"],
    regex: /\b(?:instance_eval|class_eval)\s*\(\s*(?:params|request|input|data|body|str)/g,
    explanation:
      "instance_eval/class_eval with user-provided strings executes arbitrary Ruby code in the object's context, enabling RCE.",
    verify_prompt:
      "Is the evaluated string from user input or external data? " +
      "If from a hardcoded template or internal DSL, respond FALSE_POSITIVE. " +
      "If from untrusted source, respond CONFIRMED.",
    cwe: "CWE-95",
    fix_template: "Use a block instead of string: instance_eval { method_call } or a whitelist approach.",
  },
  {
    id: "rb-012-eval-string",
    title: "eval() with string variable (code injection)",
    severity: "critical",
    languages: ["ruby"],
    regex: /\beval\s*\(\s*(?!['"])[a-zA-Z_]\w*/g,
    explanation:
      "eval() with a variable (not a string literal) executes arbitrary Ruby code. If the variable contains any user input, this is RCE.",
    verify_prompt:
      "Is the variable passed to eval() derived from user input or external data? " +
      "If it's a known-safe internal string (e.g., generated DSL, hardcoded template), respond FALSE_POSITIVE. " +
      "If it could contain untrusted data, respond CONFIRMED.",
    cwe: "CWE-95",
    fix_template: "Avoid eval(). Use a hash lookup, case/when, or method dispatch with a whitelist.",
  },
];

// ═══════════════════════════════════════════════════════════════
// Dart/Flutter Patterns
// ═══════════════════════════════════════════════════════════════

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
    explanation: "Hardcoded secrets in Dart/Flutter apps can be extracted from the compiled binary.",
    verify_prompt: "Is this a real key or placeholder? If real, respond CONFIRMED." +
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
    fix_template: "Use null-aware operators: value?.property ?? defaultValue, or guard with if (value != null).",
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
    regex: /\bFuture\s*\.\s*(?:delayed|wait|forEach)\s*\([^)]*\)(?!\s*\.\s*(?:catchError|onError|then\([^)]*,[^)]*onError))/g,
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
    fix_template: "Use null-safe access: (json['key'] as String?) ?? 'default', or use json_serializable.",
  },
  {
    id: "dart-008-buildcontext-async",
    title: "BuildContext used after async gap",
    severity: "high",
    languages: ["dart"],
    regex: /await\s+\w[\w.]*\([^)]*\)\s*;[\s\S]{0,100}?\b(?:Navigator|ScaffoldMessenger|Theme|MediaQuery|showDialog)\s*\.\s*of\s*\(\s*context/g,
    explanation:
      "Using BuildContext after an async gap (await) is unsafe because the widget may have been unmounted. The context may point to a disposed element tree.",
    verify_prompt:
      "Is there a `if (!mounted) return;` or `if (!context.mounted) return;` check between the await and the context usage? " +
      "If mounted check exists, respond FALSE_POSITIVE. " +
      "If context is used directly after await without checking, respond CONFIRMED.",
    cwe: "CWE-672",
    fix_template: "Add: if (!mounted) return; // or if (!context.mounted) return; before using context after await.",
  },
  {
    id: "dart-009-http-no-https",
    title: "http.get/post without HTTPS enforcement",
    severity: "high",
    languages: ["dart"],
    regex: /\bhttp\.(?:get|post|put|delete|patch)\s*\(\s*(?:Uri\.parse\s*\(\s*)?['"]http:\/\/(?!localhost|127\.0\.0\.1)/g,
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
    regex: /(?:const|final)\s+\w*(?:secret|key|password|token|auth)\w*\s*=\s*['"][A-Za-z0-9+/=_-]{16,}['"]/gi,
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

// ═══════════════════════════════════════════════════════════════
// Elixir Patterns
// ═══════════════════════════════════════════════════════════════

export const ELIXIR_PATTERNS: BugPattern[] = [
  {
    id: "ex-001-atom-from-user-input",
    title: "Atom creation from user input (atom table exhaustion)",
    severity: "high",
    languages: ["elixir"],
    regex: /\bString\.to_atom\s*\(/g,
    explanation:
      "String.to_atom() creates atoms that are never garbage collected. If called with user input, attackers can exhaust the atom table (default limit: 1,048,576) and crash the BEAM VM.",
    verify_prompt:
      "Is the string from user/external input (request params, API data, form fields)? " +
      "If from internal constants or compile-time config, respond FALSE_POSITIVE. " +
      "If from untrusted input, respond CONFIRMED.",
    cwe: "CWE-400",
    fix_template: "Use String.to_existing_atom() which only converts already-existing atoms, or keep as string.",
  },
  {
    id: "ex-002-to-atom-untrusted",
    title: "String.to_atom with untrusted data",
    severity: "high",
    languages: ["elixir"],
    regex: /\bString\.to_atom\s*\(\s*(?:params|conn\.|request|input|body|data)/g,
    explanation:
      "String.to_atom() with request/user data is a denial-of-service vector. Each unique string creates a new permanent atom in the BEAM VM.",
    verify_prompt:
      "Is the argument from user input (Phoenix params, Plug conn, API body)? " +
      "If from internal/compile-time source, respond FALSE_POSITIVE. " +
      "If user-controlled, respond CONFIRMED.",
    cwe: "CWE-400",
    fix_template: "Use String.to_existing_atom() or keep the value as a string. Map strings to atoms with a whitelist.",
  },
  {
    id: "ex-003-unbounded-mailbox",
    title: "GenServer without backpressure (unbounded mailbox)",
    severity: "medium",
    languages: ["elixir"],
    regex: /\bGenServer\.cast\s*\([^)]*\)[\s\S]{0,500}?(?!handle_info.*:check_mailbox|Process\.info.*:message_queue_len)/g,
    explanation:
      "GenServer.cast() is fire-and-forget. If messages arrive faster than the server processes them, the mailbox grows unbounded until the VM runs out of memory.",
    verify_prompt:
      "Is this GenServer under a high message rate (e.g., receiving events from many sources)? " +
      "If it's a low-rate administrative GenServer, respond FALSE_POSITIVE. " +
      "If it could receive bursts of messages without backpressure, respond CONFIRMED.",
    cwe: "CWE-770",
    fix_template: "Use GenServer.call() for backpressure, or monitor mailbox size with Process.info(self(), :message_queue_len).",
  },
  {
    id: "ex-004-ets-race-condition",
    title: "ETS read-modify-write without transaction",
    severity: "medium",
    languages: ["elixir"],
    regex: /\b:ets\.lookup\s*\([^)]*\)[\s\S]{0,200}?:ets\.insert\s*\(/g,
    explanation:
      "ETS lookup followed by insert is not atomic. Concurrent processes can read stale data, compute based on it, and overwrite each other's updates (lost update race).",
    verify_prompt:
      "Is this ETS table accessed by multiple processes concurrently? " +
      "If it's a single-writer table or protected by a GenServer serializing access, respond FALSE_POSITIVE. " +
      "If multiple processes read-modify-write, respond CONFIRMED.",
    cwe: "CWE-362",
    fix_template: "Use :ets.update_counter() for atomic increments, or serialize access through a GenServer.",
  },
  {
    id: "ex-005-process-exit-kill",
    title: "Process.exit(:kill) misuse",
    severity: "medium",
    languages: ["elixir"],
    regex: /\bProcess\.exit\s*\([^,)]+,\s*:kill\s*\)/g,
    explanation:
      "Process.exit(pid, :kill) sends an untrappable exit signal. The target process cannot run cleanup code (terminate/2 callback). This can leave resources (files, sockets, ETS tables) in an inconsistent state.",
    verify_prompt:
      "Is :kill used as a last resort after a normal shutdown attempt, or is it the primary shutdown mechanism? " +
      "If it's a fallback after timeout on normal exit, respond FALSE_POSITIVE. " +
      "If it's the first/only shutdown signal, respond CONFIRMED.",
    cwe: "CWE-404",
    fix_template: "Use Process.exit(pid, :shutdown) first, which allows cleanup. Only use :kill as a timeout fallback.",
  },
  {
    id: "ex-006-ecto-raw-sql-injection",
    title: "SQL injection in Ecto raw query",
    severity: "critical",
    languages: ["elixir"],
    regex: /\bEcto\.Adapters\.\w+\.query\s*\(\s*\w+\s*,\s*"[^"]*#\{/g,
    explanation:
      "String interpolation in Ecto raw SQL queries bypasses parameterization. User input in the interpolated expression enables SQL injection.",
    verify_prompt:
      "Does the #{} interpolation contain user input (params, conn.params, form data)? " +
      "If interpolating a module constant or compile-time value, respond FALSE_POSITIVE. " +
      "If user-controlled data, respond CONFIRMED.",
    cwe: "CWE-89",
    fix_template: 'Use parameterized queries: Ecto.Adapters.SQL.query(repo, "SELECT * FROM t WHERE id = $1", [user_id])',
  },
  {
    id: "ex-007-hardcoded-secrets-config",
    title: "Hardcoded secrets in config",
    severity: "high",
    languages: ["elixir"],
    regex: /(?:secret_key_base|api_key|password|secret|token):\s*"[A-Za-z0-9+/=_-]{16,}"/g,
    explanation:
      "Hardcoded secrets in config.exs or runtime.exs are committed to version control. Use environment variables or vault.",
    verify_prompt:
      "Is this in a config file committed to git (config.exs, dev.exs, prod.exs)? " +
      "If it's in runtime.exs reading from System.get_env(), respond FALSE_POSITIVE. " +
      "If the secret is a hardcoded literal in a committed config, respond CONFIRMED.",
    cwe: "CWE-798",
    fix_template: 'Use System.get_env("SECRET_KEY_BASE") in runtime.exs.',
  },
  {
    id: "ex-008-missing-supervisor-strategy",
    title: "Supervisor without explicit restart strategy",
    severity: "low",
    languages: ["elixir"],
    regex: /\bSupervisor\.start_link\s*\(\s*\[[^\]]*\]\s*,\s*(?:name:|strategy:(?!\s*:one_for_one|\s*:rest_for_one|\s*:one_for_all))/g,
    explanation:
      "Using the default supervisor strategy without explicit thought can lead to cascading failures. The default :one_for_one may not be appropriate for processes with dependencies.",
    verify_prompt:
      "Is the default :one_for_one strategy appropriate for these child processes? " +
      "If the children are independent, respond FALSE_POSITIVE. " +
      "If children depend on each other (e.g., producer-consumer), respond CONFIRMED.",
    cwe: "CWE-754",
    fix_template: "Explicitly set strategy: Supervisor.start_link(children, strategy: :one_for_all) for dependent processes.",
  },
  {
    id: "ex-009-task-async-no-await",
    title: "Task.async without Task.await (orphaned task)",
    severity: "medium",
    languages: ["elixir"],
    regex: /\bTask\.async\s*\([^)]*\)(?![\s\S]{0,300}?Task\.(?:await|yield))/g,
    explanation:
      "Task.async() creates a linked task that MUST be awaited. If never awaited, the caller process will crash when the task finishes or times out (default 5 seconds).",
    verify_prompt:
      "Is Task.await() or Task.yield() called on this task within the same function or scope? " +
      "If awaited, respond FALSE_POSITIVE. " +
      "If the task result is never collected, respond CONFIRMED.",
    cwe: "CWE-404",
    fix_template: "Add Task.await(task) to collect the result, or use Task.start/Task.start_link for fire-and-forget.",
  },
  {
    id: "ex-010-io-inspect-production",
    title: "IO.inspect left in production code",
    severity: "low",
    languages: ["elixir"],
    regex: /\bIO\.inspect\s*\(/g,
    explanation:
      "IO.inspect() is a debugging tool that writes to stdout. In production, it can leak sensitive data to logs, and the synchronous I/O impacts performance under load.",
    verify_prompt:
      "Is this IO.inspect in production code or in test/development helpers? " +
      "If in test files, IEx helpers, or behind a debug flag, respond FALSE_POSITIVE. " +
      "If in production code path (controllers, contexts, GenServers), respond CONFIRMED.",
    cwe: "CWE-532",
    fix_template: "Use Logger.debug(inspect(value)) for structured logging, or remove the IO.inspect call.",
  },
];

// ═══════════════════════════════════════════════════════════════
// Lua Patterns
// ═══════════════════════════════════════════════════════════════

export const LUA_PATTERNS: BugPattern[] = [
  {
    id: "lua-001-global-pollution",
    title: "Global variable pollution (missing local)",
    severity: "medium",
    languages: ["lua"],
    regex: /^(?!\s*local\s)\s*([a-zA-Z_]\w*)\s*=\s*(?!nil\b)/gm,
    explanation:
      "Variables without 'local' keyword are global in Lua, polluting the global namespace. This causes hard-to-debug name collisions across modules and files.",
    verify_prompt:
      "Is this an intentional global assignment (module export, configuration table)? " +
      "If it's a module-level export or in the main script, respond FALSE_POSITIVE. " +
      "If it's inside a function and should be local, respond CONFIRMED.",
    cwe: "CWE-1108",
    fix_template: "Add 'local' keyword: local myVar = value",
  },
  {
    id: "lua-002-loadstring-injection",
    title: "loadstring/load with user input (code injection)",
    severity: "critical",
    languages: ["lua"],
    regex: /\b(?:loadstring|load)\s*\(\s*(?!["'])[a-zA-Z_]/g,
    explanation:
      "loadstring()/load() compiles and returns a Lua function from a string. With user input, attackers can execute arbitrary Lua code including os.execute(), io.open(), etc.",
    verify_prompt:
      "Is the string argument from user/external input (network, file, config)? " +
      "If it's a hardcoded string literal, respond FALSE_POSITIVE. " +
      "If the string could contain untrusted data, respond CONFIRMED.",
    cwe: "CWE-95",
    fix_template: "Avoid loadstring with user data. Use a data format (JSON) and parse it instead.",
  },
  {
    id: "lua-003-table-nil-index",
    title: "Table indexed with potentially nil key",
    severity: "medium",
    languages: ["lua"],
    regex: /\b(\w+)\s*\[\s*(\w+)\s*\]\s*=(?![\s\S]{0,50}?if\s+\2\s*~=\s*nil)/g,
    explanation:
      "Indexing a table with nil crashes Lua: 'table index is nil'. This commonly happens when a variable is uninitialized or a function returns nil unexpectedly.",
    verify_prompt:
      "Is the index variable guaranteed to be non-nil at this point? " +
      "If there's a preceding nil check or the variable is always set, respond FALSE_POSITIVE. " +
      "If the index could be nil (from function return, optional parameter), respond CONFIRMED.",
    cwe: "CWE-476",
    fix_template: "Add nil guard: if key ~= nil then tbl[key] = value end",
  },
  {
    id: "lua-004-string-concat-loop",
    title: "String concatenation in loop (O(n^2) performance)",
    severity: "low",
    languages: ["lua"],
    regex: /(?:for|while)\s+[\s\S]{0,100}?\b(\w+)\s*=\s*\1\s*\.\.\s*/g,
    explanation:
      "Lua strings are immutable. Concatenating with .. in a loop creates a new string each iteration, causing O(n^2) memory allocation. Use table.concat instead.",
    verify_prompt:
      "Is this string concatenation inside a loop that could iterate many times? " +
      "If the loop iterates a fixed small number of times (< 10), respond FALSE_POSITIVE. " +
      "If it processes variable-length data (file lines, records), respond CONFIRMED.",
    cwe: "CWE-400",
    fix_template: "Collect in table, join at end: local parts = {}; for ... do parts[#parts+1] = chunk end; result = table.concat(parts)",
  },
  {
    id: "lua-005-os-execute-injection",
    title: "os.execute with user input (command injection)",
    severity: "critical",
    languages: ["lua"],
    regex: /\bos\.execute\s*\(\s*(?!["'])[a-zA-Z_]/g,
    explanation:
      "os.execute() runs a shell command. If the argument includes user input, attackers can inject additional commands with ; | && etc.",
    verify_prompt:
      "Is the command string from user/external input or constructed with user data? " +
      "If entirely hardcoded, respond FALSE_POSITIVE. " +
      "If user input is concatenated into the command, respond CONFIRMED.",
    cwe: "CWE-78",
    fix_template: "Avoid os.execute with user data. Use io.popen with proper escaping, or avoid shell entirely.",
  },
  {
    id: "lua-006-pcall-no-error-handling",
    title: "pcall result ignored (silent error swallowing)",
    severity: "medium",
    languages: ["lua"],
    regex: /\bpcall\s*\([^)]*\)\s*\n\s*(?!(?:if|local\s+\w+\s*,\s*\w+))/g,
    explanation:
      "pcall() returns success boolean and result/error, but if the return values are ignored, errors are silently swallowed. This hides bugs and makes debugging difficult.",
    verify_prompt:
      "Are the pcall return values (ok, err) captured and checked? " +
      "If the result is assigned and checked, respond FALSE_POSITIVE. " +
      "If pcall is called as a statement with no return value capture, respond CONFIRMED.",
    cwe: "CWE-754",
    fix_template: "local ok, err = pcall(fn); if not ok then log_error(err) end",
  },
  {
    id: "lua-007-infinite-coroutine",
    title: "Infinite loop without yield in coroutine",
    severity: "high",
    languages: ["lua"],
    regex: /coroutine\.create\s*\(\s*function[\s\S]{0,200}?while\s+true\s+do(?![\s\S]{0,200}?coroutine\.yield)/g,
    explanation:
      "A coroutine with while-true and no yield will never return control to the caller, effectively hanging the program.",
    verify_prompt:
      "Does this while-true loop inside the coroutine contain a coroutine.yield()? " +
      "If yield exists within the loop body, respond FALSE_POSITIVE. " +
      "If the loop has no yield or break, respond CONFIRMED.",
    cwe: "CWE-835",
    fix_template: "Add coroutine.yield() inside the loop to return control to the caller.",
  },
  {
    id: "lua-008-require-path-injection",
    title: "require() with user input (path injection)",
    severity: "high",
    languages: ["lua"],
    regex: /\brequire\s*\(\s*(?!["'])[a-zA-Z_]\w*\s*\)/g,
    explanation:
      "require() with a variable module name allows attackers to load arbitrary Lua modules. Combined with package.path manipulation, this can execute attacker-controlled code.",
    verify_prompt:
      "Is the module name from user/external input or a dynamic variable? " +
      "If it's an internal variable set from a trusted whitelist, respond FALSE_POSITIVE. " +
      "If it could be user-controlled, respond CONFIRMED.",
    cwe: "CWE-98",
    fix_template: "Whitelist modules: local ALLOWED = {mod1=true, mod2=true}; if ALLOWED[name] then require(name) end",
  },
];

// ═══════════════════════════════════════════════════════════════
// SQL Patterns
// ═══════════════════════════════════════════════════════════════

export const SQL_PATTERNS: BugPattern[] = [
  {
    id: "sql-001-grant-all",
    title: "GRANT ALL PRIVILEGES (over-permissioned)",
    severity: "high",
    languages: ["sql"],
    regex: /GRANT\s+ALL\s+PRIVILEGES/gi,
    explanation: "Granting ALL PRIVILEGES violates least-privilege principle. Grant only needed permissions.",
    verify_prompt: "Is this a setup/migration script for a dedicated service account, or a shared account? If overly broad, respond CONFIRMED." +
      "\n\nRespond FALSE_POSITIVE if ANY of these is true:\n" +
      "1. This is a local development/test setup script (not used in production)\n" +
      "2. The GRANT is for a dedicated service account with limited scope on a specific database\n" +
      "3. This is a temporary migration script with a corresponding REVOKE\n" +
      "4. The user is a superadmin/DBA account intended to have full access\n" +
      "Only respond CONFIRMED if this grants ALL PRIVILEGES to a shared or application account in production.",
    cwe: "CWE-250",
    fix_template: "GRANT SELECT, INSERT, UPDATE ON specific_table TO user;",
  },
  {
    id: "sql-002-plaintext-password",
    title: "Plaintext password in SQL",
    severity: "critical",
    languages: ["sql"],
    regex: /(?:PASSWORD|IDENTIFIED BY)\s+['"][^'"]+['"]/gi,
    explanation: "Plaintext passwords in SQL scripts are exposed to anyone with repo access.",
    verify_prompt: "Is this a real password or a placeholder like 'changeme'? If real, respond CONFIRMED." +
      "\n\nRespond FALSE_POSITIVE if ANY of these is true:\n" +
      "1. The password is a placeholder ('changeme', 'xxx', 'password', 'TODO', 'REPLACE_ME', 'secret')\n" +
      "2. This is in test, example, seed data, or documentation code\n" +
      "3. The password is loaded from an environment variable or secrets manager at runtime\n" +
      "4. This is a local development setup script not intended for production\n" +
      "Only respond CONFIRMED if a real production password is hardcoded in the SQL script.",
    cwe: "CWE-798",
    fix_template: "Use environment variables or secrets manager for credentials.",
  },
];

// ═══════════════════════════════════════════════════════════════
// Scala Patterns
// ═══════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════
// Framework-Specific Patterns
// ═══════════════════════════════════════════════════════════════

export const FRAMEWORK_PATTERNS: BugPattern[] = [
  // Django
  {
    id: "django-001-raw-sql",
    title: "Django raw SQL with string formatting",
    severity: "critical",
    languages: ["python"],
    regex: /\b(?:raw|extra)\s*\(\s*(?:f["']|["'].*%|["'].*\.format)/g,
    explanation: "Django raw()/extra() with string formatting bypasses ORM protections → SQL injection.",
    verify_prompt: "Check ALL: 1. Is this using Django's parameterized form raw(sql, [params])? → FP. 2. Is user input interpolated? Only CONFIRMED if untrusted input is formatted into SQL." +
      "\n\nRespond FALSE_POSITIVE if ANY of these is true:\n" +
      "1. Parameterized queries are used: raw('SELECT ... WHERE id = %s', [param])\n" +
      "2. The interpolated values are integer IDs from validated/internal sources\n" +
      "3. The query is constructed from trusted constants only (no user input)\n" +
      "4. This is in test/migration code with no user-facing input path\n" +
      "Only respond CONFIRMED if untrusted user input is string-formatted into the SQL query.",
    cwe: "CWE-89",
    fix_template: "Use Model.objects.raw('SELECT * FROM t WHERE id = %s', [user_id])",
  },
  {
    id: "django-002-mark-safe",
    title: "mark_safe() with dynamic content (XSS)",
    severity: "high",
    languages: ["python"],
    regex: /\bmark_safe\s*\(\s*(?:f["']|.*\+|.*\.format|.*%)/g,
    explanation: "mark_safe() tells Django to NOT escape HTML. With dynamic content → XSS.",
    verify_prompt: "Is the argument entirely hardcoded HTML? → FP. Does it include ANY user input? → CONFIRMED." +
      "\n\nRespond FALSE_POSITIVE if ANY of these is true:\n" +
      "1. The argument is entirely hardcoded HTML with no dynamic content\n" +
      "2. The dynamic content is already escaped via django.utils.html.escape() before mark_safe()\n" +
      "3. The content comes from a trusted admin-only source (CMS managed by staff)\n" +
      "4. This is in test or documentation code\n" +
      "Only respond CONFIRMED if user-controlled input is included without escaping.",
    cwe: "CWE-79",
    fix_template: "Use format_html() instead: format_html('<b>{}</b>', user_input)",
  },
  {
    id: "django-003-secret-key",
    title: "Django SECRET_KEY hardcoded in settings",
    severity: "high",
    languages: ["python"],
    regex: /SECRET_KEY\s*=\s*["'][A-Za-z0-9!@#$%^&*]{20,}["']/g,
    explanation: "Hardcoded SECRET_KEY in settings.py. If leaked, session forgery + CSRF bypass.",
    verify_prompt: "Is this in a test/example file? → FP. Is it in production settings? → CONFIRMED." +
      "\n\nRespond FALSE_POSITIVE if ANY of these is true:\n" +
      "1. This is in a test, example, or template file (not production settings)\n" +
      "2. The value is a placeholder ('changeme', 'your-secret-key-here', 'TODO')\n" +
      "3. The SECRET_KEY is loaded from environment variable with a hardcoded fallback for dev only\n" +
      "4. This is in a settings file explicitly marked as local/development\n" +
      "Only respond CONFIRMED if a real secret key is hardcoded in production settings.",
    cwe: "CWE-798",
    fix_template: "SECRET_KEY = os.environ.get('DJANGO_SECRET_KEY')",
  },
  // Express/Node.js
  {
    id: "express-001-nosql-injection",
    title: "Express MongoDB query with req.body (NoSQL injection)",
    severity: "critical",
    languages: ["javascript", "typescript"],
    regex: /\b(?:find|findOne|updateOne|deleteOne)\s*\(\s*(?:req\.body|req\.query|req\.params)/g,
    explanation: "Passing req.body directly to MongoDB enables NoSQL injection ($gt, $ne operators).",
    verify_prompt: "Is req.body passed directly without type validation/casting? → CONFIRMED. Is input validated/cast first? → FP." +
      "\n\nRespond FALSE_POSITIVE if ANY of these is true:\n" +
      "1. Input fields are explicitly cast/validated (String(), Number(), mongoose schema validation)\n" +
      "2. A validation middleware (joi, zod, express-validator) runs before this handler\n" +
      "3. Only specific scalar fields are extracted (not the entire req.body object)\n" +
      "4. This is in test code with controlled input\n" +
      "Only respond CONFIRMED if req.body/req.query/req.params is passed directly to a MongoDB query without type validation.",
    cwe: "CWE-943",
    fix_template: "Validate and cast: { email: String(req.body.email) }",
  },
  {
    id: "express-002-xss-render",
    title: "Rendering user input without escaping",
    severity: "high",
    languages: ["javascript", "typescript"],
    regex: /res\.send\s*\(\s*(?:req\.|`.*\$\{req\.)/g,
    explanation: "Sending user input directly in response without escaping → reflected XSS.",
    verify_prompt: "Is the response HTML with user input interpolated? → CONFIRMED. Is it JSON or escaped? → FP." +
      "\n\nRespond FALSE_POSITIVE if ANY of these is true:\n" +
      "1. The response is JSON (res.json()) not HTML\n" +
      "2. The output is already escaped/sanitized before being sent\n" +
      "3. The content comes from a trusted admin-only source\n" +
      "4. Content-Type is set to text/plain (not text/html)\n" +
      "Only respond CONFIRMED if user input is interpolated into an HTML response without escaping.",
    cwe: "CWE-79",
    fix_template: "Use a template engine with auto-escaping, or escape: require('he').encode(input)",
  },
  {
    id: "express-003-cors-wildcard",
    title: "CORS with origin: '*' and credentials",
    severity: "high",
    languages: ["javascript", "typescript"],
    regex: /cors\s*\(\s*\{[^}]*origin\s*:\s*(?:true|["']\*["'])/g,
    explanation: "CORS with wildcard origin allows any site to make authenticated requests.",
    verify_prompt: "Is credentials: true also set? → CONFIRMED. Is this a public API without auth? → FP." +
      "\n\nRespond FALSE_POSITIVE if ANY of these is true:\n" +
      "1. This is a public API that requires no authentication (no cookies/sessions)\n" +
      "2. credentials is not set or is set to false\n" +
      "3. This is a local development configuration not used in production\n" +
      "4. The wildcard origin is in a development-only code path (e.g., if (isDev))\n" +
      "Only respond CONFIRMED if origin '*' is combined with credentials: true in production code.",
    cwe: "CWE-942",
    fix_template: "Whitelist specific origins: origin: ['https://myapp.com']",
  },
  // React/Next.js
  {
    id: "react-001-dangerously-set",
    title: "dangerouslySetInnerHTML with dynamic content",
    severity: "high",
    languages: ["javascript", "typescript"],
    regex: /dangerouslySetInnerHTML\s*=\s*\{\s*\{\s*__html\s*:\s*(?!["'`]\s*[}])/g,
    explanation: "dangerouslySetInnerHTML bypasses React's XSS protection. With dynamic content → XSS.",
    verify_prompt: "Is __html a hardcoded constant? → FP. Does it include ANY user/external data? → CONFIRMED." +
      "\n\nRespond FALSE_POSITIVE if ANY of these is true:\n" +
      "1. The __html value is a hardcoded constant string\n" +
      "2. The content is sanitized with DOMPurify or a similar sanitizer before use\n" +
      "3. The content comes from a trusted admin-only CMS source\n" +
      "4. This is in test or storybook code with controlled input\n" +
      "Only respond CONFIRMED if user-controlled or external data is set as __html without sanitization.",
    cwe: "CWE-79",
    fix_template: "Use DOMPurify: { __html: DOMPurify.sanitize(content) }",
  },
  // Flask
  {
    id: "flask-001-render-string",
    title: "Flask render_template_string with user input (SSTI)",
    severity: "critical",
    languages: ["python"],
    regex: /\brender_template_string\s*\(\s*(?:request\.|f["']|.*\+|.*\.format|.*%)/g,
    explanation: "render_template_string() with user input enables Server-Side Template Injection → RCE.",
    verify_prompt: "Is the template string from user input? → CONFIRMED. Is it hardcoded? → FP." +
      "\n\nRespond FALSE_POSITIVE if ANY of these is true:\n" +
      "1. The template string is hardcoded (no user input in the template itself)\n" +
      "2. User input is passed only as template variables (not as part of the template string)\n" +
      "3. This is in test or documentation code\n" +
      "4. The template string comes from a trusted internal source (admin config)\n" +
      "Only respond CONFIRMED if user-controlled input is part of the template string itself (not just template variables).",
    cwe: "CWE-1336",
    fix_template: "Use render_template() with a .html file instead of render_template_string().",
  },
  // FastAPI
  {
    id: "fastapi-001-sql-raw",
    title: "FastAPI with raw SQL string formatting",
    severity: "critical",
    languages: ["python"],
    regex: /\b(?:execute|text)\s*\(\s*(?:f["']|["'].*\{)/g,
    explanation: "Raw SQL with f-strings in FastAPI/SQLAlchemy bypasses parameterized queries.",
    verify_prompt: "Is this using text() with :param placeholders? → FP. Is user input in f-string? → CONFIRMED." +
      "\n\nRespond FALSE_POSITIVE if ANY of these is true:\n" +
      "1. Parameterized queries are used: text('... WHERE id = :id').bindparams(id=val)\n" +
      "2. The interpolated values are integer IDs from validated/internal sources\n" +
      "3. The query is constructed from trusted constants only (table names, column names)\n" +
      "4. This is in test/migration code with no user-facing input path\n" +
      "Only respond CONFIRMED if untrusted user input is string-formatted into the SQL query.",
    cwe: "CWE-89",
    fix_template: "Use text('SELECT * FROM t WHERE id = :id').bindparams(id=user_id)",
  },
  // Rails
  {
    id: "rails-001-html-safe",
    title: "Rails .html_safe on user content (XSS)",
    severity: "high",
    languages: ["ruby"],
    regex: /\.html_safe\b/g,
    explanation: ".html_safe tells Rails to skip HTML escaping. On user content → XSS.",
    verify_prompt: "Is the string entirely hardcoded/internal? → FP. Could it contain user input? → CONFIRMED." +
      "\n\nRespond FALSE_POSITIVE if ANY of these is true:\n" +
      "1. The string is entirely hardcoded HTML (e.g., '<br>'.html_safe)\n" +
      "2. The content is already sanitized with sanitize() or ERB::Util.html_escape before .html_safe\n" +
      "3. The content comes from a trusted admin-only source\n" +
      "4. This is in test, helper, or view code rendering only internal/static content\n" +
      "Only respond CONFIRMED if user-controlled content could reach .html_safe without prior escaping.",
    cwe: "CWE-79",
    fix_template: "Use sanitize() helper: sanitize(user_content, tags: %w[b i em])",
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
    languages: ["shell"],
    regex: /\beval\s+["']?\$[\{(]/g,
    explanation: "eval with variable expansion in shell enables command injection.",
    verify_prompt: "Is the variable from trusted internal source or user input? CONFIRMED if user-controlled." +
      "\n\nRespond FALSE_POSITIVE if ANY of these is true:\n" +
      "1. The variable is set from a trusted internal source (hardcoded config, internal script logic)\n" +
      "2. The variable is validated/sanitized before reaching eval\n" +
      "3. This is in a build script or CI/CD pipeline with controlled inputs\n" +
      "4. The eval operates on a compile-time constant or environment variable set by the system\n" +
      "Only respond CONFIRMED if user-controlled or external input can reach the eval through the variable.",
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

// ═══════════════════════════════════════════════════════════════
// Haskell Patterns
// ═══════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════
// Zig Patterns
// ═══════════════════════════════════════════════════════════════

export const ZIG_PATTERNS: BugPattern[] = [
  // ── Use-after-free ────────────────────────────────────────────
  {
    id: "zig-001-use-after-free",
    title: "Potential use-after-free (access after allocator.free/destroy)",
    severity: "critical",
    languages: ["zig"],
    regex: /(?:allocator\.free|allocator\.destroy)\s*\([^)]*(\w+)[^)]*\)[\s\S]{0,200}?\1\s*[\[.]/g,
    explanation:
      "Accessing memory after calling allocator.free() or allocator.destroy() is undefined behavior. The memory may be reused by subsequent allocations, causing silent data corruption or crashes.",
    verify_prompt:
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      "1. Is the variable reassigned before the subsequent access? → FALSE_POSITIVE\n" +
      "2. Is the access in a different scope that doesn't execute after the free? → FALSE_POSITIVE\n" +
      "3. Is the free conditional and the access is in the non-freed branch? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if the same pointer/slice is accessed after being freed.",
    cwe: "CWE-416",
    fix_template: "Set the pointer to undefined after free: ptr = undefined; or restructure to not access after free.",
  },

  // ── Ignoring error return ─────────────────────────────────────
  {
    id: "zig-002-ignored-error",
    title: "Error union return value discarded",
    severity: "high",
    languages: ["zig"],
    regex: /\b_\s*=\s*\w+(?:\.\w+)*\s*\([^)]*\)\s*(?:catch\s+\|_\|\s*\{\s*\}|catch\s+unreachable)/g,
    explanation:
      "Discarding an error return with `_ = foo()` or `catch unreachable` silences failures. If the function can genuinely error at runtime, `catch unreachable` causes safety-checked undefined behavior in debug and actual UB in release.",
    verify_prompt:
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      "1. Is the function guaranteed to succeed in this context (proven precondition)? → FALSE_POSITIVE\n" +
      "2. Is there a comment explaining why the error is intentionally discarded? → FALSE_POSITIVE\n" +
      "3. Is this in test code? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if the function can error at runtime and the error is silently discarded.",
    cwe: "CWE-252",
    fix_template: "Handle the error: const result = foo() catch |err| { return err; };",
  },

  // ── Undefined behavior in release mode ────────────────────────
  {
    id: "zig-003-release-ub",
    title: "Safety check removed in ReleaseFast/ReleaseSmall (undefined behavior)",
    severity: "critical",
    languages: ["zig"],
    regex: /\b(?:@intCast|@truncate|@ptrCast)\s*\(/g,
    explanation:
      "Zig builtins like @intCast, @truncate, and @ptrCast perform safety checks in Debug mode but become undefined behavior in ReleaseFast/ReleaseSmall if the precondition is violated. Code that \"works in debug\" may silently corrupt data in release.",
    verify_prompt:
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      "1. Is the input value validated/bounded before the cast? → FALSE_POSITIVE\n" +
      "2. Is the value a compile-time known constant? → FALSE_POSITIVE\n" +
      "3. Is this in code that only runs in Debug mode? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if the cast could fail at runtime without prior validation.",
    cwe: "CWE-681",
    fix_template: "Validate the value before casting, or use std.math.cast() which returns null on failure.",
  },

  // ── Buffer overflow via unchecked indexing ────────────────────
  {
    id: "zig-004-buffer-overflow",
    title: "Slice indexing without bounds check (UB in release)",
    severity: "high",
    languages: ["zig"],
    regex: /\b(\w+)\s*\[\s*(\w+)\s*\](?!\s*(?:\.\.|\s*=\s*))[\s\S]{0,50}?(?![\s\S]{0,200}?(?:if\s*\(\s*\2\s*<\s*\1\.len|assert\s*\(\s*\2\s*<))/g,
    explanation:
      "Array/slice indexing in Zig is bounds-checked in Debug but becomes undefined behavior in release modes. If the index comes from external input without validation, this is a buffer overflow in production.",
    verify_prompt:
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      "1. Is there a bounds check (if idx < slice.len) before the index? → FALSE_POSITIVE\n" +
      "2. Is the index a compile-time constant within known bounds? → FALSE_POSITIVE\n" +
      "3. Is this in code that always runs with safety checks enabled? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if the index comes from runtime input without prior bounds validation.",
    cwe: "CWE-120",
    fix_template: "Add bounds check: if (idx < slice.len) slice[idx] else return error.OutOfBounds;",
  },

  // ── Memory leak ───────────────────────────────────────────────
  {
    id: "zig-005-memory-leak",
    title: "Allocation without corresponding free (memory leak)",
    severity: "medium",
    languages: ["zig"],
    regex: /allocator\.(?:alloc|create|dupe|dupeZ|alignedAlloc)\s*\([^)]*\)[\s\S]{0,500}?(?:return|break|continue)(?![\s\S]{0,300}?(?:defer\s+allocator\.free|errdefer\s+allocator\.free))/g,
    explanation:
      "Memory allocated with an allocator but not freed (or not covered by defer/errdefer) leaks. Unlike garbage-collected languages, Zig requires explicit memory management.",
    verify_prompt:
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      "1. Is there a `defer allocator.free(...)` or `errdefer allocator.free(...)` for this allocation? → FALSE_POSITIVE\n" +
      "2. Is the allocation returned to the caller (ownership transfer)? → FALSE_POSITIVE\n" +
      "3. Is this using an arena allocator that frees everything at once? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if the allocation has no corresponding free on all code paths.",
    cwe: "CWE-401",
    fix_template: "Add defer allocator.free(ptr) immediately after allocation, or use errdefer for error paths.",
  },

  // ── Sentinel-terminated string misuse ─────────────────────────
  {
    id: "zig-006-sentinel-misuse",
    title: "Sentinel-terminated slice used as regular slice (missing sentinel)",
    severity: "high",
    languages: ["zig"],
    regex: /\[\*\](?:const\s+)?u8\s*(?!=\s*@as\(\[:\d\])[\s\S]{0,100}?@ptrCast/g,
    explanation:
      "Converting between sentinel-terminated ([*:0]u8) and regular ([*]u8) slices can lose the sentinel guarantee. C interop functions expect null-terminated strings — passing a non-terminated slice causes reads past the buffer until a stray zero is found.",
    verify_prompt:
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      "1. Is the sentinel preserved through the conversion? → FALSE_POSITIVE\n" +
      "2. Is this not being passed to C interop (no extern fn call)? → FALSE_POSITIVE\n" +
      "3. Is the slice known to be null-terminated from its source? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if a non-sentinel slice is passed where a sentinel-terminated one is expected.",
    cwe: "CWE-170",
    fix_template: "Use [:0]u8 type explicitly, or use std.mem.sliceTo() to create a sentinel-terminated slice.",
  },

  // ── Integer overflow in release ───────────────────────────────
  {
    id: "zig-007-integer-overflow",
    title: "Arithmetic overflow undefined in release mode",
    severity: "high",
    languages: ["zig"],
    regex: /(?:@as\s*\(\s*u\d+|:\s*u\d+\s*=)[\s\S]{0,100}?(?:\+\s*(?!%)|(?<!\+)%\s*(?!\+)|-\s*(?!%)|\*\s*(?!%))/g,
    explanation:
      "Integer arithmetic in Zig is checked in Debug (panic on overflow) but wraps silently in ReleaseFast/ReleaseSmall. Use +% (wrapping add), -% (wrapping sub), or std.math.add for explicit overflow handling.",
    verify_prompt:
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      "1. Is wrapping arithmetic intentional (using +%, -%, *%)? → FALSE_POSITIVE\n" +
      "2. Are the operands bounded to prevent overflow? → FALSE_POSITIVE\n" +
      "3. Is this using std.math.add/sub/mul which return errors on overflow? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if unchecked arithmetic on unsigned types could overflow with runtime values.",
    cwe: "CWE-190",
    fix_template: "Use std.math.add(a, b) catch return error.Overflow, or +% for intentional wrapping.",
  },

  // ── @ptrCast without alignment ────────────────────────────────
  {
    id: "zig-008-ptrcast-alignment",
    title: "@ptrCast without verifying alignment requirements",
    severity: "high",
    languages: ["zig"],
    regex: /@ptrCast\s*\(\s*(?:\[\*\]|[*])\s*(?:align\s*\(\s*\d+\s*\)\s*)?(?:const\s+)?(?:u8|i8|c_char|anyopaque)/g,
    explanation:
      "@ptrCast can change alignment requirements. Casting a [*]u8 (align 1) to [*]u32 (align 4) on a non-aligned address is undefined behavior. This causes SIGBUS on ARM and silent corruption on x86.",
    verify_prompt:
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      "1. Is @alignCast used together with @ptrCast? → FALSE_POSITIVE\n" +
      "2. Is the source pointer guaranteed to be properly aligned (e.g., from allocator)? → FALSE_POSITIVE\n" +
      "3. Is the target type the same or smaller alignment than the source? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if the cast increases alignment requirements without verification.",
    cwe: "CWE-188",
    fix_template: "Use @alignCast before @ptrCast: @ptrCast(@alignCast(ptr)), or use std.mem.bytesAsSlice.",
  },

  // ── Unreachable code ──────────────────────────────────────────
  {
    id: "zig-009-unreachable-misuse",
    title: "unreachable used as assertion (UB in release)",
    severity: "critical",
    languages: ["zig"],
    regex: /\bunreachable\s*[;,)]/g,
    explanation:
      "In Zig, `unreachable` is a promise to the compiler that code is never reached. In Debug mode it panics, but in release mode it's undefined behavior. If the code CAN be reached (e.g., in an else branch for \"impossible\" cases), this causes silent corruption.",
    verify_prompt:
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      "1. Is this truly unreachable (e.g., after exhaustive switch, after noreturn)? → FALSE_POSITIVE\n" +
      "2. Is this in a switch prong that handles a comptime-known impossible case? → FALSE_POSITIVE\n" +
      "3. Is there a comment explaining why this is genuinely unreachable? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if the unreachable could be reached at runtime (e.g., catch-all else branch).",
    cwe: "CWE-561",
    fix_template: "Replace unreachable with an explicit error: return error.UnexpectedState, or use @panic() for debugging.",
  },

  // ── Comptime vs runtime confusion ─────────────────────────────
  {
    id: "zig-010-comptime-runtime",
    title: "Comptime value used in runtime context (or vice versa)",
    severity: "medium",
    languages: ["zig"],
    regex: /comptime\s+(?:var|const)\s+\w+[\s\S]{0,200}?(?:if\s*\(|while\s*\(|for\s*\()(?!comptime)/g,
    explanation:
      "Mixing comptime and runtime values can cause subtle bugs. A comptime variable used in a runtime branch always takes the compile-time value, ignoring runtime state. Conversely, trying to use runtime values in comptime context causes compile errors that are confusing.",
    verify_prompt:
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      "1. Is the comptime value intentionally used as a constant in runtime code? → FALSE_POSITIVE\n" +
      "2. Is this a comptime if/for that generates different code paths (inline for)? → FALSE_POSITIVE\n" +
      "3. Is the developer clearly aware of the comptime/runtime boundary? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if a comptime value is mistakenly expected to change at runtime.",
    cwe: "CWE-758",
    fix_template: "Use var instead of comptime var for runtime-changing values, or use comptime blocks explicitly.",
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
