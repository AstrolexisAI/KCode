// KCode - Conversation Streaming Tool Executor Setup
// Extracted from conversation.ts runAgentLoop — build a
// StreamingToolExecutor that pre-executes read-only tools while the
// model's response is still streaming. Only viable for OpenAI-format
// providers (tool blocks arrive incrementally during the stream).
// For Anthropic-format providers, tool blocks finalize post-stream
// so there is no early-execution benefit — returns null in that case.

import type { LoopGuardState } from "./agent-loop-guards";
import type { PermissionManager } from "./permissions";
import { StreamingToolExecutor } from "./streaming-tool-executor";
import type { ToolRegistry } from "./tool-registry";
import type { KCodeConfig } from "./types";

export interface StreamingExecutorSetupArgs {
  config: KCodeConfig;
  tools: ToolRegistry;
  permissions: PermissionManager;
  abortSignal: AbortSignal | undefined;
  guardState: LoopGuardState;
}

/**
 * Build the per-turn `StreamingToolExecutor` or return null when the
 * current provider doesn't expose tool blocks during streaming. The
 * skip predicate blocks any tool whose call-fingerprint family has
 * already been burned by two prior failures on this conversation.
 */
export function createStreamingToolExecutor(
  args: StreamingExecutorSetupArgs,
): StreamingToolExecutor | null {
  const isOpenAIFormat =
    !args.config.apiBase?.includes("anthropic.com") &&
    !args.config.model.toLowerCase().startsWith("claude");
  if (!isOpenAIFormat) return null;
  return new StreamingToolExecutor({
    tools: args.tools,
    permissions: args.permissions,
    config: args.config,
    abortSignal: args.abortSignal,
    shouldSkip: (tc) => {
      if (args.guardState.burnedFingerprints.size === 0) return false;
      for (const fp of args.guardState.burnedFingerprints) {
        if (fp.split("|")[0] === tc.name) return true;
      }
      return false;
    },
  });
}
