// KCode - Conversation Per-Turn Cost Recording
// Extracted from conversation.ts runAgentLoop — append a cost entry for
// the current turn to the rolling cost log. Looks up pricing lazily via
// `./pricing` and trims the log to `maxTurnCosts` in place so overall
// memory stays bounded across long sessions.

import { log } from "./logger";
import type { KCodeConfig, ToolUseBlock, TurnCostEntry } from "./types";

export interface TurnCostArgs {
  config: KCodeConfig;
  turnCosts: TurnCostEntry[];
  turnInputTokens: number;
  turnOutputTokens: number;
  toolCalls: ToolUseBlock[];
  maxTurnCosts: number;
}

/**
 * Append a cost entry for the current turn. No-ops when the turn used
 * no tokens. Trims `turnCosts` in place to keep at most `maxTurnCosts`
 * entries (behavior identical to the previous `slice(-MAX)` reassignment
 * since nothing outside the class holds the reference).
 *
 * Pricing resolution is non-fatal — if `./pricing` import or lookup
 * fails, the entry is still recorded with `costUsd: 0`.
 */
export async function recordTurnCost(args: TurnCostArgs): Promise<void> {
  if (args.turnInputTokens === 0 && args.turnOutputTokens === 0) return;
  try {
    const { getModelPricing, calculateCost } = await import("./pricing.js");
    const pricing = await getModelPricing(args.config.model);
    const costUsd = pricing
      ? calculateCost(pricing, args.turnInputTokens, args.turnOutputTokens)
      : 0;
    args.turnCosts.push({
      turnIndex: args.turnCosts.length + 1,
      model: args.config.model,
      inputTokens: args.turnInputTokens,
      outputTokens: args.turnOutputTokens,
      costUsd,
      toolCalls: args.toolCalls.map((tc) => tc.name),
      timestamp: Date.now(),
    });
    if (args.turnCosts.length > args.maxTurnCosts) {
      args.turnCosts.splice(0, args.turnCosts.length - args.maxTurnCosts);
    }
  } catch (err) {
    log.debug("pricing", "Failed to track turn cost: " + err);
  }
}
