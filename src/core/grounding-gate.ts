// Grounding gate — post-turn check that scans files the agent wrote
// or edited in this turn for stub markers, placeholder data, and
// "not implemented" stubs. If any are found, the turn summary gets
// a warning prepended so the agent cannot claim "done" on output that
// clearly still needs work.
//
// Triggered by: issue #100 (stub_tx1 slipped into a generated Bitcoin
// dashboard while the agent told the user the dashboard showed live
// transactions).
//
// Scope intentionally narrow for MVP:
//   * Only scans files touched via Write / Edit / MultiEdit in the
//     current turn (ctx-provided list).
//   * Regex-based (no AST) — false positives acceptable because the
//     output is advisory, not blocking.
//   * Never modifies or blocks the write itself. The write already
//     happened; this runs after, before the final text is committed.

import { existsSync, readFileSync } from "node:fs";

export interface StubFinding {
  /** Absolute path of the file containing the stub marker. */
  file: string;
  /** 1-indexed line number of the match. */
  line: number;
  /** Short category: "placeholder" | "not_implemented" | "todo_in_new_code" | "empty_stub". */
  kind: StubKind;
  /** The matching line content (trimmed). */
  snippet: string;
}

export type StubKind =
  | "placeholder"
  | "not_implemented"
  | "todo_in_new_code"
  | "empty_stub";

// Identifier-level placeholders (`stub_tx1`, `stubFoo`, `placeholder_*`).
const PLACEHOLDER_IDENT =
  /\b(?:stub_[a-zA-Z][a-zA-Z0-9_]*|placeholder_[a-zA-Z][a-zA-Z0-9_]*|fake_[a-zA-Z][a-zA-Z0-9_]*|dummy_[a-zA-Z][a-zA-Z0-9_]*)\b/;

// String-literal placeholders: "stub_something", 'placeholder', etc.
const PLACEHOLDER_STRING =
  /(["'])(?:stub[_-][a-zA-Z0-9_-]+|placeholder[_-]?[a-zA-Z0-9_-]*|fake[_-]?[a-zA-Z0-9_-]*|dummy[_-]?[a-zA-Z0-9_-]*)\1/i;

// "Not implemented" markers across Python / JS / TS / Go.
const NOT_IMPLEMENTED =
  /\b(?:raise\s+NotImplementedError|NotImplementedError\s*\(|throw\s+new\s+Error\s*\(\s*["'][^"']*not\s+implemented|unimplemented!?\s*\(|panic\s*\(\s*["'][^"']*not\s+implemented|TODO:\s*implement|FIXME:\s*implement)/i;

// Explicit TODO/FIXME markers appearing in code the agent JUST wrote.
// (In mature codebases TODOs are common, but for the grounding gate
// the assumption is: the agent should not leave TODO: markers in code
// it just generated and declared as done.)
const TODO_MARKER = /\b(?:TODO|FIXME|XXX)\s*[:\-!]?\s*(?!.*\b(?:implement|done|fixed)\b)/;

// Python-specific: function body containing only `pass` as its one
// executable statement (ignoring docstring). Detects:
//   def foo(...):
//       pass
// and
//   def foo(...):
//       """doc"""
//       pass
const PYTHON_EMPTY_STUB = /^\s*def\s+[a-zA-Z_][a-zA-Z0-9_]*\s*\([^)]*\)\s*(?:->\s*[^:]+)?\s*:\s*(?:\n\s*"""[\s\S]*?"""\s*)?\n\s*pass\s*$/m;

// TS/JS: function that only throws "not implemented" or is empty `{}`.
const TS_EMPTY_STUB =
  /(?:function\s+[a-zA-Z_][a-zA-Z0-9_]*\s*\([^)]*\)|=>)\s*(?:\{[^{}]*throw\s+new\s+Error\s*\(\s*["'][^"']*not\s+implement[^"']*["'][^{}]*\}|\{\s*\})/i;

const IGNORED_EXT = new Set([".md", ".json", ".yaml", ".yml", ".toml", ".lock"]);

/**
 * Scan a set of files for stub markers. Returns every finding in
 * order (file, line). An empty array means "no stubs found".
 *
 * Files that don't exist or can't be read are silently skipped —
 * this tool never throws.
 */
export function scanFilesForStubs(filePaths: string[]): StubFinding[] {
  const findings: StubFinding[] = [];
  const seen = new Set<string>();

  for (const file of filePaths) {
    if (seen.has(file)) continue;
    seen.add(file);

    if (!existsSync(file)) continue;

    // Skip non-code extensions
    const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
    if (IGNORED_EXT.has(ext)) continue;

    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }

    // Whole-file regex checks (multi-line patterns)
    if (PYTHON_EMPTY_STUB.test(content)) {
      const match = content.match(PYTHON_EMPTY_STUB);
      if (match && match.index !== undefined) {
        const line = content.slice(0, match.index).split("\n").length;
        findings.push({
          file,
          line,
          kind: "empty_stub",
          snippet: match[0].split("\n")[0]?.trim() ?? "(function stub)",
        });
      }
    }
    if (TS_EMPTY_STUB.test(content)) {
      const match = content.match(TS_EMPTY_STUB);
      if (match && match.index !== undefined) {
        const line = content.slice(0, match.index).split("\n").length;
        findings.push({
          file,
          line,
          kind: "empty_stub",
          snippet: match[0].slice(0, 80),
        });
      }
    }

    // Line-by-line checks
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i] ?? "";
      const line = raw.trim();
      if (!line || line.startsWith("//") && !line.includes("TODO") && !line.includes("FIXME")) {
        // Skip pure comment lines unless they're TODO/FIXME markers.
      }
      if (PLACEHOLDER_IDENT.test(raw)) {
        findings.push({
          file,
          line: i + 1,
          kind: "placeholder",
          snippet: line.slice(0, 120),
        });
        continue;
      }
      if (PLACEHOLDER_STRING.test(raw)) {
        findings.push({
          file,
          line: i + 1,
          kind: "placeholder",
          snippet: line.slice(0, 120),
        });
        continue;
      }
      if (NOT_IMPLEMENTED.test(raw)) {
        findings.push({
          file,
          line: i + 1,
          kind: "not_implemented",
          snippet: line.slice(0, 120),
        });
        continue;
      }
      if (TODO_MARKER.test(raw)) {
        findings.push({
          file,
          line: i + 1,
          kind: "todo_in_new_code",
          snippet: line.slice(0, 120),
        });
      }
    }
  }

  return findings;
}

// Phrases that indicate the agent is claiming it delivered concrete
// code/project output, across Spanish + English. When any of these
// appear in the final turn text AND zero files were actually written
// (verified against disk) this turn, that's a 2026-04-23-style
// ungrounded completion claim — agent declares victory after tools
// were blocked/failed.
const CREATION_CLAIM_PATTERNS: RegExp[] = [
  // Spanish — broad "X creado" / "X generado" shape (covers
  // "Proyecto Foo creado en /tmp", "Dashboard generado correctamente",
  // "Archivos listos", etc).
  /\bcreado(?:s)?\s+(?:en|correctamente|exitosamente|sin errores|y|,)/i,
  /\bgenerado(?:s)?\s+(?:en|correctamente|exitosamente|sin errores|y|,)/i,
  /\b(?:proyecto|dashboard|script|app(?:licaci[oó]n)?|archivo|archivos|configuraci[oó]n|c[oó]digo|m[oó]dulo|setup|entorno)\s+(?:creado|generado|armado|construido|implementado|listo|completo|funcionando)/i,
  /\bha sido creado\b/i,
  /\bse (?:ha )?(?:creado|generado|armado|construido|implementado)\b/i,
  /\blisto para (?:correr|ejecutar|usar|probar)\b/i,
  /\bestá (?:listo|funcionando|completo|operativo)\b/i,
  /\bimplementad[oa]\b/i,
  /\bauditor[ií]a (?:completada|exitosa|finalizada)\b/i,
  // English
  /\b(?:has been|have been|was|were)\s+(?:created|generated|built|implemented|set up|written|scaffolded)\b/i,
  /\b(?:project|dashboard|script|app|application|file|files|config|code|module|setup|environment)\s+(?:created|generated|built|ready|complete|working|written)\b/i,
  /\b(?:created|built|implemented|generated|wrote|scaffolded)\s+(?:a|the|your|new|an)\s+[a-z]+/i,
  /\bsuccessfully (?:created|generated|built|implemented|wrote|written|scaffolded)\b/i,
  /\b(?:implementation|build|setup|scaffold|generation)\s+(?:complete|done|finished|ready)\b/i,
  /\ball\s+(?:done|set|good|ready)\b/i,
];

export interface CreationClaimMismatch {
  /** The phrase in the final text that matched. */
  snippet: string;
  /** Number of successful file writes/edits this turn (always 0 if mismatch triggers). */
  filesWritten: number;
}

/**
 * Count how many of the given paths actually exist on disk right now.
 * The caller's `filesModified` list can include paths from Write/Edit
 * tool_use inputs that were then blocked by safety guards — in that
 * case the path is "modified" according to the session tracker but
 * the file doesn't actually exist. We only care about files that
 * really landed on disk.
 */
export function countFilesOnDisk(paths: string[]): number {
  let count = 0;
  for (const p of paths) {
    if (existsSync(p)) count++;
  }
  return count;
}

/**
 * Detect the "claim creation, did nothing" pattern: final text claims
 * some form of creation/completion, but zero files that match the
 * turn's attempted writes actually exist on disk. Returns null if
 * no mismatch.
 *
 * The `filesWrittenCount` argument should be the count of files
 * actually present on disk (use `countFilesOnDisk` to compute it),
 * not the raw count from the session tracker.
 */
export function detectCreationClaimMismatch(
  finalText: string,
  filesWrittenCount: number,
): CreationClaimMismatch | null {
  if (filesWrittenCount > 0) return null;
  if (!finalText || finalText.trim().length === 0) return null;

  for (const pattern of CREATION_CLAIM_PATTERNS) {
    const match = finalText.match(pattern);
    if (match) {
      // Extract a reasonable surrounding snippet (up to 120 chars).
      const start = Math.max(0, (match.index ?? 0) - 30);
      const end = Math.min(finalText.length, (match.index ?? 0) + match[0].length + 60);
      return {
        snippet: finalText.slice(start, end).trim(),
        filesWritten: filesWrittenCount,
      };
    }
  }
  return null;
}

/**
 * Format a creation-claim mismatch warning.
 */
export function formatClaimMismatchWarning(mismatch: CreationClaimMismatch): string {
  return (
    `⚠ Grounding check: the final message claims creation, but zero files were written or edited this turn. ` +
    `Matched phrase: "${mismatch.snippet}". ` +
    `Either a tool failed silently (check logs) or the response over-promised. ` +
    `Do not present this turn as complete work.`
  );
}

/**
 * Format findings as a short human-readable warning block to prepend
 * to the agent's final turn summary. Returns an empty string if no
 * findings. Caps at 8 items to avoid flooding.
 */
export function formatStubWarning(findings: StubFinding[]): string {
  if (findings.length === 0) return "";

  const shown = findings.slice(0, 8);
  const rest = findings.length - shown.length;

  const kindLabel: Record<StubKind, string> = {
    placeholder: "placeholder",
    not_implemented: "not implemented",
    todo_in_new_code: "TODO in new code",
    empty_stub: "empty function body",
  };

  let msg =
    "⚠ Grounding check: the code written this turn still contains placeholders or unimplemented sections. Do not present this as complete end-to-end:\n";

  for (const f of shown) {
    // Shorten the file path relative to cwd for readability
    const rel = f.file.startsWith(process.cwd())
      ? f.file.slice(process.cwd().length + 1)
      : f.file;
    msg += `  • ${rel}:${f.line} — ${kindLabel[f.kind]}: ${f.snippet}\n`;
  }

  if (rest > 0) {
    msg += `  … and ${rest} more finding(s). Call the work "prototype" or "partial", list what still needs wiring.\n`;
  }

  return msg;
}
