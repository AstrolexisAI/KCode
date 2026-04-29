// KCode - Candidate Verifier
//
// Phase 2 of the audit pipeline: verification. For each candidate identified
// by the pattern library, ask the model (local or cloud) to verify whether
// the pattern ACTUALLY triggers in the real code path.
//
// This is where the model's strength is used: reading context and reasoning
// about execution. But the scope is narrow — for each candidate the model
// answers ONE question, not "find all bugs in this project".
//
// Output contract (v2.10.361, F3 of audit product plan):
//   The model returns a single JSON object matching VerifierEvidence +
//   verdict + reasoning. Markdown fences, leading prose, and JSON-with-prose
//   are all tolerated by the parser. On unrecoverable parse failure (after
//   one retry) the verdict degrades to needs_context with a synthesized
//   minimal evidence pack so accounting stays honest.

import { readFileSync } from "node:fs";
import { getPatternById } from "./patterns";
import type {
  Candidate,
  FixStrategy,
  Verification,
  VerifierEvidence,
  VerifyVerdict,
} from "./types";

export interface VerifyOptions {
  /** Primary LLM callback (typically cheap + fast — e.g. grok-fast). */
  llmCallback: (prompt: string) => Promise<string>;
  /**
   * Optional fallback LLM callback. The semantics depend on `cascadeMode`:
   *
   *   - "on-confirmed" (default when fallbackCallback is set, v2.10.406+):
   *     after the PRIMARY model confirms a candidate, the FALLBACK is
   *     also invoked. Final verdict = `confirmed` only if BOTH agree;
   *     otherwise the candidate is downgraded to `false_positive` with
   *     a reasoning trail that names the disagreement. This is the
   *     "ensemble cascade" — primary cheap-prefilters, fallback
   *     premium-confirms. Empirically (Grok-fast + Opus on OWASP sqli):
   *     F1 0.842 vs 0.800 single-model, ~$17 vs ~$40 per OWASP-scale
   *     audit.
   *
   *   - "on-needs-context" (legacy mode): when the primary marks a
   *     candidate as `needs_context` (ambiguous), it is re-verified
   *     with the fallback. Useful when the primary is a local model
   *     that flags hard cases for a cloud second opinion.
   */
  fallbackCallback?: (prompt: string) => Promise<string>;
  /**
   * How `fallbackCallback` is invoked. Defaults to "on-confirmed"
   * when fallbackCallback is provided. v2.10.406.
   */
  cascadeMode?: "on-confirmed" | "on-needs-context";
  /** Max lines of file content to include as context (default 200). */
  contextLines?: number;
  /** Called BEFORE each verification starts (for "verifying X..." messages). */
  onProgress?: (index: number, total: number, candidate: Candidate) => void;
  /** Called AFTER each verification completes (for live progress bar updates). */
  onVerified?: (
    candidate: Candidate,
    verification: Verification,
    index: number,
    total: number,
  ) => void;
  /**
   * Optional cancellation signal. Checked at the top of each iteration
   * of the verification loop. When aborted, the loop throws
   * ScanCancelledError so the caller can short-circuit reporting and
   * surface a "cancelled by user" message. v2.10.385.
   */
  signal?: AbortSignal;
}

/**
 * Build the verification prompt for a single candidate. Asks for a
 * single JSON object with verdict + structured Evidence Pack. The
 * checklist body matches the v1 prose prompt — the only thing
 * changing is the output shape.
 */
function buildVerifyPrompt(candidate: Candidate): string {
  const pattern = getPatternById(candidate.pattern_id);
  if (!pattern) {
    throw new Error(`Unknown pattern id: ${candidate.pattern_id}`);
  }

  // Read extended context from the file.
  //
  // Strategy:
  //   - Short file (≤200 lines): send the whole file. A well-sized
  //     source file always fits in a verify prompt and lets the model
  //     see mitigations in OTHER methods of the same class — which
  //     is exactly what was missed in v312: the FW_ASSERT that made
  //     a loop bound safe lived in configure() while the match hit
  //     TextLogger_handler() 15 lines later.
  //   - Longer file: ±30 lines around the match (was ±15 before v313).
  let extendedContext = candidate.context;
  try {
    const content = readFileSync(candidate.file, "utf-8");
    const lines = content.split("\n");
    if (lines.length <= 200) {
      extendedContext = lines.map((l, i) => `${i + 1}: ${l}`).join("\n");
    } else {
      const start = Math.max(0, candidate.line - 30);
      const end = Math.min(lines.length, candidate.line + 30);
      extendedContext = lines
        .slice(start, end)
        .map((l, i) => `${start + i + 1}: ${l}`)
        .join("\n");
    }
  } catch {
    /* fall back to small context */
  }

  return `You are verifying a static-analysis finding. Read carefully and answer.

PATTERN: ${pattern.title}
FILE: ${candidate.file}:${candidate.line}
SEVERITY IF CONFIRMED: ${pattern.severity}

EXPLANATION: ${pattern.explanation}

CODE CONTEXT:
\`\`\`
${extendedContext}
\`\`\`

QUESTION: ${pattern.verify_prompt}

BEFORE CONFIRMING, work through this checklist. You MUST rule out every
mitigation below. If you cannot, the verdict is "false_positive" or "needs_context".

  1. Is there an assert, bound check, or validation in the surrounding
     function (or a setter/configure method in the same class) that
     already constrains the suspect value? Add the exact line number
     of each check you find to "mitigations_found".
  2. Is the input to this code path user-controlled AT RUNTIME, or is
     it from trusted compile-time / build-time / static configuration?
     Build-time scripts (CMake, scripts/, autocoder/, tools/) are NOT
     in most security threat models — mark those false_positive unless
     the concern is clearly runtime-relevant.
  3. What is the EXACT chain of calls from an external input boundary
     (network, IPC, file, CLI) to this line? Capture each call as a
     separate string in "execution_path_steps". If you cannot trace a
     concrete path, return verdict: "needs_context".
     IMPORTANT for component-based / flight-software code:
       * A port-input handler receiving data from a sibling component
         in the SAME flight binary is NOT external untrusted input.
         Inter-component IPC inside a single trusted process is part
         of the framework's trusted boundary. Mark false_positive.
       * Only ground-command handlers (*_cmdHandler), network deframers,
         file deserializers, and IPC from outside the binary qualify
         as untrusted external input.
       * Test-only code (paths containing "Test", "test", "Tests",
         "TestProject", "TestHarness") is NOT in the runtime threat
         model. Mark false_positive.
  4. Does the language / type system already rule out the concern
     (e.g. bounded integer types, C++ references that cannot be null,
     std::array with compile-time size, fixed-size struct member
     arrays whose loop bound is the array's own length)?

Only return verdict: "confirmed" when you can name:
  - input_boundary: the specific external input source
  - execution_path_steps: a clear trigger path that bypasses every
    mitigation in step 1 (each call as its own array entry)
  - sink: the dangerous operation the input flows into
  - reasoning: one sentence with the concrete bad outcome
    (crash / read / write / infinite loop / …)

Be strict. Prefer "false_positive" over "confirmed" when any mitigation
is present.

Respond with EXACTLY ONE JSON object — no markdown fences, no prose
before or after. The object must match this shape:

{
  "verdict": "confirmed" | "false_positive" | "needs_context",
  "reasoning": "one sentence: input source + bypass + outcome, OR the mitigation that rules this out",
  "evidence": {
    "input_boundary": "string or empty if false_positive",
    "execution_path_steps": ["call1", "call2", "..."],
    "sink": "the dangerous operation (REQUIRED, even on false_positive)",
    "sanitizers_checked": ["check1", "check2"],
    "mitigations_found": ["mitigation1 at line N"],
    "suggested_fix_strategy": "rewrite" | "annotate" | "manual",
    "suggested_fix": "minimal code change, or empty",
    "test_suggestion": "regression test recipe, or empty"
  }
}
`;
}

/**
 * Post-verification sanity check: if the model says CONFIRMED but its
 * own reasoning contains phrases that indicate it's actually safe,
 * downgrade to FALSE_POSITIVE. This catches the "confirms everything"
 * failure mode of weaker models.
 */
function sanityCheckVerdict(v: Verification): Verification {
  if (v.verdict !== "confirmed") return v;

  const exec = v.evidence?.execution_path_steps?.join(" ") ?? v.execution_path ?? "";
  const r = (v.reasoning + " " + exec).toLowerCase();
  const safeIndicators = [
    "allocation accounts for",
    "allocates.*strlen",
    "malloc.*strlen.*\\+.*1",
    "sizeof.*>=",
    "guaranteed to be.*bytes",
    "fixed.size.*buffer",
    "compile.time constant",
    "mathematically safe",
    "within bounds",
    "well within",
    "is sufficient",
    "does account for",
    "properly bounded",
    "correctly allocat",
    "safe because",
    "is safe",
  ];

  for (const pattern of safeIndicators) {
    if (new RegExp(pattern, "i").test(r)) {
      return {
        ...v,
        verdict: "false_positive",
        reasoning: `[auto-downgraded: model said CONFIRMED but reasoning indicates safe] ${v.reasoning}`,
      };
    }
  }

  return v;
}

const VALID_VERDICTS: ReadonlyArray<VerifyVerdict> = [
  "confirmed",
  "false_positive",
  "needs_context",
];

const VALID_FIX_STRATEGIES: ReadonlyArray<FixStrategy> = ["rewrite", "annotate", "manual"];

function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((s) => typeof s === "string");
}

/**
 * Coerce a parsed JSON object into a Verification. Returns null if
 * the object is missing required fields (verdict, reasoning) — caller
 * decides whether to retry or degrade.
 *
 * Be permissive about optional fields: missing arrays become [],
 * missing strings become undefined, unknown verdicts become null.
 */
function coerceVerification(parsed: unknown): Verification | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;

  // v2.10.367 — exact-match only. Earlier code accepted substring
  // inclusion ("needs_confirmation".includes("confirmed") → confirmed)
  // which silently misclassified verdicts when the model used a
  // qualifier word. Strict equality forces the model to pick one of
  // the three valid verdicts; degraded output goes through the
  // retry-then-degrade path instead.
  const rawVerdict = String(obj.verdict ?? "")
    .toLowerCase()
    .trim();
  const verdict = VALID_VERDICTS.find((v) => rawVerdict === v);
  if (!verdict) return null;

  const reasoning = typeof obj.reasoning === "string" ? obj.reasoning.trim() : "";
  if (!reasoning) return null;

  const evidenceRaw =
    obj.evidence && typeof obj.evidence === "object"
      ? (obj.evidence as Record<string, unknown>)
      : null;

  let evidence: VerifierEvidence | undefined;
  if (evidenceRaw) {
    const sink = typeof evidenceRaw.sink === "string" ? evidenceRaw.sink.trim() : "";
    // sink is the only required field on evidence — without it we
    // can't distinguish what made this confirmed/needs_context vs
    // false_positive at any structural level. Drop the evidence
    // block entirely if absent.
    if (sink) {
      const fixStrategyRaw =
        typeof evidenceRaw.suggested_fix_strategy === "string"
          ? evidenceRaw.suggested_fix_strategy.toLowerCase().trim()
          : "";
      const fixStrategy = VALID_FIX_STRATEGIES.find((s) => fixStrategyRaw === s);

      evidence = {
        sink,
        input_boundary:
          typeof evidenceRaw.input_boundary === "string"
            ? evidenceRaw.input_boundary.trim() || undefined
            : undefined,
        execution_path_steps: isStringArray(evidenceRaw.execution_path_steps)
          ? evidenceRaw.execution_path_steps
          : undefined,
        sanitizers_checked: isStringArray(evidenceRaw.sanitizers_checked)
          ? evidenceRaw.sanitizers_checked
          : undefined,
        mitigations_found: isStringArray(evidenceRaw.mitigations_found)
          ? evidenceRaw.mitigations_found
          : undefined,
        suggested_fix_strategy: fixStrategy,
        suggested_fix:
          typeof evidenceRaw.suggested_fix === "string"
            ? evidenceRaw.suggested_fix.trim() || undefined
            : undefined,
        test_suggestion:
          typeof evidenceRaw.test_suggestion === "string"
            ? evidenceRaw.test_suggestion.trim() || undefined
            : undefined,
      };
    }
  }

  // Mirror the new structured fields onto the legacy ones so callers
  // that haven't migrated yet still see something sensible.
  const execPath = evidence?.execution_path_steps?.join(" → ");
  const fix = evidence?.suggested_fix;

  return {
    verdict,
    reasoning,
    execution_path: execPath,
    suggested_fix: fix,
    evidence,
  };
}

/**
 * Extract the first JSON object from `response`. Tolerates markdown
 * fences, leading/trailing prose, and trailing commas (the last by
 * stripping them before parse). Returns the parsed object or null.
 */
function extractAndParseJson(response: string): unknown {
  let text = response.trim();
  // Strip ```json ... ``` or ``` ... ``` fences.
  const fenceMatch = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fenceMatch?.[1]) {
    text = fenceMatch[1].trim();
  }

  // Find the first balanced {...} block. Models sometimes prefix
  // "Sure, here's the verdict:" before the object even when told
  // not to. Walk forward from the first '{' and count braces.
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let isEscaped = false;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (isEscaped) {
      isEscaped = false;
      continue;
    }
    if (ch === "\\") {
      isEscaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;

  const candidate = text
    .slice(start, end + 1)
    // Trailing comma before } or ] — common LLM failure mode.
    .replace(/,(\s*[}\]])/g, "$1");

  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

/**
 * Parse the model's response into a structured Verification. Returns
 * null on unrecoverable parse failure so callers can decide whether
 * to retry or degrade.
 */
function parseVerdict(response: string): Verification | null {
  const parsed = extractAndParseJson(response);
  if (parsed === null) return null;
  return coerceVerification(parsed);
}

/**
 * Synthesize a minimal needs_context verdict for cases where the
 * model produced unparseable garbage even after one retry. Keeps the
 * arithmetic honest (every candidate accounted for) without making
 * up evidence the model didn't supply.
 */
function degradedVerdict(reason: string): Verification {
  return {
    verdict: "needs_context",
    reasoning: `[verifier output unparseable] ${reason}`,
  };
}

/**
 * Run the prompt + parse + retry + degrade pipeline against a single
 * callback. Factored out of `verifyCandidate` so the cascade-on-confirmed
 * flow (v2.10.406) can reuse it for the fallback model.
 */
async function runWithCallback(
  candidate: Candidate,
  callback: (prompt: string) => Promise<string>,
): Promise<Verification> {
  const prompt = buildVerifyPrompt(candidate);
  const primary = await callback(prompt);
  const firstParse = parseVerdict(primary);
  if (firstParse) return sanityCheckVerdict(firstParse);

  // Retry once with an explicit "your output was malformed" hint.
  // Some 7B-tier models stabilize on the second pass when shown what
  // they did wrong. Cheaper than degrading-and-escalating.
  const retryPrompt = `${prompt}

Your previous response was not valid JSON or was missing required fields.
Respond with EXACTLY ONE JSON object matching the schema above. No prose,
no markdown fences, no extra text. The "verdict" and "reasoning" fields
are mandatory.`;
  const retry = await callback(retryPrompt);
  const retryParse = parseVerdict(retry);
  if (retryParse) return sanityCheckVerdict(retryParse);

  return degradedVerdict("model returned non-JSON twice");
}

/**
 * Verify a single candidate by calling the primary LLM only. Does ONE
 * retry on parse failure with a "your previous response was not
 * valid JSON" suffix, then degrades to needs_context. Does NOT
 * auto-escalate to fallback — that's handled by the orchestrator
 * after user confirmation, or by `verifyAllCandidates` when
 * `cascadeMode` is set.
 */
export async function verifyCandidate(
  candidate: Candidate,
  opts: VerifyOptions,
): Promise<Verification> {
  return runWithCallback(candidate, opts.llmCallback);
}

/**
 * Combine a primary verdict and a fallback verdict under cascade-on-confirmed
 * semantics. Called only when primary returned `confirmed` and a fallback
 * callback is configured. Returns:
 *
 *   - `confirmed` (with [ensemble ✓] prefix on reasoning) when both agree
 *   - `false_positive` (with [ensemble ✗] prefix) when fallback disagreed
 *
 * The downgrade-to-FP on disagreement is the conservative choice: the
 * page recommends this configuration as the high-precision default,
 * and a single confirmation from the cheaper model is not enough on
 * its own to justify the alert.
 */
function combineVerdicts(primary: Verification, fallback: Verification): Verification {
  if (fallback.verdict === "confirmed") {
    return {
      ...primary,
      reasoning: `[ensemble ✓ both confirmed] ${primary.reasoning}`,
    };
  }
  const trim = (s: string) => (s.length > 200 ? `${s.slice(0, 200)}…` : s);
  return {
    verdict: "false_positive",
    reasoning: `[ensemble ✗ fallback ${fallback.verdict}] primary said: ${trim(primary.reasoning)} | fallback said: ${trim(fallback.reasoning)}`,
    evidence: primary.evidence,
  };
}

/**
 * Escalate a single candidate to the fallback LLM (cloud).
 * Called only after user approves escalation.
 */
export async function escalateCandidate(
  candidate: Candidate,
  fallbackCallback: (prompt: string) => Promise<string>,
): Promise<Verification> {
  const prompt = buildVerifyPrompt(candidate);
  const response = await fallbackCallback(prompt);
  const parsed = parseVerdict(response);
  if (!parsed) {
    return degradedVerdict("escalation model returned non-JSON");
  }
  parsed.reasoning = `[☁ escalated] ${parsed.reasoning}`;
  return parsed;
}

/**
 * Verify a batch of candidates, returning the confirmed ones as full findings.
 */
export async function verifyAllCandidates(
  candidates: Candidate[],
  opts: VerifyOptions,
): Promise<Array<{ candidate: Candidate; verification: Verification }>> {
  const results: Array<{ candidate: Candidate; verification: Verification }> = [];
  // Default cascade mode is "on-confirmed" when a fallbackCallback is
  // present — that's the high-precision ensemble configuration the
  // benchmark page recommends as default. Callers can override
  // explicitly to "on-needs-context" for the legacy escalate-on-
  // ambiguous behaviour.
  const cascadeMode: "on-confirmed" | "on-needs-context" =
    opts.cascadeMode ?? (opts.fallbackCallback ? "on-confirmed" : "on-needs-context");
  // Track consecutive transport-level failures. If the first 3
  // candidates ALL fail with a network/connect-style error, the
  // verifier endpoint is unreachable — abort the whole pass instead
  // of silently classifying every candidate as needs_context with a
  // misleading "verifier couldn't decide" label. Issue #111 v2.10.310:
  // 33/33 candidates buried behind "Unable to connect" was invisible
  // to the user. Now we throw early so the CLI can surface the
  // configuration error.
  let consecutiveTransportFailures = 0;
  // Default 3 keeps fast-fail for misconfigured endpoints (the original
  // intent — see issue #111). For long benchmark runs that must survive
  // transient 503s from a busy provider, set KCODE_VERIFIER_FAIL_LIMIT
  // to a higher value (e.g. 10). v2.10.406.
  const TRANSPORT_FAIL_LIMIT = (() => {
    const raw = process.env.KCODE_VERIFIER_FAIL_LIMIT;
    if (raw) {
      const n = parseInt(raw, 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return 3;
  })();
  for (let i = 0; i < candidates.length; i++) {
    if (opts.signal?.aborted) {
      const { ScanCancelledError } = await import("./scan-state");
      throw new ScanCancelledError(`Scan cancelled at candidate ${i}/${candidates.length}`);
    }
    const c = candidates[i]!;
    opts.onProgress?.(i, candidates.length, c);
    let verification: Verification;
    try {
      verification = await verifyCandidate(c, opts);
      // v2.10.406 — cascade. After the primary returns its verdict,
      // optionally invoke the fallback. The two supported modes
      // intersect with the verdict differently:
      //   on-confirmed: only run fallback when primary CONFIRMS
      //                 (high-precision ensemble; default when
      //                  fallbackCallback is set)
      //   on-needs-context: only run fallback when primary returns
      //                 NEEDS_CONTEXT (legacy escalate-on-ambiguous)
      if (opts.fallbackCallback) {
        if (cascadeMode === "on-confirmed" && verification.verdict === "confirmed") {
          const fallback = await runWithCallback(c, opts.fallbackCallback);
          verification = combineVerdicts(verification, fallback);
        } else if (
          cascadeMode === "on-needs-context" &&
          verification.verdict === "needs_context"
        ) {
          const fallback = await runWithCallback(c, opts.fallbackCallback);
          verification = {
            ...fallback,
            reasoning: `[☁ escalated] ${fallback.reasoning}`,
          };
        }
      }
      consecutiveTransportFailures = 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Transport-level: connection refused / DNS / timeout.
      // Configuration-level: 401 (bad key), 404 (bad URL), 429 retry-exhausted.
      // Both indicate the audit cannot proceed — abort early instead
      // of bucketing every candidate as needs_context with the same
      // error string. v311/v312.
      const isTransport =
        /Unable to connect|ECONNREFUSED|ENOTFOUND|fetch failed|timeout|EAI_AGAIN|connection refused|getaddrinfo/i.test(
          msg,
        ) || /\bLLM 40[14]\b|\bLLM 5\d\d\b|\bAnthropic 40[14]\b|\bAnthropic 5\d\d\b/.test(msg);
      if (isTransport) {
        consecutiveTransportFailures++;
        if (consecutiveTransportFailures >= TRANSPORT_FAIL_LIMIT && i + 1 >= TRANSPORT_FAIL_LIMIT) {
          throw new Error(
            `Audit verifier unreachable after ${TRANSPORT_FAIL_LIMIT} attempts: ${msg}. ` +
              `Check that the model endpoint is running and the apiBase in ~/.kcode/models.json is correct.`,
          );
        }
      }
      verification = {
        verdict: "needs_context",
        reasoning: `Verification failed: ${msg}`,
      };
    }
    results.push({ candidate: c, verification });
    // Fire post-verification callback for live progress bars
    opts.onVerified?.(c, verification, i, candidates.length);
    // Yield to event loop so Ink/React can re-render the progress bar.
    // Without this, the UI update batches all setCompleted calls and
    // only renders after the entire loop finishes.
    await new Promise((r) => setTimeout(r, 10));
  }
  return results;
}

// Exported for tests
export { buildVerifyPrompt, coerceVerification, extractAndParseJson, parseVerdict };
