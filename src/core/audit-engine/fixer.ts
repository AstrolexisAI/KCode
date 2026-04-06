// KCode - Audit Fixer
//
// Generates mechanical patches from confirmed audit findings.
// No LLM needed — each pattern has a deterministic fix strategy.
//
// Flow: read finding → read source file → apply fix rule → write file

import { readFileSync, writeFileSync } from "node:fs";
import type { AuditResult, Finding } from "./types";

export interface FixResult {
  file: string;
  line: number;
  pattern_id: string;
  applied: boolean;
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
        description: fixResult.description,
      });
    }

    if (modified) {
      writeFileSync(file, lines.join("\n"));
    }
  }

  return results;
}

interface OneFixResult {
  applied: boolean;
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
    default:
      return {
        applied: false,
        lines,
        description: `No auto-fix for pattern: ${finding.pattern_id}`,
      };
  }
}

/**
 * cpp-001: Replace (&buffer)[N] with ((const char*)buffer + N)
 */
function fixPointerArithmetic(lines: string[], finding: Finding): OneFixResult {
  const idx = finding.line - 1;
  if (idx < 0 || idx >= lines.length) {
    return { applied: false, lines, description: "Line out of range" };
  }

  const line = lines[idx]!;
  const re = /\(\s*&\s*(\w+)\s*\)\s*\[\s*(\w+)\s*\]/;
  const m = line.match(re);
  if (!m) {
    return { applied: false, lines, description: "Pattern not found on this line" };
  }

  const varName = m[1];
  const indexVar = m[2];
  const fixed = line.replace(re, `((const char*)${varName} + ${indexVar})`);
  const result = [...lines];
  result[idx] = fixed;
  return {
    applied: true,
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
    return { applied: false, lines, description: "Line out of range" };
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
        lines: result,
        description: `Moved unreachable statement before return/throw`,
      };
    }
  }

  return { applied: false, lines, description: "Could not locate return+unreachable pair" };
}

/**
 * cpp-003: Add size validation at the top of decode() functions.
 * Scans the ENTIRE function for the highest data[N] index, then inserts
 * `if (data.size() <= N) return;` after the opening brace.
 */
function fixUncheckedDataIndex(lines: string[], finding: Finding): OneFixResult {
  const idx = finding.line - 1;
  if (idx < 0 || idx >= lines.length) {
    return { applied: false, lines, description: "Line out of range" };
  }

  // Find the function that contains this line by walking backwards to
  // find "decode(" and the opening "{"
  let funcStart = -1;
  for (let i = idx; i >= Math.max(0, idx - 20); i--) {
    if (lines[i]!.includes("decode(") || lines[i]!.includes("decode (")) {
      funcStart = i;
      break;
    }
  }
  if (funcStart < 0) {
    return { applied: false, lines, description: "Could not find decode() function" };
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
    return { applied: false, lines, description: "Could not find opening brace" };
  }

  // Check if there's already a size check (don't double-fix)
  const lineAfterBrace = lines[braceIdx + 1]?.trim() ?? "";
  if (lineAfterBrace.includes("data.size()") || lineAfterBrace.includes("size() <")) {
    return { applied: false, lines, description: "Size check already exists" };
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
    return { applied: false, lines, description: "No data[N] access found in function" };
  }

  // Determine indentation from the line after the brace
  const indent = lines[braceIdx + 1]?.match(/^(\s*)/)?.[1] ?? "    ";

  // Insert the size check
  const result = [...lines];
  const guard = `${indent}if (data.size() <= ${maxIndex}) { return; }`;
  result.splice(braceIdx + 1, 0, guard);

  return {
    applied: true,
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
    return { applied: false, lines, description: "Line out of range" };
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
        lines: result,
        description: `Added ::close(${fdVar}) before throw`,
      };
    }
  }

  return { applied: false, lines, description: "Could not find throw without preceding close()" };
}

/**
 * cpp-006: Replace strcpy/strcat/sprintf with bounded variants.
 * Only auto-fixes when the source is a string LITERAL (known size).
 */
function fixStrcpyFamily(lines: string[], finding: Finding): OneFixResult {
  const idx = finding.line - 1;
  if (idx < 0 || idx >= lines.length) {
    return { applied: false, lines, description: "Line out of range" };
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
    return { applied: true, lines: result, description: `strcpy → strncpy (${src}, ${len} bytes)` };
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
    return { applied: true, lines: result, description: `strcat → strncat (${src}, ${len} chars)` };
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
    return { applied: true, lines: result, description: `sprintf → snprintf(${dst}, sizeof(${dst}), ...)` };
  }

  return { applied: false, lines, description: "Non-literal source — manual fix needed" };
}

// ── Python auto-fixes ─────────────────────────────────────────

/**
 * py-002: Replace os.system/subprocess with shell=False variant.
 */
function fixPyShellInjection(lines: string[], finding: Finding): OneFixResult {
  const idx = finding.line - 1;
  if (idx < 0 || idx >= lines.length) return { applied: false, lines, description: "Line out of range" };
  const line = lines[idx]!;
  const result = [...lines];

  // os.system("cmd") → subprocess.run(["cmd"], shell=False)
  const osSystemMatch = line.match(/\bos\.system\s*\(\s*(.+)\s*\)/);
  if (osSystemMatch) {
    const cmd = osSystemMatch[1]!.trim();
    result[idx] = line.replace(/os\.system\s*\([^)]+\)/, `subprocess.run(${cmd}, shell=False)  # FIXED: was os.system`);
    return { applied: true, lines: result, description: "os.system → subprocess.run(shell=False)" };
  }

  // subprocess.call(..., shell=True) → shell=False
  if (line.includes("shell=True") || line.includes("shell = True")) {
    result[idx] = line.replace(/shell\s*=\s*True/g, "shell=False  # FIXED: was shell=True");
    return { applied: true, lines: result, description: "shell=True → shell=False" };
  }

  // subprocess with f-string → add comment warning
  if (line.match(/subprocess\.\w+\s*\(\s*f["']/)) {
    const indent = line.match(/^(\s*)/)?.[1] ?? "";
    result.splice(idx, 0, `${indent}# SECURITY: Use list args instead of f-string to prevent injection`);
    return { applied: true, lines: result, description: "Added security warning for f-string in subprocess" };
  }

  // List args with f-strings/format — add input validation warning
  if (line.match(/subprocess\.\w+\s*\(\s*\[/) && (line.includes("f'") || line.includes('f"') || line.includes(".format("))) {
    const indent = line.match(/^(\s*)/)?.[1] ?? "";
    result.splice(idx, 0,
      `${indent}# SECURITY: Validate user-controlled args before passing to subprocess`,
      `${indent}# Sanitize: strip shell metacharacters, validate expected format`,
    );
    return { applied: true, lines: result, description: "Added input validation warning for subprocess args" };
  }

  return { applied: false, lines, description: "Complex shell injection — manual fix needed" };
}

/**
 * py-008: Add path validation for open() with dynamic paths.
 */
function fixPyPathTraversal(lines: string[], finding: Finding): OneFixResult {
  const idx = finding.line - 1;
  if (idx < 0 || idx >= lines.length) return { applied: false, lines, description: "Line out of range" };
  const line = lines[idx]!;
  const indent = line.match(/^(\s*)/)?.[1] ?? "";
  const result = [...lines];

  // Insert os.path validation before the open() call
  result.splice(idx, 0,
    `${indent}# SECURITY: Validate path to prevent traversal`,
    `${indent}import os; _path = os.path.abspath(_path); assert _path.startswith(os.getcwd()), "Path traversal blocked"`,
  );
  return { applied: true, lines: result, description: "Added path traversal guard" };
}

/**
 * py-001: Replace eval() with ast.literal_eval().
 */
function fixPyEval(lines: string[], finding: Finding): OneFixResult {
  const idx = finding.line - 1;
  if (idx < 0 || idx >= lines.length) return { applied: false, lines, description: "Line out of range" };
  const line = lines[idx]!;
  const result = [...lines];

  if (line.includes("eval(")) {
    result[idx] = line.replace(/\beval\s*\(/, "ast.literal_eval(  # FIXED: was eval(");
    return { applied: true, lines: result, description: "eval() → ast.literal_eval()" };
  }
  if (line.includes("exec(")) {
    const indent = line.match(/^(\s*)/)?.[1] ?? "";
    result.splice(idx, 0, `${indent}# SECURITY WARNING: exec() executes arbitrary code — remove or sandbox`);
    return { applied: true, lines: result, description: "Added exec() security warning" };
  }
  return { applied: false, lines, description: "Complex eval/exec — manual fix needed" };
}

/**
 * py-004: Add parameterized query comment.
 */
function fixPySqlInjection(lines: string[], finding: Finding): OneFixResult {
  const idx = finding.line - 1;
  if (idx < 0 || idx >= lines.length) return { applied: false, lines, description: "Line out of range" };
  const indent = lines[idx]!.match(/^(\s*)/)?.[1] ?? "";
  const result = [...lines];
  result.splice(idx, 0,
    `${indent}# SECURITY: Use parameterized query: cursor.execute("... WHERE id = %s", (id,))`,
  );
  return { applied: true, lines: result, description: "Added SQL injection warning + fix template" };
}

/**
 * py-005: Replace yaml.load() with yaml.safe_load().
 */
function fixPyYamlLoad(lines: string[], finding: Finding): OneFixResult {
  const idx = finding.line - 1;
  if (idx < 0 || idx >= lines.length) return { applied: false, lines, description: "Line out of range" };
  const line = lines[idx]!;
  const result = [...lines];

  if (line.includes("yaml.load(")) {
    result[idx] = line.replace(/yaml\.load\s*\(/, "yaml.safe_load(  # FIXED: was yaml.load(");
    return { applied: true, lines: result, description: "yaml.load() → yaml.safe_load()" };
  }
  return { applied: false, lines, description: "Complex YAML load — manual fix needed" };
}

/**
 * cpp-012: Add validation before loop with external bound.
 */
function fixLoopBound(lines: string[], finding: Finding): OneFixResult {
  const idx = finding.line - 1;
  if (idx < 0 || idx >= lines.length) {
    return { applied: false, lines, description: "Line out of range" };
  }

  const line = lines[idx]!;
  // Extract the bound variable: for (...; var < BOUND; ...)
  const m = line.match(/\w+\s*<\s*(\w+(?:\.\w+|->[\w.]+)+)/);
  if (!m) {
    return { applied: false, lines, description: "Could not extract loop bound" };
  }

  const boundExpr = m[1]!;
  const indent = line.match(/^(\s*)/)?.[1] ?? "    ";

  // Check if there's already a validation above
  const prev = lines[idx - 1]?.trim() ?? "";
  if (prev.includes(boundExpr) && (prev.includes("if") || prev.includes("max"))) {
    return { applied: false, lines, description: "Bound validation already exists" };
  }

  const result = [...lines];
  result.splice(idx, 0, `${indent}if (${boundExpr} > 10000) { return; } // guard: cap loop bound`);
  return {
    applied: true,
    lines: result,
    description: `Added loop bound cap: ${boundExpr} > 10000`,
  };
}
