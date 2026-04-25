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
 * - `annotated`: the generic recipe inserted an `audit-note:<id>` warning
 *   comment above the finding. The buggy code is UNCHANGED — the comment
 *   is an advisory TODO the user still has to act on.
 * - `manual`: the pattern has NO entry in BESPOKE_PATTERN_IDS or
 *   PATTERN_RECIPES — there's nothing /fix can do mechanically. The user
 *   must address it by hand. v2.10.328 split this out from `skipped` so
 *   the UI no longer conflates "no auto-fix exists" with "marker already
 *   present" or "line out of range".
 * - `skipped`: a fixer/recipe DOES exist but didn't apply this run
 *   (line out of range, pattern no longer present on the matched line,
 *   marker already there from a previous run, etc.). Idempotent re-runs
 *   end up here.
 *
 * `applied` is kept as a boolean for existing callers; it is true for both
 * `transformed` and `annotated`. New UI should look at `kind` instead so
 * annotations aren't reported as real fixes.
 */
export type FixKind = "transformed" | "annotated" | "manual" | "skipped";

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
    case "fsw-005-buffer-getdata-unchecked":
      return fixFswBufferGetdata(lines, finding);
    case "fsw-010-cmd-arg-before-validate":
      return fixFswCmdArgBeforeValidate(lines, finding);
    default: {
      // Fall through to the generic recipe table below. Every pattern
      // registered in patterns.ts has an entry here — the bespoke fixers
      // above handle the patterns that need multi-line transforms, and
      // the table covers the rest with either a mechanical replacement
      // or a language-aware safety comment.
      const recipe = PATTERN_RECIPES[finding.pattern_id];
      if (recipe) return applyRecipe(lines, finding, recipe);
      // v2.10.328: distinguish "manual" (no fixer exists) from
      // "skipped" (fixer exists but didn't apply this run). The UI
      // can then announce both honestly: "5 manual-only — patch by
      // hand" vs "2 skipped — already fixed in a previous run".
      return {
        applied: false,
        kind: "manual",
        lines,
        description: `No mechanical fix — manual patch required for ${finding.pattern_id}`,
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

// ── Flight-software bespoke fixers (v2.10.315) ───────────────

/**
 * fsw-005: insert FW_ASSERT(buf.getData() != nullptr) BEFORE the use.
 *
 * Strategy: find the buffer name from the matched line (the regex
 * captures `\\w+\\.getData\\(\\)`), then emit an assert one line above
 * with the same indentation as the use site. Idempotent: if the
 * line above already contains `FW_ASSERT(<name>.getData()` skip.
 */
function fixFswBufferGetdata(lines: string[], finding: Finding): OneFixResult {
  const idx = finding.line - 1;
  if (idx < 0 || idx >= lines.length) {
    return { applied: false, kind: "skipped", lines, description: "Line out of range" };
  }
  const line = lines[idx]!;
  const m = line.match(/(\b\w+)\.getData\s*\(\s*\)/);
  if (!m) {
    return { applied: false, kind: "skipped", lines, description: "getData() not on this line" };
  }
  const bufName = m[1]!;
  const indent = (line.match(/^\s*/) ?? [""])[0];

  // Idempotency: if the line above already has the assert for THIS
  // buffer, do nothing. Walk back up to 3 lines to absorb minor drift.
  for (let i = Math.max(0, idx - 3); i < idx; i++) {
    if (lines[i]!.includes(`FW_ASSERT(${bufName}.getData()`)) {
      return {
        applied: false,
        kind: "skipped",
        lines,
        description: `Assert already present for ${bufName}.getData()`,
      };
    }
  }

  const assertLine = `${indent}FW_ASSERT(${bufName}.getData() != nullptr);  // audit-fix:fsw-005`;
  const result = [...lines];
  result.splice(idx, 0, assertLine);
  return {
    applied: true,
    kind: "transformed",
    lines: result,
    description: `Added FW_ASSERT(${bufName}.getData() != nullptr) guard`,
  };
}

/**
 * fsw-010: insert input validation at the top of a *_cmdHandler that
 * receives a Fw::CmdStringArg.
 *
 * Strategy:
 *   1. From the finding line, walk forward to the opening brace `{`
 *      of the function body.
 *   2. Walk back to the function signature to extract the StringArg
 *      parameter name (the regex captured group #2 was the name).
 *   3. Insert at the top of the body:
 *        const Fw::CmdStringArg& <name> = <name>; // marker
 *        if (<name>.length() == 0 || <name>.length() >= Fw::CmdStringArg::SERIALIZED_SIZE) {
 *            this->cmdResponse_out(opCode, cmdSeq, Fw::CmdResponse::VALIDATION_ERROR);
 *            return;
 *        }
 *
 * Idempotent: if the body already contains a length check on this
 * variable + cmdResponse_out(VALIDATION_ERROR), skip.
 */
function fixFswCmdArgBeforeValidate(lines: string[], finding: Finding): OneFixResult {
  const startIdx = finding.line - 1;
  if (startIdx < 0 || startIdx >= lines.length) {
    return { applied: false, kind: "skipped", lines, description: "Line out of range" };
  }

  // Walk forward up to 12 lines to find the opening brace of the body.
  let braceIdx = -1;
  let signatureBlob = "";
  for (let i = startIdx; i < Math.min(lines.length, startIdx + 12); i++) {
    signatureBlob += lines[i] + " ";
    if (lines[i]!.includes("{")) {
      braceIdx = i;
      break;
    }
  }
  if (braceIdx < 0) {
    return {
      applied: false,
      kind: "skipped",
      lines,
      description: "Could not locate opening brace of cmdHandler body",
    };
  }

  // Extract the StringArg parameter name from the signature.
  const argMatch = signatureBlob.match(
    /(?:const\s+Fw::CmdStringArg\s*&\s*|Fw::CmdStringArg\s+)(\w+)/,
  );
  if (!argMatch) {
    return {
      applied: false,
      kind: "skipped",
      lines,
      description: "No Fw::CmdStringArg parameter found in signature",
    };
  }
  const argName = argMatch[1]!;

  // Idempotency: if the next ~30 lines after the brace already check
  // this argument and emit cmdResponse VALIDATION_ERROR, skip.
  for (let i = braceIdx; i < Math.min(lines.length, braceIdx + 30); i++) {
    const l = lines[i]!;
    if (
      l.includes(`${argName}.length()`) &&
      lines.slice(i, Math.min(lines.length, i + 4)).some((x) =>
        x.includes("VALIDATION_ERROR"),
      )
    ) {
      return {
        applied: false,
        kind: "skipped",
        lines,
        description: `${argName} validation already present`,
      };
    }
  }

  const indentMatch = lines[braceIdx + 1]?.match(/^\s*/);
  const indent = indentMatch ? indentMatch[0] : "    ";

  const guard = [
    `${indent}// audit-fix:fsw-010 — reject malformed ground-command argument before any side effect.`,
    `${indent}if (${argName}.length() == 0 || ${argName}.length() >= Fw::CmdStringArg::SERIALIZED_SIZE) {`,
    `${indent}    this->cmdResponse_out(opCode, cmdSeq, Fw::CmdResponse::VALIDATION_ERROR);`,
    `${indent}    return;`,
    `${indent}}`,
    "",
  ];
  const result = [...lines];
  result.splice(braceIdx + 1, 0, ...guard);
  return {
    applied: true,
    kind: "transformed",
    lines: result,
    description: `Inserted ${argName} length-check + VALIDATION_ERROR response`,
  };
}

// ── Generic recipe table ──────────────────────────────────────
//
// Every pattern in patterns.ts must have coverage: either a bespoke
// fixer above, or an entry in PATTERN_RECIPES below. A recipe inserts
// a language-aware safety comment directly above the finding, tagged
// `audit-note:<pattern_id>` so subsequent runs can detect and skip it.
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
  "uni-011-weak-crypto": r("weak crypto", "Replace MD5/SHA1/DES/RC4 with SHA-256+, bcrypt/argon2, AES-GCM, or Ed25519."),
  "uni-012-ldap-injection": r("LDAP injection", "Use parameterized LDAP queries or escape input with ldap.filter.escape_filter_chars."),
  "uni-013-session-fixation": r("session fixation", "Regenerate the session ID immediately after successful authentication."),
  "uni-014-no-session-timeout": r("session no timeout", "Set a reasonable session expiration (1-24h) and use refresh token rotation for long-lived sessions."),
  "uni-015-symlink-toctou": r("symlink TOCTOU", "Use atomic operations (openat + O_NOFOLLOW) or realpath + prefix validation instead of check-then-use."),
  "uni-016-external-file-path": r("external file path", "Use an allowlist of permitted filenames or a server-side ID-to-path mapping."),
  "uni-017-info-exposure": r("info exposure", "Strip sensitive fields before serializing the response."),
  "uni-018-sensitive-error": r("sensitive error", "Return a generic error in production and log details server-side with a correlation ID."),

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

  // ── v2.10.314 expansion: crypto misuse ─────────────────────
  "crypto-001-rand-for-key-material": r("weak RNG for secrets", "Use secrets/crypto.randomBytes/SecureRandom — never rand()/Math.random for keys or tokens."),
  "crypto-002-static-iv": r("constant IV", "Generate a fresh random IV/nonce per encryption."),
  "crypto-003-md5-sha1-for-auth": r("MD5/SHA1 for security", "Switch to SHA-256+ for hashes, HMAC-SHA256 for MAC, Argon2/bcrypt for passwords."),
  "crypto-004-password-fast-hash": r("password without KDF", "Use Argon2id / bcrypt / scrypt / PBKDF2 (≥600k iter) for password hashing."),
  "crypto-005-timing-safe-compare-missing": r("non-constant-time MAC compare", "Use hmac.compare_digest / crypto.timingSafeEqual / subtle.ConstantTimeCompare."),
  "crypto-006-tls-legacy-version": r("TLS ≤ 1.1", "Require TLS 1.2+ (prefer TLS 1.3)."),
  "crypto-007-tls-verify-off": r("TLS verify disabled", W.HTTPS),
  "crypto-008-hardcoded-key": r("hardcoded crypto key", W.SECRET),
  "crypto-009-ecb-mode": r("ECB mode", "Use an authenticated mode: AES-GCM or ChaCha20-Poly1305."),
  "crypto-010-short-rsa-dh": r("short RSA/DH key", "Use 2048-bit RSA/DH minimum (3072+ for long-term data), or switch to Ed25519/X25519."),
  "crypto-011-jwt-none-alg": r("JWT alg=none", "Whitelist algorithms explicitly: jwt.decode(..., algorithms=['HS256'])."),
  "crypto-012-homerolled-xor": r("home-rolled XOR crypto", "Replace with AES-GCM or ChaCha20-Poly1305 from stdlib."),
  "crypto-013-static-salt": r("constant KDF salt", "Generate a unique random salt per credential."),
  "crypto-014-rsa-pkcs1v15-encrypt": r("RSA PKCS#1 v1.5 encryption", "Switch encryption to OAEP padding."),
  "crypto-015-hmac-truncation": r("truncated HMAC", "Keep HMAC output at ≥128 bits; don't truncate below half the hash width."),

  // ── v2.10.314 expansion: injection ─────────────────────────
  "inj-001-sql-string-concat": r("SQL concat", W.SQL),
  "inj-002-subprocess-shell-true": r("subprocess shell=True", W.SHELL),
  "inj-003-os-system-with-var": r("system() with variable", W.SHELL),
  "inj-004-ssrf-fetch": r("SSRF fetch", "Allowlist permitted hosts; block RFC1918 + loopback + cloud metadata IPs."),
  "inj-005-path-traversal": r("path traversal", W.PATH),
  "inj-006-nosql-where": r("NoSQL $where injection", "Use standard Mongo operators ($eq/$gt/$in); never inject into $where."),
  "inj-007-ldap-filter-concat": r("LDAP filter injection", "Escape LDAP metacharacters before building the filter."),
  "inj-008-xxe-default-parser": r("XXE", "Disable external entities / DTDs on the XML parser."),
  "inj-009-ssti-render-string": r("SSTI", "Render a fixed template and pass user input as context vars."),
  "inj-010-open-redirect": r("open redirect", "Restrict redirects to relative URLs or a host allowlist."),
  "inj-011-redos-pattern": r("ReDoS regex", W.REDOS),
  "inj-012-proto-pollution": r("prototype pollution", W.PROTO),
  "inj-013-mass-assignment": r("mass assignment", "Use a field allowlist (permit/pick) before assigning request body to a model."),
  "inj-014-response-splitting": r("response splitting", "Strip CR/LF from any user value before writing it to a response header."),
  "inj-015-zipslip": r("Zip Slip", "Validate each entry's resolved path stays within the destination before extracting."),

  // ── v2.10.314 expansion: deserialization ───────────────────
  "des-001-pickle-loads": r("pickle untrusted", W.DESER),
  "des-002-yaml-full-load": r("yaml.load unsafe", W.DESER),
  "des-003-eval-user-input": r("eval user input", W.EVAL),
  "des-004-java-objectinputstream": r("Java deserialization", W.DESER),
  "des-005-php-unserialize": r("PHP unserialize", W.DESER),
  "des-006-ruby-marshal": r("Ruby Marshal.load", W.DESER),
  "des-007-csharp-binaryformatter": r("BinaryFormatter", W.DESER),
  "des-008-node-vm-runInThisContext": r("vm.run untrusted code", W.EVAL),
  "des-009-django-pickle-session": r("pickle session", W.DESER),
  "des-010-xml-type-resolver": r("polymorphic deserialization", W.DESER),

  // ── v2.10.314 expansion: flight software ───────────────────
  "fsw-001-port-handler-no-check": r("port handler no bounds check", "Add FW_ASSERT(portNum < getNum_<Port>_InputPorts()) at handler start."),
  "fsw-002-deserialize-no-length-check": r("unchecked deserialize", "Capture deserialize status and verify Fw::FW_SERIALIZE_OK before using the value."),
  "fsw-003-assert-as-validation": r("FW_ASSERT for input validation", "Use cmdResponse_VALIDATION_ERROR for untrusted input; keep FW_ASSERT for invariants."),
  "fsw-004-narrow-cast-no-check": r("narrowing cast", "Range-check the source value before static_cast to a narrower type."),
  "fsw-005-buffer-getdata-unchecked": r("Fw::Buffer.getData null deref", "Guard: FW_ASSERT(buf.getData() != nullptr) before use."),
  "fsw-006-dispatch-loop-unbounded": r("unbounded dispatch loop", "Cap messages per doDispatch() and yield to scheduler."),
  "fsw-007-assert-with-side-effect": r("FW_ASSERT with side effect", "Split: capture the side-effect into a variable, then FW_ASSERT the variable."),
  "fsw-008-time-ticks-overflow": r("tick rollover", "Use unsigned difference idiom: static_cast<U32>(now - last) for rollover safety."),
  "fsw-009-state-switch-default-missing": r("state switch no default", "Add `default: FW_ASSERT(0, state);` as the last case."),
  "fsw-010-cmd-arg-before-validate": r("cmd arg unvalidated", "Validate command arguments before use; emit VALIDATION_ERROR on failure."),
  "fsw-011-event-id-hardcoded": r("hardcoded event ID", "Use the autocoded EVENTID_<NAME> enum, not a numeric literal."),
  "fsw-012-configure-no-state-check": r("method before configure()", "Guard method entry: FW_ASSERT(this->m_configured)."),
  "fsw-013-reinterpret-cast-untrusted": r("reinterpret_cast untrusted", "Check buf.getSize() >= sizeof(T) before the cast."),
  "fsw-014-tlm-string-write-unbounded": r("unbounded log string", "Use Fw::StringBase::format with width specifier; guarantee null-termination."),
  "fsw-015-malloc-in-handler": r("heap alloc in realtime handler", "Use pre-allocated pools (BufferManager / cFE memory pools) on data-plane paths."),

  // ── v2.10.332 — Phase A web/ML expansion ───────────────────
  "py-021-torch-load-untrusted": r("torch.load untrusted", W.DESER),
  "go-021-readall-no-limit": r("io.ReadAll no limit", "Wrap with io.LimitReader / http.MaxBytesReader to cap body size."),
  "go-022-http-no-timeout": r("http.Client no timeout", "Set http.Client.Timeout or pass a deadline-bearing context.Context."),
  "go-023-template-html-bypass": r("html/template safe bypass", W.XSS),
  "cpp-013-snprintf-truncation-ignored": r("snprintf truncation ignored", W.ERR),
  "cpp-014-fread-return-ignored": r("fread/read result ignored", W.ERR),

  // ── v2.10.333 — Phase A round 2 ────────────────────────────
  "java-019-tls-trust-all": r("TLS trust-all manager", W.HTTPS),
  "java-020-ssrf-resttemplate": r("RestTemplate SSRF", "Allowlist permitted hosts; block RFC1918 + loopback + cloud metadata."),
  "java-021-spring-restbody-map": r("Spring @RequestBody Map mass-assignment", "Replace Map<String,Object> with a typed DTO + Bean Validation."),
  "php-016-ssrf-fetch": r("PHP SSRF", "Allowlist permitted hosts; block RFC1918 + loopback + metadata IPs."),
  "rb-013-ssrf-net-http": r("Ruby Net::HTTP SSRF", "Allowlist host + restrict scheme to https; block file:/// and metadata IPs."),
  "rb-014-send-file-traversal": r("Ruby send_file path traversal", W.PATH),

  // ── v2.10.334 — Phase B: deeper flight-software pack ───────
  "fsw-016-frame-length-as-offset": r("frame length as offset", "Cap header.get_lengthField() against MAX_PAYLOAD_SIZE before calling moveDeserToOffset / setBuffSize."),
  "fsw-017-component-array-id-no-check": r("array indexed by external ID", "FW_ASSERT(id < ARRAY_SIZE) before indexing the channels/packets/ports array."),
  "fsw-018-cmdhandler-stub-only-response": r("cmdHandler stub", "Implement the handler, or emit cmdResponse NOT_IMPLEMENTED so ground sees the gap."),
  "fsw-019-logger-format-from-arg": r("logger format injection", "Always pass a literal format string; never let user input become the format."),
  "fsw-020-fwtime-getseconds-no-tb-check": r("Fw::Time TimeBase mismatch", "Check getTimeBase() agreement, or use Fw::Time::sub()."),

  // ── v2.10.336 — AST-based patterns ─────────────────────────
  "py-ast-001-eval-of-parameter": r("eval() of function parameter (AST taint)", W.EVAL),
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
  const tag = `audit-note:${finding.pattern_id}`;

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
  // Match either the new spelling-friendly `audit-note:` tag (current)
  // or the legacy `KCODE-AUDIT:` tag (old runs) so re-runs against
  // pre-existing annotations don't duplicate the warning.
  const legacyTag = `KCODE-AUDIT:${finding.pattern_id}`;
  for (let i = Math.max(0, idx - WINDOW); i <= Math.min(lines.length - 1, idx + WINDOW); i++) {
    const ln = lines[i]!;
    if (ln.includes(tag) || ln.includes(legacyTag)) {
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
  // v2.10.315 flight-software bespoke fixers
  "fsw-005-buffer-getdata-unchecked",
  "fsw-010-cmd-arg-before-validate",
]);

export function hasFixRecipe(patternId: string): boolean {
  return BESPOKE_PATTERN_IDS.has(patternId) || patternId in PATTERN_RECIPES;
}

/**
 * Classify a pattern by what /fix can do for it:
 *
 *   "rewrite"  — bespoke fixer that performs a real code transform.
 *                /fix output should announce these as fixes.
 *   "annotate" — generic PATTERN_RECIPES entry that inserts an
 *                advisory `audit-note:` comment. The buggy code stays
 *                buggy. UI should NOT call this a fix.
 *   "manual"   — pattern has neither; user must address by hand.
 *                /fix should NOT silently skip these — the report
 *                must surface the count up front.
 *
 * Drives Sprint 3 honesty: report fix_support_summary {rewrite,
 * annotate, manual} on every audit so the user knows BEFORE running
 * /fix what fraction is actually mechanical. v2.10.328.
 */
export function fixSupportFor(patternId: string): "rewrite" | "annotate" | "manual" {
  if (BESPOKE_PATTERN_IDS.has(patternId)) return "rewrite";
  if (patternId in PATTERN_RECIPES) return "annotate";
  return "manual";
}
