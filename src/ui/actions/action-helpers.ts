// Shared types and helpers for builtin action handlers

import type { ConversationManager } from "../../core/conversation.js";
import type { KCodeConfig } from "../../core/types.js";
import type { MessageEntry } from "../components/MessageList.js";

export type SetCompleted = (updater: (prev: MessageEntry[]) => MessageEntry[]) => void;

export interface ActionContext {
  conversationManager: ConversationManager;
  setCompleted: SetCompleted;
  appConfig: KCodeConfig;
  args?: string;
  switchTheme?: (name: string) => void;
  /**
   * Reset transient UI state that lives in App.tsx React state but
   * isn't part of conversationManager (token counters, cost meter,
   * tool-use count, agent count, streaming buffers). The /clear
   * handler calls this so the status line returns to zeros instead
   * of showing the prior session's accumulated counts after the
   * conversation has actually been wiped.
   */
  resetUiState?: () => void;
}
