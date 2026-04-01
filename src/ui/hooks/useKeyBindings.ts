// KCode - Keyboard shortcut handler hook
// Extracted from App.tsx — handles Escape, Alt+T, Ctrl+C, Shift+Tab keybindings

import { useInput } from "ink";
import type { ConversationManager } from "../../core/conversation.js";
import type { KCodeConfig, PermissionMode } from "../../core/types.js";
import type { MessageEntry } from "../components/MessageList.js";

export interface UseKeyBindingsParams {
  config: KCodeConfig;
  conversationManager: ConversationManager;
  mode: string;
  messageQueueRef: React.MutableRefObject<string[]>;
  exit: () => void;
  setMode: (
    mode: "input" | "responding" | "permission" | "sudo-password" | "cloud" | "toggle",
  ) => void;
  setStreamingText: (text: string) => void;
  setStreamingThinking: (text: string) => void;
  setIsThinking: (v: boolean) => void;
  setLoadingMessage: (msg: string) => void;
  setCompleted: (updater: (prev: MessageEntry[]) => MessageEntry[]) => void;
  setMessageQueue: (queue: string[]) => void;
}

export function useKeyBindings({
  config,
  conversationManager,
  mode,
  messageQueueRef,
  exit,
  setMode,
  setStreamingText,
  setStreamingThinking,
  setIsThinking,
  setLoadingMessage,
  setCompleted,
  setMessageQueue,
}: UseKeyBindingsParams): void {
  useInput((input, key) => {
    // Escape cancels current response
    if (key.escape && mode === "responding") {
      conversationManager.abort();
      setMode("input");
      setStreamingText("");
      setStreamingThinking("");
      setIsThinking(false);
      setLoadingMessage("");
      setCompleted((prev) => [
        ...prev,
        { kind: "text", role: "assistant", text: "\n  [Cancelled]" },
      ]);
      return;
    }

    // Alt+T: Toggle extended thinking
    if (key.meta && input === "t" && mode === "input") {
      config.thinking = !config.thinking;
      const budgetLabel =
        config.reasoningBudget === -1
          ? "unlimited"
          : config.reasoningBudget !== undefined
            ? `${config.reasoningBudget} tokens`
            : "default";
      setCompleted((prev) => [
        ...prev,
        {
          kind: "text",
          role: "assistant",
          text: `  Thinking mode: ${config.thinking ? `ON (budget: ${budgetLabel})` : "OFF"}`,
        },
      ]);
      return;
    }

    // Ctrl+C: cancel response + clear queue if running, otherwise exit
    if (key.ctrl && input === "c") {
      if (mode === "responding") {
        conversationManager.abort();
        // Clear the entire queue
        const queuedCount = messageQueueRef.current.length;
        messageQueueRef.current = [];
        setMessageQueue([]);
        setMode("input");
        setStreamingText("");
        setStreamingThinking("");
        setIsThinking(false);
        setLoadingMessage("");
        setCompleted((prev) => [
          ...prev,
          {
            kind: "text",
            role: "assistant",
            text: `\n  [Cancelled${queuedCount > 0 ? `, ${queuedCount} queued message${queuedCount > 1 ? "s" : ""} cleared` : ""}]`,
          },
        ]);
      } else {
        exit();
      }
      return;
    }

    // Shift+Tab: cycle permission mode (ask → auto → plan → ask)
    if (key.tab && key.shift) {
      const perms = conversationManager.getPermissions();
      const currentMode = perms.getMode();
      const cycle: PermissionMode[] = ["ask", "auto", "plan"];
      const idx = cycle.indexOf(currentMode);
      const nextMode = cycle[(idx + 1) % cycle.length]!;
      perms.setMode(nextMode);
      const labels: Record<string, string> = {
        ask: "ask (confirm each tool)",
        auto: "auto (approve all tools)",
        plan: "plan (read-only)",
      };
      setCompleted((prev) => [
        ...prev,
        {
          kind: "text",
          role: "assistant",
          text: `  Permission mode: ${labels[nextMode] ?? nextMode}`,
        },
      ]);
      return;
    }
  });
}
