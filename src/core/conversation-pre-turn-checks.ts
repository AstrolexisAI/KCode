// KCode - Pre-turn verdicts and banners
//
// Extracted from conversation.ts `sendMessage()` to keep the main
// class shell focused on orchestration. This module owns the
// "phase 5/12/15/18/20/25/30" pre-flight passes:
//
//   1. Operator dashboard banner  (phase 5)
//   2. User repetition detector   (phase 25)
//   3. Semantic correction        (phase 30)
//   4. Plan reconciliation        (phase 12)
//   5. Claim-vs-reality           (phases 15/18/20)
//
// Each pass inspects the current transcript (plus the user's newest
// message) and, if it fires, pushes a synthetic user-role message
// into `state.messages` telling the model what was detected. All
// five are best-effort — dynamic imports + try/catch — so a missing
// or broken submodule never aborts the turn.
//
// Tests: the individual detectors have their own unit tests
// (user-repetition-check, semantic-correction-check, claim-reality-
// check, plan.ts detectAbandonedPlan, operator-dashboard). This
// module is glue; integration is covered by the conversation-level
// tests.

import { log } from "./logger";
import type { ConversationState, KCodeConfig } from "./types";

export interface PreTurnCheckDeps {
  state: ConversationState;
  config: KCodeConfig;
  userMessage: string;
  contextWindowSize: number;
  estimateContextTokens: () => number;
}

export async function runPreTurnChecks(deps: PreTurnCheckDeps): Promise<void> {
  const { state, config, userMessage, contextWindowSize, estimateContextTokens } = deps;

  // ── Phase 5: operator-state banner ─────────────────────────────
  // Probe system invariants and prepend any findings as a synthetic
  // user-role message. Throttled per-finding-code so the same
  // warning doesn't nag every turn. Silent when healthy.
  try {
    const { probeOperatorState, formatOperatorBanner, selectFindingsForTurn } = await import(
      "./operator-dashboard.js"
    );
    const probe = probeOperatorState(config.workingDirectory);
    const fresh = selectFindingsForTurn(probe.findings);
    const banner = formatOperatorBanner(fresh);
    if (banner) {
      state.messages.push({ role: "user", content: banner });
    }
  } catch (err) {
    log.debug("operator-dashboard", `probe failed (non-fatal): ${err}`);
  }

  // ── Phase 25: user-repetition ──────────────────────────────────
  // When the user has reported the same topic in ≥3 recent messages
  // AND expressed frustration ("sigue igual", "still broken", "audita
  // esto"), inject a [USER REPETITION] reminder. Catches the v2.10.67
  // Orbital chart-fix case where phase 15/18/20 were silent because
  // Edits succeeded on wrong code paths.
  try {
    const { checkUserRepetition, buildUserRepetitionReminder } = await import(
      "./user-repetition-check.js"
    );
    const verdict = checkUserRepetition(state.messages, userMessage);
    if (verdict.isRepeating) {
      const contextTokens = estimateContextTokens();
      const saturation = contextWindowSize ? contextTokens / contextWindowSize : undefined;
      const reminder = buildUserRepetitionReminder(verdict, saturation);
      state.messages.push({ role: "user", content: reminder });
      log.info(
        "user-repetition",
        `injected reminder: topics=[${verdict.sharedTopics
          .slice(0, 3)
          .join(",")}] frustration=[${verdict.frustrationSignals.slice(0, 2).join(",")}]${
          saturation !== undefined ? ` saturation=${Math.round(saturation * 100)}%` : ""
        }`,
      );
    }
  } catch (err) {
    log.debug("user-repetition", `check failed (non-fatal): ${err}`);
  }

  // ── Phase 30: semantic-correction ──────────────────────────────
  // Complements phase 25: phase 25 needs 3+ repetitions + frustration;
  // phase 30 fires on a SINGLE corrective message ("no es X, sino
  // Y"). Catches the v2.10.74 Nexus chart session.
  try {
    const { checkSemanticCorrection, buildSemanticCorrectionReminder } = await import(
      "./semantic-correction-check.js"
    );
    const verdict = checkSemanticCorrection(state.messages, userMessage);
    if (verdict.isCorrection) {
      const reminder = buildSemanticCorrectionReminder(verdict);
      state.messages.push({ role: "user", content: reminder });
      log.info(
        "semantic-correction",
        `injected reminder: wrong="${verdict.wrongTarget.slice(0, 40)}" right="${verdict.rightTarget.slice(0, 40)}"`,
      );
    }
  } catch (err) {
    log.debug("semantic-correction", `check failed (non-fatal): ${err}`);
  }

  // ── Shared prep: most recent assistant-text ────────────────────
  // Used by phases 12 + 15. Computed once here and passed down.
  let lastAssistantText = "";
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i];
    if (m?.role !== "assistant") continue;
    if (typeof m.content === "string") {
      lastAssistantText = m.content;
    } else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if ((block as { type?: string }).type === "text") {
          lastAssistantText += (block as { text?: string }).text ?? "";
        }
      }
    }
    break;
  }

  // ── Phase 12: plan reconciliation ──────────────────────────────
  // Previous turn declared "Task completed" / "Delivered" / etc. but
  // the active plan still has unchecked steps — inject a
  // reconciliation reminder.
  try {
    const { detectAbandonedPlan, buildPlanReconciliationReminder } = await import(
      "../tools/plan.js"
    );
    if (lastAssistantText) {
      const verdict = detectAbandonedPlan(lastAssistantText);
      if (verdict.abandoned && verdict.completionPhrase) {
        const reminder = buildPlanReconciliationReminder(
          verdict.pendingSteps,
          verdict.completionPhrase,
        );
        state.messages.push({ role: "user", content: reminder });
        log.info(
          "plan",
          `reconciliation injected: ${verdict.pendingSteps.length} pending steps, phrase="${verdict.completionPhrase}"`,
        );
      }
    }
  } catch (err) {
    log.debug("plan", `reconciliation check failed (non-fatal): ${err}`);
  }

  // ── Phases 15 / 18 / 20: claim-vs-reality ──────────────────────
  // Previous turn made concrete change claims ("Updated X", "Replaced
  // Y") but no mutating tool call actually succeeded — inject a
  // [REALITY CHECK] reminder. Three severity levels:
  //
  //   15: hallucinated completion — zero real mutations against ≥1
  //       claim. Hardest reminder.
  //   18: claim/mutation mismatch — some mutations landed but the
  //       claim count is ≥3× the mutation count. Softer reminder.
  //   20: content-level mismatch — prose URLs / literals that never
  //       appeared in any tool call this turn. Only runs when 15/18
  //       didn't already fire. Catches the picsum.photos vs
  //       photojournal.jpl.nasa.gov Orbital/Mars case.
  try {
    const {
      checkClaimReality,
      buildRealityCheckReminder,
      buildClaimMismatchReminder,
      checkContentMismatch,
      buildContentMismatchReminder,
    } = await import("./claim-reality-check.js");
    if (lastAssistantText) {
      const verdict = checkClaimReality(lastAssistantText, state.messages);
      if (verdict.isHallucinatedCompletion) {
        const reminder = buildRealityCheckReminder(verdict);
        state.messages.push({ role: "user", content: reminder });
        log.info(
          "reality-check",
          `hallucinated completion detected: ${verdict.claims.length} claims, ${verdict.successfulMutations} real mutations`,
        );
      } else if (verdict.isClaimMutationMismatch) {
        const reminder = buildClaimMismatchReminder(verdict);
        state.messages.push({ role: "user", content: reminder });
        log.info(
          "reality-check",
          `claim/mutation mismatch: ${verdict.claims.length} claims, ${verdict.successfulMutations} real mutations`,
        );
      } else {
        const contentVerdict = checkContentMismatch(lastAssistantText, state.messages);
        if (contentVerdict.isContentMismatch) {
          const reminder = buildContentMismatchReminder(contentVerdict);
          state.messages.push({ role: "user", content: reminder });
          log.info(
            "reality-check",
            `content mismatch: ${contentVerdict.missingLiterals.length} fabricated URL(s) in prose`,
          );
        }
      }
    }
  } catch (err) {
    log.debug("reality-check", `check failed (non-fatal): ${err}`);
  }
}
