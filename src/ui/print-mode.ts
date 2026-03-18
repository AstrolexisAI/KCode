// KCode - Print Mode (non-interactive output)
// Runs a single prompt and outputs assistant text to stdout.
// Tool results go to stderr. Suitable for piping: kcode "explain this" | less
// Supports output formats: text (default), json, stream-json

import type { ConversationManager } from "../core/conversation";

type OutputFormat = "text" | "json" | "stream-json";

/**
 * Run a single prompt in print mode (non-interactive).
 * - Assistant text is written to stdout
 * - Tool activity / results are written to stderr
 * - Returns the exit code (0 = success, 1 = error)
 */
export async function runPrintMode(
  conversationManager: ConversationManager,
  prompt: string,
  outputFormat: OutputFormat = "text",
): Promise<number> {
  if (outputFormat === "json") {
    return runPrintModeJson(conversationManager, prompt);
  }
  if (outputFormat === "stream-json") {
    return runPrintModeStreamJson(conversationManager, prompt);
  }
  return runPrintModeText(conversationManager, prompt);
}

/**
 * Text output mode (default): plain text to stdout, tool info to stderr.
 */
async function runPrintModeText(
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
          process.stderr.write(`[tool error] ${event.name}: ${event.result ?? "(no output)"}\n`);
        } else {
          process.stderr.write(`[tool done] ${event.name} (${event.result?.length ?? 0} chars)\n`);
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

/**
 * JSON output mode: collects all output and emits a single JSON object at the end.
 * Schema: { text, tools: [{name, result, isError}], error?, usage? }
 */
async function runPrintModeJson(
  conversationManager: ConversationManager,
  prompt: string,
): Promise<number> {
  let hadError = false;
  let text = "";
  const tools: Array<{ name: string; result?: string; isError?: boolean }> = [];
  let errorMessage: string | undefined;

  for await (const event of conversationManager.sendMessage(prompt)) {
    switch (event.type) {
      case "text_delta":
        text += event.text;
        break;

      case "tool_result":
        tools.push({
          name: event.name,
          result: event.result,
          isError: event.isError || undefined,
        });
        break;

      case "error":
        hadError = true;
        errorMessage = event.error.message;
        break;

      case "turn_end":
        if (event.stopReason === "error") hadError = true;
        break;
    }
  }

  const usage = conversationManager.getUsage();
  const output: Record<string, unknown> = { text };
  if (tools.length > 0) output.tools = tools;
  if (errorMessage) output.error = errorMessage;
  output.usage = {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  };

  process.stdout.write(JSON.stringify(output, null, 2) + "\n");

  return hadError ? 1 : 0;
}

/**
 * Stream-JSON output mode: emits one JSON object per line (NDJSON) for each event.
 * Each line: { type, ... } matching the StreamEvent types.
 */
async function runPrintModeStreamJson(
  conversationManager: ConversationManager,
  prompt: string,
): Promise<number> {
  let hadError = false;

  for await (const event of conversationManager.sendMessage(prompt)) {
    switch (event.type) {
      case "text_delta":
        process.stdout.write(JSON.stringify({ type: "text", text: event.text }) + "\n");
        break;

      case "thinking_delta":
        process.stdout.write(JSON.stringify({ type: "thinking", text: event.thinking }) + "\n");
        break;

      case "tool_use_start":
        process.stdout.write(JSON.stringify({ type: "tool_start", name: event.name, id: event.toolUseId }) + "\n");
        break;

      case "tool_result":
        process.stdout.write(JSON.stringify({ type: "tool_result", name: event.name, result: event.result, isError: event.isError || undefined }) + "\n");
        break;

      case "usage_update":
        process.stdout.write(JSON.stringify({ type: "usage", ...event.usage }) + "\n");
        break;

      case "error":
        process.stdout.write(JSON.stringify({ type: "error", message: event.error.message }) + "\n");
        hadError = true;
        break;

      case "turn_end":
        process.stdout.write(JSON.stringify({ type: "done", stopReason: event.stopReason }) + "\n");
        if (event.stopReason === "error") hadError = true;
        break;
    }
  }

  return hadError ? 1 : 0;
}
