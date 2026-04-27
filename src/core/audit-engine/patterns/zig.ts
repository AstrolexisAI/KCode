// KCode - ZIG Bug Patterns
// Extracted from the monolithic patterns.ts. See that file for the
// ALL_PATTERNS aggregator and lookup helpers.

import type { BugPattern } from "../types";

export const ZIG_PATTERNS: BugPattern[] = [
  // ── Use-after-free ────────────────────────────────────────────
  {
    id: "zig-001-use-after-free",
    title: "Potential use-after-free (access after allocator.free/destroy)",
    severity: "critical",
    languages: ["zig"],
    regex: /(?:allocator\.free|allocator\.destroy)\s*\([^)]*(\w+)[^)]*\)[\s\S]{0,200}?\1\s*[[.]/g,
    explanation:
      "Accessing memory after calling allocator.free() or allocator.destroy() is undefined behavior. The memory may be reused by subsequent allocations, causing silent data corruption or crashes.",
    verify_prompt:
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      "1. Is the variable reassigned before the subsequent access? → FALSE_POSITIVE\n" +
      "2. Is the access in a different scope that doesn't execute after the free? → FALSE_POSITIVE\n" +
      "3. Is the free conditional and the access is in the non-freed branch? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if the same pointer/slice is accessed after being freed.",
    cwe: "CWE-416",
    fix_template:
      "Set the pointer to undefined after free: ptr = undefined; or restructure to not access after free.",
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
      'Zig builtins like @intCast, @truncate, and @ptrCast perform safety checks in Debug mode but become undefined behavior in ReleaseFast/ReleaseSmall if the precondition is violated. Code that "works in debug" may silently corrupt data in release.',
    verify_prompt:
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      "1. Is the input value validated/bounded before the cast? → FALSE_POSITIVE\n" +
      "2. Is the value a compile-time known constant? → FALSE_POSITIVE\n" +
      "3. Is this in code that only runs in Debug mode? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if the cast could fail at runtime without prior validation.",
    cwe: "CWE-681",
    fix_template:
      "Validate the value before casting, or use std.math.cast() which returns null on failure.",
  },

  // ── Buffer overflow via unchecked indexing ────────────────────
  {
    id: "zig-004-buffer-overflow",
    title: "Slice indexing without bounds check (UB in release)",
    severity: "high",
    languages: ["zig"],
    regex:
      /\b(\w+)\s*\[\s*(\w+)\s*\](?!\s*(?:\.\.|\s*=\s*))[\s\S]{0,50}?(?![\s\S]{0,200}?(?:if\s*\(\s*\2\s*<\s*\1\.len|assert\s*\(\s*\2\s*<))/g,
    explanation:
      "Array/slice indexing in Zig is bounds-checked in Debug but becomes undefined behavior in release modes. If the index comes from external input without validation, this is a buffer overflow in production.",
    verify_prompt:
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      "1. Is there a bounds check (if idx < slice.len) before the index? → FALSE_POSITIVE\n" +
      "2. Is the index a compile-time constant within known bounds? → FALSE_POSITIVE\n" +
      "3. Is this in code that always runs with safety checks enabled? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if the index comes from runtime input without prior bounds validation.",
    cwe: "CWE-120",
    fix_template:
      "Add bounds check: if (idx < slice.len) slice[idx] else return error.OutOfBounds;",
  },

  // ── Memory leak ───────────────────────────────────────────────
  {
    id: "zig-005-memory-leak",
    title: "Allocation without corresponding free (memory leak)",
    severity: "medium",
    languages: ["zig"],
    regex:
      /allocator\.(?:alloc|create|dupe|dupeZ|alignedAlloc)\s*\([^)]*\)[\s\S]{0,500}?(?:return|break|continue)(?![\s\S]{0,300}?(?:defer\s+allocator\.free|errdefer\s+allocator\.free))/g,
    explanation:
      "Memory allocated with an allocator but not freed (or not covered by defer/errdefer) leaks. Unlike garbage-collected languages, Zig requires explicit memory management.",
    verify_prompt:
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      "1. Is there a `defer allocator.free(...)` or `errdefer allocator.free(...)` for this allocation? → FALSE_POSITIVE\n" +
      "2. Is the allocation returned to the caller (ownership transfer)? → FALSE_POSITIVE\n" +
      "3. Is this using an arena allocator that frees everything at once? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if the allocation has no corresponding free on all code paths.",
    cwe: "CWE-401",
    fix_template:
      "Add defer allocator.free(ptr) immediately after allocation, or use errdefer for error paths.",
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
    fix_template:
      "Use [:0]u8 type explicitly, or use std.mem.sliceTo() to create a sentinel-terminated slice.",
  },

  // ── Integer overflow in release ───────────────────────────────
  {
    id: "zig-007-integer-overflow",
    title: "Arithmetic overflow undefined in release mode",
    severity: "high",
    languages: ["zig"],
    regex:
      /(?:@as\s*\(\s*u\d+|:\s*u\d+\s*=)[\s\S]{0,100}?(?:\+\s*(?!%)|(?<!\+)%\s*(?!\+)|-\s*(?!%)|\*\s*(?!%))/g,
    explanation:
      "Integer arithmetic in Zig is checked in Debug (panic on overflow) but wraps silently in ReleaseFast/ReleaseSmall. Use +% (wrapping add), -% (wrapping sub), or std.math.add for explicit overflow handling.",
    verify_prompt:
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      "1. Is wrapping arithmetic intentional (using +%, -%, *%)? → FALSE_POSITIVE\n" +
      "2. Are the operands bounded to prevent overflow? → FALSE_POSITIVE\n" +
      "3. Is this using std.math.add/sub/mul which return errors on overflow? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if unchecked arithmetic on unsigned types could overflow with runtime values.",
    cwe: "CWE-190",
    fix_template:
      "Use std.math.add(a, b) catch return error.Overflow, or +% for intentional wrapping.",
  },

  // ── @ptrCast without alignment ────────────────────────────────
  {
    id: "zig-008-ptrcast-alignment",
    title: "@ptrCast without verifying alignment requirements",
    severity: "high",
    languages: ["zig"],
    regex:
      /@ptrCast\s*\(\s*(?:\[\*\]|[*])\s*(?:align\s*\(\s*\d+\s*\)\s*)?(?:const\s+)?(?:u8|i8|c_char|anyopaque)/g,
    explanation:
      "@ptrCast can change alignment requirements. Casting a [*]u8 (align 1) to [*]u32 (align 4) on a non-aligned address is undefined behavior. This causes SIGBUS on ARM and silent corruption on x86.",
    verify_prompt:
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      "1. Is @alignCast used together with @ptrCast? → FALSE_POSITIVE\n" +
      "2. Is the source pointer guaranteed to be properly aligned (e.g., from allocator)? → FALSE_POSITIVE\n" +
      "3. Is the target type the same or smaller alignment than the source? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if the cast increases alignment requirements without verification.",
    cwe: "CWE-188",
    fix_template:
      "Use @alignCast before @ptrCast: @ptrCast(@alignCast(ptr)), or use std.mem.bytesAsSlice.",
  },

  // ── Unreachable code ──────────────────────────────────────────
  {
    id: "zig-009-unreachable-misuse",
    title: "unreachable used as assertion (UB in release)",
    severity: "critical",
    languages: ["zig"],
    regex: /\bunreachable\s*[;,)]/g,
    explanation:
      'In Zig, `unreachable` is a promise to the compiler that code is never reached. In Debug mode it panics, but in release mode it\'s undefined behavior. If the code CAN be reached (e.g., in an else branch for "impossible" cases), this causes silent corruption.',
    verify_prompt:
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      "1. Is this truly unreachable (e.g., after exhaustive switch, after noreturn)? → FALSE_POSITIVE\n" +
      "2. Is this in a switch prong that handles a comptime-known impossible case? → FALSE_POSITIVE\n" +
      "3. Is there a comment explaining why this is genuinely unreachable? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if the unreachable could be reached at runtime (e.g., catch-all else branch).",
    cwe: "CWE-561",
    fix_template:
      "Replace unreachable with an explicit error: return error.UnexpectedState, or use @panic() for debugging.",
  },

  // ── Comptime vs runtime confusion ─────────────────────────────
  {
    id: "zig-010-comptime-runtime",
    title: "Comptime value used in runtime context (or vice versa)",
    severity: "medium",
    languages: ["zig"],
    regex:
      /comptime\s+(?:var|const)\s+\w+[\s\S]{0,200}?(?:if\s*\(|while\s*\(|for\s*\()(?!comptime)/g,
    explanation:
      "Mixing comptime and runtime values can cause subtle bugs. A comptime variable used in a runtime branch always takes the compile-time value, ignoring runtime state. Conversely, trying to use runtime values in comptime context causes compile errors that are confusing.",
    verify_prompt:
      "Check ALL of these before confirming. Respond FALSE_POSITIVE if ANY is true:\n" +
      "1. Is the comptime value intentionally used as a constant in runtime code? → FALSE_POSITIVE\n" +
      "2. Is this a comptime if/for that generates different code paths (inline for)? → FALSE_POSITIVE\n" +
      "3. Is the developer clearly aware of the comptime/runtime boundary? → FALSE_POSITIVE\n" +
      "Only respond CONFIRMED if a comptime value is mistakenly expected to change at runtime.",
    cwe: "CWE-758",
    fix_template:
      "Use var instead of comptime var for runtime-changing values, or use comptime blocks explicitly.",
  },
];
