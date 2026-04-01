// KCode - Builtin action handlers for slash commands
// Extracted from App.tsx — handles /stats, /doctor, /models, /clear, /compact, etc.
// Refactored: action handlers are split into categorized files in ./actions/

import type { ConversationManager } from "../core/conversation.js";
import type { KCodeConfig } from "../core/types.js";
import type { ActionContext } from "./actions/action-helpers.js";
import { handleGitAction } from "./actions/git-actions.js";
import { handleInfoAction } from "./actions/info-actions.js";
import { handleModelConfigAction } from "./actions/model-config-actions.js";
import { handleSessionAction } from "./actions/session-actions.js";
import { handleToolAction } from "./actions/tool-actions.js";
import { handleUtilityAction } from "./actions/utility-actions.js";
import type { MessageEntry } from "./components/MessageList.js";

export type SetCompleted = (updater: (prev: MessageEntry[]) => MessageEntry[]) => void;

export function summarizeInput(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Bash":
      return String(input.command ?? "").slice(0, 80);
    case "Read":
    case "Write":
    case "Edit":
      return String(input.file_path ?? "");
    case "Glob":
      return String(input.pattern ?? "");
    case "Grep":
      return String(input.pattern ?? "");
    case "Agent":
      return String(input.description ?? "");
    case "WebFetch":
      return String(input.url ?? "").slice(0, 60);
    case "WebSearch":
      return String(input.query ?? "").slice(0, 60);
    case "DiffView":
      return String(input.file_a ?? "");
    case "TestRunner":
      return String(input.file ?? "all tests");
    case "Rename":
      return `${String(input.symbol ?? "")} → ${String(input.new_name ?? "")}`;
    case "Clipboard":
      return `${String(input.text ?? "").slice(0, 40)}`;
    case "Undo":
      return String(input.action ?? "undo");
    case "GitStatus":
      return "";
    case "GitCommit":
      return String(input.message ?? "").slice(0, 60);
    case "GitLog":
      return input.file ? String(input.file) : `last ${input.count ?? 10}`;
    case "GrepReplace":
      return `${String(input.pattern ?? "")} → ${String(input.replacement ?? "")}`;
    case "Stash":
      return `${String(input.action ?? "")}${input.name ? ` ${String(input.name)}` : ""}`;
    case "AskUser":
      return String(input.question ?? "").slice(0, 60);
    case "LSP":
      return `${String(input.action ?? "")} ${String(input.file ?? "")}`.trim();
    case "ToolSearch":
      return String(input.query ?? "").slice(0, 60);
    default:
      return "";
  }
}

// Dispatcher: delegates to categorized action handlers
const handlers = [
  handleSessionAction,
  handleInfoAction,
  handleModelConfigAction,
  handleToolAction,
  handleGitAction,
  handleUtilityAction,
];

export async function handleBuiltinAction(
  action: string,
  conversationManager: ConversationManager,
  setCompleted: SetCompleted,
  appConfig: KCodeConfig,
  args?: string,
  switchTheme?: (name: string) => void,
): Promise<string> {
  const ctx: ActionContext = {
    conversationManager,
    setCompleted,
    appConfig,
    args,
    switchTheme,
  };

  for (const handler of handlers) {
    const result = await handler(action, ctx);
    if (result !== null) return result;
  }

  return `  Unknown built-in action: ${action}`;
}
