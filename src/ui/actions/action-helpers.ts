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
}
