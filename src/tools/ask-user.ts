// KCode - AskUser Tool
// Structured user questions with optional choices

import type { ToolDefinition, ToolResult } from "../core/types";

export const askUserDefinition: ToolDefinition = {
  name: "AskUser",
  description:
    "Ask the user a structured question when you need clarification or a decision. " +
    "Supports free-form questions, multiple-choice, and yes/no prompts. " +
    "Use this instead of embedding questions in assistant text when you need " +
    "a clear, actionable response before proceeding.",
  input_schema: {
    type: "object" as const,
    properties: {
      question: {
        type: "string",
        description: "The question to ask the user",
      },
      choices: {
        type: "array",
        items: { type: "string" },
        description: "Optional list of choices for the user to pick from",
      },
      default_choice: {
        type: "string",
        description: "Default choice if the user presses Enter without typing",
      },
      context: {
        type: "string",
        description: "Optional context to help the user understand why you are asking",
      },
    },
    required: ["question"],
  },
};

export async function executeAskUser(input: Record<string, unknown>): Promise<ToolResult> {
  const question = String(input.question ?? "");
  const choices = input.choices as string[] | undefined;
  const defaultChoice = input.default_choice as string | undefined;
  const context = input.context as string | undefined;

  if (!question.trim()) {
    return { tool_use_id: "", content: "Error: question is required", is_error: true };
  }

  // Phase 14 (#111 v282 follow-up): when the model asks about credentials
  // / connection failures, its 'context' field is often the only place
  // where failure evidence lives — e.g. the Bitcoin TUI swallowed the 401
  // Unauthorized inside blessed, so stdout for 'bun run' showed no error
  // but the model saw the 401 render on screen and put it into its
  // AskUser context. Feed that signal into the scope so mayClaimReady
  // flips to false and the closeout renders the failed_auth branch.
  //
  // Narrow classifier: only infer from unambiguous failure signatures
  // (auth / connection / traceback). Status updates won't trip it.
  try {
    const combinedSignal = [question, context ?? ""].join("\n");
    const { classifyRuntimeStatus } =
      require("../core/runtime-classifier") as typeof import("../core/runtime-classifier");
    const status = classifyRuntimeStatus("", null, combinedSignal);
    // Only act on CONFIDENT failure signals. failed_unknown is the
    // classifier's default-when-no-match and must not be treated as
    // evidence (the question 'Which port should I bind to?' would
    // otherwise degrade the scope to failed because classifier
    // returns failed_unknown for anything without a matching signature).
    const CONFIDENT = new Set([
      "failed_auth",
      "failed_connection",
      "failed_traceback",
      "failed_dependency",
      "started_unverified",
    ]);
    if (CONFIDENT.has(status)) {
      const { getTaskScopeManager } =
        require("../core/task-scope") as typeof import("../core/task-scope");
      const mgr = getTaskScopeManager();
      if (mgr.current()) {
        mgr.recordRuntimeCommand({
          command: "(model-reported via AskUser)",
          exitCode: null,
          output: combinedSignal.slice(0, 600),
          runtimeFailed: status.startsWith("failed_"),
          status,
          timestamp: Date.now(),
        });
      }
    }
  } catch {
    /* scope unavailable — legacy path */
  }

  const parts: string[] = [];

  if (context) {
    parts.push(`Context: ${context}\n`);
  }

  parts.push(`[USER_INPUT_REQUIRED]`);
  parts.push(`Question: ${question}`);

  if (choices && choices.length > 0) {
    parts.push(`\nChoices:`);
    for (let i = 0; i < choices.length; i++) {
      const marker = defaultChoice === choices[i] ? " (default)" : "";
      parts.push(`  ${i + 1}. ${choices[i]}${marker}`);
    }
  } else if (defaultChoice) {
    parts.push(`Default: ${defaultChoice}`);
  }

  return { tool_use_id: "", content: parts.join("\n") };
}
