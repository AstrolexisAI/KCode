// KCode - Message Preparation
// Extracted from conversation.ts sendMessage() preamble
// Handles pre-processing before the agent loop: context injection, RAG, skills, etc.

import { log } from "./logger";
import {
  detectLanguage,
  looksCheckpointed,
  looksTheoretical,
} from "./prompt-analysis";
import type { ConversationState, KCodeConfig, Message, StreamEvent, TokenUsage } from "./types";

// ─── Budget Check ─────────────────────────────────────────────

export async function* checkBudgetLimit(
  config: KCodeConfig,
  cumulativeUsage: TokenUsage,
): AsyncGenerator<StreamEvent> {
  if (!config.maxBudgetUsd || config.maxBudgetUsd <= 0) return;
  try {
    const { getModelPricing, calculateCost } = await import("./pricing.js");
    const pricing = await getModelPricing(config.model);
    if (pricing) {
      const cost = calculateCost(pricing, cumulativeUsage.inputTokens, cumulativeUsage.outputTokens);
      if (cost >= config.maxBudgetUsd) {
        yield {
          type: "error",
          error: new Error(
            `Budget limit reached: $${cost.toFixed(2)} >= $${config.maxBudgetUsd.toFixed(2)}. Use --max-budget-usd to increase.`,
          ),
          retryable: false,
        };
        yield { type: "turn_end", stopReason: "error" };
        return;
      }
    } else {
      log.warn(
        "budget",
        `No pricing data for model "${config.model}" — budget limit ($${config.maxBudgetUsd}) cannot be enforced`,
      );
    }
  } catch (err) {
    log.debug("budget", "Failed to check budget limit: " + err);
  }
}

// ─── Theoretical Mode Detection ───────────────────────────────

export interface TheoreticalModeResult {
  isTheoretical: boolean;
  injectedMessages: Message[];
}

export function detectTheoreticalMode(userMessage: string): TheoreticalModeResult {
  if (!looksTheoretical(userMessage)) {
    return { isTheoretical: false, injectedMessages: [] };
  }

  const lang = detectLanguage(userMessage);
  log.info("session", `Detected theoretical prompt (lang=${lang}) — strict analysis mode`);
  const langHint =
    lang !== "en"
      ? ` You MUST respond in ${lang === "es" ? "Spanish" : lang === "fr" ? "French" : lang === "pt" ? "Portuguese" : "the user's language"}.`
      : "";

  return {
    isTheoretical: true,
    injectedMessages: [
      {
        role: "user",
        content:
          `[SYSTEM] STRICT ANALYSIS MODE: The user's question is theoretical/formal. Rules:\n` +
          `1. Respond with text only — do NOT use any tools.\n` +
          `2. Use Unicode for math (fᵢ : S → S, not LaTeX).\n` +
          `3. Be precise and concise — avoid verbose introductions and repetitive conclusions.\n` +
          `4. If data is missing for some items, state "No data provided for X" — do NOT invent values.\n` +
          `5. End with a single, clear conclusion — do NOT repeat the conclusion.\n` +
          `6. If your response will be long, prioritize structure over length.${langHint}`,
      },
    ],
  };
}

// ─── Checkpoint Mode Detection ────────────────────────────────

export interface CheckpointModeResult {
  isCheckpoint: boolean;
  injectedMessages: Message[];
}

export async function detectCheckpointMode(userMessage: string): Promise<CheckpointModeResult> {
  if (!looksCheckpointed(userMessage)) {
    return { isCheckpoint: false, injectedMessages: [] };
  }

  log.info("session", "Detected checkpoint request — will limit tool execution to initial stage");

  try {
    const { onPlanChange } = await import("../tools/plan.js");
    const unsubCheckpoint = onPlanChange((plan: any) => {
      if (plan && plan.steps.length > 0 && !plan.stopAfterStepId) {
        plan.stopAfterStepId = plan.steps[0]!.id;
        log.info("session", `Checkpoint: auto-set stopAfterStepId to "${plan.steps[0]!.id}"`);
      }
      unsubCheckpoint();
    });
  } catch {
    /* plan module not loaded */
  }

  return {
    isCheckpoint: true,
    injectedMessages: [
      {
        role: "user",
        content:
          "[SYSTEM] The user asked for ONLY the first step or initial structure. Complete ONLY that stage, then STOP and provide a summary. Do NOT continue to additional features, pages, or implementation beyond the initial setup.",
      },
    ],
  };
}

// ─── Output Budget ────────────────────────────────────────────

export async function evaluateOutputBudgetHint(
  userMessage: string,
  maxTokens: number | undefined,
  tokenCount: number,
  contextWindowSize: number,
): Promise<Message | null> {
  try {
    const { evaluateOutputBudget } = await import("./output-budget.js");
    const contextPct =
      tokenCount > 0 ? Math.round((tokenCount / contextWindowSize) * 100) : 0;
    const budget = evaluateOutputBudget(userMessage, maxTokens, contextPct);
    if (budget.strategy !== "normal" && budget.systemHint) {
      log.info(
        "session",
        `Output budget: ${budget.strategy} (est. ${budget.estimatedOutputTokens} tokens, max ${budget.maxAllowedTokens})`,
      );
      return { role: "user", content: budget.systemHint };
    }
  } catch {
    /* module not loaded */
  }
  return null;
}

// ─── Smart Context Injection ──────────────────────────────────

export async function injectSmartContext(
  userMessage: string,
  messages: Message[],
  workingDirectory: string,
): Promise<Message[]> {
  const injected: Message[] = [];

  // Codebase index context
  try {
    const { getCodebaseIndex } = await import("./codebase-index.js");
    const idx = getCodebaseIndex(workingDirectory);

    if (messages.length <= 6) {
      const snippets = idx.formatRelevantSnippets(userMessage, 60);
      if (snippets) {
        injected.push({ role: "user", content: `[SYSTEM CONTEXT] ${snippets}` });
      }
    } else if (messages.length <= 20) {
      const contextHint = idx.formatRelevantContext(userMessage);
      if (contextHint) {
        injected.push({ role: "user", content: `[SYSTEM CONTEXT] ${contextHint}` });
      }
    }
  } catch (err) {
    log.debug("context", "Failed to inject smart context hints: " + err);
  }

  // Auto-RAG context
  try {
    const { getRAGEngine } = await import("./rag/engine.js");
    const rag = getRAGEngine(workingDirectory);
    await rag.init();
    if (rag.stats().total > 0) {
      const ragResults = await rag.search(userMessage, { limit: 5, queryType: "code" });
      if (ragResults.length > 0 && ragResults[0]!.similarity > 0.01) {
        const ragContext = rag.formatAsContext(ragResults, 3000);
        if (ragContext) {
          injected.push({ role: "user", content: `[SYSTEM CONTEXT] ${ragContext}` });
        }
      }
    }
  } catch (err) {
    log.debug("context", "Failed to inject RAG context: " + err);
  }

  // Auto-invoke skills
  try {
    const { SkillManager } = await import("./skills.js");
    const sm = new SkillManager(workingDirectory);
    const matched = sm.matchAutoInvoke(userMessage);
    if (matched.length > 0) {
      const skillContext = matched
        .map((s: any) => {
          const body = sm.getLevel2Body(s.name);
          return body ? `[SKILL: ${s.name}]\n${body}` : null;
        })
        .filter(Boolean)
        .join("\n\n");
      if (skillContext) {
        injected.push({
          role: "user",
          content: `[SYSTEM CONTEXT — Auto-invoked skills]\n${skillContext}`,
        });
      }
    }
  } catch (err) {
    log.debug("skills", "Failed to auto-invoke skills: " + err);
  }

  return injected;
}
