// KCode - Conversation JSON Schema Validation Gate
// Extracted from conversation.ts runAgentLoop — when `--json-schema`
// is configured and the model produced a text-only turn (no tool
// calls), validate the text against the schema. On rejection, inject
// a SYSTEM retry message and signal the caller to restart the turn.

import { validateModelOutput, type LoopGuardState } from "./agent-loop-guards";
import type { ConversationState, KCodeConfig, StreamEvent, ToolUseBlock } from "./types";

export interface SchemaValidationArgs {
  config: KCodeConfig;
  fullText: string;
  toolCalls: ToolUseBlock[];
  state: ConversationState;
  guardState: LoopGuardState;
}

/**
 * Run JSON-schema validation against the turn's final text. Returns a
 * `turn_end` StreamEvent when the caller must yield and `continue` the
 * loop (schema rejected, retry message injected). Returns null when
 * the schema passed, is not configured, or the turn used tools.
 */
export function validateJsonSchemaForTurn(args: SchemaValidationArgs): StreamEvent | null {
  if (!args.config.jsonSchema) return null;
  if (args.toolCalls.length !== 0) return null;
  if (args.fullText.length === 0) return null;

  const { retryMessage, shouldAccept } = validateModelOutput(
    args.fullText,
    args.config.jsonSchema,
    args.guardState.jsonSchemaRetries,
  );
  if (shouldAccept || !retryMessage) return null;

  args.guardState.jsonSchemaRetries++;
  args.state.messages.push({ role: "user", content: retryMessage });
  return { type: "turn_end", stopReason: "tool_use" };
}
