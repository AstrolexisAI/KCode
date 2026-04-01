// Utility actions — thin dispatcher
// Delegates to categorized sub-handlers extracted from this file.

import type { ActionContext } from "./action-helpers.js";
import { handleFileAction } from "./file-actions.js";
import { handleMathConversionAction } from "./math-conversion-actions.js";
import { handleNetworkAction } from "./network-actions.js";
import { handleSystemAction } from "./system-actions.js";
import { handleTextAction } from "./text-actions.js";

const subHandlers = [
  handleFileAction,
  handleMathConversionAction,
  handleNetworkAction,
  handleSystemAction,
  handleTextAction,
];

export async function handleUtilityAction(
  action: string,
  ctx: ActionContext,
): Promise<string | null> {
  const { conversationManager, appConfig, args } = ctx;

  switch (action) {
    case "project_cost": {
      const usage = conversationManager.getUsage();
      const state = conversationManager.getState();

      const { getModelPricing, calculateCost, formatCost } = await import("../../core/pricing.js");
      const pricing = await getModelPricing(appConfig.model);

      const msgCount = state.messages.length;
      if (msgCount === 0) return "  No messages yet — cannot project costs.";

      const n = parseInt(args?.trim() || "") || 10;

      // Current averages
      const avgInputPerMsg = Math.round(usage.inputTokens / msgCount);
      const avgOutputPerMsg = Math.round(usage.outputTokens / msgCount);
      const currentCost = pricing
        ? calculateCost(pricing, usage.inputTokens, usage.outputTokens)
        : 0;

      // Project
      const projInputTokens = avgInputPerMsg * n;
      const projOutputTokens = avgOutputPerMsg * n;
      const projCost = pricing ? calculateCost(pricing, projInputTokens, projOutputTokens) : 0;
      const totalProjectedCost = currentCost + projCost;

      const lines = [
        `  Cost Projection \u2014 Next ${n} Messages`,
        ``,
        `  Current Session:`,
        `    Messages:      ${msgCount}`,
        `    Input tokens:  ${usage.inputTokens.toLocaleString()} (avg ${avgInputPerMsg.toLocaleString()}/msg)`,
        `    Output tokens: ${usage.outputTokens.toLocaleString()} (avg ${avgOutputPerMsg.toLocaleString()}/msg)`,
        `    Cost so far:   ${formatCost(currentCost)}`,
        ``,
        `  Projection (+${n} messages):`,
        `    Est. input:    +${projInputTokens.toLocaleString()} tokens`,
        `    Est. output:   +${projOutputTokens.toLocaleString()} tokens`,
        `    Est. cost:     +${formatCost(projCost)}`,
        `    Total:         ${formatCost(totalProjectedCost)}`,
      ];

      if (pricing) {
        lines.push(``, `  Rate: $${pricing.inputPer1M}/M in, $${pricing.outputPer1M}/M out`);
      } else {
        lines.push(``, `  \u2139 No pricing data for ${appConfig.model} (local model \u2014 free)`);
      }

      // Context budget check
      const contextSize = appConfig.contextWindowSize ?? 200000;
      const totalTokens =
        usage.inputTokens + usage.outputTokens + projInputTokens + projOutputTokens;
      const pct = Math.round((totalTokens / contextSize) * 100);
      if (pct > 80) {
        lines.push(
          ``,
          `  \u26A0 Projected to use ${pct}% of context window \u2014 may trigger auto-compact`,
        );
      }

      return lines.join("\n");
    }
    default: {
      // Delegate to sub-handlers
      for (const handler of subHandlers) {
        const result = await handler(action, ctx);
        if (result !== null) return result;
      }
      return null;
    }
  }
}
