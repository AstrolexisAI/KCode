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

export type StubKind = "placeholder" | "not_implemented" | "todo_in_new_code" | "empty_stub";

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
const PYTHON_EMPTY_STUB =
  /^\s*def\s+[a-zA-Z_][a-zA-Z0-9_]*\s*\([^)]*\)\s*(?:->\s*[^:]+)?\s*:\s*(?:\n\s*"""[\s\S]*?"""\s*)?\n\s*pass\s*$/m;

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
      if (!line || (line.startsWith("//") && !line.includes("TODO") && !line.includes("FIXME"))) {
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

// Patterns for readiness claims — "X is ready / está listo / runs with …
// / displays real-time …". When paired with direct evidence of runtime
// failure (errors encountered this turn) or blocked repair paths, this
// is the #103 pattern: agent saw ModuleNotFoundError + blocked Edit +
// still emitted "app.py is ready" / "the dashboard displays …".
const READINESS_CLAIM_PATTERNS: RegExp[] = [
  // Spanish
  /\b(?:app(?:licaci[oó]n)?|script|dashboard|proyecto|archivo|c[oó]digo|m[oó]dulo)\s+(?:est[aá]\s+list[oa]|es\s+list[oa])\b/i,
  /\b(?:correl[oa]|ejecut[aá]l?[oa]?|corr[eé])\s+con\b/i,
  /\b(?:el|la)\s+(?:dashboard|app|aplicaci[oó]n)\s+(?:muestra|actualiza|despliega|funciona|corre)/i,
  /\bmuestra\s+en\s+(?:tiempo\s+real|vivo)\b/i,
  /\b(?:funciona|funcionando|operativo)\s+(?:perfectamente|correctamente|bien)\b/i,
  // English
  /\b(?:app|script|dashboard|project|file|code|module)\s+(?:is|'s)\s+(?:ready|running|working|functional|live)\b/i,
  /\brun\s+it\s+with\b/i,
  /\bthe\s+(?:dashboard|app|application)\s+(?:displays|shows|updates|runs|renders|works)\b/i,
  /\bdisplays\s+real[-\s]?time\b/i,
  /\b(?:is|are)\s+(?:fully|now)\s+(?:working|functional|operational|running)\b/i,
  // Run-command hints — "run with: python3 app.py" style
  /\brun\s+with\s*[:]?\s*['"`]?(?:python(?:3)?|node|bun|ruby|go)\s+/i,
];

export interface ReadinessContradictionFinding {
  /** Phrase in final text that claims readiness. */
  snippet: string;
  /** Number of tool errors recorded this turn. */
  errorCount: number;
  /** Whether any tool returned a BLOCKED response (repair blocked). */
  repairBlocked: boolean;
}

/**
 * Detect readiness-claim contradictions: final text says the artifact
 * runs / is ready, but tool signals from the same turn say otherwise.
 * Fires on any of:
 *   - errorCount > 0 (a tool, typically a validation Bash call,
 *     returned non-zero)
 *   - repairBlocked true (Edit/Write was blocked, so the broken code
 *     was never fixed)
 *
 * This is the #103 invariant: the agent must not contradict its own
 * direct observation of failure.
 */
export function detectReadinessAfterErrors(
  finalText: string,
  errorCount: number,
  repairBlocked: boolean,
): ReadinessContradictionFinding | null {
  if (errorCount === 0 && !repairBlocked) return null;
  if (!finalText || finalText.trim().length === 0) return null;

  for (const pattern of READINESS_CLAIM_PATTERNS) {
    const match = finalText.match(pattern);
    if (match) {
      const start = Math.max(0, (match.index ?? 0) - 30);
      const end = Math.min(finalText.length, (match.index ?? 0) + match[0].length + 80);
      return {
        snippet: finalText.slice(start, end).trim(),
        errorCount,
        repairBlocked,
      };
    }
  }
  return null;
}

// ─── Post-error patch without rerun (issue #104) ────────────────

/**
 * Given the turn's tool history (as a flat list of {name, isError, cmd}),
 * detect the #104 pattern:
 *   1. A runtime execution via Bash (python/node/bun/etc running a
 *      recently-written file) returned non-zero → ran_failed.
 *   2. A patch was applied (Edit / Write / MultiEdit / GrepReplace /
 *      Bash file-mutation) after that failure → patched_after_failure.
 *   3. No subsequent successful rerun of the same kind of command →
 *      rerun_passed = false.
 *
 * If all three conditions are met AND the final text claims the code
 * works/is ready/runs, that's an ungrounded success claim.
 */
export interface ToolEvent {
  name: string;
  isError: boolean;
  /** Free-form summary: the command for Bash, the path for Edit/Write. */
  summary: string;
}

export interface PatchWithoutRerunFinding {
  /** Description of the failing command that started the chain. */
  failingCommand: string;
  /** What patch tool and target were applied after the failure. */
  patchAction: string;
  /** Phrase in final text that asserts success. */
  claimSnippet: string;
}

const RUNTIME_COMMAND =
  /\b(?:python(?:3)?|node|bun\s+run|ruby|go\s+run|cargo\s+run|java|php|deno\s+run|rustc)\b/i;
const PATCH_TOOL_NAMES = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "GrepReplace",
  "Bash", // bash file-mutations count as patches — filter by command shape below
]);
const BASH_IS_MUTATION =
  /\b(?:sed\s+.*-i|perl\s+.*-i|awk\s+.*-i\s+inplace|>\s*\S|>>\s*\S|tee\s)\b/i;

export function detectPatchWithoutRerun(
  events: ToolEvent[],
  finalText: string,
): PatchWithoutRerunFinding | null {
  if (events.length === 0 || !finalText) return null;

  // Find the most recent runtime failure, scanning forwards.
  let ranFailedIndex = -1;
  let failingCmd = "";
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.name !== "Bash") continue;
    if (!ev.isError) continue;
    if (!RUNTIME_COMMAND.test(ev.summary)) continue;
    ranFailedIndex = i;
    failingCmd = ev.summary.slice(0, 120);
  }
  if (ranFailedIndex < 0) return null;

  // Find patches AFTER the failure.
  let patchIndex = -1;
  let patchDescription = "";
  for (let i = ranFailedIndex + 1; i < events.length; i++) {
    const ev = events[i]!;
    if (!PATCH_TOOL_NAMES.has(ev.name)) continue;
    if (ev.isError) continue; // only counts successful patches
    if (ev.name === "Bash" && !BASH_IS_MUTATION.test(ev.summary)) continue;
    patchIndex = i;
    patchDescription = `${ev.name}: ${ev.summary.slice(0, 80)}`;
  }
  if (patchIndex < 0) return null;

  // Check whether any SUCCESSFUL runtime command ran after the patch.
  let rerunPassed = false;
  for (let i = patchIndex + 1; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.name !== "Bash") continue;
    if (ev.isError) continue;
    if (!RUNTIME_COMMAND.test(ev.summary)) continue;
    rerunPassed = true;
    break;
  }
  if (rerunPassed) return null;

  // Claim-in-final-text patterns (readiness/success language).
  const CLAIM_PATTERNS = [
    /\bconecta\s+(?:al|a)\b/i,
    /\bmuestra\b/i,
    /\bactualiza\s+en\s+(?:vivo|tiempo\s+real)\b/i,
    /\bmostrar[aá]?\b/i,
    /\b(?:funciona|corre|ejecuta)\b/i,
    /\bhe\s+creado\b/i,
    /\bincluye\s+un\s+script\b/i,
    /\b(?:works|runs|connects|displays|shows|updates)\b/i,
    /\bcreated\s+the\s+(?:app|project|script)\b/i,
  ];
  for (const p of CLAIM_PATTERNS) {
    const m = finalText.match(p);
    if (m) {
      const start = Math.max(0, (m.index ?? 0) - 30);
      const end = Math.min(finalText.length, (m.index ?? 0) + m[0].length + 80);
      return {
        failingCommand: failingCmd,
        patchAction: patchDescription,
        claimSnippet: finalText.slice(start, end).trim(),
      };
    }
  }
  return null;
}

// ─── Runtime traceback in bash output (issue #106) ──────────────

/**
 * Traceback / error patterns that indicate runtime failure even when
 * the bash exit code is 0 (typical with `timeout N python app.py
 * 2>&1 | head -20` shape commands where the pipe's last command
 * succeeds and masks the python failure).
 */
const RUNTIME_ERROR_SIGNATURES = [
  /\bTraceback\s+\(most recent call last\)/,
  /\bModuleNotFoundError\b/,
  /\bImportError\b/,
  /\bSyntaxError\b/,
  /\bNameError\b/,
  /\bAttributeError\b/,
  /\bIndentationError\b/,
  /\bTypeError\s*:/,
  /\bValueError\s*:/,
  /\bruntime error\b/i,
  // Node.js
  /\bReferenceError\b/,
  /\bUncaught Exception\b/,
  /\bUnhandledPromiseRejectionWarning\b/,
  /\bError: Cannot find module\b/,
  // Ruby / Go / Rust
  /\bpanic:/,
  /\bNoMethodError\b/,
  /\b(?:thread\s+'.+'\s+panicked|panicked at)\b/i,
];

export interface RuntimeFailureInOutputFinding {
  /** The first signature that matched (regex source). */
  marker: string;
  /** The command line that produced the output. */
  command: string;
  /** A short excerpt of the failing output. */
  excerpt: string;
}

/**
 * Scan a list of (command, output) pairs for runtime-error signatures
 * that indicate the generated code failed to run, even if the bash
 * exit code was 0. Returns the first finding, or null.
 *
 * Issue #106: `timeout 5 python app.py 2>&1 | head` returned exit
 * code 0 because the pipe's last command succeeded, masking the
 * Traceback in stdout. KCode's error counter missed it, so the
 * readiness-vs-errors gate didn't fire.
 */
export function detectRuntimeFailureInOutput(
  events: Array<{ command: string; output: string }>,
): RuntimeFailureInOutputFinding | null {
  for (const ev of events) {
    // Only check output from runtime execution commands
    if (
      !/\b(?:python(?:3)?|node|bun\s+run|ruby|go\s+run|cargo\s+run|java|php|deno\s+run|rustc|npx|npm\s+(?:run|start|test))\b/i.test(
        ev.command,
      )
    ) {
      continue;
    }
    for (const sig of RUNTIME_ERROR_SIGNATURES) {
      const m = ev.output.match(sig);
      if (m) {
        const start = Math.max(0, (m.index ?? 0) - 10);
        const end = Math.min(ev.output.length, (m.index ?? 0) + m[0].length + 200);
        return {
          marker: sig.source,
          command: ev.command.slice(0, 160),
          excerpt: ev.output.slice(start, end).trim().slice(0, 240),
        };
      }
    }
  }
  return null;
}

export function formatRuntimeFailureInOutputWarning(
  finding: RuntimeFailureInOutputFinding,
): string {
  return (
    `⚠ Grounding check: a runtime command produced an error in its output but the bash exit code was 0 — likely a piped command that masked the underlying failure. ` +
    `Command: "${finding.command}". ` +
    `Error excerpt: "${finding.excerpt}". ` +
    `Do not present the artifact as working until the failing command runs cleanly (no Traceback / Error in output).`
  );
}

export function formatPatchWithoutRerunWarning(finding: PatchWithoutRerunFinding): string {
  return (
    `⚠ Grounding check: runtime failed → a patch was applied → no successful rerun was observed → the response still claims success. ` +
    `Failing command: "${finding.failingCommand}". ` +
    `Patch applied: ${finding.patchAction}. ` +
    `Claim in response: "${finding.claimSnippet}". ` +
    `Do not present the artifact as working until it has been rerun after the patch and the rerun passes.`
  );
}

export function formatReadinessContradictionWarning(
  finding: ReadinessContradictionFinding,
): string {
  const parts: string[] = [
    `⚠ Grounding check: the response claims the artifact is ready, but the turn recorded direct failure signals.`,
    `Matched phrase: "${finding.snippet}".`,
  ];
  if (finding.errorCount > 0) {
    parts.push(
      `${finding.errorCount} tool error(s) occurred this turn — likely a validation Bash call returned non-zero.`,
    );
  }
  if (finding.repairBlocked) {
    parts.push(
      `At least one repair attempt (Edit/Write) was blocked by a safety policy, so the broken state was never fixed.`,
    );
  }
  parts.push(
    `Do not present the artifact as working. Say exactly: what was created, that validation failed, what the error was, and whether repair was possible.`,
  );
  return parts.join(" ");
}

// Patterns that declare strong, broad completion — the kind of claim that
// requires evidence of actual runtime behavior end-to-end, not just a
// successful import or file write. Issue #102: "Proyecto completado,
// listo para analizar la blockchain en tiempo real" after only imports
// and a TUI render succeeded. When the user asked for a broad "analyze
// the full blockchain in real time", a closeout this strong is almost
// always over-calibrated relative to what was implemented.
const STRONG_COMPLETION_PATTERNS: RegExp[] = [
  // Spanish — "completado", "listo para", "funciona perfectamente", "en producción"
  /\b(?:proyecto|aplicaci[oó]n|dashboard|sistema|implementaci[oó]n|soluci[oó]n)\s+(?:completad[oa]|terminad[oa]|finalizad[oa])\b/i,
  /\blist[oa]s?\s+para\s+(?:analizar|usar|producci[oó]n|correr\s+en|funcionar\s+en|operar\s+en)/i,
  /\bfunciona\s+(?:perfectamente|completamente|sin\s+problemas)\b/i,
  /\bcompletamente\s+funcional\b/i,
  /\ben\s+tiempo\s+real\b/i,
  /\ben\s+producci[oó]n\b/i,
  // English
  /\b(?:project|app|application|dashboard|system|implementation|solution)\s+(?:complete|completed|finished|done|ready)\b/i,
  /\bready\s+(?:for\s+(?:production|use|real.?time|deployment)|to\s+(?:analyze|use|deploy|ship))\b/i,
  /\bfully\s+(?:working|functional|implemented|operational)\b/i,
  /\bproduction[-\s]?ready\b/i,
  /\bworks\s+(?:perfectly|flawlessly|end.to.end)\b/i,
];

// Heuristic markers that suggest the user wanted broad/comprehensive
// functionality, not a narrow slice. When these appear alongside
// strong-completion claims, the risk of scope over-claim is high.
export const BROAD_SCOPE_REQUEST_PATTERNS: RegExp[] = [
  /\b(?:todo|toda|todos|todas|completo|completa|completamente|integral|integral(mente)?|full[ly]?|complete(?:ly)?|entire(?:ly)?|comprehensive(?:ly)?|end[-\s]to[-\s]end)\b/i,
  /\btiempo\s+real\b/i,
  /\bmucho\s+m[aá]s\b/i,
  /\banalizar?\s+(?:completamente|totalmente|a\s+fondo|todo)/i,
  /\b(?:everything|all\s+(?:the|of)|full\s+(?:stack|implementation|featured))\b/i,
];

export interface StrongCompletionFinding {
  /** The phrase that matched. */
  snippet: string;
  /** Whether the ORIGINAL user request had broad-scope markers. */
  broadRequest: boolean;
}

/**
 * Detect over-confident completion claims in the final text. Fires
 * when any strong-completion phrase appears. If the session's original
 * user message also contained broad-scope language, the mismatch is
 * more severe and the warning can be escalated.
 *
 * Unlike the creation-claim check, this one does not require zero
 * files — it fires even when files WERE written, because the
 * 2026-04-23 #102 run DID write app.py but the "completado / listo
 * para tiempo real" claim was still disproportionate.
 */
export function detectStrongCompletionClaim(
  finalText: string,
  originalUserPrompt: string,
): StrongCompletionFinding | null {
  if (!finalText || finalText.trim().length === 0) return null;

  for (const pattern of STRONG_COMPLETION_PATTERNS) {
    const match = finalText.match(pattern);
    if (match) {
      const broadRequest = BROAD_SCOPE_REQUEST_PATTERNS.some((p) => p.test(originalUserPrompt));
      return {
        snippet: extractSentenceLikeSnippet(finalText, match.index ?? 0, match[0].length),
        broadRequest,
      };
    }
  }
  return null;
}

/**
 * Extract a snippet centered on a regex match, expanded to the
 * nearest semantic boundaries instead of raw byte offsets. Prevents
 * the "rk de observación..." class of mid-word truncation.
 *
 * Boundaries (in priority order):
 *   - newline
 *   - sentence terminator: . ! ? (followed by whitespace or EOL)
 *   - bullet/list marker at column 0: •, -, *
 *   - colon followed by whitespace (description markers)
 *
 * After boundary expansion, markdown bold/italic/code markers are
 * trimmed from both ends so the snippet doesn't start with "**" or
 * a half-closed backtick.
 */
export function extractSentenceLikeSnippet(
  text: string,
  matchStart: number,
  matchLen: number,
  maxLen = 220,
): string {
  if (matchStart < 0 || matchStart >= text.length) return "";
  const matchEnd = Math.min(text.length, matchStart + matchLen);

  let start = matchStart;
  // Walk backward to nearest sentence boundary or line start.
  for (let i = matchStart - 1; i >= 0 && matchStart - i < maxLen; i--) {
    const ch = text[i];
    if (ch === "\n") {
      start = i + 1;
      break;
    }
    if (i > 0 && (ch === "." || ch === "!" || ch === "?")) {
      const next = text[i + 1];
      if (next === " " || next === "\n" || next === "\t") {
        start = i + 1;
        break;
      }
    }
    if (ch === "•" || (ch === "-" && (i === 0 || text[i - 1] === "\n" || text[i - 1] === " "))) {
      start = i;
      break;
    }
    start = i;
  }

  let end = matchEnd;
  for (let i = matchEnd; i < text.length && i - matchEnd < maxLen; i++) {
    const ch = text[i];
    if (ch === "\n") {
      end = i;
      break;
    }
    if (ch === "." || ch === "!" || ch === "?") {
      const next = text[i + 1];
      if (next === undefined || next === " " || next === "\n" || next === "\t") {
        end = i + 1;
        break;
      }
    }
    end = i + 1;
  }

  // Trim pure whitespace and dangling markdown markers without
  // breaking word boundaries.
  let snippet = text.slice(start, end).trim();
  // Remove leading list marker
  snippet = snippet.replace(/^[-*•]\s+/, "");
  // Strip dangling markdown delimiters at edges (count unmatched).
  snippet = balanceMarkdownDelimiters(snippet);
  // Guarantee word-boundary edges: if we still start/end mid-word
  // (rare — only when the whole text has no boundaries within maxLen),
  // trim inward to the nearest space.
  if (snippet.length > 0 && /\w/.test(snippet[0]!) && start > 0 && /\w/.test(text[start - 1]!)) {
    const firstSpace = snippet.indexOf(" ");
    if (firstSpace !== -1 && firstSpace < snippet.length / 2) {
      snippet = snippet.slice(firstSpace + 1);
    }
  }
  const last = snippet[snippet.length - 1];
  if (
    snippet.length > 0 &&
    last !== undefined &&
    /\w/.test(last) &&
    end < text.length &&
    /\w/.test(text[end] ?? "")
  ) {
    const lastSpace = snippet.lastIndexOf(" ");
    if (lastSpace !== -1 && lastSpace > snippet.length / 2) {
      snippet = snippet.slice(0, lastSpace);
    }
  }
  if (snippet.length > maxLen) snippet = `${snippet.slice(0, maxLen - 1).trimEnd()}…`;
  return snippet;
}

function balanceMarkdownDelimiters(s: string): string {
  let out = s;
  // Strip leading half-opened **, *, `, ~~ if the closer is missing.
  for (const delim of ["**", "`", "*", "~~"]) {
    const occ = out.split(delim).length - 1;
    if (occ === 1) {
      // One occurrence means a dangling half. Remove both edge cases.
      if (out.startsWith(delim)) out = out.slice(delim.length).trimStart();
      else if (out.endsWith(delim)) out = out.slice(0, -delim.length).trimEnd();
    }
  }
  return out;
}

export function formatStrongCompletionWarning(finding: StrongCompletionFinding): string {
  const severity = finding.broadRequest
    ? "The user's request was broad-scope ('completo', 'full', 'tiempo real', etc.), " +
      "but the implementation covers only a narrow subset. "
    : "";
  return (
    `⚠ Grounding check: the response declares completion in strong, broad terms. ` +
    `Matched phrase: "${finding.snippet}". ` +
    severity +
    `Replace "completado / listo para producción / works end-to-end" with scope-honest ` +
    `wording: "initial version", "MVP", "first pass", "covers X but not Y". ` +
    `Only claim end-to-end readiness when you've verified the full path (external ` +
    `dependencies, auth, error cases), not just imports or a render.`
  );
}

// Patterns for operational / network claims that require actual evidence
// from the session, not inference from a successful unauthenticated call.
// See issue #101: agent claimed "Conecta al RPC de tu nodo en
// localhost:8332 (sin auth, como funciona)" without ever running an
// authenticated vs unauthenticated comparison.
const UNVERIFIABLE_AUTH_CLAIM_PATTERNS: RegExp[] = [
  // Spanish
  /\b\(\s*sin\s+(?:auth|autenticaci[oó]n)\b/i,
  /\bsin\s+(?:auth|autenticaci[oó]n)\s*[,.)]/i,
  /\b(?:no requiere|no pide|no usa)\s+(?:auth|autenticaci[oó]n|credenciales|password|contraseña)\b/i,
  /\bsin\s+(?:credenciales|password|contraseña|usuario)\b/i,
  /\bRPC\s+(?:abierto|sin\s+auth|p[uú]blico)\b/i,
  // English
  /\b\(\s*no\s+(?:auth|authentication)\s*(?:required|needed)?\s*[,)]/i,
  /\bwithout\s+(?:auth|authentication|credentials|a\s+password)\b/i,
  /\b(?:no|does not require|doesn'?t need)\s+auth(?:entication)?\b/i,
  /\bRPC\s+(?:is\s+)?(?:open|public|unauthenticated)\b/i,
];

export interface AuthClaimFinding {
  /** The specific phrase in the final text that matched. */
  snippet: string;
  /** The regex rule that fired (for telemetry). */
  rule: string;
}

/**
 * Detect ungrounded auth/network claims in the final response. Unlike
 * the creation-claim check, this one doesn't measure evidence — it
 * always flags these claims because verifying them requires comparing
 * authenticated vs unauthenticated access patterns, which the session
 * almost never does. Safer to always warn and let the user confirm.
 */
export function detectAuthClaim(finalText: string): AuthClaimFinding | null {
  if (!finalText || finalText.trim().length === 0) return null;

  for (const pattern of UNVERIFIABLE_AUTH_CLAIM_PATTERNS) {
    const match = finalText.match(pattern);
    if (match) {
      const start = Math.max(0, (match.index ?? 0) - 30);
      const end = Math.min(finalText.length, (match.index ?? 0) + match[0].length + 60);
      return {
        snippet: finalText.slice(start, end).trim(),
        rule: pattern.source,
      };
    }
  }
  return null;
}

export function formatAuthClaimWarning(finding: AuthClaimFinding): string {
  return (
    `⚠ Grounding check: the response asserts a specific auth/network property that isn't proven by the session. ` +
    `Matched phrase: "${finding.snippet}". ` +
    `Successful local access does not prove "no auth required" — your node could be accepting localhost without creds while still requiring them externally. ` +
    `Verify directly with the customer/environment before acting on this claim.`
  );
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
    const rel = f.file.startsWith(process.cwd()) ? f.file.slice(process.cwd().length + 1) : f.file;
    msg += `  • ${rel}:${f.line} — ${kindLabel[f.kind]}: ${f.snippet}\n`;
  }

  if (rest > 0) {
    msg += `  … and ${rest} more finding(s). Call the work "prototype" or "partial", list what still needs wiring.\n`;
  }

  return msg;
}
