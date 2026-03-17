// KCode - Main Ink application component
// Top-level component managing conversation flow and rendering

import React, { useState, useCallback, useRef } from "react";
import { Box, useInput, useApp } from "ink";
import type { ConversationManager } from "../core/conversation.js";
import type { KCodeConfig, StreamEvent, PermissionMode } from "../core/types.js";
import type { ToolRegistry } from "../core/tool-registry.js";
import { SkillManager } from "../core/skills.js";
import { collectStats, formatStats } from "../core/stats.js";
import { runDiagnostics } from "../core/doctor.js";
import { listModels, loadModelsConfig } from "../core/models.js";
import { getAvailableThemes, getCurrentThemeName } from "../core/theme.js";
import { useTheme } from "./ThemeContext.js";

import Header from "./components/Header.js";
import MessageList, { type MessageEntry } from "./components/MessageList.js";
import InputPrompt from "./components/InputPrompt.js";
import PermissionDialog, {
  type PermissionRequest,
  type PermissionChoice,
} from "./components/PermissionDialog.js";

interface AppProps {
  config: KCodeConfig;
  conversationManager: ConversationManager;
  tools: ToolRegistry;
}

type AppMode = "input" | "responding" | "permission";

export default function App({ config, conversationManager, tools }: AppProps) {
  const { exit } = useApp();
  const { switchTheme } = useTheme();

  // Skills manager - created once per component instance
  const [skillManager] = useState(() => {
    const sm = new SkillManager(config.workingDirectory);
    sm.load();
    return sm;
  });

  // Build completions list from skills (slash commands + aliases)
  const [slashCompletions] = useState(() => {
    const names: string[] = [];
    for (const skill of skillManager.listSkills()) {
      names.push("/" + skill.name);
      for (const alias of skill.aliases) {
        names.push("/" + alias);
      }
    }
    // Add built-in non-skill commands
    names.push("/exit", "/quit", "/status", "/undo", "/rewind", "/usage", "/plan", "/hooks", "/changes", "/fork", "/memory");
    return names.sort();
  });

  const [commandDescriptions] = useState(() => {
    const descs: Record<string, string> = {};
    for (const skill of skillManager.listSkills()) {
      descs["/" + skill.name] = skill.description;
      for (const alias of skill.aliases) {
        descs["/" + alias] = skill.description;
      }
    }
    descs["/exit"] = "Exit KCode";
    descs["/quit"] = "Exit KCode";
    descs["/status"] = "Show session status";
    descs["/undo"] = "Undo last file change";
    descs["/rewind"] = "Undo recent file changes";
    return descs;
  });

  const [mode, setMode] = useState<AppMode>("input");
  const [completed, setCompleted] = useState<MessageEntry[]>([
    {
      kind: "banner",
      title: `KCode v${config.version ?? "?"}`,
      subtitle: "Kulvex Code by Astrolexis",
    },
  ]);
  const [streamingText, setStreamingText] = useState("");
  const [streamingThinking, setStreamingThinking] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState("");
  const [tokenCount, setTokenCount] = useState(0);
  const [turnTokens, setTurnTokens] = useState(0);
  const [turnStartTime, setTurnStartTime] = useState(0);
  const [spinnerPhase, setSpinnerPhase] = useState<"thinking" | "streaming" | "tool">("thinking");
  const [toolUseCount, setToolUseCount] = useState(0);

  // Plan mode toggle state (Shift+Tab)
  const [savedPermMode, setSavedPermMode] = useState<PermissionMode | null>(null);

  // Message queue — user can type while KCode is responding
  const [messageQueue, setMessageQueue] = useState<string[]>([]);
  const messageQueueRef = useRef<string[]>([]);

  // Permission dialog state
  const [permissionRequest, setPermissionRequest] = useState<PermissionRequest | null>(null);
  const [permissionResolver, setPermissionResolver] = useState<
    ((choice: PermissionChoice) => void) | null
  >(null);

  // Wire up the permission prompt callback so PermissionManager can ask the user
  useState(() => {
    conversationManager.getPermissions().setPromptFn(async (req) => {
      return new Promise<{ granted: boolean; alwaysAllow?: boolean }>((resolve) => {
        setPermissionRequest({
          toolName: req.toolName,
          description: req.summary,
        });
        setMode("permission");
        setPermissionResolver(() => (choice: PermissionChoice) => {
          resolve({
            granted: choice === "allow" || choice === "allow_always",
            alwaysAllow: choice === "allow_always",
          });
        });
      });
    });
  });

  // Global keybindings
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
      setCompleted((prev) => [
        ...prev,
        { kind: "text", role: "assistant", text: `  Thinking mode: ${config.thinking ? "ON" : "OFF"}` },
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
          { kind: "text", role: "assistant", text: `\n  [Cancelled${queuedCount > 0 ? `, ${queuedCount} queued message${queuedCount > 1 ? "s" : ""} cleared` : ""}]` },
        ]);
      } else {
        exit();
      }
      return;
    }

    // Shift+Tab: toggle plan mode
    if (key.tab && key.shift) {
      const perms = conversationManager.getPermissions();
      const currentMode = perms.getMode();
      if (currentMode === "plan") {
        // Toggle back to previous mode
        perms.setMode(savedPermMode ?? "ask");
        setSavedPermMode(null);
        setCompleted((prev) => [
          ...prev,
          { kind: "text", role: "assistant", text: `  Mode: ${savedPermMode ?? "ask"} (exited plan mode)` },
        ]);
      } else {
        // Enter plan mode
        setSavedPermMode(currentMode);
        perms.setMode("plan");
        setCompleted((prev) => [
          ...prev,
          { kind: "text", role: "assistant", text: "  Mode: plan (read-only)" },
        ]);
      }
      return;
    }
  });

  // Process a single message (sends to LLM, handles events, resets state)
  const processMessage = useCallback(
    async (userInput: string) => {
      // Built-in exit commands
      const lower = userInput.toLowerCase().trim();
      if (
        lower === "/exit" || lower === "/quit" || lower === "/bye" ||
        lower === "exit" || lower === "quit" || lower === "bye"
      ) {
        exit();
        return;
      }

      if (lower === "/undo") {
        const result = conversationManager.getUndo().undo();
        setCompleted((prev) => [
          ...prev,
          { kind: "text", role: "user", text: userInput },
          {
            kind: "text",
            role: "assistant",
            text: result ?? "  Nothing to undo.",
          },
        ]);
        return;
      }

      if (userInput === "/status") {
        const state = conversationManager.getState();
        const usage = conversationManager.getUsage();
        setCompleted((prev) => [
          ...prev,
          { kind: "text", role: "user", text: userInput },
          {
            kind: "text",
            role: "assistant",
            text: `  Messages: ${state.messages.length}\n  Tokens: ${usage.inputTokens + usage.outputTokens} (in: ${usage.inputTokens}, out: ${usage.outputTokens})\n  Tool uses: ${state.toolUseCount}`,
          },
        ]);
        return;
      }

      // Slash command handling via SkillManager
      if (userInput.startsWith("/")) {
        const skillMatch = skillManager.match(userInput);
        if (skillMatch) {
          const expanded = skillManager.expand(skillMatch);

          // Built-in help is handled locally (no LLM call)
          if (expanded.isHelp) {
            setCompleted((prev) => [
              ...prev,
              { kind: "text", role: "user", text: userInput },
              {
                kind: "text",
                role: "assistant",
                text: skillManager.formatHelp(tools.getToolNames()),
              },
            ]);
            return;
          }

          // Built-in template command — display result locally (no LLM call)
          if (expanded.isTemplate) {
            setCompleted((prev) => [
              ...prev,
              { kind: "text", role: "user", text: userInput },
              {
                kind: "text",
                role: "assistant",
                text: expanded.prompt,
              },
            ]);
            return;
          }

          // Built-in action commands (stats, doctor, models, clear, compact, rewind)
          if (expanded.builtinAction) {
            const result = await handleBuiltinAction(expanded.builtinAction, conversationManager, setCompleted, config, expanded.prompt, switchTheme);
            setCompleted((prev) => [
              ...prev,
              { kind: "text", role: "user", text: userInput },
              { kind: "text", role: "assistant", text: result },
            ]);
            return;
          }

          // Show the slash command as user message, then send expanded prompt to LLM
          setCompleted((prev) => [...prev, { kind: "text", role: "user", text: userInput }]);
          setMode("responding");
          setStreamingText("");
          setTurnTokens(0);
          setTurnStartTime(Date.now());
          setSpinnerPhase("thinking");
          setLoadingMessage("Thinking...");

          try {
            const events = conversationManager.sendMessage(expanded.prompt);
            await processEvents(events);
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            setCompleted((prev) => [
              ...prev,
              { kind: "text", role: "assistant", text: `\n  Error: ${msg}\n` },
            ]);
          }

          setMode("input");
          setStreamingText("");
          setStreamingThinking("");
          setIsThinking(false);
          setLoadingMessage("");
          const state = conversationManager.getState();
          setTokenCount(state.tokenCount);
          setToolUseCount(state.toolUseCount);
          return;
        }

        // Unknown slash command
        setCompleted((prev) => [
          ...prev,
          { kind: "text", role: "user", text: userInput },
          {
            kind: "text",
            role: "assistant",
            text: `\n  Unknown command: ${userInput}. Type /help for available commands.\n`,
          },
        ]);
        return;
      }

      // Add user message to display
      setCompleted((prev) => [...prev, { kind: "text", role: "user", text: userInput }]);

      // Start response
      setMode("responding");
      setStreamingText("");
      setTurnTokens(0);
      setTurnStartTime(Date.now());
      setSpinnerPhase("thinking");
      setLoadingMessage("Thinking...");

      try {
        const events = conversationManager.sendMessage(userInput);
        await processEvents(events);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        setCompleted((prev) => [
          ...prev,
          { kind: "text", role: "assistant", text: `\n  Error: ${msg}\n` },
        ]);
      }

      setMode("input");
      setStreamingText("");
      setStreamingThinking("");
      setIsThinking(false);
      setLoadingMessage("");

      // Update stats
      const state = conversationManager.getState();
      setTokenCount(state.tokenCount);
      setToolUseCount(state.toolUseCount);
    },
    [conversationManager, tools, skillManager, exit],
  );

  // Drain the message queue — process queued messages one by one
  const drainQueue = useCallback(async () => {
    while (messageQueueRef.current.length > 0) {
      const next = messageQueueRef.current[0];
      messageQueueRef.current = messageQueueRef.current.slice(1);
      setMessageQueue([...messageQueueRef.current]);
      await processMessage(next);
    }
  }, [processMessage]);

  const handleSubmit = useCallback(
    async (userInput: string) => {
      if (mode === "responding") {
        // Queue the message — show it as queued in the UI
        messageQueueRef.current = [...messageQueueRef.current, userInput];
        setMessageQueue([...messageQueueRef.current]);
        setCompleted((prev) => [
          ...prev,
          { kind: "text", role: "user", text: `${userInput}  [queued]` },
        ]);
        return;
      }

      await processMessage(userInput);
      // After processing, drain any queued messages
      await drainQueue();
    },
    [mode, processMessage, drainQueue],
  );

  const processEvents = useCallback(
    async (events: AsyncGenerator<StreamEvent>) => {
      let currentText = "";
      let currentThinking = "";

      for await (const event of events) {
        switch (event.type) {
          case "turn_start":
            setLoadingMessage("");
            break;

          case "text_delta":
            // Finalize any accumulated thinking when text starts
            if (currentThinking.length > 0) {
              const thinking = currentThinking;
              setIsThinking(false);
              setStreamingThinking("");
              setCompleted((prev) => [
                ...prev,
                { kind: "thinking", text: thinking },
              ]);
              currentThinking = "";
            }
            currentText += event.text;
            setStreamingText(currentText);
            break;

          case "thinking_delta":
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
              setCompleted((prev) => [
                ...prev,
                { kind: "thinking", text: thinking },
              ]);
              currentThinking = "";
            }
            // Finalize any accumulated text
            if (currentText.length > 0) {
              const text = currentText;
              setCompleted((prev) => [
                ...prev,
                { kind: "text", role: "assistant", text },
              ]);
              currentText = "";
              setStreamingText("");
            }
            break;

          case "tool_input_delta":
            // Tool input streaming - could show partial JSON; skip for now
            break;

          case "tool_executing": {
            const summary = summarizeInput(event.name, event.input);
            setCompleted((prev) => [
              ...prev,
              { kind: "tool_use", name: event.name, summary },
            ]);
            setLoadingMessage(`Running ${event.name}...`);
            setSpinnerPhase("tool");
            break;
          }

          case "tool_result":
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
            if (event.name === "Learn" && !event.isError && event.result.startsWith("✧")) {
              setCompleted((prev) => [
                ...prev,
                { kind: "learn", text: event.result.replace(/^✧\s*/, "") },
              ]);
            } else {
              setCompleted((prev) => [
                ...prev,
                {
                  kind: "tool_result",
                  name: event.name,
                  result: event.result,
                  isError: event.isError,
                },
              ]);
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
              setCompleted((prev) => [
                ...prev,
                { kind: "suggestion", suggestions: event.suggestions },
              ]);
            }
            break;

          case "turn_end":
            // Finalize any remaining thinking
            if (currentThinking.length > 0) {
              const thinking = currentThinking;
              setIsThinking(false);
              setStreamingThinking("");
              setCompleted((prev) => [
                ...prev,
                { kind: "thinking", text: thinking },
              ]);
              currentThinking = "";
            }
            // Finalize any remaining streamed text
            if (currentText.length > 0) {
              const text = currentText;
              setCompleted((prev) => [
                ...prev,
                { kind: "text", role: "assistant", text },
              ]);
              currentText = "";
              setStreamingText("");
            }
            break;
        }
      }
    },
    [],
  );

  const handlePermissionChoice = useCallback(
    (choice: PermissionChoice) => {
      if (permissionResolver) {
        permissionResolver(choice);
        setPermissionRequest(null);
        setPermissionResolver(null);
        setMode("responding");
      }
    },
    [permissionResolver],
  );

  return (
    <Box flexDirection="column">
      <MessageList
        completed={completed}
        streamingText={streamingText}
        isLoading={mode === "responding"}
        loadingMessage={loadingMessage}
        streamingThinking={streamingThinking}
        isThinking={isThinking}
        turnTokens={turnTokens}
        turnStartTime={turnStartTime}
        spinnerPhase={spinnerPhase}
      />

      {mode === "permission" && permissionRequest && (
        <PermissionDialog
          request={permissionRequest}
          onChoice={handlePermissionChoice}
          isActive={mode === "permission"}
        />
      )}

      <InputPrompt
        onSubmit={handleSubmit}
        isActive={mode !== "permission"}
        isQueuing={mode === "responding"}
        queueSize={messageQueue.length}
        model={config.model}
        cwd={config.workingDirectory}
        completions={slashCompletions}
        commandDescriptions={commandDescriptions}
      />
    </Box>
  );
}

function summarizeInput(name: string, input: Record<string, unknown>): string {
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
    default:
      return "";
  }
}

async function handleBuiltinAction(
  action: string,
  conversationManager: ConversationManager,
  setCompleted: React.Dispatch<React.SetStateAction<MessageEntry[]>>,
  appConfig: KCodeConfig,
  args?: string,
  switchTheme?: (name: string) => void,
): Promise<string> {
  switch (action) {
    case "stats": {
      const stats = await collectStats(7);
      return formatStats(stats);
    }
    case "doctor": {
      const checks = await runDiagnostics();
      const lines = checks.map((c) => {
        const icon = c.status === "ok" ? "✓" : c.status === "warn" ? "⚠" : "✗";
        return `  ${icon} ${c.name}: ${c.message}`;
      });
      return lines.join("\n");
    }
    case "models": {
      const models = await listModels();
      const modelsConfig = await loadModelsConfig();
      if (models.length === 0) return "  No models registered. Use 'kcode models add' to register one.";
      const lines = models.map((m) => {
        const def = m.name === modelsConfig.defaultModel ? " (default)" : "";
        const ctx = m.contextSize ? `, ctx: ${m.contextSize.toLocaleString()}` : "";
        const gpu = m.gpu ? `, gpu: ${m.gpu}` : "";
        return `  ${m.name}${def} — ${m.baseUrl}${ctx}${gpu}`;
      });
      return lines.join("\n");
    }
    case "clear": {
      setCompleted([{
        kind: "banner",
        title: `KCode v${appConfig.version ?? "?"}`,
        subtitle: "Kulvex Code by Astrolexis",
      }]);
      return "  Conversation cleared.";
    }
    case "compact": {
      const state = conversationManager.getState();
      if (state.messages.length <= 4) return "  Nothing to compact (too few messages).";

      const { CompactionManager } = await import("../core/compaction.js");
      const compactor = new CompactionManager(appConfig.apiKey, appConfig.model, appConfig.apiBase);

      const keepLast = 4;
      const toPrune = state.messages.slice(0, -keepLast);
      const kept = state.messages.slice(-keepLast);

      const summary = await compactor.compact(toPrune);
      if (summary) {
        conversationManager.restoreMessages([summary, ...kept]);
        return `  Compacted ${toPrune.length} messages into summary. ${kept.length} recent messages preserved.`;
      }
      return "  Compaction failed -- conversation unchanged.";
    }
    case "context": {
      const state = conversationManager.getState();
      const usage = conversationManager.getUsage();
      const contextSize = appConfig.contextWindowSize ?? 200000;
      const usedTokens = usage.inputTokens + usage.outputTokens;
      const pct = Math.min(100, Math.round((usedTokens / contextSize) * 100));

      // Build a visual bar
      const barLen = 40;
      const filled = Math.round(barLen * pct / 100);
      const bar = "\u2588".repeat(filled) + "\u2591".repeat(barLen - filled);

      const lines = [
        `  Context: [${bar}] ${pct}%`,
        `  Tokens:  ${usedTokens.toLocaleString()} / ${contextSize.toLocaleString()}`,
        `  Input:   ${usage.inputTokens.toLocaleString()}`,
        `  Output:  ${usage.outputTokens.toLocaleString()}`,
        `  Messages: ${state.messages.length}`,
        `  Tools:   ${state.toolUseCount} calls`,
      ];
      return lines.join("\n");
    }
    case "rewind": {
      const undo = conversationManager.getUndo();
      const count = parseInt(args || "") || 1;
      const results: string[] = [];
      for (let i = 0; i < count; i++) {
        const result = undo.undo();
        if (result) {
          results.push(result);
        } else {
          break;
        }
      }
      if (results.length === 0) return "  Nothing to rewind.";
      return results.join("\n");
    }
    case "plugins": {
      const { getPluginManager } = await import("../core/plugins.js");
      return getPluginManager().formatList();
    }
    case "export": {
      const state = conversationManager.getState();
      const filename = args?.trim() || `kcode-export-${new Date().toISOString().slice(0, 19).replace(/[:.]/g, "-")}.md`;

      const lines: string[] = [`# KCode Conversation Export\n`, `Date: ${new Date().toISOString()}\n`];

      for (const msg of state.messages) {
        if (typeof msg.content === "string") {
          lines.push(`## ${msg.role === "user" ? "User" : "Assistant"}\n`, msg.content, "");
        } else {
          for (const block of msg.content) {
            if (block.type === "text") {
              lines.push(`## ${msg.role === "user" ? "User" : "Assistant"}\n`, block.text, "");
            } else if (block.type === "tool_use") {
              lines.push(`### Tool: ${block.name}\n`, "```json", JSON.stringify(block.input, null, 2), "```", "");
            } else if (block.type === "tool_result") {
              const content = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
              lines.push(`### Result${block.is_error ? " (Error)" : ""}\n`, "```", content.slice(0, 1000), "```", "");
            }
          }
        }
      }

      const { writeFileSync } = await import("node:fs");
      writeFileSync(filename, lines.join("\n"), "utf-8");
      return `  Exported ${state.messages.length} messages to ${filename}`;
    }
    case "theme": {
      const available = getAvailableThemes();
      const current = getCurrentThemeName();
      const themeName = args?.trim();

      if (!themeName) {
        // List all themes with the current one marked
        const lines = ["  Available themes:"];
        for (const name of available) {
          const marker = name === current ? " (active)" : "";
          lines.push(`  ${name}${marker}`);
        }
        lines.push("");
        lines.push("  Usage: /theme <name>");
        return lines.join("\n");
      }

      if (available.includes(themeName)) {
        if (switchTheme) switchTheme(themeName);
        return `  Theme switched to: ${themeName}`;
      }

      return `  Unknown theme "${themeName}". Available: ${available.join(", ")}`;
    }
    case "usage": {
      const usage = conversationManager.getUsage();
      const state = conversationManager.getState();
      const contextSize = appConfig.contextWindowSize ?? 200000;
      const totalTokens = usage.inputTokens + usage.outputTokens;

      const { getModelPricing, calculateCost, formatCost } = await import("../core/pricing.js");
      const pricing = await getModelPricing(appConfig.model);
      const cost = pricing ? calculateCost(pricing, usage.inputTokens, usage.outputTokens) : 0;

      const lines = [
        `  Session Token Usage`,
        ``,
        `  Input tokens:   ${usage.inputTokens.toLocaleString()}`,
        `  Output tokens:  ${usage.outputTokens.toLocaleString()}`,
        `  Total tokens:   ${totalTokens.toLocaleString()}`,
        `  Cache created:  ${usage.cacheCreationInputTokens.toLocaleString()}`,
        `  Cache read:     ${usage.cacheReadInputTokens.toLocaleString()}`,
        ``,
        `  Messages:       ${state.messages.length}`,
        `  Tool calls:     ${state.toolUseCount}`,
        `  Context window: ${totalTokens.toLocaleString()} / ${contextSize.toLocaleString()} (${Math.round((totalTokens / contextSize) * 100)}%)`,
        ``,
        `  Model:  ${appConfig.model}`,
        `  Cost:   ${formatCost(cost)}`,
      ];
      if (pricing) {
        lines.push(`  Rate:   $${pricing.inputPer1M}/M in, $${pricing.outputPer1M}/M out`);
      }
      return lines.join("\n");
    }
    case "plan": {
      const { getActivePlan, formatPlan, executePlan: execPlan } = await import("../tools/plan.js");

      if (args?.trim() === "clear") {
        await execPlan({ mode: "clear" });
        return "  Plan cleared.";
      }

      const plan = getActivePlan();
      if (!plan) return "  No active plan. The AI will create one when tackling multi-step tasks.";
      return "  " + formatPlan(plan).split("\n").join("\n  ");
    }
    case "changes": {
      const files = conversationManager.getModifiedFiles();
      if (files.length === 0) return "  No files modified in this session.";

      const { execSync } = await import("node:child_process");
      const lines = [`  Files modified this session (${files.length}):\n`];

      for (const f of files) {
        // Try to get a short git diff stat for each file
        let diffStat = "";
        try {
          diffStat = execSync(`git diff --stat -- "${f}" 2>/dev/null`, {
            cwd: appConfig.workingDirectory,
            timeout: 3000,
          }).toString().trim();
        } catch { /* not in git or no changes */ }

        if (diffStat) {
          lines.push(`  ${f}`);
          for (const dl of diffStat.split("\n")) {
            lines.push(`    ${dl}`);
          }
        } else {
          lines.push(`  ${f}`);
        }
      }

      // Overall summary if in a git repo
      try {
        const summary = execSync("git diff --stat 2>/dev/null", {
          cwd: appConfig.workingDirectory,
          timeout: 3000,
        }).toString().trim();
        if (summary) {
          lines.push("");
          lines.push(`  ${summary.split("\n").pop() ?? ""}`);
        }
      } catch { /* ignore */ }

      return lines.join("\n");
    }
    case "pin": {
      const { resolve } = await import("node:path");
      const { pinFile, listPinnedFiles } = await import("../core/context-pin.js");

      if (!args?.trim()) {
        const pinned = listPinnedFiles();
        if (pinned.length === 0) return "  No pinned files. Usage: /pin <file-path>";
        const lines = ["  Pinned files:"];
        for (const p of pinned) {
          lines.push(`    ${p.path} (${p.size} chars)`);
        }
        return lines.join("\n");
      }

      const filePath = resolve(appConfig.workingDirectory, args.trim());
      const result = pinFile(filePath, appConfig.workingDirectory);
      return `  ${result.message}`;
    }
    case "unpin": {
      const { resolve } = await import("node:path");
      const { unpinFile, clearPinnedFiles } = await import("../core/context-pin.js");

      if (args?.trim() === "all") {
        clearPinnedFiles();
        return "  All files unpinned.";
      }

      if (!args?.trim()) return "  Usage: /unpin <file-path> or /unpin all";

      const filePath = resolve(appConfig.workingDirectory, args.trim());
      const result = unpinFile(filePath, appConfig.workingDirectory);
      return `  ${result.message}`;
    }
    case "index": {
      const { getCodebaseIndex } = await import("../core/codebase-index.js");
      const idx = getCodebaseIndex(appConfig.workingDirectory);

      if (!args?.trim()) {
        const count = idx.build();
        const stats = idx.getStats();
        const extLines = Object.entries(stats.extensions)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8)
          .map(([ext, n]) => `${ext}: ${n}`)
          .join(", ");
        return `  Indexed ${count} files (${stats.exportCount} exports). Types: ${extLines}`;
      }

      const results = idx.search(args.trim());
      if (results.length === 0) return `  No results for "${args.trim()}"`;

      const lines = [`  Results for "${args.trim()}" (${results.length}):`];
      for (const r of results.slice(0, 10)) {
        const exports = r.exports.length > 0 ? ` [${r.exports.slice(0, 3).join(", ")}]` : "";
        lines.push(`    ${r.relativePath}${exports}`);
      }
      return lines.join("\n");
    }
    case "hooks": {
      const { readFileSync, existsSync } = await import("node:fs");
      const { join } = await import("node:path");

      const settingsPath = join(appConfig.workingDirectory, ".kcode", "settings.json");
      if (!existsSync(settingsPath)) return "  No hooks configured. Add hooks to .kcode/settings.json";

      try {
        const raw = JSON.parse(readFileSync(settingsPath, "utf-8"));
        const hooks = raw.hooks;
        if (!hooks || Object.keys(hooks).length === 0) return "  No hooks configured.";

        const lines = ["  Configured hooks:"];
        for (const [event, configs] of Object.entries(hooks)) {
          if (!Array.isArray(configs)) continue;
          for (const config of configs as any[]) {
            const hookCount = config.hooks?.length ?? 0;
            lines.push(`  ${event} [${config.matcher}] - ${hookCount} action(s)`);
            for (const h of config.hooks ?? []) {
              lines.push(`    ${h.type}: ${h.command}`);
            }
          }
        }
        return lines.join("\n");
      } catch {
        return "  Error reading hooks config.";
      }
    }
    case "fork": {
      const keepCount = args?.trim() ? parseInt(args.trim()) : undefined;
      if (keepCount !== undefined && (isNaN(keepCount) || keepCount < 1)) {
        return "  Usage: /fork [message-number]. Number must be a positive integer.";
      }
      const result = conversationManager.forkConversation(keepCount);
      return `  Forked conversation with ${result.messageCount} messages. New transcript started.`;
    }
    case "memory": {
      const { getMemoryDir, loadAllMemories, searchMemories, readMemoryFile, deleteMemoryFile, readMemoryIndex } = await import("../core/memory.js");
      const cwd = appConfig.workingDirectory;
      const arg = args?.trim() ?? "list";

      if (arg === "list") {
        const memories = await loadAllMemories(cwd);
        if (memories.length === 0) return "  No memories found. The AI creates memories during conversations.";

        const lines = [`  Memories (${memories.length}):\n`];
        for (const m of memories) {
          const typeTag = `[${m.meta.type}]`;
          lines.push(`  ${typeTag.padEnd(12)} ${m.meta.title}  (${m.filename})`);
        }
        return lines.join("\n");
      }

      if (arg.startsWith("search ")) {
        const query = arg.slice(7).trim();
        if (!query) return "  Usage: /memory search <query>";

        const results = await searchMemories(cwd, query);
        if (results.length === 0) return `  No memories matching "${query}"`;

        const lines = [`  Search results for "${query}" (${results.length}):\n`];
        for (const m of results) {
          lines.push(`  [${m.meta.type}] ${m.meta.title}  (${m.filename})`);
        }
        return lines.join("\n");
      }

      if (arg.startsWith("show ")) {
        const filename = arg.slice(5).trim();
        const { join } = await import("node:path");
        const dir = getMemoryDir(cwd);
        const entry = await readMemoryFile(join(dir, filename));
        if (!entry) return `  Memory file "${filename}" not found.`;

        const lines = [
          `  ${entry.meta.title}`,
          `  Type: ${entry.meta.type}`,
          entry.meta.tags ? `  Tags: ${entry.meta.tags.join(", ")}` : null,
          entry.meta.created ? `  Created: ${entry.meta.created}` : null,
          ``,
          entry.content,
        ].filter(Boolean);
        return (lines as string[]).join("\n");
      }

      if (arg.startsWith("delete ")) {
        const filename = arg.slice(7).trim();
        const { join } = await import("node:path");
        const dir = getMemoryDir(cwd);
        const deleted = await deleteMemoryFile(join(dir, filename));
        return deleted ? `  Deleted: ${filename}` : `  File "${filename}" not found.`;
      }

      if (arg === "index") {
        const index = await readMemoryIndex(cwd);
        return index ? `  MEMORY.md:\n\n${index}` : "  No MEMORY.md index found.";
      }

      return "  Usage: /memory list | search <query> | show <file> | delete <file> | index";
    }
    default:
      return `  Unknown built-in action: ${action}`;
  }
}
