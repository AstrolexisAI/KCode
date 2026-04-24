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

  // Phase 15 (#111 v292): AskUser pauses the conversation waiting for
  // user input. Post-turn doesn't run, so the grounded closeout never
  // renders before the user sees the question. The model can therefore
  // ask 'do you want more features?' while scope state is partial/failed,
  // and the user misses the honest state.
  //
  // Fix: if scope has a correction worth rendering (phase failed/partial/
  // blocked, patchAppliedAfterFailure, etc.) we prepend the grounded
  // closeout to the context string the user sees. That way the AskUser
  // box shows:
  //   Context: <grounded closeout>\n<original context>
  //   Question: ...
  let enrichedContext = context ?? "";
  try {
    const { getTaskScopeManager } =
      require("../core/task-scope") as typeof import("../core/task-scope");
    const { renderCloseoutFromScope, needsClosewoutCorrection } =
      require("../core/closeout-renderer") as typeof import("../core/closeout-renderer");
    const scope = getTaskScopeManager().current();
    if (scope && needsClosewoutCorrection(scope)) {
      const closeout = renderCloseoutFromScope(scope);
      if (closeout) {
        // Strip the leading '---' divider (it's visual noise in the
        // AskUser box). Prepend the closeout to the context so the
        // user sees grounded state before the question.
        const clean = closeout.replace(/^\s*\n?---\n?\s*/, "").trim();
        enrichedContext = enrichedContext
          ? `${clean}\n\n--- Model's stated context ---\n${enrichedContext}`
          : clean;
      }
    }
  } catch {
    /* scope unavailable — fall back to plain context */
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

  if (enrichedContext) {
    parts.push(`Context: ${enrichedContext}\n`);
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
