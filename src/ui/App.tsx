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
    names.push("/exit", "/quit", "/status", "/undo", "/rewind", "/usage", "/plan", "/hooks", "/changes", "/fork", "/memory", "/branches", "/compare", "/bookmark", "/analytics", "/consensus", "/search-chat", "/auto-test", "/stashes");
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
    descs["/branches"] = "Show conversation fork history";
    descs["/compare"] = "Compare responses from two models";
    descs["/bookmark"] = "Set or jump to conversation bookmarks";
    descs["/analytics"] = "Show tool usage analytics";
    descs["/consensus"] = "Query multiple models for consensus";
    descs["/search-chat"] = "Search through conversation messages";
    descs["/auto-test"] = "Find and run tests for modified files";
    descs["/stashes"] = "List, show, apply, or drop git stashes";
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
  const [sessionStart] = useState(() => Date.now());

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
        const sessionElapsed = Date.now() - sessionStart;
        const formatTime = (ms: number) => {
          const secs = Math.floor(ms / 1000);
          if (secs < 60) return `${secs}s`;
          const mins = Math.floor(secs / 60);
          if (mins < 60) return `${mins}m${(secs % 60).toString().padStart(2, "0")}s`;
          const hours = Math.floor(mins / 60);
          return `${hours}h${(mins % 60).toString().padStart(2, "0")}m`;
        };
        setCompleted((prev) => [
          ...prev,
          { kind: "text", role: "user", text: userInput },
          {
            kind: "text",
            role: "assistant",
            text: `  Messages: ${state.messages.length}\n  Tokens: ${usage.inputTokens + usage.outputTokens} (in: ${usage.inputTokens}, out: ${usage.outputTokens})\n  Tool uses: ${state.toolUseCount}\n  Session: ${formatTime(sessionElapsed)}`,
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
    case "branches": {
      const tm = new (await import("../core/transcript.js")).TranscriptManager();
      const sessions = tm.listSessions();

      if (sessions.length === 0) return "  No saved sessions.";

      // Find forked sessions (those starting with [FORK])
      const lines: string[] = ["  Conversation History:\n"];
      const recent = sessions.slice(0, 20);

      for (let i = 0; i < recent.length; i++) {
        const s = recent[i];
        const isFork = s.prompt.includes("fork");
        const prefix = isFork ? "  \u251C\u2500 " : "  \u2502  ";
        const icon = isFork ? "\u2442" : "\u25CF";
        const date = s.startedAt.replace(/T/g, " ").slice(0, 16);
        lines.push(`${prefix}${icon} ${date}  ${s.prompt.slice(0, 50)}`);
        lines.push(`${prefix}  ${s.filename}`);
      }

      if (sessions.length > 20) {
        lines.push(`\n  ... and ${sessions.length - 20} more sessions`);
      }

      lines.push(`\n  Resume: /resume or kcode --continue`);
      lines.push(`  Fork:   /fork [N] or kcode --fork`);
      return lines.join("\n");
    }
    case "compare": {
      if (!args?.trim()) return "  Usage: /compare <model1> <model2> <prompt>\n  Example: /compare gpt-4o claude-sonnet-4-6 explain this code";

      const parts = args.trim().split(/\s+/);
      if (parts.length < 3) return "  Usage: /compare <model1> <model2> <prompt>";

      const model1 = parts[0];
      const model2 = parts[1];
      const prompt = parts.slice(2).join(" ");

      const { getModelBaseUrl } = await import("../core/models.js");

      const lines: string[] = [`  Comparing: ${model1} vs ${model2}\n  Prompt: "${prompt.slice(0, 60)}${prompt.length > 60 ? "..." : ""}"\n`];

      // Send to both models in parallel
      const fetchModel = async (model: string): Promise<{ text: string; tokens: number; timeMs: number }> => {
        const baseUrl = await getModelBaseUrl(model) ?? appConfig.apiBase ?? "http://localhost:10091";
        const start = Date.now();
        try {
          const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(appConfig.apiKey ? { "Authorization": `Bearer ${appConfig.apiKey}` } : {}),
            },
            body: JSON.stringify({
              model,
              messages: [{ role: "user", content: prompt }],
              max_tokens: 512,
              stream: false,
            }),
            signal: AbortSignal.timeout(30000),
          });
          const data = await resp.json() as any;
          const text = data.choices?.[0]?.message?.content ?? "(no response)";
          const tokens = data.usage?.total_tokens ?? 0;
          return { text, tokens, timeMs: Date.now() - start };
        } catch (err) {
          return { text: `Error: ${err instanceof Error ? err.message : String(err)}`, tokens: 0, timeMs: Date.now() - start };
        }
      };

      const [r1, r2] = await Promise.all([fetchModel(model1), fetchModel(model2)]);

      lines.push(`  \u250C\u2500\u2500 ${model1} (${r1.timeMs}ms, ${r1.tokens} tok) \u2500\u2500`);
      for (const line of r1.text.split("\n").slice(0, 15)) {
        lines.push(`  \u2502 ${line}`);
      }
      if (r1.text.split("\n").length > 15) lines.push(`  \u2502 ... (truncated)`);
      lines.push(`  \u2514${"\u2500".repeat(40)}`);
      lines.push(``);
      lines.push(`  \u250C\u2500\u2500 ${model2} (${r2.timeMs}ms, ${r2.tokens} tok) \u2500\u2500`);
      for (const line of r2.text.split("\n").slice(0, 15)) {
        lines.push(`  \u2502 ${line}`);
      }
      if (r2.text.split("\n").length > 15) lines.push(`  \u2502 ... (truncated)`);
      lines.push(`  \u2514${"\u2500".repeat(40)}`);

      // Summary
      const faster = r1.timeMs < r2.timeMs ? model1 : model2;
      lines.push(`\n  Faster: ${faster} (${Math.abs(r1.timeMs - r2.timeMs)}ms difference)`);

      return lines.join("\n");
    }
    case "export": {
      const state = conversationManager.getState();
      const rawFilename = args?.trim() || "";
      const timestamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, "-");

      // Detect format from extension or flag
      let format = "md";
      let filename = rawFilename;

      if (rawFilename.endsWith(".json")) format = "json";
      else if (rawFilename.endsWith(".html")) format = "html";
      else if (rawFilename === "json") { format = "json"; filename = ""; }
      else if (rawFilename === "html") { format = "html"; filename = ""; }

      if (!filename || filename === "json" || filename === "html" || filename === "md") {
        filename = `kcode-export-${timestamp}.${format}`;
      }

      const { writeFileSync } = await import("node:fs");

      if (format === "json") {
        // JSON export — structured data
        const exported = {
          version: appConfig.version,
          model: appConfig.model,
          exportedAt: new Date().toISOString(),
          messageCount: state.messages.length,
          messages: state.messages.map(msg => {
            if (typeof msg.content === "string") {
              return { role: msg.role, content: msg.content };
            }
            return {
              role: msg.role,
              blocks: msg.content.map(b => {
                if (b.type === "text") return { type: "text", text: b.text };
                if (b.type === "tool_use") return { type: "tool_use", name: b.name, input: b.input };
                if (b.type === "tool_result") return { type: "tool_result", content: typeof b.content === "string" ? b.content.slice(0, 500) : "[complex]", isError: b.is_error };
                return { type: b.type };
              }),
            };
          }),
        };
        writeFileSync(filename, JSON.stringify(exported, null, 2), "utf-8");
        return `  Exported ${state.messages.length} messages to ${filename} (JSON)`;
      }

      if (format === "html") {
        // HTML export — shareable page
        const htmlLines: string[] = [
          '<!DOCTYPE html>',
          '<html><head><meta charset="utf-8"><title>KCode Conversation</title>',
          '<style>body{font-family:monospace;max-width:800px;margin:2em auto;background:#1e1e2e;color:#cdd6f4}',
          '.user{background:#313244;padding:1em;border-radius:8px;margin:1em 0;border-left:3px solid #89b4fa}',
          '.assistant{background:#181825;padding:1em;border-radius:8px;margin:1em 0;border-left:3px solid #a6e3a1}',
          '.tool{background:#1e1e2e;padding:0.5em 1em;border-radius:4px;margin:0.5em 0;border-left:3px solid #fab387;font-size:0.9em;color:#a6adc8}',
          'pre{background:#11111b;padding:1em;border-radius:4px;overflow-x:auto}',
          'h1{color:#cba6f7}h2{color:#89b4fa}</style></head><body>',
          `<h1>KCode Conversation</h1>`,
          `<p style="color:#6c7086">Model: ${appConfig.model} | Date: ${new Date().toISOString()} | Messages: ${state.messages.length}</p>`,
        ];

        for (const msg of state.messages) {
          if (typeof msg.content === "string") {
            const cls = msg.role === "user" ? "user" : "assistant";
            const escaped = msg.content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
            htmlLines.push(`<div class="${cls}"><strong>${msg.role}:</strong><br>${escaped}</div>`);
          } else {
            for (const block of msg.content) {
              if (block.type === "text") {
                const cls = msg.role === "user" ? "user" : "assistant";
                const escaped = block.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
                htmlLines.push(`<div class="${cls}"><strong>${msg.role}:</strong><br>${escaped}</div>`);
              } else if (block.type === "tool_use") {
                const inputStr = JSON.stringify(block.input).slice(0, 200).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
                htmlLines.push(`<div class="tool">⚡ ${block.name}: ${inputStr}</div>`);
              } else if (block.type === "tool_result") {
                const content = typeof block.content === "string" ? block.content.slice(0, 300) : "[complex]";
                const escaped = content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
                htmlLines.push(`<div class="tool">✓ ${escaped}</div>`);
              }
            }
          }
        }

        htmlLines.push('<p style="color:#6c7086;text-align:center;margin-top:2em">Exported by KCode (Kulvex Code by Astrolexis)</p>');
        htmlLines.push('</body></html>');
        writeFileSync(filename, htmlLines.join("\n"), "utf-8");
        return `  Exported ${state.messages.length} messages to ${filename} (HTML)`;
      }

      // Default: Markdown export (existing behavior)
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
    case "bookmark": {
      const { addBookmark, loadBookmarks, getBookmark, removeBookmark } = await import("../core/bookmarks.js");
      const arg = args?.trim() ?? "list";
      const state = conversationManager.getState();

      if (arg === "list") {
        const bookmarks = loadBookmarks();
        if (bookmarks.length === 0) return "  No bookmarks set. Usage: /bookmark <label>";
        const lines = ["  Bookmarks:\n"];
        for (const b of bookmarks) {
          lines.push(`  \u{1F4CC} ${b.label} \u2014 msg #${b.messageIndex} (${b.timestamp.slice(0, 16)})`);
          lines.push(`     ${b.preview}`);
        }
        return lines.join("\n");
      }

      if (arg.startsWith("goto ")) {
        const label = arg.slice(5).trim();
        const bookmark = getBookmark(label);
        if (!bookmark) return `  Bookmark "${label}" not found.`;

        // Truncate conversation to bookmark point
        const msgCount = bookmark.messageIndex;
        if (msgCount >= state.messages.length) return `  Bookmark "${label}" points beyond current conversation.`;

        conversationManager.restoreMessages(state.messages.slice(0, msgCount));
        return `  Jumped to bookmark "${label}" (message #${msgCount}). ${state.messages.length - msgCount} messages removed.`;
      }

      if (arg.startsWith("delete ")) {
        const label = arg.slice(7).trim();
        const removed = removeBookmark(label);
        return removed ? `  Deleted bookmark "${label}"` : `  Bookmark "${label}" not found.`;
      }

      // Set a bookmark at the current position
      const label = arg;
      const lastMsg = state.messages[state.messages.length - 1];
      const preview = typeof lastMsg?.content === "string" ? lastMsg.content : "[complex message]";
      const bookmark = addBookmark(label, state.messages.length, preview);
      return `  \u{1F4CC} Bookmark "${label}" set at message #${bookmark.messageIndex}`;
    }
    case "analytics": {
      const state = conversationManager.getState();
      const usage = conversationManager.getUsage();

      // Count tool usage from messages
      const toolCounts: Record<string, number> = {};
      const toolErrors: Record<string, number> = {};
      let totalToolCalls = 0;

      for (const msg of state.messages) {
        if (!Array.isArray(msg.content)) continue;
        for (const block of msg.content) {
          if (block.type === "tool_use") {
            totalToolCalls++;
            toolCounts[block.name] = (toolCounts[block.name] ?? 0) + 1;
          }
          if (block.type === "tool_result" && block.is_error) {
            // Try to find the corresponding tool_use
            const prevMsg = state.messages.find(m =>
              Array.isArray(m.content) && m.content.some(b =>
                b.type === "tool_use" && b.id === block.tool_use_id
              )
            );
            if (prevMsg && Array.isArray(prevMsg.content)) {
              const toolBlock = prevMsg.content.find(b => b.type === "tool_use" && b.id === block.tool_use_id);
              if (toolBlock && toolBlock.type === "tool_use") {
                toolErrors[toolBlock.name] = (toolErrors[toolBlock.name] ?? 0) + 1;
              }
            }
          }
        }
      }

      if (totalToolCalls === 0) return "  No tool calls in this session yet.";

      // Sort by usage
      const sorted = Object.entries(toolCounts).sort((a, b) => b[1] - a[1]);
      const maxNameLen = Math.max(...sorted.map(([n]) => n.length), 8);

      // Build bar chart
      const maxCount = sorted[0]?.[1] ?? 1;
      const barWidth = 20;

      const lines = [
        `  Session Analytics`,
        ``,
        `  Messages:    ${state.messages.length}`,
        `  Tool calls:  ${totalToolCalls}`,
        `  Tokens:      ${(usage.inputTokens + usage.outputTokens).toLocaleString()}`,
        ``,
        `  Tool Usage:`,
      ];

      for (const [name, count] of sorted) {
        const pct = Math.round((count / totalToolCalls) * 100);
        const filled = Math.round((count / maxCount) * barWidth);
        const bar = "\u2588".repeat(filled) + "\u2591".repeat(barWidth - filled);
        const errors = toolErrors[name] ? ` (${toolErrors[name]} err)` : "";
        lines.push(`  ${name.padEnd(maxNameLen)} ${bar} ${count} (${pct}%)${errors}`);
      }

      // Error rate
      const totalErrors = Object.values(toolErrors).reduce((a, b) => a + b, 0);
      if (totalErrors > 0) {
        lines.push(``);
        lines.push(`  Error rate: ${totalErrors}/${totalToolCalls} (${Math.round((totalErrors / totalToolCalls) * 100)}%)`);
      }

      return lines.join("\n");
    }
    case "consensus": {
      if (!args?.trim()) return "  Usage: /consensus <prompt>\n  Sends to all registered models and synthesizes responses.";

      const prompt = args.trim();
      const { listModels: getModels } = await import("../core/models.js");
      const models = await getModels();

      if (models.length < 2) return "  Need at least 2 registered models for consensus. Use 'kcode models add' to register models.";

      // Use up to 4 models
      const selectedModels = models.slice(0, 4);
      const lines: string[] = [`  Consensus query across ${selectedModels.length} models\n  Prompt: "${prompt.slice(0, 60)}${prompt.length > 60 ? "..." : ""}"\n`];

      // Query all models in parallel
      const fetchModel = async (model: { name: string; baseUrl: string }): Promise<{ name: string; text: string; timeMs: number }> => {
        const start = Date.now();
        try {
          const resp = await fetch(`${model.baseUrl}/v1/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(appConfig.apiKey ? { "Authorization": `Bearer ${appConfig.apiKey}` } : {}),
            },
            body: JSON.stringify({
              model: model.name,
              messages: [{ role: "user", content: prompt }],
              max_tokens: 512,
              stream: false,
            }),
            signal: AbortSignal.timeout(30000),
          });
          const data = await resp.json() as any;
          return { name: model.name, text: data.choices?.[0]?.message?.content ?? "(no response)", timeMs: Date.now() - start };
        } catch (err) {
          return { name: model.name, text: `Error: ${err instanceof Error ? err.message : String(err)}`, timeMs: Date.now() - start };
        }
      };

      const results = await Promise.all(selectedModels.map(m => fetchModel(m)));

      // Show individual responses
      for (const r of results) {
        lines.push(`  \u2500\u2500 ${r.name} (${r.timeMs}ms) \u2500\u2500`);
        const preview = r.text.split("\n").slice(0, 8).join("\n");
        for (const line of preview.split("\n")) {
          lines.push(`  ${line}`);
        }
        if (r.text.split("\n").length > 8) lines.push(`  ... (truncated)`);
        lines.push(``);
      }

      // Simple agreement check
      const validResults = results.filter(r => !r.text.startsWith("Error:"));
      if (validResults.length >= 2) {
        // Check if responses are similar (basic: compare first 100 chars lowercase)
        const normalized = validResults.map(r => r.text.toLowerCase().slice(0, 100));
        const allSimilar = normalized.every(n => {
          const words1 = new Set(n.split(/\s+/));
          const words2 = new Set(normalized[0].split(/\s+/));
          const overlap = [...words1].filter(w => words2.has(w)).length;
          return overlap / Math.max(words1.size, words2.size) > 0.3;
        });

        lines.push(`  \u2500\u2500 Consensus \u2500\u2500`);
        if (allSimilar) {
          lines.push(`  \u2713 Models broadly agree.`);
        } else {
          lines.push(`  \u26A0 Models gave divergent responses \u2014 review individually.`);
        }

        // Show fastest
        const fastest = validResults.reduce((a, b) => a.timeMs < b.timeMs ? a : b);
        lines.push(`  Fastest: ${fastest.name} (${fastest.timeMs}ms)`);
      }

      return lines.join("\n");
    }
    case "search_chat": {
      if (!args?.trim()) return "  Usage: /search-chat <query>";

      const query = args.trim().toLowerCase();
      const state = conversationManager.getState();
      const matches: string[] = [];

      for (let i = 0; i < state.messages.length; i++) {
        const msg = state.messages[i];
        let texts: string[] = [];

        if (typeof msg.content === "string") {
          texts.push(msg.content);
        } else {
          for (const block of msg.content) {
            if (block.type === "text") texts.push(block.text);
            else if (block.type === "tool_use") texts.push(`${block.name}: ${JSON.stringify(block.input).slice(0, 200)}`);
          }
        }

        for (const text of texts) {
          if (text.toLowerCase().includes(query)) {
            const lineIdx = text.toLowerCase().indexOf(query);
            const start = Math.max(0, lineIdx - 40);
            const end = Math.min(text.length, lineIdx + query.length + 40);
            const snippet = (start > 0 ? "..." : "") + text.slice(start, end).replace(/\n/g, " ") + (end < text.length ? "..." : "");
            matches.push(`  #${i + 1} [${msg.role}] ${snippet}`);
            break; // One match per message
          }
        }
      }

      if (matches.length === 0) return `  No matches for "${args.trim()}" in ${state.messages.length} messages.`;

      return [`  Search: "${args.trim()}" (${matches.length} matches)\n`, ...matches.slice(0, 20)].join("\n") +
        (matches.length > 20 ? `\n  ... and ${matches.length - 20} more` : "");
    }
    case "auto_test": {
      const { getTestSuggestionsForFiles } = await import("../core/auto-test.js");
      const files = conversationManager.getModifiedFiles();

      if (files.length === 0) return "  No files modified in this session.";

      const suggestions = getTestSuggestionsForFiles(files, appConfig.workingDirectory);
      if (suggestions.length === 0) return `  No related test files found for ${files.length} modified file(s).`;

      const lines = [`  Found ${suggestions.length} test file(s) for modified code:\n`];
      for (const s of suggestions) {
        lines.push(`  ${s.sourceFile}`);
        lines.push(`    Test: ${s.testFile}`);
        lines.push(`    Run:  ${s.command}\n`);
      }
      lines.push(`  Run all: paste the commands above, or use /test`);
      return lines.join("\n");
    }
    case "stashes": {
      const { execSync } = await import("node:child_process");
      const arg = args?.trim() ?? "list";
      const cwd = appConfig.workingDirectory;

      // Validate stash index to prevent command injection
      const validateIndex = (s: string): string | null => {
        const trimmed = s.trim();
        if (/^\d+$/.test(trimmed)) return trimmed;
        return null;
      };

      try {
        if (arg === "list" || !arg) {
          const output = execSync("git stash list 2>/dev/null", { cwd, timeout: 5000 }).toString().trim();
          if (!output) return "  No stashes found.";

          const lines = ["  Git Stashes:\n"];
          for (const line of output.split("\n")) {
            // Format: stash@{0}: WIP on branch: message
            const match = line.match(/^(stash@\{(\d+)\}):\s*(.+)$/);
            if (match) {
              lines.push(`  [${match[2]}] ${match[3]}`);
              // Get stat for this stash
              try {
                const stat = execSync(`git stash show stash@{${match[2]}} --stat 2>/dev/null`, { cwd, timeout: 3000 }).toString().trim();
                const lastLine = stat.split("\n").pop() ?? "";
                lines.push(`      ${lastLine}`);
              } catch { /* ignore */ }
            } else {
              lines.push(`  ${line}`);
            }
          }
          return lines.join("\n");
        }

        if (arg.startsWith("show ")) {
          const n = validateIndex(arg.slice(5));
          if (n === null) return "  Usage: /stashes show <number>";
          const diff = execSync(`git stash show -p stash@{${n}} 2>&1`, { cwd, timeout: 5000 }).toString().trim();
          if (!diff) return `  Stash @{${n}} is empty or not found.`;
          // Truncate long diffs
          const lines = diff.split("\n");
          const preview = lines.slice(0, 40).join("\n");
          return `  Stash @{${n}}:\n\n${preview}${lines.length > 40 ? `\n  ... ${lines.length - 40} more lines` : ""}`;
        }

        if (arg === "pop") {
          const output = execSync("git stash pop 2>&1", { cwd, timeout: 10000 }).toString().trim();
          return `  ${output}`;
        }

        if (arg.startsWith("apply ")) {
          const n = validateIndex(arg.slice(6));
          if (n === null) return "  Usage: /stashes apply <number>";
          const output = execSync(`git stash apply stash@{${n}} 2>&1`, { cwd, timeout: 10000 }).toString().trim();
          return `  ${output}`;
        }

        if (arg.startsWith("drop ")) {
          const n = validateIndex(arg.slice(5));
          if (n === null) return "  Usage: /stashes drop <number>";
          const output = execSync(`git stash drop stash@{${n}} 2>&1`, { cwd, timeout: 5000 }).toString().trim();
          return `  ${output}`;
        }

        return "  Usage: /stashes [list | show <n> | apply <n> | pop | drop <n>]";
      } catch (err: any) {
        return `  Git error: ${err.stderr?.toString() || err.message}`;
      }
    }
    default:
      return `  Unknown built-in action: ${action}`;
  }
}
