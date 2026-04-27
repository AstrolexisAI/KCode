// KCode - CPP Bug Patterns
// Extracted from the monolithic patterns.ts. See that file for the
// ALL_PATTERNS aggregator and lookup helpers.

import type { BugPattern } from "../types";

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
    fix_template:
      "Replace `(&VAR)[IDX]` with `(char*)VAR + IDX` (for pointers) or verify VAR is an array.",
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
    regex:
      /\bint\s+(\w+)\s*=\s*\w+\([^)]*\)\s*;[\s\S]{0,200}?\b(std::vector|std::string|std::array)\s*<[^>]+>\s*\w+\s*\(\s*\1/g,
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
      '1. Is the source a short string LITERAL (e.g. "key:", "(*)", "sometime")? → FALSE_POSITIVE\n' +
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
    regex:
      /\b(\w+)\s*->\s*\w+(?![\s\S]{0,100}?\b(?:return|break|goto)\b)[\s\S]{0,100}?\bif\s*\(\s*\1\s*(?:==|!=)\s*(?:NULL|nullptr|0)\s*\)/g,
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
    fix_template:
      "Use calloc(count, sizeof(T)) which handles overflow, or add explicit bounds check.",
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

  // ── v2.10.332 — Phase A C/C++ expansion ───────────────────────
  {
    id: "cpp-013-snprintf-truncation-ignored",
    title: "snprintf return value ignored (silent truncation)",
    severity: "medium",
    languages: ["c", "cpp"],
    regex: /(?:^|\n)\s*snprintf\s*\(/g,
    explanation:
      "snprintf returns the number of bytes that WOULD have been written (excluding the null). If the return value ≥ buffer size, the output was truncated. Code that ignores the return and treats the buffer as a complete formatted string mishandles long inputs — common in log formatters, command builders, and serializers.",
    verify_prompt:
      "Check the surrounding context. FALSE_POSITIVE if ANY:\n" +
      "1. The return is captured into a variable that's checked against the buffer size → FALSE_POSITIVE.\n" +
      '2. The format string contains only fixed-width specifiers whose total can never exceed the buffer (e.g. "%04d" into a 16-byte buffer) → FALSE_POSITIVE.\n' +
      "3. The buffer is later treated as untrusted and bounds-checked before use → FALSE_POSITIVE.\n" +
      "4. This is in test code or a known-safe internal log path → FALSE_POSITIVE.\n" +
      "Only CONFIRMED when the call is `snprintf(buf, sizeof buf, fmt, %s/%d untrusted_value)` with the return value discarded AND the result is treated as a complete string downstream.",
    cwe: "CWE-252",
    fix_template:
      "Capture the return value: `int n = snprintf(buf, sizeof buf, ...); if (n < 0 || (size_t)n >= sizeof buf) handle_truncation();`",
  },
  {
    id: "cpp-014-fread-return-ignored",
    title: "fread / read return value not checked before parsing",
    severity: "high",
    languages: ["c", "cpp"],
    regex:
      /(?:^|\n)\s*(?:fread|read)\s*\([^;]+\);(?![\s\S]{0,200}?\b(?:if|FW_ASSERT|assert)\s*\()/g,
    explanation:
      "fread/read can return fewer bytes than requested (partial read on a network socket, end-of-file on a file). Code that calls fread then immediately parses the buffer assumes a full read happened. Short reads cause garbage parsing, OOB reads on the next access, or undefined behavior on uninitialized memory.",
    verify_prompt:
      "Check the next ~200 chars after the call:\n" +
      "1. Is the return captured AND compared (== expected_size, < 0, etc.)? → FALSE_POSITIVE.\n" +
      "2. Is there an FW_ASSERT or assert that gates further use? → FALSE_POSITIVE.\n" +
      "3. Is the read bounded by a length-prefix check upstream? → FALSE_POSITIVE.\n" +
      "Only CONFIRMED when the read result is discarded AND the buffer is parsed / dereferenced immediately afterwards.",
    cwe: "CWE-252",
    fix_template:
      "Capture and check: `ssize_t n = read(fd, buf, len); if (n < (ssize_t)len) handle_short_read();`",
  },
];
