// KCode - Print Mode (non-interactive output)
// Runs a single prompt and outputs assistant text to stdout.
// Tool results go to stderr. Suitable for piping: kcode "explain this" | less

import type { ConversationManager } from "../core/conversation";

/**
 * Run a single prompt in print mode (non-interactive).
 * - Assistant text is written to stdout
 * - Tool activity / results are written to stderr
 * - Returns the exit code (0 = success, 1 = error)
 */
export async function runPrintMode(
  conversationManager: ConversationManager,
  prompt: string,
): Promise<number> {
  let hadError = false;

  for await (const event of conversationManager.sendMessage(prompt)) {
    switch (event.type) {
      case "text_delta":
        process.stdout.write(event.text);
        break;

      case "thinking_delta":
        // Suppress thinking in print mode
        break;

      case "tool_use_start":
        process.stderr.write(`[tool] ${event.name}\n`);
        break;

      case "tool_executing":
        // Already logged at tool_use_start
        break;

      case "tool_result":
        if (event.isError) {
          process.stderr.write(`[tool error] ${event.name}: ${event.result}\n`);
        } else {
          process.stderr.write(`[tool done] ${event.name} (${event.result.length} chars)\n`);
        }
        break;

      case "error":
        process.stderr.write(`[error] ${event.error.message}\n`);
        hadError = true;
        break;

      case "turn_end":
        if (event.stopReason === "error") {
          hadError = true;
        }
        break;

      // Ignore: turn_start, usage_update, tool_input_delta
    }
  }

  // Ensure output ends with a newline
  process.stdout.write("\n");

  return hadError ? 1 : 0;
}
