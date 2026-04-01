// KCode - Stream event handler
// Extracted from App.tsx — processes LLM streaming events and updates UI state

import type { ConversationManager } from "../core/conversation.js";
import { getFileChangeSuggester } from "../core/file-watcher.js";
import type { StreamEvent } from "../core/types.js";
import { summarizeInput } from "./builtin-actions.js";
import type { KodiEvent } from "./components/Kodi.js";
import type { MessageEntry } from "./components/MessageList.js";

export interface TabInfo {
  toolUseId: string;
  name: string;
  summary: string;
  status: "queued" | "running" | "done" | "error";
  startTime: number;
  durationMs?: number;
}

export interface StreamHandlerDeps {
  config: { workingDirectory: string };
  conversationManager: ConversationManager;
  tabRemovalTimers: { current: Set<ReturnType<typeof setTimeout>> };

  // State setters
  setLoadingMessage: (msg: string) => void;
  setLastKodiEvent: (event: KodiEvent | null) => void;
  setIsThinking: (v: boolean) => void;
  setStreamingThinking: (v: string) => void;
  setCompleted: (updater: (prev: MessageEntry[]) => MessageEntry[]) => void;
  setStreamingText: (v: string) => void;
  setToolUseCount: (v: number) => void;
  setBashStreamOutput: (v: string | ((prev: string) => string)) => void;
  setActiveTabs: (updater: (prev: TabInfo[]) => TabInfo[]) => void;
  setTokenCount: (v: number) => void;
  setTurnTokens: (v: number) => void;
  setSpinnerPhase: (v: "thinking" | "streaming" | "tool") => void;
  setRunningAgentCount: (v: number) => void;
  setWatcherSuggestions: (updater: (prev: string[]) => string[]) => void;
}

/**
 * Consume a stream of LLM events and update React state accordingly.
 */
export async function processStreamEvents(
  events: AsyncGenerator<StreamEvent>,
  deps: StreamHandlerDeps,
): Promise<void> {
  const {
    config,
    conversationManager,
    tabRemovalTimers,
    setLoadingMessage,
    setLastKodiEvent,
    setIsThinking,
    setStreamingThinking,
    setCompleted,
    setStreamingText,
    setToolUseCount,
    setBashStreamOutput,
    setActiveTabs,
    setTokenCount,
    setTurnTokens,
    setSpinnerPhase,
    setRunningAgentCount,
    setWatcherSuggestions,
  } = deps;

  let currentText = "";
  let hadPartialProgress = false;
  let currentThinking = "";

  for await (const event of events) {
    switch (event.type) {
      case "turn_start":
        setLoadingMessage("");
        // Show any pending file change suggestions
        {
          const suggester = getFileChangeSuggester(config.workingDirectory);
          const suggestions = suggester.getSuggestions();
          if (suggestions.length > 0) {
            setWatcherSuggestions((prev) => [...prev, ...suggestions]);
          }
        }
        // Refresh running agent count
        try {
          const { getRunningAgentCount } = await import("../tools/agent.js");
          setRunningAgentCount(getRunningAgentCount());
        } catch {
          /* ignore */
        }
        break;

      case "text_delta":
        if (currentText.length === 0) setLastKodiEvent({ type: "streaming" });
        // Finalize any accumulated thinking when text starts
        if (currentThinking.length > 0) {
          const thinking = currentThinking;
          setIsThinking(false);
          setStreamingThinking("");
          setCompleted((prev) => [...prev, { kind: "thinking", text: thinking }]);
          currentThinking = "";
        }
        currentText += event.text;
        setStreamingText(currentText);
        break;

      case "thinking_delta":
        if (currentThinking.length === 0) {
          setLastKodiEvent({ type: "thinking" });
          setSpinnerPhase("thinking");
        }
        currentThinking += event.thinking;
        setIsThinking(true);
        setStreamingThinking(currentThinking);
        setLoadingMessage("");
        break;

      case "tool_use_start":
        // Finalize any accumulated thinking
        if (currentThinking.length > 0) {
          const thinking = currentThinking;
          setIsThinking(false);
          setStreamingThinking("");
          setCompleted((prev) => [...prev, { kind: "thinking", text: thinking }]);
          currentThinking = "";
        }
        // Finalize any accumulated text
        if (currentText.length > 0) {
          const text = currentText;
          setCompleted((prev) => [...prev, { kind: "text", role: "assistant", text }]);
          currentText = "";
          setStreamingText("");
        }
        break;

      case "tool_input_delta":
        // Tool input streaming - could show partial JSON; skip for now
        break;

      case "tool_executing": {
        setLastKodiEvent({ type: "tool_start", detail: event.name });
        const summary = summarizeInput(event.name, event.input);
        setCompleted((prev) => [...prev, { kind: "tool_use", name: event.name, summary }]);
        // Enhanced loading message with command/file details
        const detail = summary ? summary.slice(0, 60) : "";
        setLoadingMessage(detail ? `Running ${event.name}: ${detail}` : `Running ${event.name}...`);
        setSpinnerPhase("tool");
        // Add to active tabs, except for Plan which has its own persistent panel.
        if (event.name !== "Plan") {
          setActiveTabs((prev) => [
            ...prev.filter((t) => t.toolUseId !== event.toolUseId),
            {
              toolUseId: event.toolUseId,
              name: event.name,
              summary: detail,
              status: "running",
              startTime: Date.now(),
            },
          ]);
        }
        break;
      }

      case "tool_stream":
        // Live streaming output from Bash commands
        setBashStreamOutput((prev: string) => {
          const updated = prev + event.chunk;
          // Keep only the last 200 lines to avoid memory bloat
          const lines = updated.split("\n");
          if (lines.length > 200) {
            return lines.slice(-200).join("\n");
          }
          return updated;
        });
        break;

      case "tool_result":
        setLastKodiEvent({ type: event.isError ? "tool_error" : "tool_done", detail: event.name });
        setToolUseCount(conversationManager.getState().toolUseCount);
        // Clear Bash stream output when any Bash result arrives
        if (event.name === "Bash") {
          setBashStreamOutput("");
        }
        // Plan tool gets a visual checklist display
        if (event.name === "Plan" && !event.isError) {
          try {
            const { getActivePlan } = await import("../tools/plan.js");
            const plan = getActivePlan();
            if (plan) {
              setCompleted((prev) => [
                ...prev,
                {
                  kind: "plan" as const,
                  title: plan.title,
                  steps: plan.steps.map((s) => ({ id: s.id, title: s.title, status: s.status })),
                },
              ]);
              break;
            }
          } catch {
            // fallthrough to default rendering
          }
        }
        // Learn tool gets a special visual treatment
        if (event.name === "Learn" && !event.isError && event.result.startsWith("\u2727")) {
          setCompleted((prev) => [
            ...prev,
            { kind: "learn", text: event.result.replace(/^\u2727\s*/, "") },
          ]);
        } else {
          setCompleted((prev) => [
            ...prev,
            {
              kind: "tool_result",
              name: event.name,
              result: event.result,
              isError: event.isError,
              durationMs: event.durationMs,
            },
          ]);
        }
        // Refresh agent count after any Agent tool result
        if (event.name === "Agent") {
          try {
            const { getRunningAgentCount } = await import("../tools/agent.js");
            setRunningAgentCount(getRunningAgentCount());
          } catch {
            /* ignore */
          }
        }
        // Update tab: mark as done/error, then remove after 1.5s.
        // Plan is excluded from ToolTabs because it lives in the fixed ActivePlanPanel.
        if (event.name !== "Plan") {
          setActiveTabs((prev) =>
            prev.map((t) =>
              t.toolUseId === event.toolUseId
                ? {
                    ...t,
                    status: (event.isError ? "error" : "done") as "done" | "error",
                    durationMs: event.durationMs,
                  }
                : t,
            ),
          );
          {
            const timerId = setTimeout(() => {
              setActiveTabs((prev) => prev.filter((t) => t.toolUseId !== event.toolUseId));
              tabRemovalTimers.current.delete(timerId);
            }, 1500);
            tabRemovalTimers.current.add(timerId);
          }
        }
        setLoadingMessage("Thinking...");
        setSpinnerPhase("thinking");
        break;

      case "usage_update":
        setTokenCount(event.usage.inputTokens + event.usage.outputTokens);
        setTurnTokens(event.usage.inputTokens + event.usage.outputTokens);
        break;

      case "token_count":
        setTurnTokens(event.tokens);
        setSpinnerPhase("streaming");
        break;

      case "error":
        setLastKodiEvent({ type: "error", detail: event.error.message });
        setCompleted((prev) => [
          ...prev,
          {
            kind: "text",
            role: "assistant",
            text: `\n  Error: ${event.error.message}${event.retryable ? " (retrying...)" : ""}\n`,
          },
        ]);
        break;

      case "suggestion":
        if (event.suggestions.length > 0) {
          setCompleted((prev) => [...prev, { kind: "suggestion", suggestions: event.suggestions }]);
        }
        break;

      case "partial_progress":
        hadPartialProgress = true;
        setCompleted((prev) => [
          ...prev,
          {
            kind: "partial_progress" as const,
            toolsUsed: event.toolsUsed,
            elapsedMs: event.elapsedMs,
            filesModified: event.filesModified,
            lastError: event.lastError,
            summary: event.summary,
          },
        ]);
        break;

      case "compaction_start":
        setLastKodiEvent({ type: "compaction" });
        setCompleted((prev) => [
          ...prev,
          {
            kind: "banner",
            title: "Compacting context...",
            subtitle: `Summarizing ${event.messageCount} messages (~${Math.round(event.tokensBefore / 1000)}k tokens)`,
          },
        ]);
        setLoadingMessage("Compacting context...");
        break;

      case "compaction_end":
        setCompleted((prev) => [
          ...prev,
          {
            kind: "banner",
            title: "Context compacted",
            subtitle: `${event.method === "llm" ? "LLM summary" : event.method === "compressed" ? "Tool results compressed" : "Messages pruned"} \u2192 ~${Math.round(event.tokensAfter / 1000)}k tokens`,
          },
        ]);
        break;

      case "budget_warning":
        setCompleted((prev) => [
          ...prev,
          {
            kind: "banner",
            title: `Budget ${event.pct >= 100 ? "EXCEEDED" : "warning"}: ${event.pct}%`,
            subtitle: `$${event.costUsd.toFixed(2)} / $${event.limitUsd.toFixed(2)}`,
          },
        ]);
        break;

      case "tool_progress":
        if (event.status === "running" || event.status === "queued") {
          setLoadingMessage(`Parallel: ${event.name} (${event.index + 1}/${event.total})...`);
          // Update tab status
          setActiveTabs((prev) =>
            prev.map((t) =>
              t.toolUseId === event.toolUseId
                ? { ...t, status: event.status as "running" | "queued" }
                : t,
            ),
          );
        } else if (event.status === "done") {
          const ms = event.durationMs ? ` ${event.durationMs}ms` : "";
          setLoadingMessage(
            `Parallel: ${event.name} done${ms} (${event.index + 1}/${event.total})`,
          );
        }
        break;

      case "turn_end":
        setLastKodiEvent({ type: "turn_end" });
        // Finalize any remaining thinking
        if (currentThinking.length > 0) {
          const thinking = currentThinking;
          setIsThinking(false);
          setStreamingThinking("");
          setCompleted((prev) => [...prev, { kind: "thinking", text: thinking }]);
          currentThinking = "";
        }
        // Finalize any remaining streamed text
        if (currentText.length > 0) {
          let text = currentText;
          // Clean up truncated questions/confirmations at the end
          try {
            const { isTruncatedQuestion } = require("../core/continuation-merge.js");
            if (isTruncatedQuestion(text)) {
              // Strip the truncated question from the end
              const lastNewline = text.lastIndexOf("\n");
              if (lastNewline > text.length * 0.5) {
                text = text.slice(0, lastNewline).trimEnd();
              }
            }
          } catch {
            /* module not loaded */
          }
          setCompleted((prev) => [...prev, { kind: "text", role: "assistant", text }]);
          currentText = "";
          setStreamingText("");
        } else if (
          !hadPartialProgress &&
          event.stopReason !== "tool_use" &&
          event.stopReason !== "max_tokens_continue" &&
          event.stopReason !== "empty_response_retry" &&
          event.stopReason !== "checkpoint_reached" &&
          event.stopReason !== "theoretical_no_tools" &&
          event.stopReason !== "truncation_retry" &&
          event.stopReason !== "plan_stop_reached"
        ) {
          // Model returned empty response — show a diagnostic fallback
          const emptyType = event.emptyType;
          const hint =
            emptyType === "thinking_only"
              ? "(the model reasoned but produced no visible answer — try a different model or disable thinking)"
              : emptyType === "tools_only"
                ? "(the model used tools but gave no response — try rephrasing)"
                : emptyType === "no_output"
                  ? "(empty response — the model returned no text. Try rephrasing or use a different model.)"
                  : "(empty response \u2014 the model returned no text. Try rephrasing or use a different model.)";
          setCompleted((prev) => [...prev, { kind: "text", role: "assistant", text: `  ${hint}` }]);
        }
        // Show incomplete response banner if the session ended incomplete
        try {
          const { getLastSession } = require("../core/response-session.js");
          const lastSession = getLastSession();
          // Only show the incomplete banner once: on the final turn_end, for
          // sessions that closed recently (within 5s) and with terminal stop reasons.
          const isTerminalStop =
            event.stopReason === "end_turn" ||
            event.stopReason === "error" ||
            event.stopReason === "force_stop" ||
            event.stopReason === "aborted";
          const isRecent = lastSession && Date.now() - lastSession.updatedAt < 5000;
          if (
            lastSession &&
            isRecent &&
            isTerminalStop &&
            (lastSession.status === "incomplete" || lastSession.status === "failed")
          ) {
            setCompleted((prev) => {
              // Don't add duplicate banners
              if (prev.some((e) => e.kind === "incomplete_response")) return prev;
              return [
                ...prev,
                {
                  kind: "incomplete_response" as const,
                  continuations: lastSession.continuationCount,
                  stopReason: event.stopReason,
                },
              ];
            });
          }
        } catch {
          /* module not loaded */
        }

        // Show any pending file change suggestions
        {
          const suggester = getFileChangeSuggester(config.workingDirectory);
          const suggestions = suggester.getSuggestions();
          if (suggestions.length > 0) {
            setWatcherSuggestions((prev) => [...prev, ...suggestions]);
          }
        }
        break;
    }
  }
}
