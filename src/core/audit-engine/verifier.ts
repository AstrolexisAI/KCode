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
// Output contract:
//   The model MUST respond with a line starting with CONFIRMED, FALSE_POSITIVE,
//   or NEEDS_CONTEXT, followed by reasoning. This is parsed deterministically.

import { readFileSync } from "node:fs";
import { getPatternById } from "./patterns";
import type { Candidate, Verification, VerifyVerdict } from "./types";

export interface VerifyOptions {
  /** Primary LLM callback (typically local, cheap). */
  llmCallback: (prompt: string) => Promise<string>;
  /**
   * Optional fallback LLM callback (typically cloud, accurate). When set,
   * candidates that the primary model marks as NEEDS_CONTEXT (ambiguous)
   * are re-verified with this callback. Keeps token cost down: only hard
   * cases escalate to the expensive model.
   */
  fallbackCallback?: (prompt: string) => Promise<string>;
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
}

/**
 * Build the verification prompt for a single candidate. The prompt is
 * designed to be compact and structured so even small local models can
 * respond reliably.
 */
function buildVerifyPrompt(candidate: Candidate): string {
  const pattern = getPatternById(candidate.pattern_id);
  if (!pattern) {
    throw new Error(`Unknown pattern id: ${candidate.pattern_id}`);
  }

  // Read extended context from the file (~30 lines around the match)
  let extendedContext = candidate.context;
  try {
    const content = readFileSync(candidate.file, "utf-8");
    const lines = content.split("\n");
    const start = Math.max(0, candidate.line - 15);
    const end = Math.min(lines.length, candidate.line + 15);
    extendedContext = lines
      .slice(start, end)
      .map((l, i) => `${start + i + 1}: ${l}`)
      .join("\n");
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

Respond in EXACTLY this format (parsed deterministically):
VERDICT: <CONFIRMED | FALSE_POSITIVE | NEEDS_CONTEXT>
REASONING: <one sentence explaining WHY in your own words>
EXECUTION_PATH: <the exact sequence of calls/events that triggers this, or NONE>
FIX: <a minimal code change that would resolve this, or NONE>

Be strict. If you cannot prove the bug triggers, use FALSE_POSITIVE or NEEDS_CONTEXT.
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

  const r = (v.reasoning + " " + (v.execution_path ?? "")).toLowerCase();
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

/**
 * Parse the model's response into a structured Verification.
 */
function parseVerdict(response: string): Verification {
  const lines = response.split("\n");
  let verdict: VerifyVerdict = "needs_context";
  let reasoning = "";
  let execution_path: string | undefined;
  let suggested_fix: string | undefined;

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.startsWith("verdict:")) {
      const val = line.slice("verdict:".length).trim().toLowerCase();
      if (val.includes("confirmed")) verdict = "confirmed";
      else if (val.includes("false_positive") || val.includes("false positive"))
        verdict = "false_positive";
      else verdict = "needs_context";
    } else if (lower.startsWith("reasoning:")) {
      reasoning = line.slice("reasoning:".length).trim();
    } else if (lower.startsWith("execution_path:")) {
      const val = line.slice("execution_path:".length).trim();
      if (val && val.toLowerCase() !== "none") execution_path = val;
    } else if (lower.startsWith("fix:")) {
      const val = line.slice("fix:".length).trim();
      if (val && val.toLowerCase() !== "none") suggested_fix = val;
    }
  }

  // Fallback: if reasoning is empty, use first sentence of response
  if (!reasoning) {
    const firstLine = response.trim().split("\n")[0] ?? "";
    reasoning = firstLine.slice(0, 200);
  }

  return { verdict, reasoning, execution_path, suggested_fix };
}

/**
 * Verify a single candidate by calling the primary LLM only.
 * Does NOT auto-escalate to fallback — that's handled by the orchestrator
 * after user confirmation.
 */
export async function verifyCandidate(
  candidate: Candidate,
  opts: VerifyOptions,
): Promise<Verification> {
  const prompt = buildVerifyPrompt(candidate);
  const primary = await opts.llmCallback(prompt);
  const verdict = parseVerdict(primary);
  // Sanity check: catch model confirming something its own reasoning says is safe
  return sanityCheckVerdict(verdict);
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
  const verdict = parseVerdict(response);
  verdict.reasoning = `[☁ escalated] ${verdict.reasoning}`;
  return verdict;
}

/**
 * Verify a batch of candidates, returning the confirmed ones as full findings.
 */
export async function verifyAllCandidates(
  candidates: Candidate[],
  opts: VerifyOptions,
): Promise<Array<{ candidate: Candidate; verification: Verification }>> {
  const results: Array<{ candidate: Candidate; verification: Verification }> = [];
  // Track consecutive transport-level failures. If the first 3
  // candidates ALL fail with a network/connect-style error, the
  // verifier endpoint is unreachable — abort the whole pass instead
  // of silently classifying every candidate as needs_context with a
  // misleading "verifier couldn't decide" label. Issue #111 v2.10.310:
  // 33/33 candidates buried behind "Unable to connect" was invisible
  // to the user. Now we throw early so the CLI can surface the
  // configuration error.
  let consecutiveTransportFailures = 0;
  const TRANSPORT_FAIL_LIMIT = 3;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    opts.onProgress?.(i, candidates.length, c);
    let verification: Verification;
    try {
      verification = await verifyCandidate(c, opts);
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
        ) ||
        /\bLLM 40[14]\b|\bLLM 5\d\d\b|\bAnthropic 40[14]\b|\bAnthropic 5\d\d\b/.test(msg);
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
export { buildVerifyPrompt, parseVerdict };
