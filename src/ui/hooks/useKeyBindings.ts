// KCode - Keyboard shortcut handler hook
// Routes key presses through the user-configurable KeybindingResolver
// (~/.kcode/keybindings.json overrides src/core/keybindings/defaults.ts)
// and dispatches by action. Ctrl+C is reserved and stays hardcoded.

import { useInput } from "ink";
import type { ConversationManager } from "../../core/conversation.js";
import type { KeyCombo } from "../../core/keybindings/index.js";
import type { KCodeConfig, PermissionMode } from "../../core/types.js";
import { useKeybindingContext } from "../components/KeybindingContext.js";
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

/** Translate an Ink (input, key) pair into a resolver KeyCombo.
 *  Ink reports Alt as `meta` (ESC-prefixed sequences), so meta maps to alt. */
function inkToCombo(
  input: string,
  key: {
    return?: boolean;
    escape?: boolean;
    tab?: boolean;
    upArrow?: boolean;
    downArrow?: boolean;
    leftArrow?: boolean;
    rightArrow?: boolean;
    pageUp?: boolean;
    pageDown?: boolean;
    backspace?: boolean;
    delete?: boolean;
    ctrl?: boolean;
    shift?: boolean;
    meta?: boolean;
  },
): KeyCombo {
  let base = (input ?? "").toLowerCase();
  if (key.return) base = "enter";
  else if (key.escape) base = "escape";
  else if (key.tab) base = "tab";
  else if (key.upArrow) base = "up";
  else if (key.downArrow) base = "down";
  else if (key.leftArrow) base = "left";
  else if (key.rightArrow) base = "right";
  else if (key.pageUp) base = "pageup";
  else if (key.pageDown) base = "pagedown";
  else if (key.backspace) base = "backspace";
  else if (key.delete) base = "delete";
  return {
    key: base,
    ctrl: Boolean(key.ctrl),
    alt: Boolean(key.meta),
    shift: Boolean(key.shift),
    meta: false,
  };
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
  const { resolver } = useKeybindingContext();

  const cancelResponse = (extra = "") => {
    conversationManager.abort();
    setMode("input");
    setStreamingText("");
    setStreamingThinking("");
    setIsThinking(false);
    setLoadingMessage("");
    setCompleted((prev) => [
      ...prev,
      { kind: "text", role: "assistant", text: `\n  [Cancelled${extra}]` },
    ]);
  };

  useInput((input, key) => {
    // Ctrl+C is reserved (RESERVED_KEYS): cancel + clear queue, or exit.
    if (key.ctrl && input === "c") {
      if (mode === "responding") {
        const queuedCount = messageQueueRef.current.length;
        messageQueueRef.current = [];
        setMessageQueue([]);
        cancelResponse(
          queuedCount > 0
            ? `, ${queuedCount} queued message${queuedCount > 1 ? "s" : ""} cleared`
            : "",
        );
      } else {
        exit();
      }
      return;
    }

    const combo = inkToCombo(input, key);
    const action = resolver.processKeyPress(combo, mode === "input" ? "input" : undefined);
    if (!action) return;

    switch (action) {
      case "cancel":
        if (mode === "responding") cancelResponse();
        break;

      case "toggle.thinking": {
        if (mode !== "input") break;
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
        break;
      }

      case "permission.cycle": {
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
        break;
      }

      default:
        // Actions handled elsewhere (submit/newline/history in InputPrompt)
        // or not yet implemented (help, search.messages, pin.file, ...).
        break;
    }
  });
}
