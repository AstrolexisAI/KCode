// KCode — Self-critique grounding pass.
//
// Called after every completed turn, before the turn_end event is
// emitted. Takes the assistant's draft final text + the tool results
// recorded this turn, asks a second model whether any claims in the
// draft are unsupported or contradicted by the evidence, and emits a
// banner for each contradiction found.
//
// Why this exists:
//   Pattern-based grounding gates (secret-redactor, stub-scanner,
//   creation-claim, auth-claim, etc.) catch known phrasings. Users
//   writing natural prompts produce novel phrasings every time. To
//   generalize beyond enumerable patterns, we let a separate model
//   do the contradiction check semantically. Issues #100-#103 were
//   each fixed by adding a new regex; this pass is meant to reduce
//   that whack-a-mole cycle to near zero by catching the entire
//   class of unsupported claims in one call.
//
// Failure modes are designed to be silent:
//   - Timeout → skip the pass, turn closes normally
//   - JSON parse failure → skip, log at debug
//   - Critique model unreachable → skip
//   - Critique says "ok" → no banner, no noise
//
// Opt-out: KCODE_DISABLE_SELF_CRITIQUE=1.

import { type ForkedAgentResult, runForkedAgent } from "./forked-agent";
import { log } from "./logger";
import type { Message } from "./types";

// ─── Types ──────────────────────────────────────────────────────

export interface SelfCritiqueInput {
  /** The assistant's draft final text for this turn. */
  draftText: string;
  /** Recent messages from the current turn (for context). */
  recentMessages: Message[];
  /** Total tool-call errors recorded this turn. */
  errorsEncountered: number;
  /** Absolute file paths the agent Wrote/Edited this turn. */
  filesWritten: string[];
  /** Whether any Edit / Write / Bash-mutation was blocked this turn. */
  repairBlocked: boolean;
  /** Original user prompt of the turn (for scope calibration). */
  userPrompt?: string;
  /** Override the critique model (default: tertiary/cheap model). */
  model?: string;
  /** Override API base and key (for tests / alternate providers). */
  apiBase?: string;
  apiKey?: string;
}

export interface Contradiction {
  /** Exact phrase from the draft that is contradicted. */
  claim: string;
  /** Which tool output or evidence contradicts it. */
  evidence: string;
  /** Severity — "high" blocks strong claims, "low" is scope/wording. */
  severity: "high" | "medium" | "low";
}

export interface SelfCritiqueResult {
  contradictions: Contradiction[];
  /** "ok" = draft is fine, "downgrade" = one or more high/medium severity. */
  verdict: "ok" | "downgrade";
  /** True when the call failed silently (timeout / parse / network). */
  skipped: boolean;
  /** Reason the call was skipped, if applicable. */
  skipReason?: string;
  /** The model that ran the critique (if not skipped). */
  modelUsed?: string;
  /** Duration of the critique call in ms. */
  durationMs?: number;
}

// ─── Prompt ─────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a grounding auditor for a coding agent.

The coding agent has just finished a turn. You will receive:
  1. The agent's DRAFT final text (what it's about to tell the user).
  2. The TOOL RESULTS the agent produced during the turn.
  3. Session signals: files written, tool errors, whether any repair
     was blocked by safety policy.

Your only job: identify CLAIMS in the draft that are CONTRADICTED or
UNSUPPORTED by the tool results.

Respond with STRICT JSON — no prose, no markdown fences. Schema:
{
  "contradictions": [
    {
      "claim": "<exact quoted phrase from the draft, <= 120 chars>",
      "evidence": "<what the tool result actually showed, <= 150 chars>",
      "severity": "high" | "medium" | "low"
    }
  ],
  "verdict": "ok" | "downgrade"
}

Severity rubric:
  high    — claims an artifact runs / works / is ready when a
            tool call showed failure (ModuleNotFoundError, non-zero
            exit, blocked repair, etc.), OR states a feature was
            implemented when generated code doesn't contain it.
  medium  — claims a feature is available when only a partial
            scaffold exists (imports succeed but no verification),
            OR references a library that isn't in the code.
  low     — scope overclaim ("production-ready", "completado") on
            work that is demonstrably a first-pass MVP.

Rules:
  - Flag ONLY contradictions, not stylistic choices.
  - Be literal: if the draft says "X is ready" and there's no
    evidence of a successful run, that's a contradiction.
  - Do NOT flag truthful claims like "I created file X" when
    file X is in filesWritten.
  - Do NOT flag general caveats ("try it yourself to confirm").
  - Verdict is "downgrade" if ANY high/medium contradiction exists.
  - If you find none, output {"contradictions": [], "verdict": "ok"}.

Output JSON ONLY, nothing else.`;

// ─── Context builders ───────────────────────────────────────────

/** Summarize the tool-call history of a turn into a compact string. */
function summarizeToolHistory(messages: Message[], maxPairs = 10): string {
  const pairs: string[] = [];
  let pairCount = 0;

  for (let i = messages.length - 1; i >= 0 && pairCount < maxPairs; i--) {
    const m = messages[i];
    if (!m) continue;

    // tool_result block (inside a user message)
    if (m.role === "user" && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (
          typeof b === "object" &&
          b !== null &&
          (b as { type?: unknown }).type === "tool_result"
        ) {
          const raw = (b as { content?: unknown }).content;
          const isError = (b as { is_error?: unknown }).is_error === true;
          const text =
            typeof raw === "string"
              ? raw
              : Array.isArray(raw)
                ? raw
                    .filter(
                      (c: unknown): c is { type: string; text: string } =>
                        typeof c === "object" &&
                        c !== null &&
                        (c as { type?: unknown }).type === "text",
                    )
                    .map((c) => c.text)
                    .join(" ")
                : "";
          const truncated = text.length > 400 ? text.slice(0, 400) + "…" : text;
          pairs.push(`[result${isError ? ",ERROR" : ""}] ${truncated}`);
          pairCount++;
          if (pairCount >= maxPairs) break;
        }
      }
    }

    // tool_use block (inside an assistant message)
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (typeof b === "object" && b !== null && (b as { type?: unknown }).type === "tool_use") {
          const name = (b as { name?: unknown }).name ?? "?";
          const inp = (b as { input?: unknown }).input;
          const inpSummary =
            typeof inp === "object" && inp !== null
              ? JSON.stringify(inp).slice(0, 200)
              : String(inp ?? "").slice(0, 200);
          pairs.push(`[${name}] ${inpSummary}`);
        }
      }
    }
  }

  // Reverse so oldest tool event is first
  return pairs.reverse().join("\n");
}

function buildCritiquePrompt(input: SelfCritiqueInput): string {
  const toolHistory = summarizeToolHistory(input.recentMessages);
  const filesList =
    input.filesWritten.length > 0 ? input.filesWritten.slice(0, 10).join("\n  - ") : "(none)";

  return [
    `## Draft final text from the assistant`,
    "```",
    input.draftText.slice(0, 3000),
    "```",
    "",
    `## Original user request`,
    input.userPrompt ? input.userPrompt.slice(0, 500) : "(not provided)",
    "",
    `## Tool history (most recent last)`,
    toolHistory || "(no tool calls recorded)",
    "",
    `## Session signals`,
    `- Tool errors this turn: ${input.errorsEncountered}`,
    `- Repair/edit blocked: ${input.repairBlocked}`,
    `- Files written or edited:`,
    `  - ${filesList}`,
    "",
    "Now output the grounding audit JSON per the system prompt schema.",
  ].join("\n");
}

// ─── JSON parser (robust) ───────────────────────────────────────

/**
 * Extract the first balanced {...} JSON object from a string. Tolerates
 * leading/trailing prose or markdown code fences, which small models
 * sometimes emit despite instructions.
 */
function extractJson(raw: string): string | null {
  const trimmed = raw.trim();

  // Strip markdown code fence if present
  const fenced = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  const candidate = fenced ? fenced[1]! : trimmed;

  // Find the first { and balance braces
  const start = candidate.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let isEscaped = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
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
      if (depth === 0) return candidate.slice(start, i + 1);
    }
  }
  return null;
}

export function parseCritiqueResponse(raw: string): {
  contradictions: Contradiction[];
  verdict: "ok" | "downgrade";
} | null {
  const json = extractJson(raw);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;

    const verdictRaw = obj.verdict;
    const verdict: "ok" | "downgrade" = verdictRaw === "downgrade" ? "downgrade" : "ok";

    const rawList = obj.contradictions;
    const contradictions: Contradiction[] = [];
    if (Array.isArray(rawList)) {
      for (const item of rawList) {
        if (typeof item !== "object" || item === null) continue;
        const x = item as Record<string, unknown>;
        const claim = typeof x.claim === "string" ? x.claim : "";
        const evidence = typeof x.evidence === "string" ? x.evidence : "";
        const sevRaw = x.severity;
        const severity: Contradiction["severity"] =
          sevRaw === "high" || sevRaw === "medium" || sevRaw === "low" ? sevRaw : "medium";
        if (claim && evidence) {
          contradictions.push({ claim, evidence, severity });
        }
      }
    }

    return { contradictions, verdict };
  } catch (err) {
    log.debug("self-critique", `JSON parse failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

// ─── Main entry ─────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_TOKENS = 800;

/**
 * Run the self-critique pass. Returns the parsed result, or a
 * {skipped: true} result on any failure path. Never throws.
 */
export async function runSelfCritique(input: SelfCritiqueInput): Promise<SelfCritiqueResult> {
  if (process.env.KCODE_DISABLE_SELF_CRITIQUE === "1") {
    log.info("self-critique", "skipped: disabled via KCODE_DISABLE_SELF_CRITIQUE");
    return {
      contradictions: [],
      verdict: "ok",
      skipped: true,
      skipReason: "disabled via env",
    };
  }

  // Skip if nothing substantial to critique
  if (!input.draftText || input.draftText.trim().length < 40) {
    log.info("self-critique", `skipped: draft too short (${input.draftText?.length ?? 0} chars)`);
    return {
      contradictions: [],
      verdict: "ok",
      skipped: true,
      skipReason: "draft too short to critique",
    };
  }

  log.info(
    "self-critique",
    `running: draft=${input.draftText.length}ch errors=${input.errorsEncountered} blocked=${input.repairBlocked} files=${input.filesWritten.length} model=${input.model ?? "(default)"}`,
  );

  const userPrompt = buildCritiquePrompt(input);

  return new Promise<SelfCritiqueResult>((resolve) => {
    let resolved = false;
    const safeResolve = (r: SelfCritiqueResult) => {
      if (resolved) return;
      resolved = true;
      resolve(r);
    };

    runForkedAgent({
      name: "self-critique",
      systemPrompt: SYSTEM_PROMPT,
      contextMessages: [],
      userPrompt,
      model: input.model,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxTokens: DEFAULT_MAX_TOKENS,
      apiBase: input.apiBase,
      apiKey: input.apiKey,
      onComplete: async (result: ForkedAgentResult) => {
        const parsed = parseCritiqueResponse(result.content);
        if (!parsed) {
          log.warn(
            "self-critique",
            `parse FAILED (${result.content.length}ch, model=${result.model}, dur=${result.durationMs}ms). First 200ch: ${result.content.slice(0, 200)}`,
          );
          safeResolve({
            contradictions: [],
            verdict: "ok",
            skipped: true,
            skipReason: "JSON parse failed",
            modelUsed: result.model,
            durationMs: result.durationMs,
          });
          return;
        }
        log.info(
          "self-critique",
          `done: ${parsed.contradictions.length} contradiction(s), verdict=${parsed.verdict}, model=${result.model}, dur=${result.durationMs}ms`,
        );
        safeResolve({
          contradictions: parsed.contradictions,
          verdict: parsed.verdict,
          skipped: false,
          modelUsed: result.model,
          durationMs: result.durationMs,
        });
      },
      onError: (err: Error) => {
        log.warn("self-critique", `model call failed: ${err.message}`);
        safeResolve({
          contradictions: [],
          verdict: "ok",
          skipped: true,
          skipReason: err.message,
        });
      },
    }).catch((err) => {
      log.debug("self-critique", `runForkedAgent threw: ${err}`);
      safeResolve({
        contradictions: [],
        verdict: "ok",
        skipped: true,
        skipReason: `runForkedAgent threw: ${err instanceof Error ? err.message : err}`,
      });
    });
  });
}

/**
 * Format the critique result as a user-facing banner subtitle.
 * Returns empty string if no contradictions / verdict is ok.
 */
export function formatCritiqueBanner(result: SelfCritiqueResult): string {
  if (result.contradictions.length === 0) return "";

  const lines: string[] = [
    `⚠ Self-critique flagged ${result.contradictions.length} issue(s) in this response:`,
  ];
  const shown = result.contradictions.slice(0, 5);
  for (const c of shown) {
    const claim = c.claim.length > 80 ? c.claim.slice(0, 80) + "…" : c.claim;
    const ev = c.evidence.length > 100 ? c.evidence.slice(0, 100) + "…" : c.evidence;
    lines.push(`  • [${c.severity}] "${claim}" — evidence says: ${ev}`);
  }
  const rest = result.contradictions.length - shown.length;
  if (rest > 0) lines.push(`  … and ${rest} more.`);
  lines.push(
    `If any of these are accurate, rewrite the response to match the evidence before presenting as done.`,
  );
  return lines.join("\n");
}
