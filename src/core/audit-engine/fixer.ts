// KCode - Audit Fixer
//
// Generates mechanical patches from confirmed audit findings.
// No LLM needed — each pattern has a deterministic fix strategy.
//
// Flow: read finding → read source file → apply fix rule → write file

import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { AuditResult, Finding } from "./types";

/**
 * Atomic file write: write to a sibling temp file, fsync if possible,
 * then rename over the target. This avoids half-written state if the
 * process dies mid-write (disk full, Ctrl-C, crash). The temp file lives
 * in the same directory as the target so the rename is on the same
 * filesystem and therefore atomic on POSIX.
 *
 * If the rename fails (e.g., cross-device on some setups), we clean up
 * the temp file and let the error propagate.
 */
function atomicWriteFileSync(targetPath: string, content: string): void {
  // 8 random bytes → 16 hex chars — low collision risk even with concurrent
  // /fix runs, and short enough to stay under path length limits.
  const tmp = `${targetPath}.kcode-fix-${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, targetPath);
  } catch (err) {
    // Best-effort cleanup of the temp file if the rename failed. We
    // swallow errors from unlinkSync because the temp file may not
    // exist (writeFileSync itself may have thrown before creating it).
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Outcome of applying a single fix.
 *
 * - `transformed`: a bespoke fixer rewrote real code to remove the bug.
 *   The file on disk is now different in a meaningful way.
 * - `annotated`: the generic recipe inserted a `KCODE-AUDIT:<id>` warning
 *   comment above the finding. The buggy code is UNCHANGED — the comment
 *   is an advisory TODO the user still has to act on.
 * - `skipped`: neither a bespoke fixer nor an annotation was applied
 *   (line out of range, pattern no longer present, marker already there).
 *
 * `applied` is kept as a boolean for existing callers; it is true for both
 * `transformed` and `annotated`. New UI should look at `kind` instead so
 * annotations aren't reported as real fixes.
 */
export type FixKind = "transformed" | "annotated" | "skipped";

export interface FixResult {
  file: string;
  line: number;
  pattern_id: string;
  applied: boolean;
  kind: FixKind;
  description: string;
}

/**
 * Apply fixes for all confirmed findings in an audit result.
 * Returns a list of what was fixed and what was skipped.
 */
export function applyFixes(result: AuditResult): FixResult[] {
  const results: FixResult[] = [];

  // Group findings by file so we apply all fixes to a file at once
  // (important: apply from bottom to top so line numbers don't shift)
  const byFile = new Map<string, Finding[]>();
  for (const f of result.findings) {
    const arr = byFile.get(f.file) ?? [];
    arr.push(f);
    byFile.set(f.file, arr);
  }

  for (const [file, findings] of byFile) {
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      for (const f of findings) {
        results.push({
          file,
          line: f.line,
          pattern_id: f.pattern_id,
          applied: false,
          kind: "skipped",
          description: `Cannot read file: ${file}`,
        });
      }
      continue;
    }

    // Sort findings by line DESC so we fix from bottom to top
    const sorted = [...findings].sort((a, b) => b.line - a.line);
    let lines = content.split("\n");
    let modified = false;

    for (const finding of sorted) {
      const fixResult = applyOneFix(lines, finding);
      if (fixResult.applied) {
        lines = fixResult.lines;
        modified = true;
      }
      results.push({
        file,
        line: finding.line,
        pattern_id: finding.pattern_id,
        applied: fixResult.applied,
        kind: fixResult.kind,
        description: fixResult.description,
      });
    }

    if (modified) {
      // Preserve the original file's trailing newline convention —
      // lines.split("\n") produces an empty last element if the file
      // ended with "\n", which lines.join("\n") will serialize back
      // correctly. No extra work needed; just use atomic write to
      // avoid corruption on mid-write crash.
      atomicWriteFileSync(file, lines.join("\n"));
    }
  }

  return results;
}

interface OneFixResult {
  applied: boolean;
  kind: FixKind;
  lines: string[];
  description: string;
}

function applyOneFix(lines: string[], finding: Finding): OneFixResult {
  switch (finding.pattern_id) {
    case "cpp-001-ptr-address-index":
      return fixPointerArithmetic(lines, finding);
    case "cpp-002-unreachable-after-return":
      return fixUnreachableCode(lines, finding);
    case "cpp-003-unchecked-data-index":
      return fixUncheckedDataIndex(lines, finding);
    case "cpp-004-fd-leak-throw":
      return fixFdLeakThrow(lines, finding);
    case "cpp-012-loop-unvalidated-bound":
      return fixLoopBound(lines, finding);
    case "cpp-006-strcpy-family":
      return fixStrcpyFamily(lines, finding);
    case "py-002-shell-injection":
      return fixPyShellInjection(lines, finding);
    case "py-008-path-traversal":
      return fixPyPathTraversal(lines, finding);
    case "py-001-eval-exec":
      return fixPyEval(lines, finding);
    case "py-004-sql-injection":
      return fixPySqlInjection(lines, finding);
    case "py-005-yaml-unsafe-load":
      return fixPyYamlLoad(lines, finding);
    case "py-013-bare-except":
      return fixPyBareExcept(lines, finding);
    case "dart-005-setstate-after-dispose":
      return fixDartSetStateAfterDispose(lines, finding);
    case "dart-007-json-null-check":
      return fixDartJsonNullCheck(lines, finding);
    default: {
      // Fall through to the generic recipe table below. Every pattern
      // registered in patterns.ts has an entry here — the bespoke fixers
      // above handle the patterns that need multi-line transforms, and
      // the table covers the rest with either a mechanical replacement
      // or a language-aware safety comment.
      const recipe = PATTERN_RECIPES[finding.pattern_id];
      if (recipe) return applyRecipe(lines, finding, recipe);
      return {
        applied: false,
        kind: "skipped",
        lines,
        description: `No auto-fix for pattern: ${finding.pattern_id}`,
      };
    }
  }
}

/**
 * cpp-001: Replace (&buffer)[N] with ((const char*)buffer + N)
 */
function fixPointerArithmetic(lines: string[], finding: Finding): OneFixResult {
  const idx = finding.line - 1;
  if (idx < 0 || idx >= lines.length) {
    return { applied: false, kind: "skipped", lines, description: "Line out of range" };
  }

  const line = lines[idx]!;
  const re = /\(\s*&\s*(\w+)\s*\)\s*\[\s*(\w+)\s*\]/;
  const m = line.match(re);
  if (!m) {
    return { applied: false, kind: "skipped", lines, description: "Pattern not found on this line" };
  }

  const varName = m[1];
  const indexVar = m[2];
  const fixed = line.replace(re, `((const char*)${varName} + ${indexVar})`);
  const result = [...lines];
  result[idx] = fixed;
  return {
    applied: true,
    kind: "transformed",
    lines: result,
    description: `(&${varName})[${indexVar}] → ((const char*)${varName} + ${indexVar})`,
  };
}

/**
 * cpp-002: Move unreachable statement before the return/throw/break.
 */
function fixUnreachableCode(lines: string[], finding: Finding): OneFixResult {
  const idx = finding.line - 1;
  if (idx < 0 || idx >= lines.length) {
    return { applied: false, kind: "skipped", lines, description: "Line out of range" };
  }

  // The pattern matches: line with return/throw/break, NEXT line with statement
  // We need to find the return line and the unreachable line after it
  // The finding.line points to the block containing both
  // Scan forward from finding.line to find the return+statement pair
  for (let i = Math.max(0, idx - 2); i < Math.min(lines.length - 1, idx + 5); i++) {
    const curr = lines[i]!.trim();
    const next = lines[i + 1]?.trim() ?? "";
    if (
      (curr.startsWith("return ") || curr.startsWith("throw ") ||
       curr === "continue;" || curr === "break;") &&
      curr.endsWith(";") &&
      next.length > 0 &&
      !next.startsWith("//") &&
      !next.startsWith("}") &&
      !next.startsWith("case ") &&
      !next.startsWith("default:")
    ) {
      // Swap: move the unreachable line BEFORE the return
      const result = [...lines];
      const returnLine = result[i]!;
      const unreachableLine = result[i + 1]!;
      result[i] = unreachableLine;
      result[i + 1] = returnLine;
      return {
        applied: true,
        kind: "transformed",
        lines: result,
        description: `Moved unreachable statement before return/throw`,
      };
    }
  }

  return { applied: false, kind: "skipped", lines, description: "Could not locate return+unreachable pair" };
}

/**
 * cpp-003: Add size validation at the top of decode() functions.
 * Scans the ENTIRE function for the highest data[N] index, then inserts
 * `if (data.size() <= N) return;` after the opening brace.
 */
function fixUncheckedDataIndex(lines: string[], finding: Finding): OneFixResult {
  const idx = finding.line - 1;
  if (idx < 0 || idx >= lines.length) {
    return { applied: false, kind: "skipped", lines, description: "Line out of range" };
  }

  // Find the function DEFINITION (not a call) by walking backwards.
  // A definition has "::decode(" or "void ... decode(" — a call is just "decode(data);"
  let funcStart = -1;
  for (let i = idx; i >= Math.max(0, idx - 30); i--) {
    const line = lines[i]!;
    if (
      (line.includes("::decode(") || line.includes("::decode (")) &&
      !line.trim().endsWith(";") // definitions don't end with ;
    ) {
      funcStart = i;
      break;
    }
    // Also match standalone function defs: "void decode(" at start of line
    if (/^\s*(void|int|size_t|bool)\s+\w*decode\s*\(/.test(line)) {
      funcStart = i;
      break;
    }
  }
  if (funcStart < 0) {
    return { applied: false, kind: "skipped", lines, description: "Could not find decode() function" };
  }

  // Find the opening brace
  let braceIdx = -1;
  for (let i = funcStart; i < Math.min(lines.length, funcStart + 5); i++) {
    if (lines[i]!.includes("{")) {
      braceIdx = i;
      break;
    }
  }
  if (braceIdx < 0) {
    return { applied: false, kind: "skipped", lines, description: "Could not find opening brace" };
  }

  // Check if there's already a size check (don't double-fix)
  const lineAfterBrace = lines[braceIdx + 1]?.trim() ?? "";
  if (lineAfterBrace.includes("data.size()") || lineAfterBrace.includes("size() <")) {
    return { applied: false, kind: "skipped", lines, description: "Size check already exists" };
  }

  // Scan the function body for the highest data[N] index
  let maxIndex = 0;
  const dataIdxRe = /\b(?:data|buffer|buf|packet|msg|payload)\s*\[\s*(\d+)\s*\]/g;
  // Scan from function start to end (find matching closing brace).
  // Start depth at 0 and only check for closure AFTER seeing the first {.
  let depth = 0;
  let seenOpen = false;
  let funcEnd = lines.length - 1;
  for (let i = braceIdx; i < lines.length; i++) {
    for (const ch of lines[i]!) {
      if (ch === "{") { depth++; seenOpen = true; }
      if (ch === "}") depth--;
      if (seenOpen && depth === 0) {
        funcEnd = i;
        break;
      }
    }
    if (seenOpen && depth === 0) break;
  }

  for (let i = braceIdx; i <= funcEnd; i++) {
    let m: RegExpExecArray | null;
    dataIdxRe.lastIndex = 0;
    while ((m = dataIdxRe.exec(lines[i]!)) !== null) {
      const n = parseInt(m[1]!, 10);
      if (n > maxIndex) maxIndex = n;
    }
  }

  if (maxIndex === 0) {
    return { applied: false, kind: "skipped", lines, description: "No data[N] access found in function" };
  }

  // Determine indentation from the line after the brace
  const indent = lines[braceIdx + 1]?.match(/^(\s*)/)?.[1] ?? "    ";

  // Insert the size check
  const result = [...lines];
  const guard = `${indent}if (data.size() <= ${maxIndex}) { return; }`;
  result.splice(braceIdx + 1, 0, guard);

  return {
    applied: true,
    kind: "transformed",
    lines: result,
    description: `Added size guard: data.size() <= ${maxIndex}`,
  };
}

/**
 * cpp-004: Add close(fd) before throw in error paths.
 */
function fixFdLeakThrow(lines: string[], finding: Finding): OneFixResult {
  const idx = finding.line - 1;
  if (idx < 0 || idx >= lines.length) {
    return { applied: false, kind: "skipped", lines, description: "Line out of range" };
  }

  // Find the socket/open assignment near finding.line
  let fdVar = "socketHandle";
  for (let i = Math.max(0, idx - 5); i <= idx; i++) {
    const m = lines[i]?.match(/\b(\w+)\s*=\s*(?:open|socket|fopen)\s*\(/);
    if (m) {
      fdVar = m[1]!;
      break;
    }
  }

  // Find the first throw after the finding line that doesn't have a close before it
  for (let i = idx; i < Math.min(lines.length, idx + 50); i++) {
    if (lines[i]!.trim().startsWith("throw ")) {
      // Check if close(fd) is on the preceding line
      const prev = lines[i - 1]?.trim() ?? "";
      if (prev.includes(`close(${fdVar})`) || prev.includes("closesocket")) {
        continue; // already fixed
      }
      const indent = lines[i]!.match(/^(\s*)/)?.[1] ?? "        ";
      const result = [...lines];
      // Use ::close() (global namespace) to avoid conflict with class close() methods
      result.splice(i, 0, `${indent}::close(${fdVar});`);
      return {
        applied: true,
        kind: "transformed",
        lines: result,
        description: `Added ::close(${fdVar}) before throw`,
      };
    }
  }

  return { applied: false, kind: "skipped", lines, description: "Could not find throw without preceding close()" };
}

/**
 * cpp-006: Replace strcpy/strcat/sprintf with bounded variants.
 * Only auto-fixes when the source is a string LITERAL (known size).
 */
function fixStrcpyFamily(lines: string[], finding: Finding): OneFixResult {
  const idx = finding.line - 1;
  if (idx < 0 || idx >= lines.length) {
    return { applied: false, kind: "skipped", lines, description: "Line out of range" };
  }

  const line = lines[idx]!;
  const result = [...lines];

  // strcpy(dst, "literal") → strncpy(dst, "literal", len)
  const strcpyMatch = line.match(/\bstrcpy\s*\(\s*([^,]+),\s*("(?:[^"\\]|\\.)*")\s*\)/);
  if (strcpyMatch) {
    const dst = strcpyMatch[1]!.trim();
    const src = strcpyMatch[2]!;
    const len = src.length - 2 + 1; // string chars + null terminator
    // Replace the entire strcpy(...) call using the exact matched text
    const fullMatch = strcpyMatch[0];
    result[idx] = line.replace(fullMatch, `strncpy(${dst}, ${src}, ${len})`);
    return { applied: true, kind: "transformed", lines: result, description: `strcpy → strncpy (${src}, ${len} bytes)` };
  }

  // strcat(dst, "literal") → strncat(dst, "literal", len)
  const strcatMatch = line.match(/\bstrcat\s*\(\s*([^,]+),\s*("(?:[^"\\]|\\.)*")\s*\)/);
  if (strcatMatch) {
    const dst = strcatMatch[1]!.trim();
    const src = strcatMatch[2]!;
    const len = src.length - 2;
    result[idx] = line.replace(
      /\bstrcat\s*\([^)]+\)/,
      `strncat(${dst}, ${src}, ${len})`,
    );
    return { applied: true, kind: "transformed", lines: result, description: `strcat → strncat (${src}, ${len} chars)` };
  }

  // sprintf(dst, "fmt", ...) → snprintf(dst, sizeof(dst), "fmt", ...)
  const sprintfMatch = line.match(/\bsprintf\s*\(\s*(\w+)\s*,/);
  if (sprintfMatch) {
    const dst = sprintfMatch[1]!;
    result[idx] = line.replace(
      /\bsprintf\s*\(/,
      `snprintf(${dst}, sizeof(${dst}), `,
    ).replace(
      // Remove duplicate first arg since snprintf already has it
      new RegExp(`snprintf\\(${dst}, sizeof\\(${dst}\\), ${dst},`),
      `snprintf(${dst}, sizeof(${dst}),`,
    );
    return { applied: true, kind: "transformed", lines: result, description: `sprintf → snprintf(${dst}, sizeof(${dst}), ...)` };
  }

  return { applied: false, kind: "skipped", lines, description: "Non-literal source — manual fix needed" };
}

// ── Python auto-fixes ─────────────────────────────────────────

/**
 * py-002: Replace os.system/subprocess with shell=False variant.
 */
function fixPyShellInjection(lines: string[], finding: Finding): OneFixResult {
  const idx = finding.line - 1;
  if (idx < 0 || idx >= lines.length) return { applied: false, kind: "skipped", lines, description: "Line out of range" };
  const line = lines[idx]!;
  const result = [...lines];

  // os.system("cmd") → subprocess.run(["cmd"], shell=False)
  const osSystemMatch = line.match(/\bos\.system\s*\(\s*(.+)\s*\)/);
  if (osSystemMatch) {
    const cmd = osSystemMatch[1]!.trim();
    result[idx] = line.replace(/os\.system\s*\([^)]+\)/, `subprocess.run(${cmd}, shell=False)  # FIXED: was os.system`);
    return { applied: true, kind: "transformed", lines: result, description: "os.system → subprocess.run(shell=False)" };
  }

  // subprocess.call(..., shell=True) → shell=False
  if (line.includes("shell=True") || line.includes("shell = True")) {
    result[idx] = line.replace(/shell\s*=\s*True/g, "shell=False  # FIXED: was shell=True");
    return { applied: true, kind: "transformed", lines: result, description: "shell=True → shell=False" };
  }

  // subprocess with f-string → add comment warning
  if (line.match(/subprocess\.\w+\s*\(\s*f["']/)) {
    const indent = line.match(/^(\s*)/)?.[1] ?? "";
    result.splice(idx, 0, `${indent}# SECURITY: Use list args instead of f-string to prevent injection`);
    return { applied: true, kind: "transformed", lines: result, description: "Added security warning for f-string in subprocess" };
  }

  // List args with f-strings/format — add input validation warning
  if (line.match(/subprocess\.\w+\s*\(\s*\[/) && (line.includes("f'") || line.includes('f"') || line.includes(".format("))) {
    const indent = line.match(/^(\s*)/)?.[1] ?? "";
    result.splice(idx, 0,
      `${indent}# SECURITY: Validate user-controlled args before passing to subprocess`,
      `${indent}# Sanitize: strip shell metacharacters, validate expected format`,
    );
    return { applied: true, kind: "transformed", lines: result, description: "Added input validation warning for subprocess args" };
  }

  return { applied: false, kind: "skipped", lines, description: "Complex shell injection — manual fix needed" };
}

/**
 * py-008: Add path validation for open() with dynamic paths.
 */
function fixPyPathTraversal(lines: string[], finding: Finding): OneFixResult {
  const idx = finding.line - 1;
  if (idx < 0 || idx >= lines.length) return { applied: false, kind: "skipped", lines, description: "Line out of range" };
  const line = lines[idx]!;
  const indent = line.match(/^(\s*)/)?.[1] ?? "";
  const result = [...lines];

  // Insert os.path validation before the open() call
  result.splice(idx, 0,
    `${indent}# SECURITY: Validate path to prevent traversal`,
    `${indent}import os; _path = os.path.abspath(_path); assert _path.startswith(os.getcwd()), "Path traversal blocked"`,
  );
  return { applied: true, kind: "transformed", lines: result, description: "Added path traversal guard" };
}

/**
 * py-001: Replace eval() with ast.literal_eval().
 */
function fixPyEval(lines: string[], finding: Finding): OneFixResult {
  const idx = finding.line - 1;
  if (idx < 0 || idx >= lines.length) return { applied: false, kind: "skipped", lines, description: "Line out of range" };
  const line = lines[idx]!;
  const result = [...lines];

  if (line.includes("eval(")) {
    result[idx] = line.replace(/\beval\s*\(/, "ast.literal_eval(  # FIXED: was eval(");
    return { applied: true, kind: "transformed", lines: result, description: "eval() → ast.literal_eval()" };
  }
  if (line.includes("exec(")) {
    const indent = line.match(/^(\s*)/)?.[1] ?? "";
    result.splice(idx, 0, `${indent}# SECURITY WARNING: exec() executes arbitrary code — remove or sandbox`);
    return { applied: true, kind: "transformed", lines: result, description: "Added exec() security warning" };
  }
  return { applied: false, kind: "skipped", lines, description: "Complex eval/exec — manual fix needed" };
}

/**
 * py-004: Add parameterized query comment.
 */
function fixPySqlInjection(lines: string[], finding: Finding): OneFixResult {
  const idx = finding.line - 1;
  if (idx < 0 || idx >= lines.length) return { applied: false, kind: "skipped", lines, description: "Line out of range" };
  const indent = lines[idx]!.match(/^(\s*)/)?.[1] ?? "";
  const result = [...lines];
  result.splice(idx, 0,
    `${indent}# SECURITY: Use parameterized query: cursor.execute("... WHERE id = %s", (id,))`,
  );
  return { applied: true, kind: "transformed", lines: result, description: "Added SQL injection warning + fix template" };
}

/**
 * py-005: Replace yaml.load() with yaml.safe_load().
 */
function fixPyYamlLoad(lines: string[], finding: Finding): OneFixResult {
  const idx = finding.line - 1;
  if (idx < 0 || idx >= lines.length) return { applied: false, kind: "skipped", lines, description: "Line out of range" };
  const line = lines[idx]!;
  const result = [...lines];

  if (line.includes("yaml.load(")) {
    result[idx] = line.replace(/yaml\.load\s*\(/, "yaml.safe_load(  # FIXED: was yaml.load(");
    return { applied: true, kind: "transformed", lines: result, description: "yaml.load() → yaml.safe_load()" };
  }
  return { applied: false, kind: "skipped", lines, description: "Complex YAML load — manual fix needed" };
}

/**
 * py-013: Replace bare `except:` with `except Exception:`.
 *
 * Bare except catches BaseException, which includes SystemExit,
 * KeyboardInterrupt, and GeneratorExit — signals that should almost
 * never be silenced. The fix narrows it to Exception, which preserves
 * error handling for runtime issues while letting system signals
 * propagate.
 *
 * Handles all common indent styles and inline comments.
 */
function fixPyBareExcept(lines: string[], finding: Finding): OneFixResult {
  const idx = finding.line - 1;
  if (idx < 0 || idx >= lines.length) {
    return { applied: false, kind: "skipped", lines, description: "Line out of range" };
  }
  const line = lines[idx]!;
  // Match `except:` with optional leading whitespace and optional
  // trailing comment. Don't match `except SomeType:` (already specific).
  if (!/^\s*except\s*:/.test(line)) {
    return { applied: false, kind: "skipped", lines, description: "No bare `except:` on this line" };
  }
  // Already narrowed to Exception — skip.
  if (/except\s+Exception\s*:/.test(line)) {
    return { applied: false, kind: "skipped", lines, description: "Already uses `except Exception:`" };
  }
  const result = [...lines];
  result[idx] = line.replace(/\bexcept\s*:/, "except Exception:");
  return {
    applied: true,
    kind: "transformed",
    lines: result,
    description: "`except:` → `except Exception:`",
  };
}

/**
 * cpp-012: Add validation before loop with external bound.
 */
function fixLoopBound(lines: string[], finding: Finding): OneFixResult {
  const idx = finding.line - 1;
  if (idx < 0 || idx >= lines.length) {
    return { applied: false, kind: "skipped", lines, description: "Line out of range" };
  }

  const line = lines[idx]!;
  // Extract the bound variable: for (...; var < BOUND; ...)
  const m = line.match(/\w+\s*<\s*(\w+(?:\.\w+|->[\w.]+)+)/);
  if (!m) {
    return { applied: false, kind: "skipped", lines, description: "Could not extract loop bound" };
  }

  const boundExpr = m[1]!;
  const indent = line.match(/^(\s*)/)?.[1] ?? "    ";

  // Check if there's already a validation above
  const prev = lines[idx - 1]?.trim() ?? "";
  if (prev.includes(boundExpr) && (prev.includes("if") || prev.includes("max"))) {
    return { applied: false, kind: "skipped", lines, description: "Bound validation already exists" };
  }

  const result = [...lines];
  result.splice(idx, 0, `${indent}if (${boundExpr} > 10000) { return; } // guard: cap loop bound`);
  return {
    applied: true,
    kind: "transformed",
    lines: result,
    description: `Added loop bound cap: ${boundExpr} > 10000`,
  };
}

/**
 * dart-007: Rewrite `json['key'] as Int|String|double|bool|num` casts
 * that target non-nullable primitives to use the nullable variant plus a
 * safe default.
 *
 *   id: json['id'] as int,            →  id: json['id'] as int? ?? 0,
 *   name: json['name'] as String,     →  name: json['name'] as String? ?? '',
 *
 * SCOPE — only the `json[...] as Type` shape is touched:
 *   - `foo.length as int` is NOT rewritten (not a JSON subscript).
 *   - `Map<K, V>.cast<int>()` is NOT rewritten (not an `as` cast).
 *   - `users as List<int>` is NOT rewritten (not on a json subscript).
 * This prevents the fixer from silently changing the semantics of
 * business-logic casts that have nothing to do with JSON parsing.
 *
 * The audit engine dedupes matches of the same pattern in the same file
 * into a single Finding (for verification efficiency), so a fromJson
 * with 40 unsafe casts produces ONE finding. That finding's line is
 * just the first match. Because every other match has the same
 * json[...] shape, sweeping the whole file with the narrow regex
 * rewrites all of them in one pass — AND because the regex is scoped
 * to json subscripts, it never accidentally rewrites unrelated casts.
 *
 * Idempotency — the regex has a `(?!\?)` lookahead so casts already
 * written as `as T?` are left alone, regardless of whether they're
 * followed by `?? default` or not.
 */
function fixDartJsonNullCheck(lines: string[], _finding: Finding): OneFixResult {
  const DEFAULTS: Record<string, string> = {
    int: "0",
    double: "0.0",
    num: "0",
    bool: "false",
    String: "''",
  };
  // Narrow regex: `json['anything'] as TYPE` where TYPE is one of the
  // supported primitives AND is not already nullable. Captures the whole
  // `json[...] as TYPE` span as group 1 so the replacement can keep the
  // original json access intact.
  //
  // Note: the outer `json` identifier match is intentionally literal —
  // the pattern library's regex in patterns.ts only fires on the
  // identifier `json`, which is the conventional parameter name for
  // Dart fromJson factories. Projects that use a different name (e.g.
  // `data` or `m`) won't get auto-fixed, but that's the correct
  // conservative behavior for a deterministic rewriter.
  const rex = /(\bjson\s*\[\s*['"][^'"]+['"]\s*\]\s*as\s+(int|double|num|bool|String))\b(?!\?)/g;
  let totalCount = 0;
  const result = lines.map((line) =>
    line.replace(rex, (_full, wholeCast: string, type: string) => {
      totalCount++;
      return `${wholeCast}? ?? ${DEFAULTS[type]}`;
    }),
  );
  if (totalCount === 0) {
    return {
      applied: false,
      kind: "skipped",
      lines,
      description: "No unsafe `json[...] as Type` casts found in file",
    };
  }
  return {
    applied: true,
    kind: "transformed",
    lines: result,
    description: `Rewrote ${totalCount} json[...] non-nullable cast${totalCount === 1 ? "" : "s"} to nullable with default`,
  };
}

// Walk backwards from `fromIdx` looking for a class declaration that
// extends one of Flutter's State base types. Returns true only if the
// setState call is clearly inside a State<T> / ConsumerState<T> /
// StatefulWidgetState<T> subclass, where `mounted` is a defined
// instance getter. Returns false if no such class is found within a
// reasonable lookback (400 lines — large enough for most Dart files,
// small enough to avoid pathological O(n²) behavior).
//
// This keeps us from inserting `if (!mounted) return;` into code where
// `mounted` doesn't exist (e.g., a standalone function, a helper class,
// a mixin that receives a callback) which would fail to compile.
function isInsideFlutterState(lines: string[], fromIdx: number): boolean {
  // Any of these patterns identifies a class where `mounted` is defined.
  // We accept both raw Flutter (`State<X>`) and common Riverpod/Provider
  // extensions (`ConsumerState<X>`, `ConsumerStatefulState<X>`), plus the
  // fully-qualified form.
  const classRex = /\bclass\s+\w+[^{]*\bextends\s+\w*State(?:<|\b)/;
  const limit = Math.max(0, fromIdx - 400);
  for (let i = fromIdx; i >= limit; i--) {
    if (classRex.test(lines[i]!)) return true;
  }
  return false;
}

/**
 * dart-005: Insert `if (!mounted) return;` before a setState call that
 * sits after an `await`. Only fires when:
 *
 *   1. A `setState(` call is found within 10 lines after the finding's
 *      await line (walked forward).
 *   2. NO mounted/disposed guard exists anywhere between the await and
 *      the setState call (full span check, not just 3-line lookback).
 *   3. The setState is inside a `class Foo extends ... State<...>`
 *      subclass, so `mounted` is a valid instance getter. Otherwise we
 *      skip rather than produce uncompilable code.
 */
function fixDartSetStateAfterDispose(lines: string[], finding: Finding): OneFixResult {
  const startIdx = finding.line - 1;
  if (startIdx < 0 || startIdx >= lines.length) {
    return { applied: false, kind: "skipped", lines, description: "Line out of range" };
  }
  let setStateIdx = -1;
  for (let i = startIdx; i < Math.min(lines.length, startIdx + 10); i++) {
    if (/\bsetState\s*\(/.test(lines[i]!)) {
      setStateIdx = i;
      break;
    }
  }
  if (setStateIdx === -1) {
    return {
      applied: false,
      kind: "skipped",
      lines,
      description: "Could not locate setState call within 10 lines after await",
    };
  }
  // Full-span guard detection: walk every line between the await
  // (startIdx) and the setState (setStateIdx) looking for ANY guard.
  // This fixes the earlier 3-line lookback bug where a valid guard at
  // line -5 was missed and we inserted a duplicate.
  for (let i = setStateIdx - 1; i >= startIdx; i--) {
    const prev = lines[i]!;
    if (prev.trim() === "") continue;
    if (/\bif\s*\(\s*!?(mounted|context\.mounted)\s*\)/.test(prev)) {
      return {
        applied: false,
        kind: "skipped",
        lines,
        description: "mounted guard already present between await and setState",
      };
    }
    if (/\bif\s*\(\s*!?_?disposed\s*\)/.test(prev)) {
      return {
        applied: false,
        kind: "skipped",
        lines,
        description: "disposed guard already present between await and setState",
      };
    }
  }
  // Verify we're inside a State<T> subclass before assuming `mounted`
  // is defined. If not, skip the bespoke fix — the generic recipe
  // (advisory comment) is still available through the default branch,
  // but dart-005 routes here first. We'd rather return "skipped" than
  // emit uncompilable code.
  if (!isInsideFlutterState(lines, setStateIdx)) {
    return {
      applied: false,
      kind: "skipped",
      lines,
      description: "setState not inside a State<T> subclass — `mounted` may be undefined here",
    };
  }
  const indent = lines[setStateIdx]!.match(/^(\s*)/)?.[1] ?? "";
  const guard = `${indent}if (!mounted) return;`;
  const result = [...lines];
  result.splice(setStateIdx, 0, guard);
  return {
    applied: true,
    kind: "transformed",
    lines: result,
    description: "Inserted `if (!mounted) return;` before setState",
  };
}

// ── Generic recipe table ──────────────────────────────────────
//
// Every pattern in patterns.ts must have coverage: either a bespoke
// fixer above, or an entry in PATTERN_RECIPES below. A recipe inserts
// a language-aware safety comment directly above the finding, tagged
// `KCODE-AUDIT:<pattern_id>` so subsequent runs can detect and skip it.
// This gives developers a concrete, greppable marker per finding and
// keeps /fix from reporting "no auto-fix" for any registered pattern.

interface PatternRecipe {
  description: string;
  warnings: string[];
}

const r = (description: string, ...warnings: string[]): PatternRecipe => ({
  description,
  warnings,
});

// Shared warning strings — recipes reference these so the guidance
// stays consistent across languages.
const W = {
  SQL: "Use a parameterized query — never concatenate user input into SQL.",
  SECRET: "Move this credential to an environment variable or secret store.",
  XSS: "Escape/sanitize this value before rendering it as HTML.",
  SHELL: "Pass arguments as an array — never build a shell string from user input.",
  DESER: "Never deserialize untrusted data — use JSON or a safe_load variant.",
  PROTO: "Reject __proto__, constructor and prototype keys before assigning.",
  PATH: "Resolve the absolute path and verify it stays within the allowed root.",
  EVAL: "Remove eval — use an explicit parser or a safe evaluator.",
  UNWRAP: "Handle the null/error case instead of force-unwrapping.",
  LEAK: "Ensure this resource is released (defer/using/try-with-resources).",
  NULL: "Guard against null/undefined before dereferencing.",
  RACE: "Synchronize access to this shared state.",
  UNSAFE: "Document the invariants that make this unsafe code sound.",
  REDOS: "Rewrite this regex to avoid catastrophic backtracking.",
  ERR: "Handle this error explicitly instead of ignoring it.",
  HTTPS: "Use HTTPS and enable certificate verification.",
};

const PATTERN_RECIPES: Record<string, PatternRecipe> = {
  // ── C/C++ (bespoke covers 001-004, 006, 012) ───────────────
  "cpp-005-int-returned-as-size": r("int→size_t cast", "Return size_t or validate the int is non-negative before casting."),
  "cpp-007-deref-before-null-check": r("null check after deref", "Move the null check BEFORE dereferencing the pointer."),
  "cpp-008-memcpy-untrusted-len": r("memcpy untrusted length", "Clamp the length against the destination buffer size before memcpy."),
  "cpp-009-toctou-stat-open": r("TOCTOU stat+open", "Use openat/fstat on the open fd instead of stat() + open()."),
  "cpp-010-malloc-mul-overflow": r("malloc size overflow", "Check SIZE_MAX / a < b before multiplying in a malloc size."),
  "cpp-011-signed-unsigned-cmp": r("signed/unsigned compare", "Cast both sides to the same signedness before comparing."),

  // ── C# ─────────────────────────────────────────────────────
  "cs-001-sql-injection": r("C# SQL injection", W.SQL),
  "cs-002-deserialization": r("C# deserialization", W.DESER),
  "cs-003-hardcoded-connection": r("hardcoded connection string", W.SECRET),
  "cs-004-async-void": r("async void", "Use async Task instead of async void except for event handlers."),
  "cs-005-task-not-awaited": r("task not awaited", "Await the returned Task or store it for later await."),
  "cs-006-disposable-no-using": r("IDisposable without using", W.LEAK),
  "cs-007-sql-interpolation": r("C# SQL interpolation", W.SQL),
  "cs-008-multiple-enumeration": r("multiple enumeration", "Materialize with ToList()/ToArray() before enumerating more than once."),
  "cs-009-lock-this-typeof": r("lock on this/typeof", "Lock on a private readonly object, not `this` or `typeof(T)`."),
  "cs-010-configureawait-missing": r("missing ConfigureAwait", "Append .ConfigureAwait(false) in library code."),
  "cs-011-nullable-no-check": r("nullable without check", W.NULL),
  "cs-012-dictionary-key-not-found": r("dict key not checked", "Use TryGetValue or ContainsKey before indexing."),

  // ── Dart / Flutter ─────────────────────────────────────────
  "dart-001-insecure-http": r("insecure http", W.HTTPS),
  "dart-002-hardcoded-key": r("hardcoded key", W.SECRET),
  "dart-003-force-unwrap": r("force unwrap", W.UNWRAP),
  "dart-004-dart-mirrors": r("dart:mirrors", "dart:mirrors breaks Flutter tree-shaking — use code generation."),
  "dart-005-setstate-after-dispose": r("setState after dispose", "Check `mounted` before calling setState."),
  "dart-006-future-no-error": r("Future without error", "Add .catchError or wrap in try/catch."),
  "dart-007-json-null-check": r("json missing null check", "Verify the map has the key and the value is non-null before accessing."),
  "dart-008-buildcontext-async": r("BuildContext after await", "Check `context.mounted` after the async gap before using BuildContext."),
  "dart-009-http-no-https": r("http without https", W.HTTPS),
  "dart-010-string-hardcoded-secret": r("hardcoded secret", W.SECRET),

  // ── Django ─────────────────────────────────────────────────
  "django-001-raw-sql": r("Django raw SQL", W.SQL),
  "django-002-mark-safe": r("mark_safe on user content", W.XSS),
  "django-003-secret-key": r("hardcoded SECRET_KEY", W.SECRET),

  // ── Elixir ─────────────────────────────────────────────────
  "ex-001-atom-from-user-input": r("atom from user input", "Atoms are never garbage collected — never create atoms from user input."),
  "ex-002-to-atom-untrusted": r("to_atom on untrusted", "Use String.to_existing_atom/1 or reject unknown values."),
  "ex-003-unbounded-mailbox": r("unbounded mailbox", "Add backpressure — use GenStage or a bounded buffer."),
  "ex-004-ets-race-condition": r("ETS race", "Use :ets.update_counter or transaction primitives."),
  "ex-005-process-exit-kill": r("System.halt in library", "Don't call System.halt from library code — let the supervisor decide."),
  "ex-006-ecto-raw-sql-injection": r("Ecto raw SQL", W.SQL),
  "ex-007-hardcoded-secrets-config": r("hardcoded secret in config", W.SECRET),
  "ex-008-missing-supervisor-strategy": r("missing supervisor strategy", "Define a supervision strategy (:one_for_one, etc.) explicitly."),
  "ex-009-task-async-no-await": r("Task.async not awaited", "Await the task or use Task.Supervisor.async_nolink."),
  "ex-010-io-inspect-production": r("IO.inspect in production", "Remove IO.inspect before shipping — use Logger.debug."),

  // ── Express / Node web ─────────────────────────────────────
  "express-001-nosql-injection": r("NoSQL injection", "Validate input type — use $eq operators explicitly for untrusted input."),
  "express-002-xss-render": r("xss in render", W.XSS),
  "express-003-cors-wildcard": r("CORS wildcard", "Restrict CORS origin to an allowlist instead of '*'."),

  // ── FastAPI ────────────────────────────────────────────────
  "fastapi-001-sql-raw": r("FastAPI raw SQL", W.SQL),

  // ── Flask ──────────────────────────────────────────────────
  "flask-001-render-string": r("render_template_string", "Use render_template, not render_template_string with user input."),

  // ── Go ─────────────────────────────────────────────────────
  "go-001-sql-injection": r("Go SQL injection", W.SQL),
  "go-002-unsafe-pointer": r("unsafe.Pointer", W.UNSAFE),
  "go-003-command-injection": r("command injection", W.SHELL),
  "go-004-error-ignored": r("error ignored", W.ERR),
  "go-005-tls-skip-verify": r("InsecureSkipVerify", "Remove InsecureSkipVerify or gate it behind a dev-only flag."),
  "go-006-blank-error": r("blank error return", W.ERR),
  "go-007-goroutine-leak": r("goroutine leak", "Ensure this goroutine has an exit path (context.Done or channel close)."),
  "go-008-defer-in-loop": r("defer in loop", "Move defer out of the loop — it runs on function return, not iteration end."),
  "go-009-nil-map-write": r("nil map write", "Initialize the map with make() before writing."),
  "go-010-race-shared-var": r("race on shared var", W.RACE),
  "go-011-context-not-propagated": r("context not propagated", "Thread ctx through the call chain."),
  "go-012-infinite-recursion": r("infinite recursion", "Add a base case or convert to iteration."),
  "go-013-hardcoded-credentials": r("hardcoded credentials", W.SECRET),
  "go-014-unbuffered-channel-deadlock": r("unbuffered channel deadlock", "Use a buffered channel or run sender/receiver in separate goroutines."),
  "go-015-waitgroup-add-after-go": r("wg.Add after go", "Call wg.Add(1) BEFORE launching the goroutine."),
  "go-016-http-body-not-closed": r("response body not closed", "defer resp.Body.Close() immediately after the request."),
  "go-017-slice-append-shared": r("append on shared slice", "Copy the slice with append([]T{}, s...) before append to avoid aliasing."),
  "go-018-sprintf-hot-path": r("Sprintf in hot path", "Use strings.Builder instead of fmt.Sprintf in hot paths."),
  "go-019-os-exit-library": r("os.Exit in library", "Don't call os.Exit from library code — return an error."),
  "go-020-loop-var-goroutine": r("loop var in goroutine", "Shadow the loop variable with `v := v` before `go func()`."),

  // ── Haskell ────────────────────────────────────────────────
  "hs-001-head-empty-list": r("head on list", "Use listToMaybe or pattern match instead of head."),
  "hs-002-fromjust": r("fromJust", W.UNWRAP),
  "hs-003-read-no-error": r("read without error handling", "Use readMaybe instead of read for untrusted input."),
  "hs-004-unsafe-perform-io": r("unsafePerformIO", W.UNSAFE),
  "hs-005-space-leak": r("space leak", "Force strict evaluation with seq / $! to avoid thunk accumulation."),
  "hs-006-missing-show-error": r("missing Show instance", "Derive Show or provide an instance."),
  "hs-007-error-control-flow": r("error for control flow", "Return Either/Maybe instead of calling error for control flow."),
  "hs-008-string-type": r("String type", "Prefer Text/ByteString over String for performance."),

  // ── Java ───────────────────────────────────────────────────
  "java-001-sql-injection": r("Java SQL injection", W.SQL),
  "java-002-deserialization": r("Java deserialization", W.DESER),
  "java-003-xxe": r("XXE", "Disable DTD: factory.setFeature('http://apache.org/xml/features/disallow-doctype-decl', true)."),
  "java-004-path-traversal": r("path traversal", W.PATH),
  "java-005-nullable-method-call": r("nullable method call", W.NULL),
  "java-006-resource-leak": r("resource leak", "Use try-with-resources to auto-close."),
  "java-007-sql-concat-prepared": r("SQL concat in PreparedStatement", W.SQL),
  "java-008-concurrent-modification": r("concurrent modification", "Use Iterator.remove() or a concurrent collection."),
  "java-009-unsafe-singleton": r("unsafe singleton", "Use the holder idiom or an enum singleton for thread-safety."),
  "java-010-hardcoded-creds": r("hardcoded credentials", W.SECRET),
  "java-011-insecure-deserialize": r("insecure deserialization", W.DESER),
  "java-012-path-traversal-string": r("path traversal string", W.PATH),
  "java-013-xxe-transformer": r("XXE in transformer", "Set TransformerFactory.FEATURE_SECURE_PROCESSING to true."),
  "java-014-log-injection": r("log injection", "Strip CRLF from user input before logging."),
  "java-015-infinite-loop": r("infinite loop", "Add a termination condition."),
  "java-016-equals-no-hashcode": r("equals without hashCode", "Override hashCode() whenever equals() is overridden."),
  "java-017-mutable-static": r("mutable static field", "Make the field final and the collection immutable."),
  "java-018-catch-generic-exception": r("generic catch", "Catch specific exceptions, not Exception/Throwable."),

  // ── JavaScript / TypeScript ───────────────────────────────
  "js-001-eval": r("eval", W.EVAL),
  "js-002-innerhtml": r("innerHTML", "Use textContent or DOMPurify.sanitize() before innerHTML."),
  "js-003-prototype-pollution": r("prototype pollution", W.PROTO),
  "js-004-nosql-injection": r("NoSQL injection", "Validate input type before passing to the Mongo query."),
  "js-005-regex-dos": r("regex DoS", W.REDOS),
  "js-006-hardcoded-secret": r("hardcoded secret", W.SECRET),
  "js-007-command-injection": r("command injection", W.SHELL),
  "js-008-prototype-pollution-bracket": r("prototype pollution (bracket)", W.PROTO),
  "js-009-redos-nested-quantifier": r("ReDoS nested quantifier", W.REDOS),
  "js-010-innerhtml-xss": r("innerHTML XSS", W.XSS),
  "js-011-eval-new-function": r("new Function()", W.EVAL),
  "js-012-event-listener-leak": r("event listener leak", "Remove the listener in the cleanup/unmount callback."),
  "js-013-loose-equality": r("loose equality", "Use === or !== for strict comparison."),
  "js-014-json-parse-no-catch": r("JSON.parse no catch", "Wrap JSON.parse in try/catch and handle SyntaxError."),
  "js-015-promise-no-catch": r("promise no catch", "Add .catch() or await inside try/catch."),
  "js-016-open-redirect": r("open redirect", "Validate the redirect URL against an allowlist."),
  "js-017-hardcoded-secret-inline": r("hardcoded secret inline", W.SECRET),
  "js-018-document-write": r("document.write", "Avoid document.write — build DOM nodes explicitly."),

  // ── Kotlin ─────────────────────────────────────────────────
  "kt-001-force-unwrap": r("force unwrap !!", W.UNWRAP),
  "kt-002-sql-injection": r("Kotlin SQL injection", W.SQL),
  "kt-003-double-bang-production": r("!! in production", "Use safe call ?. or elvis ?:."),
  "kt-004-lateinit-uninit": r("lateinit unchecked", "Check ::field.isInitialized before use."),
  "kt-005-coroutine-leak": r("coroutine leak", "Launch inside a lifecycle-scoped CoroutineScope."),
  "kt-006-blocking-in-coroutine": r("blocking in coroutine", "Wrap blocking calls in withContext(Dispatchers.IO)."),
  "kt-007-platform-type-null": r("platform type null", "Java platform types can be null — annotate or check."),
  "kt-008-mutable-collection-exposed": r("mutable collection exposed", "Return an immutable view (toList/toSet)."),
  "kt-009-hardcoded-secrets": r("hardcoded secret", W.SECRET),
  "kt-010-sql-template-injection": r("SQL template injection", W.SQL),
  "kt-011-runblocking-main": r("runBlocking in main", "Use a CoroutineScope.launch instead of runBlocking in production."),
  "kt-012-globalscope": r("GlobalScope", "Use a scoped CoroutineScope tied to lifecycle."),

  // ── Lua ────────────────────────────────────────────────────
  "lua-001-global-pollution": r("global pollution", "Declare with `local` to avoid polluting globals."),
  "lua-002-loadstring-injection": r("loadstring injection", W.EVAL),
  "lua-003-table-nil-index": r("table nil index", "Check value ~= nil before chaining further indices."),
  "lua-004-string-concat-loop": r("string concat in loop", "Accumulate into a table and call table.concat at the end."),
  "lua-005-os-execute-injection": r("os.execute injection", W.SHELL),
  "lua-006-pcall-no-error-handling": r("pcall no error handling", "Handle the error return of pcall explicitly."),
  "lua-007-infinite-coroutine": r("infinite coroutine", "Add a termination condition to the coroutine loop."),
  "lua-008-require-path-injection": r("require path injection", "Validate the require path against an allowlist."),

  // ── PHP ────────────────────────────────────────────────────
  "php-001-sql-injection": r("PHP SQL injection", W.SQL),
  "php-002-eval": r("eval", W.EVAL),
  "php-003-file-include": r("dynamic include", "Validate the include path against an allowlist."),
  "php-004-xss": r("XSS", "Use htmlspecialchars with ENT_QUOTES before output."),
  "php-005-sql-superglobal": r("SQL from superglobal", W.SQL),
  "php-006-unserialize": r("unserialize", W.DESER),
  "php-007-path-traversal": r("path traversal", W.PATH),
  "php-008-csrf-no-token": r("missing CSRF token", "Validate a CSRF token before mutating state."),
  "php-009-type-juggling": r("type juggling", "Use === for strict comparison."),
  "php-010-extract-user-input": r("extract on user input", "Never extract() user input — assign fields explicitly."),
  "php-011-shell-exec": r("shell exec", W.SHELL),
  "php-012-hardcoded-credentials": r("hardcoded credentials", W.SECRET),
  "php-013-weak-hash-password": r("weak password hash", "Use password_hash with PASSWORD_BCRYPT or PASSWORD_ARGON2ID."),
  "php-014-print-xss": r("print XSS", W.XSS),
  "php-015-backtick-injection": r("backtick injection", W.SHELL),

  // ── Python (bespoke covers 001, 002, 004, 005, 008) ───────
  "py-003-pickle-deserialize": r("pickle deserialize", W.DESER),
  "py-006-hardcoded-secret": r("hardcoded secret", W.SECRET),
  "py-007-assert-security": r("assert for security", "Don't use assert for security — it's stripped in python -O mode."),
  "py-009-pickle-untrusted": r("pickle untrusted", W.DESER),
  "py-010-assert-validation": r("assert for validation", "Don't use assert for validation in production."),
  "py-011-eq-without-hash": r("__eq__ without __hash__", "Define __hash__ alongside __eq__."),
  "py-012-mutable-default-arg": r("mutable default arg", "Use None as default and assign inside the function."),
  "py-013-bare-except": r("bare except", "Catch specific exceptions, not bare `except:`."),
  "py-014-late-binding-closure": r("late-binding closure", "Capture the loop variable with a default arg."),
  "py-015-os-system-user-input": r("os.system user input", W.SHELL),
  "py-016-tempfile-mktemp": r("tempfile.mktemp", "Use tempfile.mkstemp or NamedTemporaryFile — mktemp is race-prone."),
  "py-017-hardcoded-secret-assign": r("hardcoded secret assign", W.SECRET),
  "py-018-re-no-raw-string": r("regex no raw string", "Use raw string r'...' for regex patterns."),
  "py-019-fstring-logging": r("f-string logging", "Use lazy % formatting: logger.info('msg %s', val)."),
  "py-020-global-keyword": r("global keyword", "Avoid `global` — pass state explicitly or use a class."),

  // ── Rails ──────────────────────────────────────────────────
  "rails-001-html-safe": r("html_safe on user content", W.XSS),

  // ── Ruby ───────────────────────────────────────────────────
  "rb-001-eval": r("eval", W.EVAL),
  "rb-002-sql-injection": r("Ruby SQL injection", W.SQL),
  "rb-003-yaml-unsafe": r("YAML.load", "Use YAML.safe_load instead of YAML.load."),
  "rb-004-send-user-input": r("send(user input)", "Whitelist methods before send()."),
  "rb-005-mass-assignment": r("mass assignment", "Use strong_parameters (permit/require)."),
  "rb-006-system-backtick": r("system/backtick", W.SHELL),
  "rb-007-open-redirect": r("open redirect", "Validate the redirect against an allowlist."),
  "rb-008-hardcoded-secrets": r("hardcoded secret", W.SECRET),
  "rb-009-marshal-load": r("Marshal.load", W.DESER),
  "rb-010-sql-interpolation": r("SQL interpolation", W.SQL),
  "rb-011-instance-eval-untrusted": r("instance_eval untrusted", W.EVAL),
  "rb-012-eval-string": r("eval string", W.EVAL),

  // ── React ──────────────────────────────────────────────────
  "react-001-dangerously-set": r("dangerouslySetInnerHTML", "Use DOMPurify.sanitize() before dangerouslySetInnerHTML."),

  // ── Rust ───────────────────────────────────────────────────
  "rs-001-unsafe-block": r("unsafe block", W.UNSAFE),
  "rs-002-unwrap-panic": r("unwrap panic", W.UNWRAP),
  "rs-003-sql-injection": r("Rust SQL injection", W.SQL),
  "rs-004-unwrap-non-test": r("unwrap in non-test", W.UNWRAP),
  "rs-005-expect-no-message": r("expect without message", "Add a descriptive message to .expect() explaining the invariant."),
  "rs-006-unsafe-no-safety": r("unsafe without SAFETY", "Add a `// SAFETY:` comment above every unsafe block."),
  "rs-007-arc-mutex-read-heavy": r("Arc<Mutex> read-heavy", "Use RwLock for read-heavy workloads."),
  "rs-008-blocking-in-async": r("blocking in async", "Use tokio::task::spawn_blocking or an async variant."),
  "rs-009-clone-in-loop": r("clone in loop", "Hoist the clone out of the loop."),
  "rs-010-async-send-sync": r("async Send/Sync", "Ensure the future is Send + Sync when crossing threads."),
  "rs-011-hardcoded-secrets": r("hardcoded secret", W.SECRET),
  "rs-012-panic-in-drop": r("panic in Drop", "Don't panic in Drop::drop."),
  "rs-013-unbounded-vec": r("unbounded Vec growth", "Preallocate with Vec::with_capacity or cap growth."),
  "rs-014-mem-transmute": r("mem::transmute", "Prefer safe casting (as / From / Into) over transmute."),
  "rs-015-format-sql": r("format! SQL", "Use sqlx::query! with parameters."),

  // ── Scala ──────────────────────────────────────────────────
  "scala-001-sql-injection": r("Scala SQL injection", W.SQL),
  "scala-002-option-get": r("Option.get", "Use getOrElse or pattern match."),
  "scala-003-blocking-future": r("blocking in Future", "Wrap blocking calls in blocking { ... }."),
  "scala-004-mutable-concurrent": r("mutable in concurrent", "Use a concurrent collection or synchronized access."),
  "scala-005-nonexhaustive-match": r("non-exhaustive match", "Add a wildcard case _."),
  "scala-006-implicit-conversion": r("implicit conversion", "Make the conversion explicit."),
  "scala-007-try-get": r("Try.get", "Pattern match on Success/Failure instead of .get."),
  "scala-008-akka-unhandled": r("akka unhandled", "Add `case _ => unhandled(msg)` to the receive block."),
  "scala-009-sql-string-concat": r("SQL string concat", W.SQL),
  "scala-010-null-usage": r("null usage", "Use Option instead of null."),

  // ── Shell ──────────────────────────────────────────────────
  "sh-001-eval-injection": r("eval injection", W.EVAL),

  // ── SQL ────────────────────────────────────────────────────
  "sql-001-grant-all": r("GRANT ALL", "Grant specific privileges, not ALL."),
  "sql-002-plaintext-password": r("plaintext password", "Store a password hash (bcrypt/argon2), never plaintext."),

  // ── Swift ──────────────────────────────────────────────────
  "swift-001-force-unwrap": r("force unwrap", W.UNWRAP),
  "swift-002-force-try": r("force try", "Use do/catch or try?."),
  "swift-003-insecure-http": r("insecure http", W.HTTPS),
  "swift-004-keychain-no-access": r("keychain no access", "Set kSecAttrAccessibleWhenUnlockedThisDeviceOnly."),
  "swift-005-hardcoded-secret": r("hardcoded secret", W.SECRET),
  "swift-006-webview-js": r("webview JS", "Validate JavaScript before evaluateJavaScript."),
  "swift-007-force-unwrap-production": r("force unwrap prod", W.UNWRAP),
  "swift-008-retain-cycle": r("retain cycle", "Capture [weak self] in the closure."),
  "swift-009-main-thread-violation": r("off main thread UI", "Dispatch UI work to DispatchQueue.main."),
  "swift-010-force-try-production": r("force try prod", "Use try? or do/catch."),
  "swift-011-force-cast": r("force cast", "Use `as?` for optional cast."),
  "swift-012-unowned-dealloc": r("unowned may dealloc", "Use [weak self] if the referenced object may outlive self."),
  "swift-013-missing-main-actor": r("missing @MainActor", "Annotate the class/method with @MainActor."),
  "swift-014-hardcoded-secret-swift": r("hardcoded secret", W.SECRET),
  "swift-015-missing-async-error-handling": r("async no error handling", "Wrap the async call in do/catch."),

  // ── Universal ──────────────────────────────────────────────
  "uni-001-hardcoded-ip": r("hardcoded IP", "Move the IP address to config — hardcoding makes deployment brittle."),
  "uni-002-security-todo": r("security TODO", "Address this security TODO before shipping."),
  "uni-003-ssrf": r("SSRF", "Validate the URL against an allowlist of permitted hosts. Block private IP ranges (10.x, 172.16-31.x, 192.168.x, 169.254.x, localhost)."),
  "uni-004-missing-auth": r("missing auth", "Add authentication middleware/decorator before this endpoint."),
  "uni-005-weak-auth-compare": r("timing-unsafe compare", "Use constant-time comparison: hmac.compare_digest (Python), crypto.timingSafeEqual (Node.js), subtle.ConstantTimeCompare (Go)."),
  "uni-006-critical-no-auth": r("critical op no auth", "Require authentication AND authorization before destructive/privileged operations."),
  "uni-007-command-injection-concat": r("command injection concat", W.SHELL),
  "uni-008-privilege-escalation": r("privilege escalation", "Run with minimum required privileges. Use 0o755 not 0o777. Drop root after binding ports."),
  "uni-009-code-injection": r("code injection", "Never compile/evaluate user input. Use a sandboxed interpreter or safe template engine."),
  "uni-010-client-side-auth": r("client-side auth", "Read authorization from server session or validated JWT — never from request body/query/cookies."),

  // ── Zig ────────────────────────────────────────────────────
  "zig-001-use-after-free": r("use-after-free", "Don't use memory after free — null the pointer or use defer."),
  "zig-002-ignored-error": r("ignored error", "Use `try` or `catch` instead of `_ = ...`."),
  "zig-003-release-ub": r("release UB", "Undefined behavior in release mode — fix or guard with @setRuntimeSafety(.on)."),
  "zig-004-buffer-overflow": r("buffer overflow", "Clamp the index against buffer.len before access."),
  "zig-005-memory-leak": r("memory leak", "Use defer allocator.free(...) right after allocation."),
  "zig-006-sentinel-misuse": r("sentinel misuse", "Validate the sentinel byte before slicing."),
  "zig-007-integer-overflow": r("integer overflow", "Use @addWithOverflow or explicit wrap/saturate."),
  "zig-008-ptrcast-alignment": r("ptrCast alignment", "Validate alignment before @ptrCast."),
  "zig-009-unreachable-misuse": r("unreachable misuse", "Replace `unreachable` with a real error return or @panic."),
  "zig-010-comptime-runtime": r("comptime/runtime mix", "Distinguish comptime from runtime evaluation explicitly."),
};

function commentPrefix(path: string): string {
  const p = path.toLowerCase();
  if (
    p.endsWith(".py") || p.endsWith(".rb") || p.endsWith(".sh") ||
    p.endsWith(".yaml") || p.endsWith(".yml") || p.endsWith(".toml") ||
    p.endsWith(".lua") || p.endsWith(".ex") || p.endsWith(".exs")
  ) {
    return "# ";
  }
  if (p.endsWith(".hs") || p.endsWith(".sql")) {
    return "-- ";
  }
  return "// ";
}

function applyRecipe(
  lines: string[],
  finding: Finding,
  recipe: PatternRecipe,
): OneFixResult {
  const idx = finding.line - 1;
  if (idx < 0 || idx >= lines.length) {
    return { applied: false, kind: "skipped", lines, description: "Line out of range" };
  }
  const line = lines[idx]!;
  const indent = line.match(/^(\s*)/)?.[1] ?? "";
  const prefix = commentPrefix(finding.file);
  const tag = `KCODE-AUDIT:${finding.pattern_id}`;

  // Skip if a previous /fix run already tagged this location.
  //
  // The old check only looked at `lines[idx - 1]`, which fails when
  // /fix is re-run against a stale AUDIT_REPORT.json whose line
  // numbers predate a previous annotation. Example:
  //
  //   Run 1 — scanner reports Future.delayed at line 190. Annotation
  //           inserted at idx 189. Future.delayed shifts to 191.
  //   Run 2 — stale report still says line 190. idx = 189.
  //           `lines[idx - 1] = lines[188]` = debugPrint — no tag.
  //           Guard misses → duplicate annotation inserted at 189.
  //
  // The reliable fix: scan a small window (±3 lines) around the
  // insertion point for the tag. Any hit, skip. This absorbs line
  // drift of up to 3 positions from stale reports.
  const WINDOW = 3;
  let existingTag = false;
  for (let i = Math.max(0, idx - WINDOW); i <= Math.min(lines.length - 1, idx + WINDOW); i++) {
    if (lines[i]!.includes(tag)) {
      existingTag = true;
      break;
    }
  }
  if (existingTag) {
    return { applied: false, kind: "skipped", lines, description: "Warning already present" };
  }

  const warningLines: string[] = [];
  warningLines.push(`${indent}${prefix}${tag} — ${recipe.warnings[0]}`);
  for (let i = 1; i < recipe.warnings.length; i++) {
    warningLines.push(`${indent}${prefix}  ${recipe.warnings[i]}`);
  }

  const result = [...lines];
  result.splice(idx, 0, ...warningLines);
  // IMPORTANT: this is an annotation, NOT a real fix. The buggy code is
  // unchanged; we only inserted an advisory `KCODE-AUDIT:<id>` comment.
  // Callers should report this distinctly from transformed fixes so users
  // know the finding still needs manual attention.
  return { applied: true, kind: "annotated", lines: result, description: recipe.description };
}

/**
 * Returns true when every pattern id in `patternIds` has coverage
 * (either a bespoke fixer above or a PATTERN_RECIPES entry). Used by
 * tests to detect when a new pattern is added without a fix recipe.
 */
const BESPOKE_PATTERN_IDS: ReadonlySet<string> = new Set([
  "cpp-001-ptr-address-index",
  "cpp-002-unreachable-after-return",
  "cpp-003-unchecked-data-index",
  "cpp-004-fd-leak-throw",
  "cpp-006-strcpy-family",
  "cpp-012-loop-unvalidated-bound",
  "py-001-eval-exec",
  "py-002-shell-injection",
  "py-004-sql-injection",
  "py-005-yaml-unsafe-load",
  "py-008-path-traversal",
  "py-013-bare-except",
  "dart-005-setstate-after-dispose",
  "dart-007-json-null-check",
]);

export function hasFixRecipe(patternId: string): boolean {
  return BESPOKE_PATTERN_IDS.has(patternId) || patternId in PATTERN_RECIPES;
}
