// KCode - Stop Condition Handlers
// Extracted from conversation.ts to reduce the size of runAgentLoop.
// These handlers evaluate whether the agent loop should stop, continue, or modify behavior
// based on force-stop, theoretical mode, checkpoint mode, and plan coherence.

import { log } from "./logger";
import type { ContentBlock, ToolUseBlock } from "./types";

// ─── Types ──────────────────────────────────────────────────────

export interface StopAction {
  /** What to do next in the loop */
  action: "break" | "continue" | "pass";
  /** Reason for the stop */
  stopReason?: string;
  /** Updated assistant content (if tools were dropped) */
  updatedContent?: ContentBlock[];
  /** Message to inject as user role */
  injectMessage?: string;
  /** Whether to set forceStopLoop on guard state */
  setForceStop?: boolean;
  /** Error to yield */
  error?: Error;
}

// ─── Force Stop ─────────────────────────────────────────────────

export function handleForceStop(
  forceStopActive: boolean,
  toolCalls: ToolUseBlock[],
  assistantContent: ContentBlock[],
): StopAction {
  if (!forceStopActive || toolCalls.length === 0) {
    return { action: "pass" };
  }

  log.warn(
    "session",
    `Force-stop active but model returned ${toolCalls.length} tool calls — dropping them`,
  );
  const textOnly = assistantContent.filter((b) => b.type === "text");
  return {
    action: "break",
    stopReason: "force_stop",
    updatedContent: textOnly.length > 0 ? textOnly : undefined,
  };
}

// ─── Theoretical Mode ───────────────────────────────────────────

export function handleTheoreticalMode(
  isTheoretical: boolean,
  toolCalls: ToolUseBlock[],
  assistantContent: ContentBlock[],
  retryCount: number,
): StopAction & { newRetryCount: number } {
  if (!isTheoretical || toolCalls.length === 0) {
    return { action: "pass", newRetryCount: retryCount };
  }

  const newRetryCount = retryCount + 1;
  log.info(
    "session",
    `Theoretical mode: dropping ${toolCalls.length} tool call(s) (attempt ${newRetryCount})`,
  );
  const textOnly = assistantContent.filter((b) => b.type === "text");
  const updatedContent = textOnly.length > 0 ? textOnly : [{ type: "text" as const, text: "" }];

  if (newRetryCount >= 2) {
    log.warn(
      "session",
      "Theoretical mode: model persists with tool calls after 2 retries — accepting text and stopping",
    );
    const hasText =
      textOnly.length > 0 &&
      textOnly.some((b) => b.type === "text" && (b as { text: string }).text);
    return {
      action: "break",
      stopReason: "theoretical_no_tools",
      updatedContent,
      newRetryCount: 0,
      error: hasText
        ? undefined
        : new Error(
            "The model could not produce a text-only response for this theoretical question. Try rephrasing or using a different model.",
          ),
    };
  }

  return {
    action: "continue",
    stopReason: "theoretical_no_tools",
    updatedContent,
    injectMessage:
      "[SYSTEM] Tools are disabled for theoretical questions. Answer with text only. Do not attempt any tool calls.",
    newRetryCount,
  };
}

// ─── Checkpoint Mode ────────────────────────────────────────────

export function handleCheckpointMode(
  isCheckpoint: boolean,
  toolCalls: ToolUseBlock[],
  toolCount: number,
  assistantContent: ContentBlock[],
): StopAction & { newToolCount: number } {
  if (!isCheckpoint || toolCalls.length === 0) {
    return { action: "pass", newToolCount: toolCount };
  }

  const newToolCount = toolCount + toolCalls.length;
  if (newToolCount < 4) {
    return { action: "pass", newToolCount };
  }

  log.info(
    "session",
    `Checkpoint mode: ${newToolCount} tools used — forcing stop for stage summary`,
  );
  const textOnly = assistantContent.filter((b) => b.type === "text");

  return {
    action: "continue",
    stopReason: "checkpoint_reached",
    updatedContent: textOnly.length > 0 ? textOnly : [{ type: "text" as const, text: "" }],
    injectMessage:
      "[SYSTEM] CHECKPOINT REACHED: You have completed enough work for the initial stage the user requested. STOP executing tools NOW. Provide a clear summary of: (1) what was created, (2) what still needs to be done, (3) suggested next step. Do NOT continue implementing.",
    setForceStop: true,
    newToolCount,
  };
}

// ─── Plan Coherence ─────────────────────────────────────────────

export interface PlanCoherenceResult {
  /** Tool calls that were blocked */
  blockedResults: Array<{ tool_use_id: string; content: string; name: string }>;
  /** Tool calls that should still execute */
  keptCalls: ToolUseBlock[];
  /** Messages to inject */
  injectMessages: string[];
  /** Whether to force stop */
  setForceStop?: boolean;
  stopReason?: string;
}

export async function handlePlanCoherence(
  toolCalls: ToolUseBlock[],
  assistantContent: ContentBlock[],
): Promise<PlanCoherenceResult> {
  const result: PlanCoherenceResult = {
    blockedResults: [],
    keptCalls: [...toolCalls],
    injectMessages: [],
  };

  try {
    const {
      getActivePlan,
      countInProgressSteps,
      getActiveStep,
      shouldStopAfterCurrentStep,
      classifyToolCoherence,
    } = await import("../tools/plan.js");

    // Skip all plan coherence checks if there's no active plan
    if (!getActivePlan()) return result;

    // Check if stopAfterStep was reached
    if (shouldStopAfterCurrentStep()) {
      log.info("session", "Plan stopAfterStep reached — forcing stop");
      const textOnly = assistantContent.filter((b) => b.type === "text");
      return {
        ...result,
        keptCalls: [],
        injectMessages: [
          "[SYSTEM] The plan's stop-after step has been completed. STOP and provide a summary of what was done. Do NOT continue to further steps.",
        ],
        setForceStop: true,
        stopReason: "plan_stop_reached",
      };
    }

    // Check multiple in_progress
    const inProgress = countInProgressSteps();
    if (inProgress > 1) {
      log.warn(
        "session",
        `Plan coherence: ${inProgress} steps in_progress simultaneously — injecting correction`,
      );
      result.injectMessages.push(
        `[SYSTEM] Plan coherence warning: you have ${inProgress} steps marked as in_progress simultaneously. Finish the current step before starting another. Update the plan to reflect actual progress.`,
      );
    }

    // Check tool coherence against active step
    const activeStep = getActiveStep();
    if (activeStep && toolCalls.length > 0) {
      const blocked: ToolUseBlock[] = [];
      const kept: ToolUseBlock[] = [];
      let warned = false;

      for (const tc of toolCalls) {
        const coherence = classifyToolCoherence(
          tc.name,
          tc.input as Record<string, unknown>,
          activeStep.title,
        );
        if (coherence === "block") {
          log.warn(
            "session",
            `Plan block: tool ${tc.name} contradicts step "${activeStep.title}" — blocking`,
          );
          blocked.push(tc);
        } else if (coherence === "warn" && !warned) {
          warned = true;
          log.warn(
            "session",
            `Plan deviation: tool ${tc.name} may not match step "${activeStep.title}"`,
          );
          result.injectMessages.push(
            `[SYSTEM] Plan deviation detected: your action (${tc.name}) doesn't seem to match the current plan step "${activeStep.id}. ${activeStep.title}". Finish the current step first, or update the plan if you're intentionally changing approach.`,
          );
          kept.push(tc);
        } else {
          kept.push(tc);
        }
      }

      if (blocked.length > 0) {
        result.blockedResults = blocked.map((tc) => ({
          tool_use_id: tc.id,
          content: `BLOCKED by plan: "${tc.name}" contradicts the current step "${activeStep.id}. ${activeStep.title}". Finish or update the current step first.`,
          name: tc.name,
        }));
        result.keptCalls = kept;
      }
    }
  } catch {
    /* plan module not loaded */
  }

  return result;
}
