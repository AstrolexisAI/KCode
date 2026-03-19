// KCode - Main Ink application component
// Top-level component managing conversation flow and rendering

import React, { useState, useCallback, useRef, useEffect } from "react";
import { Box, Text, useInput, useApp } from "ink";
import type { ConversationManager } from "../core/conversation.js";
import type { KCodeConfig, StreamEvent, PermissionMode } from "../core/types.js";
import type { ToolRegistry } from "../core/tool-registry.js";
import { SkillManager } from "../core/skills.js";
import { collectStats, formatStats } from "../core/stats.js";
import { runDiagnostics } from "../core/doctor.js";
import { listModels, loadModelsConfig } from "../core/models.js";
import { getAvailableThemes, getCurrentThemeName } from "../core/theme.js";
import { useTheme } from "./ThemeContext.js";

import { getFileChangeSuggester } from "../core/file-watcher.js";
import { setTrustPromptCallback } from "../core/hooks.js";
import Header from "./components/Header.js";
import ToolTabs from "./components/ToolTabs.js";
import MessageList, { type MessageEntry } from "./components/MessageList.js";
import KodiCompanion, { type KodiEvent } from "./components/Kodi.js";
import InputPrompt from "./components/InputPrompt.js";
import PermissionDialog, {
  type PermissionRequest,
  type PermissionChoice,
} from "./components/PermissionDialog.js";
import ContextGrid from "./components/ContextGrid.js";
import CloudMenu, { type CloudResult } from "./components/CloudMenu.js";
import ModelToggle, { type ModelToggleResult } from "./components/ModelToggle.js";

interface AppProps {
  config: KCodeConfig;
  conversationManager: ConversationManager;
  tools: ToolRegistry;
  initialSessionName?: string;
}

type AppMode = "input" | "responding" | "permission" | "cloud" | "toggle";

export default function App({ config, conversationManager, tools, initialSessionName }: AppProps) {
  const { exit } = useApp();
  const { switchTheme } = useTheme();
  // Skills manager - created once per component instance
  const [skillManager] = useState(() => {
    const sm = new SkillManager(config.workingDirectory);
    sm.load();
    return sm;
  });

  // Build completions list from skills (slash commands + aliases)
  // Uses a Set to guarantee no duplicates regardless of source
  const [slashCompletions] = useState(() => {
    const names = new Set<string>();
    for (const skill of skillManager.listSkills()) {
      names.add("/" + skill.name);
      for (const alias of skill.aliases) {
        names.add("/" + alias);
      }
    }
    // Add built-in non-skill commands (not registered in skillManager)
    names.add("/exit");
    names.add("/quit");
    names.add("/status");
    names.add("/cloud");
    names.add("/api-key");
    names.add("/provider");
    names.add("/toggle");
    names.add("/model");
    names.add("/switch");
    names.add("/plugin");
    names.add("/plugins");
    names.add("/hookify");
    names.add("/marketplace");
    return [...names].sort();
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
    descs["/cloud"] = "Configure cloud API providers (Anthropic, OpenAI, Gemini, etc.)";
    descs["/api-key"] = "Configure cloud API providers";
    descs["/provider"] = "Configure cloud API providers";
    descs["/toggle"] = "Switch between local and cloud models";
    descs["/model"] = "Switch between local and cloud models";
    descs["/switch"] = "Switch between local and cloud models";
    descs["/plugin"] = "Install, list, or remove plugins";
    descs["/plugins"] = "Install, list, or remove plugins";
    descs["/hookify"] = "Manage dynamic hookify rules (create, list, toggle, delete, test)";
    descs["/marketplace"] = "Browse and install plugins from the marketplace";
    return descs;
  });

  const [mode, setMode] = useState<AppMode>("input");
  const [completed, setCompleted] = useState<MessageEntry[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [streamingThinking, setStreamingThinking] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState("");
  const [tokenCount, setTokenCount] = useState(0);
  const [turnTokens, setTurnTokens] = useState(0);
  const [turnStartTime, setTurnStartTime] = useState(0);
  const [spinnerPhase, setSpinnerPhase] = useState<"thinking" | "streaming" | "tool">("thinking");
  const [toolUseCount, setToolUseCount] = useState(0);
  const [runningAgentCount, setRunningAgentCount] = useState(0);
  const [activeTabs, setActiveTabs] = useState<Array<{ toolUseId: string; name: string; summary: string; status: "queued" | "running" | "done" | "error"; startTime: number; durationMs?: number }>>([]);
  const [bashStreamOutput, setBashStreamOutput] = useState("");
  const tabRemovalTimers = React.useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const [selectedTabIndex, setSelectedTabIndex] = useState(0);
  const [sessionStart] = useState(() => Date.now());
  const [sessionNotes, setSessionNotes] = useState<Array<{ time: string; text: string }>>([]);
  const [watcherSuggestions, setWatcherSuggestions] = useState<string[]>([]);
  const [sessionName, setSessionName] = useState<string>(initialSessionName ?? "");
  const [sessionTags, setSessionTags] = useState<string[]>([]);
  const [showContextGrid, setShowContextGrid] = useState(false);
  const [lastKodiEvent, setLastKodiEvent] = useState<KodiEvent | null>(null);
  const lastUserPromptRef = useRef<string>("");
  const commandDepthRef = useRef<number>(0);
  const telemetryPromptShownRef = useRef<boolean>(false);

  // Multiline input buffer — accumulates lines when user ends with backslash
  const multilineBufferRef = useRef<string[]>([]);

  // (savedPermMode removed — Shift+Tab now cycles through modes)

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

  // Wire up trust prompt callback so project hooks auto-trust with logging
  useEffect(() => {
    setTrustPromptCallback(async (workspacePath, _command) => {
      setCompleted((prev) => [
        ...prev,
        { kind: "system" as const, text: `Trusting workspace: ${workspacePath}` },
      ]);
      return true;
    });
  }, []);

  // Cleanup tab removal timers on unmount
  useEffect(() => {
    return () => {
      for (const t of tabRemovalTimers.current) clearTimeout(t);
      tabRemovalTimers.current.clear();
    };
  }, []);

  // Wire file change suggester for real-time notifications
  useEffect(() => {
    const suggester = getFileChangeSuggester(config.workingDirectory);
    suggester.onSuggestion = (newSuggestions) => {
      setWatcherSuggestions((prev) => [...prev, ...newSuggestions]);
    };
    return () => {
      suggester.onSuggestion = null;
    };
  }, [config.workingDirectory]);

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
        { kind: "text", role: "assistant", text: `  Permission mode: ${labels[nextMode] ?? nextMode}` },
      ]);
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

      // ! bash mode — execute command directly, bypass LLM
      if (userInput.startsWith("!") && userInput.length > 1) {
        const cmd = userInput.slice(1).trim();
        if (!cmd) {
          setCompleted((prev) => [...prev, { kind: "text", role: "user", text: userInput }, { kind: "text", role: "assistant", text: "  Usage: !<command>" }]);
          return;
        }
        setCompleted((prev) => [...prev, { kind: "text", role: "user", text: userInput }]);
        try {
          const { execSync } = await import("node:child_process");
          let output = execSync(cmd, {
            cwd: config.workingDirectory,
            encoding: "utf-8",
            timeout: 30000,
            stdio: ["pipe", "pipe", "pipe"],
          });
          // Strip potentially dangerous OSC terminal escape sequences (window title, clipboard, etc.)
          output = output.replace(/\x1b\][^\x07]*\x07/g, "")   // OSC sequences with BEL terminator
                         .replace(/\x1b\][^\x1b]*\x1b\\/g, ""); // OSC sequences with ST terminator
          setCompleted((prev) => [...prev, { kind: "text", role: "assistant", text: output.trimEnd() || "  (no output)" }]);
        } catch (err: any) {
          const stderr = err.stderr ? String(err.stderr).trimEnd() : "";
          const stdout = err.stdout ? String(err.stdout).trimEnd() : "";
          const output = stderr || stdout || (err.message ?? "Command failed");
          setCompleted((prev) => [...prev, { kind: "text", role: "assistant", text: `  ${output}` }]);
        }
        // Don't add to conversation history — just display result
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

      // Alias resolution — check user-defined aliases before anything else
      // Guard against infinite recursion (circular aliases, self-references, chain loops)
      if (commandDepthRef.current > 10) {
        commandDepthRef.current = 0;
        setCompleted((prev) => [...prev, { kind: "text", role: "assistant", text: "  Error: Max command recursion depth (10) exceeded. Check for circular aliases." }]);
        return;
      }
      if (userInput.startsWith("/")) {
        const { resolveAlias } = await import("../core/aliases.js");
        const resolved = resolveAlias(userInput);
        if (resolved) {
          commandDepthRef.current++;
          await processMessage(resolved);
          commandDepthRef.current = 0;
          return;
        }
      }

      // /retry — re-send last user prompt
      if (lower === "/retry" || lower.startsWith("/retry ") || lower === "/again" || lower === "/redo") {
        const last = lastUserPromptRef.current;
        if (!last) {
          setCompleted((prev) => [...prev, { kind: "text", role: "user", text: userInput }, { kind: "text", role: "assistant", text: "  No previous prompt to retry." }]);
          return;
        }
        const replacement = userInput.replace(/^\/(retry|again|redo)\s*/i, "").trim();
        const toSend = replacement || last;
        setCompleted((prev) => [...prev, { kind: "text", role: "assistant", text: `  Retrying: "${toSend.slice(0, 80)}${toSend.length > 80 ? "..." : ""}"` }]);
        commandDepthRef.current++;
        await processMessage(toSend);
        commandDepthRef.current = 0;
        return;
      }

      // /note — add timestamped annotation (not sent to LLM)
      if (lower.startsWith("/note ") || lower.startsWith("/annotate ")) {
        const noteText = userInput.replace(/^\/(note|annotate)\s+/i, "").trim();
        if (!noteText) {
          setCompleted((prev) => [...prev, { kind: "text", role: "user", text: userInput }, { kind: "text", role: "assistant", text: "  Usage: /note <text>" }]);
          return;
        }
        const time = new Date().toLocaleTimeString();
        setSessionNotes((prev) => [...prev, { time, text: noteText }]);
        setCompleted((prev) => [...prev, { kind: "text", role: "user", text: userInput }, { kind: "text", role: "assistant", text: `  \u{1F4DD} [${time}] ${noteText}` }]);
        return;
      }
      if (lower === "/note" || lower === "/annotate") {
        // Show all notes
        if (sessionNotes.length === 0) {
          setCompleted((prev) => [...prev, { kind: "text", role: "user", text: userInput }, { kind: "text", role: "assistant", text: "  No notes yet. Usage: /note <text>" }]);
        } else {
          const lines = [`  Session Notes (${sessionNotes.length}):\n`, ...sessionNotes.map(n => `  [${n.time}] ${n.text}`)];
          setCompleted((prev) => [...prev, { kind: "text", role: "user", text: userInput }, { kind: "text", role: "assistant", text: lines.join("\n") }]);
        }
        return;
      }

      // /chain — run multiple slash commands in sequence
      if (lower.startsWith("/chain ") || lower.startsWith("/seq ") || lower.startsWith("/multi ")) {
        const chainBody = userInput.replace(/^\/(chain|seq|multi)\s+/i, "").trim();
        const commands = chainBody.split(/\s*;\s*/).filter(Boolean);
        if (commands.length === 0) {
          setCompleted((prev) => [...prev, { kind: "text", role: "user", text: userInput }, { kind: "text", role: "assistant", text: "  Usage: /chain /cmd1 ; /cmd2 ; /cmd3" }]);
          return;
        }
        setCompleted((prev) => [...prev, { kind: "text", role: "user", text: userInput }, { kind: "text", role: "assistant", text: `  Running ${commands.length} commands...` }]);
        for (const cmd of commands) {
          commandDepthRef.current++;
          await processMessage(cmd.trim());
        }
        commandDepthRef.current = 0;
        return;
      }

      // /workspace — switch working directory
      if (lower.startsWith("/workspace ") || lower.startsWith("/cwd ") || lower.startsWith("/cd ")) {
        const dirArg = userInput.replace(/^\/(workspace|cwd|cd)\s+/i, "").trim();
        if (!dirArg) {
          setCompleted((prev) => [...prev, { kind: "text", role: "user", text: userInput }, { kind: "text", role: "assistant", text: `  Current: ${config.workingDirectory}\n  Usage: /workspace <path>` }]);
          return;
        }
        const { resolve: resolvePath } = await import("node:path");
        const { existsSync, statSync: statSyncFn } = await import("node:fs");
        const newDir = resolvePath(config.workingDirectory, dirArg);
        if (!existsSync(newDir) || !statSyncFn(newDir).isDirectory()) {
          setCompleted((prev) => [...prev, { kind: "text", role: "user", text: userInput }, { kind: "text", role: "assistant", text: `  Not a directory: ${newDir}` }]);
          return;
        }
        config.workingDirectory = newDir;
        conversationManager.getConfig().workingDirectory = newDir;
        process.chdir(newDir);
        setCompleted((prev) => [...prev, { kind: "text", role: "user", text: userInput }, { kind: "text", role: "assistant", text: `  Working directory changed to: ${newDir}` }]);
        return;
      }
      if (lower === "/workspace" || lower === "/cwd" || lower === "/cd") {
        setCompleted((prev) => [...prev, { kind: "text", role: "user", text: userInput }, { kind: "text", role: "assistant", text: `  Current: ${config.workingDirectory}\n  Usage: /workspace <path>` }]);
        return;
      }

      // /cloud — interactive cloud provider setup
      if (lower === "/cloud" || lower === "/api-key" || lower === "/apikey" || lower === "/provider") {
        setCompleted((prev) => [...prev, { kind: "text", role: "user", text: userInput }]);
        setMode("cloud");
        return;
      }

      // /toggle — switch between local and cloud models
      if (lower === "/toggle" || lower === "/model" || lower === "/switch") {
        setCompleted((prev) => [...prev, { kind: "text", role: "user", text: userInput }]);
        setMode("toggle");
        return;
      }

      // /hookify — dynamic rule engine
      if (lower.startsWith("/hookify")) {
        setCompleted((prev) => [...prev, { kind: "text", role: "user", text: userInput }]);
        (async () => {
          try {
            const { loadHookifyRules, saveHookifyRule, deleteHookifyRule, testHookifyRules, formatRuleList, formatRuleDetail } = await import("../core/hookify.js");
            const args = userInput.slice("/hookify".length).trim();
            const parts = args.split(/\s+/);
            const subcmd = parts[0]?.toLowerCase() || "list";

            if (subcmd === "list" || subcmd === "ls" || !args) {
              const rules = await loadHookifyRules();
              setCompleted((prev) => [...prev, { kind: "text", role: "assistant", text: formatRuleList(rules) }]);
            } else if (subcmd === "create" || subcmd === "add" || subcmd === "new") {
              const name = parts[1];
              if (!name) {
                setCompleted((prev) => [...prev, { kind: "text", role: "assistant", text: "  Usage: /hookify create <name> [event=bash|file|all] [action=block|warn] [tool=Bash|Edit] [field:operator:pattern]\n\n  Example: /hookify create no-force-push event=bash action=block tool=Bash command:regex_match:git\\\\s+push\\\\s+.*--force" }]);
                return;
              }
              const rule: any = { name, enabled: true, event: "all" as const, conditions: [], action: "warn" as const, message: `Rule "${name}" triggered.` };
              for (let i = 2; i < parts.length; i++) {
                const part = parts[i]!;
                if (part.startsWith("event=")) rule.event = part.slice(6);
                else if (part.startsWith("action=")) rule.action = part.slice(7);
                else if (part.startsWith("tool=")) rule.toolMatcher = part.slice(5);
                else if (part.startsWith("msg=")) rule.message = part.slice(4).replace(/_/g, " ");
                else if (part.includes(":")) {
                  const [field, operator, ...rest] = part.split(":");
                  if (field && operator) {
                    rule.conditions.push({ field, operator, pattern: rest.join(":") });
                  }
                }
              }
              await saveHookifyRule(rule);
              setCompleted((prev) => [...prev, { kind: "text", role: "assistant", text: `  Created hookify rule: ${name}\n${formatRuleDetail(rule)}` }]);
            } else if (subcmd === "toggle") {
              const name = parts[1];
              if (!name) {
                setCompleted((prev) => [...prev, { kind: "text", role: "assistant", text: "  Usage: /hookify toggle <name>" }]);
                return;
              }
              const rules = await loadHookifyRules();
              const rule = rules.find(r => r.name === name);
              if (!rule) {
                setCompleted((prev) => [...prev, { kind: "text", role: "assistant", text: `  Rule not found: ${name}` }]);
                return;
              }
              rule.enabled = !rule.enabled;
              await saveHookifyRule(rule);
              setCompleted((prev) => [...prev, { kind: "text", role: "assistant", text: `  Rule "${name}" is now ${rule.enabled ? "enabled" : "disabled"}` }]);
            } else if (subcmd === "delete" || subcmd === "rm" || subcmd === "remove") {
              const name = parts[1];
              if (!name) {
                setCompleted((prev) => [...prev, { kind: "text", role: "assistant", text: "  Usage: /hookify delete <name>" }]);
                return;
              }
              const deleted = await deleteHookifyRule(name);
              setCompleted((prev) => [...prev, { kind: "text", role: "assistant", text: deleted ? `  Deleted rule: ${name}` : `  Rule not found: ${name}` }]);
            } else if (subcmd === "test") {
              const command = parts.slice(1).join(" ");
              if (!command) {
                setCompleted((prev) => [...prev, { kind: "text", role: "assistant", text: "  Usage: /hookify test <command>" }]);
                return;
              }
              const result = await testHookifyRules(command);
              const lines = [`  Test result for: ${command}\n`, `  Decision: ${result.decision}`];
              if (result.matchedRules.length > 0) {
                lines.push(`  Matched rules: ${result.matchedRules.join(", ")}`);
              }
              if (result.messages.length > 0) {
                lines.push(`  Messages:`);
                for (const msg of result.messages) lines.push(`    ${msg}`);
              }
              setCompleted((prev) => [...prev, { kind: "text", role: "assistant", text: lines.join("\n") }]);
            } else if (subcmd === "show" || subcmd === "info") {
              const name = parts[1];
              if (!name) {
                setCompleted((prev) => [...prev, { kind: "text", role: "assistant", text: "  Usage: /hookify show <name>" }]);
                return;
              }
              const rules = await loadHookifyRules();
              const rule = rules.find(r => r.name === name);
              if (!rule) {
                setCompleted((prev) => [...prev, { kind: "text", role: "assistant", text: `  Rule not found: ${name}` }]);
                return;
              }
              setCompleted((prev) => [...prev, { kind: "text", role: "assistant", text: formatRuleDetail(rule) }]);
            } else {
              setCompleted((prev) => [...prev, { kind: "text", role: "assistant", text: "  Usage: /hookify [list|create <name>|toggle <name>|delete <name>|test <command>|show <name>]" }]);
            }
          } catch (err) {
            setCompleted((prev) => [...prev, { kind: "text", role: "assistant", text: `  Hookify error: ${err instanceof Error ? err.message : err}` }]);
          }
        })();
        return;
      }

      // /marketplace — plugin marketplace
      if (lower.startsWith("/marketplace")) {
        setCompleted((prev) => [...prev, { kind: "text", role: "user", text: userInput }]);
        (async () => {
          try {
            const { searchPlugins, getPluginDetails, installFromMarketplace, updatePlugin, listInstalled, checkUpdates, formatPluginInfo, formatPluginList } = await import("../core/marketplace.js");
            const args = userInput.slice("/marketplace".length).trim();
            const parts = args.split(/\s+/);
            const subcmd = parts[0]?.toLowerCase() || "list";

            if (subcmd === "search" || subcmd === "find") {
              const query = parts.slice(1).join(" ");
              const results = await searchPlugins(query);
              setCompleted((prev) => [...prev, { kind: "text", role: "assistant", text: formatPluginList(results, query ? `Search results for "${query}"` : "All available plugins") }]);
            } else if (subcmd === "install" || subcmd === "add") {
              const name = parts[1];
              if (!name) {
                setCompleted((prev) => [...prev, { kind: "text", role: "assistant", text: "  Usage: /marketplace install <plugin-name>" }]);
                return;
              }
              const success = await installFromMarketplace(name);
              setCompleted((prev) => [...prev, { kind: "text", role: "assistant", text: success ? `  Installed "${name}" from marketplace` : `  Failed to install "${name}". Check logs for details.` }]);
            } else if (subcmd === "update") {
              const name = parts[1];
              if (name) {
                const success = await updatePlugin(name);
                setCompleted((prev) => [...prev, { kind: "text", role: "assistant", text: success ? `  Updated "${name}"` : `  Failed to update "${name}"` }]);
              } else {
                const updates = await checkUpdates();
                if (updates.length === 0) {
                  setCompleted((prev) => [...prev, { kind: "text", role: "assistant", text: "  All plugins are up to date." }]);
                } else {
                  const lines = [`  Updates available (${updates.length}):\n`];
                  for (const u of updates) {
                    lines.push(`  ${u.name}: ${u.current} -> ${u.latest}`);
                  }
                  lines.push(`\n  Run /marketplace update <name> to update`);
                  setCompleted((prev) => [...prev, { kind: "text", role: "assistant", text: lines.join("\n") }]);
                }
              }
            } else if (subcmd === "info" || subcmd === "details") {
              const name = parts[1];
              if (!name) {
                setCompleted((prev) => [...prev, { kind: "text", role: "assistant", text: "  Usage: /marketplace info <plugin-name>" }]);
                return;
              }
              const plugin = await getPluginDetails(name);
              if (!plugin) {
                setCompleted((prev) => [...prev, { kind: "text", role: "assistant", text: `  Plugin not found: ${name}` }]);
                return;
              }
              setCompleted((prev) => [...prev, { kind: "text", role: "assistant", text: formatPluginInfo(plugin) }]);
            } else if (subcmd === "list" || subcmd === "ls" || subcmd === "installed" || !args) {
              const installed = await listInstalled();
              if (installed.length === 0) {
                const available = await searchPlugins("");
                setCompleted((prev) => [...prev, { kind: "text", role: "assistant", text: `  No plugins installed from marketplace.\n\n${formatPluginList(available, "Available plugins")}` }]);
              } else {
                setCompleted((prev) => [...prev, { kind: "text", role: "assistant", text: formatPluginList(installed, "Installed from marketplace") }]);
              }
            } else {
              setCompleted((prev) => [...prev, { kind: "text", role: "assistant", text: "  Usage: /marketplace [search <query>|install <name>|update [name]|info <name>|list]" }]);
            }
          } catch (err) {
            setCompleted((prev) => [...prev, { kind: "text", role: "assistant", text: `  Marketplace error: ${err instanceof Error ? err.message : err}` }]);
          }
        })();
        return;
      }

      // /plugin — plugin management
      if (lower.startsWith("/plugin")) {
        setCompleted((prev) => [...prev, { kind: "text", role: "user", text: userInput }]);
        (async () => {
          try {
            const { PluginManager } = await import("../core/plugin-manager.js");
            const pm = new PluginManager();
            const args = userInput.slice("/plugin".length).trim();
            const parts = args.split(/\s+/);
            const subcmd = parts[0]?.toLowerCase() || "list";

            if (subcmd === "list" || subcmd === "ls" || !args) {
              const plugins = await pm.list();
              if (plugins.length === 0) {
                setCompleted((prev) => [...prev, { kind: "text", role: "assistant", text: "  No plugins installed.\n  Usage: /plugin install <path-or-git-url>" }]);
              } else {
                const lines = plugins.map((p) => `  ${p.name} v${p.version} — ${p.description ?? "no description"}`);
                setCompleted((prev) => [...prev, { kind: "text", role: "assistant", text: `  Installed plugins (${plugins.length}):\n${lines.join("\n")}` }]);
              }
            } else if (subcmd === "install" || subcmd === "add") {
              const source = parts.slice(1).join(" ");
              if (!source) {
                setCompleted((prev) => [...prev, { kind: "text", role: "assistant", text: "  Usage: /plugin install <path-or-git-url>" }]);
              } else {
                const manifest = await pm.install(source);
                setCompleted((prev) => [...prev, { kind: "text", role: "assistant", text: `  Installed: ${manifest.name} v${manifest.version}\n  ${manifest.description ?? ""}` }]);
              }
            } else if (subcmd === "remove" || subcmd === "rm" || subcmd === "uninstall") {
              const name = parts[1];
              if (!name) {
                setCompleted((prev) => [...prev, { kind: "text", role: "assistant", text: "  Usage: /plugin remove <name>" }]);
              } else {
                const ok = await pm.remove(name);
                setCompleted((prev) => [...prev, { kind: "text", role: "assistant", text: ok ? `  Removed: ${name}` : `  Plugin not found: ${name}` }]);
              }
            } else {
              setCompleted((prev) => [...prev, { kind: "text", role: "assistant", text: "  Usage: /plugin [list|install <source>|remove <name>]" }]);
            }
          } catch (err) {
            setCompleted((prev) => [...prev, { kind: "text", role: "assistant", text: `  Plugin error: ${err instanceof Error ? err.message : err}` }]);
          }
        })();
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

            // /context — toggle the context grid display
            if (expanded.builtinAction === "context") {
              setShowContextGrid((prev) => !prev);
            }

            // /rename — set session name (needs component state access)
            if (result.startsWith("__rename__")) {
              const name = result.slice("__rename__".length).trim();
              if (!name) {
                setCompleted((prev) => [...prev, { kind: "text", role: "user", text: userInput }, { kind: "text", role: "assistant", text: sessionName ? `  Current session: "${sessionName}"\n  Usage: /rename <name>` : "  Usage: /rename <name>" }]);
              } else {
                setSessionName(name);
                setCompleted((prev) => [...prev, { kind: "text", role: "user", text: userInput }, { kind: "text", role: "assistant", text: `  Session renamed to: "${name}"` }]);
              }
              return;
            }

            // /session-tags — manage session tags (needs component state access)
            if (result.startsWith("__session_tags__")) {
              const tagArgs = result.slice("__session_tags__".length).trim();
              const parts = tagArgs.split(/\s+/);
              const subCmd = parts[0] ?? "";
              const tagValue = parts.slice(1).join(" ");

              if (subCmd === "add" && tagValue) {
                setSessionTags((prev) => {
                  if (prev.includes(tagValue)) return prev;
                  return [...prev, tagValue];
                });
                setCompleted((prev) => [...prev, { kind: "text", role: "user", text: userInput }, { kind: "text", role: "assistant", text: `  Tag added: "${tagValue}"` }]);
              } else if (subCmd === "remove" && tagValue) {
                setSessionTags((prev) => prev.filter(t => t !== tagValue));
                setCompleted((prev) => [...prev, { kind: "text", role: "user", text: userInput }, { kind: "text", role: "assistant", text: `  Tag removed: "${tagValue}"` }]);
              } else {
                // List tags
                const tagsDisplay = sessionTags.length > 0
                  ? `  Session Tags: ${sessionTags.map(t => `[${t}]`).join(" ")}`
                  : "  No tags set. Use /session-tags add <tag> to add one.";
                setCompleted((prev) => [...prev, { kind: "text", role: "user", text: userInput }, { kind: "text", role: "assistant", text: tagsDisplay }]);
              }
              return;
            }

            // Some builtin actions return a prompt to send to the LLM (dry-run, auto-fix)
            if (result.startsWith("__dry_run_prompt__") || result.startsWith("__auto_fix_prompt__")) {
              const llmPrompt = result.replace(/^__(?:dry_run|auto_fix)_prompt__/, "");
              setCompleted((prev) => [...prev, { kind: "text", role: "user", text: userInput }]);
              setMode("responding");
              setStreamingText("");
              setTurnTokens(0);
              setTurnStartTime(Date.now());
              setSpinnerPhase("thinking");
              setLoadingMessage("Thinking...");
              try {
                const events = conversationManager.sendMessage(llmPrompt);
                await processEvents(events);
              } catch (err) {
                setCompleted((prev) => [...prev, { kind: "text", role: "assistant", text: `Error: ${err instanceof Error ? err.message : err}` }]);
              } finally {
                setMode("input");
                setStreamingText("");
                setStreamingThinking("");
                setIsThinking(false);
                setLoadingMessage("");
              }
              return;
            }

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

      // One-time telemetry opt-in banner on first prompt when not yet configured
      if (!telemetryPromptShownRef.current && config.telemetry === undefined) {
        telemetryPromptShownRef.current = true;
        // Show a non-blocking banner — the user can respond later via /telemetry
        setCompleted((prev) => [
          ...prev,
          {
            kind: "text",
            role: "assistant",
            text: "  KCode collects anonymous tool usage analytics locally (never sent externally).\n  Enable? Use /telemetry on or /telemetry off to decide.",
          },
        ]);
      }

      // Track last user prompt for /retry
      lastUserPromptRef.current = userInput;

      // @ file mentions — detect @path/to/file patterns and prepend file content
      let processedInput = userInput;
      const fileMentions = userInput.match(/@([\w./_~-]+[\w._/-]+)/g);
      if (fileMentions && fileMentions.length > 0) {
        const { resolve: resolvePath } = await import("node:path");
        const { readFileSync, existsSync } = await import("node:fs");
        const prefixes: string[] = [];
        let cleanedInput = userInput;
        for (const mention of fileMentions) {
          const filePath = mention.slice(1); // strip @
          const absPath = resolvePath(config.workingDirectory, filePath);
          if (existsSync(absPath)) {
            try {
              const content = readFileSync(absPath, "utf-8");
              const truncated = content.length > 50000 ? content.slice(0, 50000) + "\n... (truncated)" : content;
              prefixes.push(`[File: ${filePath}]\n${truncated}`);
            } catch {
              prefixes.push(`[File: ${filePath}] (could not read)`);
            }
          }
          cleanedInput = cleanedInput.replace(mention, filePath);
        }
        if (prefixes.length > 0) {
          processedInput = prefixes.join("\n\n") + "\n\n" + cleanedInput;
        }
      }

      // Image file path detection — detect paths to image files and annotate the message
      const pathPattern = /(?:^|\s)((?:\/|\.\/|~\/|\.\.\/)?[\w./_~-]*\.(png|jpg|jpeg|gif|webp|bmp))(?:\s|$)/gi;
      const imageMatches = [...processedInput.matchAll(pathPattern)];
      if (imageMatches.length > 0) {
        const annotations: string[] = [];
        for (const match of imageMatches) {
          const imagePath = match[1];
          annotations.push(`[Image attached: ${imagePath}]`);
        }
        // Check if mnemo:scanner model is available
        let scannerNote = "";
        try {
          const { loadModelsConfig } = await import("../core/models.js");
          const modelsConfig = await loadModelsConfig();
          const hasScanner = modelsConfig.models?.some(
            (m: { name: string }) => m.name === "mnemo:scanner" || m.name.includes("scanner")
          );
          if (hasScanner) {
            scannerNote = "\n(Note: The mnemo:scanner model is available for image analysis)";
          }
        } catch { /* ignore */ }
        processedInput = processedInput + "\n\n" + annotations.join("\n") + scannerNote;
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
        const events = conversationManager.sendMessage(processedInput);
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

      // Update stats — use API-reported tokens, or estimate from context if unavailable
      const state = conversationManager.getState();
      const usage = conversationManager.getUsage();
      const apiTokens = usage.inputTokens + usage.outputTokens;
      setTokenCount(apiTokens > 0 ? apiTokens : state.tokenCount);
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
      // Multiline input support — if line ends with \, accumulate and wait for more
      if (userInput.endsWith("\\")) {
        const lineWithoutBackslash = userInput.slice(0, -1);
        multilineBufferRef.current.push(lineWithoutBackslash);
        setCompleted((prev) => [
          ...prev,
          { kind: "text", role: "user", text: `... ${lineWithoutBackslash}` },
        ]);
        return;
      }

      // If we have buffered lines, join them with the final line
      let finalInput = userInput;
      if (multilineBufferRef.current.length > 0) {
        multilineBufferRef.current.push(userInput);
        finalInput = multilineBufferRef.current.join("\n");
        multilineBufferRef.current = [];
      }

      // Clear file watcher suggestions on new input
      setWatcherSuggestions([]);

      if (mode === "responding") {
        // Queue the message — show it as queued in the UI
        messageQueueRef.current = [...messageQueueRef.current, finalInput];
        setMessageQueue([...messageQueueRef.current]);
        setCompleted((prev) => [
          ...prev,
          { kind: "text", role: "user", text: `${finalInput}  [queued]` },
        ]);
        return;
      }

      await processMessage(finalInput);
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
            // Show any pending file change suggestions
            {
              const suggester = getFileChangeSuggester(config.workingDirectory);
              const suggestions = suggester.getSuggestions();
              if (suggestions.length > 0) {
                setWatcherSuggestions(suggestions);
              }
            }
            // Refresh running agent count
            try {
              const { getRunningAgentCount } = await import("../tools/agent.js");
              setRunningAgentCount(getRunningAgentCount());
            } catch { /* ignore */ }
            break;

          case "text_delta":
            if (currentText.length === 0) setLastKodiEvent({ type: "streaming" });
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
            if (currentThinking.length === 0) setLastKodiEvent({ type: "thinking" });
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
            setLastKodiEvent({ type: "tool_start", detail: event.name });
            const summary = summarizeInput(event.name, event.input);
            setCompleted((prev) => [
              ...prev,
              { kind: "tool_use", name: event.name, summary },
            ]);
            // Enhanced loading message with command/file details
            const detail = summary ? summary.slice(0, 60) : "";
            setLoadingMessage(detail ? `Running ${event.name}: ${detail}` : `Running ${event.name}...`);
            setSpinnerPhase("tool");
            // Add to active tabs
            setActiveTabs(prev => [
              ...prev.filter(t => t.toolUseId !== event.toolUseId),
              { toolUseId: event.toolUseId, name: event.name, summary: detail, status: "running", startTime: Date.now() },
            ]);
            break;
          }

          case "tool_stream":
            // Live streaming output from Bash commands
            setBashStreamOutput((prev) => {
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
                  durationMs: event.durationMs,
                },
              ]);
            }
            // Refresh agent count after any Agent tool result
            if (event.name === "Agent") {
              try {
                const { getRunningAgentCount } = await import("../tools/agent.js");
                setRunningAgentCount(getRunningAgentCount());
              } catch { /* ignore */ }
            }
            // Update tab: mark as done/error, then remove after 1.5s
            setActiveTabs(prev => prev.map(t =>
              t.toolUseId === event.toolUseId
                ? { ...t, status: (event.isError ? "error" : "done") as "done" | "error", durationMs: event.durationMs }
                : t
            ));
            const timerId = setTimeout(() => {
              setActiveTabs(prev => prev.filter(t => t.toolUseId !== event.toolUseId));
              tabRemovalTimers.current.delete(timerId);
            }, 1500);
            tabRemovalTimers.current.add(timerId);
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
              setCompleted((prev) => [
                ...prev,
                { kind: "suggestion", suggestions: event.suggestions },
              ]);
            }
            break;

          case "compaction_start":
            setLastKodiEvent({ type: "compaction" });
            setCompleted((prev) => [
              ...prev,
              { kind: "banner", title: "Compacting context...", subtitle: `Summarizing ${event.messageCount} messages (~${Math.round(event.tokensBefore / 1000)}k tokens)` },
            ]);
            setLoadingMessage("Compacting context...");
            break;

          case "compaction_end":
            setCompleted((prev) => [
              ...prev,
              { kind: "banner", title: "Context compacted", subtitle: `${event.method === "llm" ? "LLM summary" : event.method === "compressed" ? "Tool results compressed" : "Messages pruned"} → ~${Math.round(event.tokensAfter / 1000)}k tokens` },
            ]);
            break;

          case "budget_warning":
            setCompleted((prev) => [
              ...prev,
              { kind: "banner", title: `Budget ${event.pct >= 100 ? "EXCEEDED" : "warning"}: ${event.pct}%`, subtitle: `$${event.costUsd.toFixed(2)} / $${event.limitUsd.toFixed(2)}` },
            ]);
            break;

          case "tool_progress":
            if (event.status === "running" || event.status === "queued") {
              setLoadingMessage(`Parallel: ${event.name} (${event.index + 1}/${event.total})...`);
              // Update tab status
              setActiveTabs(prev => prev.map(t =>
                t.toolUseId === event.toolUseId ? { ...t, status: event.status as "running" | "queued" } : t
              ));
            } else if (event.status === "done") {
              const ms = event.durationMs ? ` ${event.durationMs}ms` : "";
              setLoadingMessage(`Parallel: ${event.name} done${ms} (${event.index + 1}/${event.total})`);
            }
            break;

          case "turn_end":
            setLastKodiEvent({ type: "turn_end" });
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
            } else if (event.stopReason !== "tool_use" && event.stopReason !== "max_tokens_continue") {
              // Model returned empty response — show a fallback so the user knows
              setCompleted((prev) => [
                ...prev,
                { kind: "text", role: "assistant", text: "  (empty response — the model returned no text. Try rephrasing or use a different model.)" },
              ]);
            }
            // Show any pending file change suggestions
            {
              const suggester = getFileChangeSuggester(config.workingDirectory);
              const suggestions = suggester.getSuggestions();
              if (suggestions.length > 0) {
                setWatcherSuggestions(suggestions);
              }
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

  const handleCloudDone = useCallback(
    async (result: CloudResult | null) => {
      if (!result) {
        setCompleted((prev) => [...prev, { kind: "text", role: "assistant", text: "  Cloud setup cancelled." }]);
        setMode("input");
        return;
      }

      try {
        const { loadUserSettingsRaw, saveUserSettingsRaw } = await import("../core/config.js");
        const { addModel } = await import("../core/models.js");
        const provider = result.provider;

        // Save API key to settings (raw to preserve extra fields)
        const settings = await loadUserSettingsRaw();
        settings[provider.settingsKey] = result.apiKey;
        await saveUserSettingsRaw(settings);

        // Set env var for current session
        process.env[provider.envVar] = result.apiKey;

        // Update current config
        if (provider.id === "anthropic") {
          config.anthropicApiKey = result.apiKey;
        } else {
          config.apiKey = result.apiKey;
        }

        // Register default models for this provider
        const modelProvider = provider.id === "anthropic" ? "anthropic" as const : "openai" as const;
        const modelsToRegister = provider.models.split(",").map((m) => m.trim());
        for (const modelName of modelsToRegister) {
          await addModel({
            name: modelName,
            baseUrl: provider.baseUrl,
            provider: modelProvider,
            description: `${provider.name} cloud model`,
          });
        }

        // Switch active model to the first model of this provider
        const newModel = modelsToRegister[0]!;
        config.model = newModel;
        config.modelExplicitlySet = true;
        conversationManager.getConfig().model = newModel;
        conversationManager.getConfig().modelExplicitlySet = true;

        // Update context window size from registry
        const { getModelContextSize } = await import("../core/models.js");
        const ctxSize = await getModelContextSize(newModel);
        if (ctxSize) {
          config.contextWindowSize = ctxSize;
          conversationManager.getConfig().contextWindowSize = ctxSize;
        }

        setCompleted((prev) => [
          ...prev,
          {
            kind: "text",
            role: "assistant",
            text: `  ☁  ${provider.name} configured!\n  API key saved to ~/.kcode/settings.json\n  Registered models: ${provider.models}\n  Active model switched to: ${newModel}`,
          },
        ]);
      } catch (err) {
        setCompleted((prev) => [
          ...prev,
          { kind: "text", role: "assistant", text: `  Error saving config: ${err instanceof Error ? err.message : err}` },
        ]);
      }

      setMode("input");
    },
    [config],
  );

  const handleToggleDone = useCallback(
    async (result: ModelToggleResult | null) => {
      if (!result) {
        setMode("input");
        return;
      }

      const newModel = result.model.name;
      config.model = newModel;
      config.modelExplicitlySet = true;
      conversationManager.getConfig().model = newModel;
      conversationManager.getConfig().modelExplicitlySet = true;

      // Update context window size
      const { getModelContextSize } = await import("../core/models.js");
      const ctxSize = await getModelContextSize(newModel);
      if (ctxSize) {
        config.contextWindowSize = ctxSize;
        conversationManager.getConfig().contextWindowSize = ctxSize;
      }

      // Update API key if switching to a cloud provider
      const { getModelProvider } = await import("../core/models.js");
      const provider = await getModelProvider(newModel);
      if (provider === "anthropic" && process.env.ANTHROPIC_API_KEY) {
        config.anthropicApiKey = process.env.ANTHROPIC_API_KEY;
      }

      const isLocal = result.model.baseUrl.includes("localhost") || result.model.baseUrl.includes("127.0.0.1");
      const label = isLocal ? "🖥  Local" : "☁  Cloud";

      setCompleted((prev) => [
        ...prev,
        {
          kind: "text",
          role: "assistant",
          text: `  ${label}: Switched to ${newModel}${result.model.description ? ` — ${result.model.description}` : ""}`,
        },
      ]);

      setMode("input");
    },
    [config],
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
          bashStreamOutput={bashStreamOutput}
        />

        {watcherSuggestions.length > 0 && mode === "input" && (
          <Box marginLeft={2} marginBottom={1} flexDirection="column">
            {watcherSuggestions.map((s, i) => (
              <Text key={i} dimColor>{"  ✱ "}{s}</Text>
            ))}
          </Box>
        )}

        {mode === "permission" && permissionRequest && (
          <PermissionDialog
            request={permissionRequest}
            onChoice={handlePermissionChoice}
            isActive={mode === "permission"}
          />
        )}

        {mode === "cloud" && (
          <CloudMenu
            isActive={mode === "cloud"}
            onDone={handleCloudDone}
          />
        )}

        {mode === "toggle" && (
          <ModelToggle
            isActive={mode === "toggle"}
            currentModel={config.model}
            onDone={handleToggleDone}
          />
        )}

        {activeTabs.length > 0 && (
          <ToolTabs tabs={activeTabs} selectedIndex={selectedTabIndex} />
        )}

        {showContextGrid && config.contextWindowSize && config.contextWindowSize > 0 && (() => {
          const state = conversationManager.getState();
          let systemTokens = 0;
          let messageTokens = 0;
          let toolTokens = 0;
          for (const msg of state.messages) {
            if (typeof msg.content === "string") {
              const est = Math.round(msg.content.length / 4);
              if (msg.role === "user") messageTokens += est;
              else messageTokens += est;
            } else if (Array.isArray(msg.content)) {
              for (const block of msg.content) {
                if (block.type === "text") {
                  messageTokens += Math.round(block.text.length / 4);
                } else if (block.type === "tool_result") {
                  const c = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
                  toolTokens += Math.round(c.length / 4);
                } else if (block.type === "tool_use") {
                  toolTokens += Math.round(JSON.stringify(block.input).length / 4);
                }
              }
            }
          }
          // Estimate system prompt tokens from the difference
          systemTokens = Math.max(0, tokenCount - messageTokens - toolTokens);
          return (
            <ContextGrid
              breakdown={{
                totalTokens: tokenCount,
                contextWindowSize: config.contextWindowSize,
                systemTokens,
                messageTokens,
                toolTokens,
              }}
            />
          );
        })()}

      {/* Kodi companion — pinned above input, always visible */}
      <KodiCompanion
        mode={mode}
        toolUseCount={toolUseCount}
        tokenCount={tokenCount}
        activeToolName={activeTabs.length > 0 ? activeTabs[activeTabs.length - 1]!.name : null}
        isThinking={isThinking}
        runningAgents={runningAgentCount}
        sessionElapsedMs={Date.now() - sessionStart}
        lastEvent={lastKodiEvent}
        model={config.model}
        version={config.version ?? "?"}
        workingDirectory={config.workingDirectory}
        permissionMode={conversationManager.getPermissions().getMode()}
        contextWindowSize={config.contextWindowSize}
        sessionName={sessionName}
        sessionStartTime={sessionStart}
      />
      <InputPrompt
        onSubmit={handleSubmit}
        isActive={mode !== "permission" && mode !== "cloud" && mode !== "toggle"}
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
      let output = formatStats(stats);
      const breakdown = conversationManager.formatCostBreakdown();
      if (breakdown) {
        output += "\n" + breakdown;
      }
      return output;
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

      // Preview mode: show what would be compacted without applying
      if (args?.trim() === "preview") {
        const summary = await compactor.compact(toPrune);
        if (!summary) return "  Preview failed — could not generate summary.";
        const summaryText = typeof summary.content === "string"
          ? summary.content
          : (summary.content as Array<{ type: string; text?: string }>).map((b) => b.text ?? "").join("\n");
        const lines = [
          `  Compact Preview:`,
          `  Messages to compact: ${toPrune.length}`,
          `  Messages to keep:    ${kept.length} (most recent)`,
          ``,
          `  Generated Summary:`,
          `  ─────────────────────────────────────────`,
          ...summaryText.split("\n").map((l: string) => `  ${l}`),
          `  ─────────────────────────────────────────`,
          ``,
          `  Run /compact (without preview) to apply.`,
        ];
        return lines.join("\n");
      }

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

      // Build a visual bar with color zones
      const barLen = 40;
      const filled = Math.round(barLen * pct / 100);
      const bar = "\u2588".repeat(filled) + "\u2591".repeat(barLen - filled);
      const status = pct >= 90 ? " CRITICAL" : pct >= 70 ? " WARNING" : "";

      // Analyze context breakdown by category
      let systemChars = 0;
      let userChars = 0;
      let assistantChars = 0;
      let toolResultChars = 0;
      let thinkingChars = 0;
      let toolCalls = 0;

      for (const msg of state.messages) {
        if (typeof msg.content === "string") {
          if (msg.role === "user") userChars += msg.content.length;
          else assistantChars += msg.content.length;
        } else if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === "text") {
              if (msg.role === "user") userChars += block.text.length;
              else assistantChars += block.text.length;
            } else if (block.type === "tool_result") {
              const c = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
              toolResultChars += c.length;
            } else if (block.type === "tool_use") {
              toolCalls++;
              toolResultChars += JSON.stringify(block.input).length;
            } else if (block.type === "thinking") {
              thinkingChars += block.thinking.length;
            }
          }
        }
      }

      const totalChars = userChars + assistantChars + toolResultChars + thinkingChars;
      const pctOf = (chars: number) => totalChars > 0 ? Math.round((chars / totalChars) * 100) : 0;

      // Breakdown bars
      const miniBar = (p: number) => {
        const w = 15;
        const f = Math.round(w * Math.min(p, 100) / 100);
        return "\u2588".repeat(f) + "\u2591".repeat(w - f);
      };

      const lines = [
        `  Context: [${bar}] ${pct}%${status}`,
        `  Tokens:  ${usedTokens.toLocaleString()} / ${contextSize.toLocaleString()}`,
        `  Messages: ${state.messages.length} | Tool calls: ${state.toolUseCount}`,
        ``,
        `  Breakdown by category:`,
        `  User prompts   ${miniBar(pctOf(userChars))} ${pctOf(userChars)}% (${Math.round(userChars / 4).toLocaleString()} est. tokens)`,
        `  Assistant text  ${miniBar(pctOf(assistantChars))} ${pctOf(assistantChars)}% (${Math.round(assistantChars / 4).toLocaleString()} est. tokens)`,
        `  Tool results    ${miniBar(pctOf(toolResultChars))} ${pctOf(toolResultChars)}% (${Math.round(toolResultChars / 4).toLocaleString()} est. tokens)`,
        `  Thinking        ${miniBar(pctOf(thinkingChars))} ${pctOf(thinkingChars)}% (${Math.round(thinkingChars / 4).toLocaleString()} est. tokens)`,
      ];

      if (usage.cacheReadInputTokens > 0 || usage.cacheCreationInputTokens > 0) {
        lines.push(``);
        lines.push(`  Cache: ${usage.cacheReadInputTokens.toLocaleString()} read, ${usage.cacheCreationInputTokens.toLocaleString()} created`);
      }

      if (pct >= 70) {
        lines.push(``);
        lines.push(`  Tip: Use /compact to summarize older messages and free context.`);
      }

      return lines.join("\n");
    }
    case "rewind": {
      const trimmed = args?.trim() ?? "";

      // /rewind or /rewind list — show all checkpoints
      if (trimmed === "" || trimmed === "list") {
        const cps = conversationManager.listCheckpoints();
        if (cps.length === 0) return "  No checkpoints available.";
        const lines = ["  Checkpoints:", ""];
        for (const cp of cps) {
          lines.push(`  ${cp.index}. [${cp.age}] "${cp.label}" (message ${cp.messageIndex})`);
        }
        lines.push("", "  Use /rewind <number> to rewind to a checkpoint, or /rewind last for the most recent.");
        return lines.join("\n");
      }

      // /rewind last — rewind to most recent checkpoint
      if (trimmed === "last" || trimmed === "checkpoint" || trimmed === "cp") {
        const result = conversationManager.rewindToCheckpoint();
        return result ?? "  No checkpoints available.";
      }

      // /rewind <number> — rewind to specific checkpoint index
      const idx = parseInt(trimmed);
      if (!isNaN(idx)) {
        const result = conversationManager.rewindToCheckpoint(idx);
        return result ?? "  No checkpoints available.";
      }

      // Fallback: use undo stack for file changes only
      const undo = conversationManager.getUndo();
      const undoCount = 1;
      const undoResults: string[] = [];
      for (let i = 0; i < undoCount; i++) {
        const result = undo.undo();
        if (result) {
          undoResults.push(result);
        } else {
          break;
        }
      }

      const cpCount = conversationManager.getCheckpointCount();
      const cpHint = cpCount > 0 ? `\n  (${cpCount} conversation checkpoint${cpCount === 1 ? "" : "s"} available — use /rewind list)` : "";

      if (undoResults.length === 0) return `  Nothing to rewind.${cpHint}`;
      return undoResults.join("\n") + cpHint;
    }
    case "plugins": {
      const { getPluginManager } = await import("../core/plugins.js");
      return getPluginManager().formatList();
    }
    case "sessions": {
      const tm = new (await import("../core/transcript.js")).TranscriptManager();
      const query = args?.trim();

      // /sessions search <query> — search across all sessions
      if (query?.startsWith("search ")) {
        const searchQuery = query.slice(7).trim();
        if (!searchQuery) return "  Usage: /sessions search <query>";
        const results = tm.searchSessions(searchQuery);
        if (results.length === 0) return `  No sessions matching "${searchQuery}"`;
        const lines = [`  Sessions matching "${searchQuery}" (${results.length}):\n`];
        for (const r of results) {
          const date = r.startedAt.replace(/T/g, " ").slice(0, 16);
          lines.push(`  ${date}  ${r.prompt.slice(0, 50)}`);
          lines.push(`    → ${r.snippet.slice(0, 80)}`);
          lines.push(`    ${r.filename}`);
        }
        return lines.join("\n");
      }

      // /sessions info <filename> — detailed session summary
      if (query?.startsWith("info ")) {
        const filename = query.slice(5).trim();
        const summary = tm.getSessionSummary(filename);
        if (!summary) return `  Session not found: ${filename}`;
        return [
          `  Session: ${filename}`,
          `  Prompt: ${summary.prompt}`,
          `  Messages: ${summary.messageCount} | Tools: ${summary.toolUseCount}`,
          `  Duration: ${summary.duration}`,
          `\n  Resume: kcode --continue (resumes latest)`,
        ].join("\n");
      }

      // /sessions — list recent sessions
      const sessions = tm.listSessions();
      if (sessions.length === 0) return "  No saved sessions.";

      const lines = [`  Recent Sessions (${Math.min(sessions.length, 20)} of ${sessions.length}):\n`];
      const recent = sessions.slice(0, 20);
      for (const s of recent) {
        const date = s.startedAt.replace(/T/g, " ").slice(0, 16);
        const summary = tm.getSessionSummary(s.filename);
        const tools = summary ? ` | ${summary.toolUseCount} tools | ${summary.duration}` : "";
        lines.push(`  ${date}  ${s.prompt.slice(0, 50)}${tools}`);
        lines.push(`    ${s.filename}`);
      }
      if (sessions.length > 20) lines.push(`\n  ... and ${sessions.length - 20} more`);
      lines.push(`\n  Search: /sessions search <query>`);
      lines.push(`  Details: /sessions info <filename>`);
      return lines.join("\n");
    }
    case "branches": {
      const { getBranchManager: getBM, formatBranchTree: fmtTree } = await import("../core/branch-manager.js");
      const branchMgr = getBM();
      const allBranches = branchMgr.listBranches();

      if (allBranches.length === 0) {
        const tm2 = new (await import("../core/transcript.js")).TranscriptManager();
        const sess = tm2.listSessions();
        if (sess.length === 0) return "  No saved sessions or branches.";
        const lines: string[] = ["  No persistent branches tracked yet.\n"];
        lines.push("  Use /fork to create tracked branches.\n");
        for (const s of sess.slice(0, 10)) {
          const date = s.startedAt.replace(/T/g, " ").slice(0, 16);
          lines.push(`  \u25CF ${date}  ${s.prompt.slice(0, 50)}`);
        }
        return lines.join("\n");
      }

      const branchTree = branchMgr.getBranchTree();
      const lines: string[] = ["  Conversation Branches:\n"];
      lines.push(...fmtTree(branchTree).map((l: string) => `  ${l}`));
      lines.push("");
      lines.push(`  Total: ${allBranches.length} branch(es)`);
      lines.push(`\n  Label:  /branch label <name>`);
      lines.push(`  Fork:   /fork [N]`);
      lines.push(`  Resume: /resume or kcode --continue`);
      return lines.join("\n");
    }
    case "branch": {
      const { getBranchManager: getBM2 } = await import("../core/branch-manager.js");
      const { createBranch } = await import("../core/session-branch.js");
      const bm2 = getBM2();
      const barg = args?.trim() ?? "";
      if (barg.startsWith("label ")) {
        const newLabel = barg.slice(6).trim();
        if (!newLabel) return "  Usage: /branch label <name>";
        const cid = conversationManager.getSessionId();
        const br = bm2.getBranch(cid);
        if (!br) {
          bm2.saveBranch(cid, null, newLabel, `session-${cid}`);
        } else {
          bm2.labelBranch(cid, newLabel);
        }
        return `  Branch labeled: "${newLabel}"`;
      }
      if (barg === "delete") {
        const cid = conversationManager.getSessionId();
        const br = bm2.getBranch(cid);
        if (!br) return "  Current session is not a tracked branch.";
        bm2.deleteBranch(cid);
        return `  Branch "${br.label || br.id}" marked as deleted.`;
      }
      // /branch [name] — create a fork from current conversation state
      const branchName = barg || "";
      const sessionId = conversationManager.getSessionId();
      const messages = conversationManager.getState().messages;
      const branch = await createBranch(sessionId, branchName, messages);
      bm2.saveBranch(branch.id, sessionId, branch.name, `session-${branch.id}`, messages.length);
      return `  Branch created: "${branch.name}" (id: ${branch.id})\n  ${messages.length} messages saved at branch point\n  Use /continue ${branch.id} to resume from this branch`;
    }
    case "continue": {
      const { loadBranch } = await import("../core/session-branch.js");
      const branchId = args?.trim() ?? "";
      if (!branchId) return "  Usage: /continue <branchId>";
      const branch = await loadBranch(branchId);
      if (!branch) return `  Branch not found: ${branchId}`;
      conversationManager.restoreMessages(branch.messages);
      return `  Loaded branch: "${branch.name}" (${branch.messages.length} messages)\n  Branched at message ${branch.branchPoint} on ${branch.createdAt}\n  You can continue the conversation from here.`;
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
      else if (rawFilename.endsWith(".txt")) format = "txt";
      else if (rawFilename === "json") { format = "json"; filename = ""; }
      else if (rawFilename === "html") { format = "html"; filename = ""; }
      else if (rawFilename === "txt") { format = "txt"; filename = ""; }

      if (!filename || filename === "json" || filename === "html" || filename === "md" || filename === "txt") {
        filename = `/tmp/kcode-export-${timestamp}.${format}`;
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
        // HTML export — shareable page with collapsible tool calls and syntax highlighting
        const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const htmlLines: string[] = [
          '<!DOCTYPE html>',
          '<html><head><meta charset="utf-8"><title>KCode Conversation</title>',
          '<style>',
          '*{box-sizing:border-box}',
          'body{font-family:"JetBrains Mono","Fira Code",monospace;max-width:860px;margin:2em auto;padding:0 1em;background:#1e1e2e;color:#cdd6f4;line-height:1.6}',
          '.user{background:#313244;padding:1em 1.2em;border-radius:8px;margin:1em 0;border-left:3px solid #89b4fa}',
          '.assistant{background:#181825;padding:1em 1.2em;border-radius:8px;margin:1em 0;border-left:3px solid #a6e3a1}',
          '.tool-group{margin:0.4em 0}',
          '.tool-header{cursor:pointer;background:#1e1e2e;padding:0.4em 0.8em;border-radius:4px;border-left:3px solid #fab387;color:#fab387;font-size:0.9em;user-select:none}',
          '.tool-header:hover{background:#313244}',
          '.tool-header::before{content:"▸ ";display:inline}',
          '.tool-header.open::before{content:"▾ "}',
          '.tool-body{display:none;padding:0.4em 0.8em 0.4em 1.2em;border-left:3px solid #45475a;margin-left:0.3em;font-size:0.85em;color:#a6adc8}',
          '.tool-body.open{display:block}',
          '.tool-error{border-left-color:#f38ba8}',
          'pre{background:#11111b;padding:1em;border-radius:4px;overflow-x:auto;margin:0.5em 0}',
          'code{font-family:inherit}',
          '.kw{color:#cba6f7;font-weight:bold}.str{color:#a6e3a1}.num{color:#fab387}.cmt{color:#6c7086;font-style:italic}.type{color:#f9e2af}.fn{color:#89b4fa}',
          'h1{color:#cba6f7;margin-bottom:0.3em}',
          '.meta{color:#6c7086;font-size:0.85em;margin-bottom:2em}',
          '</style></head><body>',
          `<h1>KCode Conversation</h1>`,
          `<p class="meta">Model: ${escHtml(appConfig.model)} | ${new Date().toISOString()} | ${state.messages.length} messages</p>`,
        ];

        for (const msg of state.messages) {
          if (typeof msg.content === "string") {
            const cls = msg.role === "user" ? "user" : "assistant";
            htmlLines.push(`<div class="${cls}"><strong>${escHtml(msg.role)}:</strong><br>${escHtml(msg.content).replace(/\n/g, "<br>")}</div>`);
          } else {
            // Group consecutive tool_use + tool_result into collapsible blocks
            for (const block of msg.content) {
              if (block.type === "text") {
                const cls = msg.role === "user" ? "user" : "assistant";
                // Basic markdown: code blocks get <pre>
                let html = escHtml(block.text);
                html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
                  return `<pre><code>${code}</code></pre>`;
                });
                html = html.replace(/`([^`]+)`/g, '<code style="background:#313244;padding:0.1em 0.3em;border-radius:3px">$1</code>');
                html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
                html = html.replace(/\n/g, "<br>");
                htmlLines.push(`<div class="${cls}"><strong>${escHtml(msg.role)}:</strong><br>${html}</div>`);
              } else if (block.type === "tool_use") {
                const inputStr = escHtml(JSON.stringify(block.input, null, 2).slice(0, 500));
                htmlLines.push(`<div class="tool-group"><div class="tool-header" onclick="this.classList.toggle('open');this.nextElementSibling.classList.toggle('open')">⚡ ${escHtml(block.name)}</div>`);
                htmlLines.push(`<div class="tool-body"><pre>${inputStr}</pre></div></div>`);
              } else if (block.type === "tool_result") {
                const content = typeof block.content === "string" ? block.content.slice(0, 500) : "[complex]";
                const errCls = block.is_error ? " tool-error" : "";
                const icon = block.is_error ? "✗" : "✓";
                htmlLines.push(`<div class="tool-group"><div class="tool-header${errCls}" onclick="this.classList.toggle('open');this.nextElementSibling.classList.toggle('open')">${icon} result</div>`);
                htmlLines.push(`<div class="tool-body"><pre>${escHtml(content)}</pre></div></div>`);
              }
            }
          }
        }

        htmlLines.push('<p class="meta" style="text-align:center;margin-top:2em">Exported by KCode (Kulvex Code by Astrolexis)</p>');
        htmlLines.push('</body></html>');
        writeFileSync(filename, htmlLines.join("\n"), "utf-8");
        return `  Exported ${state.messages.length} messages to ${filename} (HTML)`;
      }

      if (format === "txt") {
        // Plain text export
        const txtLines: string[] = [`KCode Conversation Export`, `Date: ${new Date().toISOString()}`, ``];

        for (const msg of state.messages) {
          const role = msg.role === "user" ? "User" : "Assistant";
          if (typeof msg.content === "string") {
            txtLines.push(`${role}: ${msg.content}`, ``);
          } else {
            for (const block of msg.content) {
              if (block.type === "text") {
                txtLines.push(`${role}: ${block.text}`, ``);
              } else if (block.type === "tool_use") {
                txtLines.push(`[Tool: ${block.name}]`, ``);
              } else if (block.type === "tool_result") {
                const content = typeof block.content === "string" ? block.content.slice(0, 500) : "[complex]";
                txtLines.push(`[Result${block.is_error ? " (Error)" : ""}]: ${content}`, ``);
              }
            }
          }
        }

        writeFileSync(filename, txtLines.join("\n"), "utf-8");
        return `  Exported ${state.messages.length} messages to ${filename} (TXT)`;
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
      const { homedir } = await import("node:os");

      const sources = [
        { label: "User (~/.kcode/settings.json)", path: join(homedir(), ".kcode", "settings.json") },
        { label: "Project (.kcode/settings.json)", path: join(appConfig.workingDirectory, ".kcode", "settings.json") },
      ];

      const lines = ["  Configured Hooks\n"];
      let totalHooks = 0;

      for (const src of sources) {
        if (!existsSync(src.path)) continue;
        try {
          const raw = JSON.parse(readFileSync(src.path, "utf-8"));
          const hooks = raw.hooks;
          if (!hooks || Object.keys(hooks).length === 0) continue;

          lines.push(`  ── ${src.label} ──`);
          for (const [event, configs] of Object.entries(hooks)) {
            if (!Array.isArray(configs)) continue;
            for (const config of configs as any[]) {
              const hookCount = config.hooks?.length ?? 0;
              totalHooks += hookCount;
              lines.push(`  ${event} [${config.matcher}] - ${hookCount} action(s)`);
              for (const h of config.hooks ?? []) {
                const label = h.type === "http" ? `http: ${h.url}` : `command: ${h.command}`;
                lines.push(`    ${label}`);
              }
            }
          }
          lines.push("");
        } catch { /* skip malformed */ }
      }

      if (totalHooks === 0) {
        return [
          "  No hooks configured.\n",
          "  Add hooks to .kcode/settings.json or ~/.kcode/settings.json:",
          "  {",
          '    "hooks": {',
          '      "PreToolUse": [{',
          '        "matcher": "Bash",',
          '        "hooks": [{ "type": "command", "command": "echo check" }]',
          "      }]",
          "    }",
          "  }",
          "",
          "  Hook types: command (stdin JSON), http (POST JSON)",
          "  Events: SessionStart, PreToolUse, PostToolUse, PostToolUseFailure,",
          "          PreCompact, PostCompact, UserPromptSubmit, PermissionRequest,",
          "          Stop, Notification, ConfigChange, InstructionsLoaded",
        ].join("\n");
      }

      lines.push(`  Total: ${totalHooks} hook action(s)`);
      return lines.join("\n");
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

      // Count tool usage from messages (current session)
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

      // Build session analytics
      const sorted = Object.entries(toolCounts).sort((a, b) => b[1] - a[1]);
      const maxNameLen = Math.max(...sorted.map(([n]) => n.length), 8);
      const maxCount = sorted[0]?.[1] ?? 1;
      const barWidth = 20;

      const lines = [
        `  Session Analytics`,
        ``,
        `  Messages:    ${state.messages.length}`,
        `  Tool calls:  ${totalToolCalls}`,
        `  Tokens:      ${(usage.inputTokens + usage.outputTokens).toLocaleString()}`,
      ];

      if (totalToolCalls > 0) {
        lines.push(``, `  Tool Usage:`);
        for (const [name, count] of sorted) {
          const pct = Math.round((count / totalToolCalls) * 100);
          const filled = Math.round((count / maxCount) * barWidth);
          const bar = "\u2588".repeat(filled) + "\u2591".repeat(barWidth - filled);
          const errors = toolErrors[name] ? ` (${toolErrors[name]} err)` : "";
          lines.push(`  ${name.padEnd(maxNameLen)} ${bar} ${count} (${pct}%)${errors}`);
        }

        const totalErrors = Object.values(toolErrors).reduce((a, b) => a + b, 0);
        if (totalErrors > 0) {
          lines.push(``, `  Error rate: ${totalErrors}/${totalToolCalls} (${Math.round((totalErrors / totalToolCalls) * 100)}%)`);
        }
      }

      // Persistent analytics (cross-session, last 7 days)
      try {
        const { getAnalyticsSummary, formatAnalyticsSummary } = await import("../core/analytics.js");
        const summary = getAnalyticsSummary(7);
        if (summary.totalToolCalls > 0) {
          lines.push(``, `  ─── Historical (7 days) ───`, ``);
          lines.push(formatAnalyticsSummary(summary, 7));
        }
      } catch { /* analytics table may not exist yet */ }

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
    case "ratelimit": {
      const rl = conversationManager.getRateLimiter();
      const stats = rl.stats;
      const lines = [
        `  Rate Limiter Dashboard`,
        ``,
        `  Active requests:    ${stats.activeRequests}`,
        `  Pending (queued):   ${stats.pending}`,
        `  Requests this min:  ${stats.requestsThisMinute}`,
        ``,
        `  Config:`,
        `    Max per minute:   ${appConfig.rateLimit?.maxPerMinute ?? 60}`,
        `    Max concurrent:   ${appConfig.rateLimit?.maxConcurrent ?? 2}`,
      ];

      // Visual gauge for requests this minute
      const maxRpm = appConfig.rateLimit?.maxPerMinute ?? 60;
      const pct = Math.min(100, Math.round((stats.requestsThisMinute / maxRpm) * 100));
      const barLen = 30;
      const filled = Math.round(barLen * pct / 100);
      const bar = "\u2588".repeat(filled) + "\u2591".repeat(barLen - filled);
      lines.push(``, `  Rate:  [${bar}] ${pct}% (${stats.requestsThisMinute}/${maxRpm})`);

      return lines.join("\n");
    }
    case "config": {
      const { existsSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");

      const cwd = appConfig.workingDirectory;

      const lines = [
        `  Resolved Configuration`,
        ``,
        `  model:            ${appConfig.model}`,
        `  apiBase:          ${appConfig.apiBase ?? "(default)"}`,
        `  maxTokens:        ${appConfig.maxTokens}`,
        `  permissionMode:   ${appConfig.permissionMode}`,
        `  contextWindow:    ${(appConfig.contextWindowSize ?? 200000).toLocaleString()}`,
        `  autoRoute:        ${appConfig.autoRoute ?? true}`,
        `  compactThreshold: ${(appConfig.compactThreshold ?? 0.8) * 100}%`,
        `  theme:            ${appConfig.theme ?? "(default)"}`,
        `  thinking:         ${appConfig.thinking ? "on" : "off"}`,
        ``,
        `  Settings Sources (highest priority first):`,
      ];

      // Check which files exist
      const sources = [
        { name: "Environment vars", exists: !!(process.env.KCODE_MODEL || process.env.KCODE_API_KEY || process.env.KCODE_API_BASE) },
        { name: ".kcode/settings.local.json", exists: existsSync(join(cwd, ".kcode", "settings.local.json")) },
        { name: ".kcode/settings.json", exists: existsSync(join(cwd, ".kcode", "settings.json")) },
        { name: "~/.kcode/settings.json", exists: existsSync(join(homedir(), ".kcode", "settings.json")) },
      ];

      for (const src of sources) {
        const icon = src.exists ? "\u2713" : "\u2717";
        lines.push(`    ${icon} ${src.name}`);
      }

      // Show env overrides if any
      const envVars = ["KCODE_MODEL", "KCODE_API_KEY", "KCODE_API_BASE", "KCODE_EFFORT_LEVEL", "KCODE_MAX_TOKENS", "KCODE_PERMISSION_MODE", "KCODE_THEME"];
      const setVars = envVars.filter(v => process.env[v]);
      if (setVars.length > 0) {
        lines.push(``, `  Active env vars:`);
        for (const v of setVars) {
          const val = v.includes("KEY") ? "****" : process.env[v];
          lines.push(`    ${v}=${val}`);
        }
      }

      return lines.join("\n");
    }
    case "snippet": {
      const { saveSnippet, loadSnippet, listSnippets, deleteSnippet } = await import("../core/snippets.js");
      const arg = args?.trim() ?? "list";

      if (arg === "list") {
        const snippets = listSnippets();
        if (snippets.length === 0) return "  No snippets saved. Usage: /snippet save <name> <content>";
        const lines = [`  Saved Snippets (${snippets.length}):\n`];
        for (const s of snippets) {
          const preview = s.content.split("\n")[0].slice(0, 60);
          lines.push(`  ${s.name.padEnd(20)} ${preview}${s.content.length > 60 ? "..." : ""}`);
        }
        return lines.join("\n");
      }

      if (arg.startsWith("save ")) {
        const rest = arg.slice(5).trim();
        const spaceIdx = rest.indexOf(" ");
        if (spaceIdx === -1) return "  Usage: /snippet save <name> <content>";
        const name = rest.slice(0, spaceIdx);
        const content = rest.slice(spaceIdx + 1);
        saveSnippet(name, content);
        return `  Snippet "${name}" saved (${content.length} chars).`;
      }

      if (arg.startsWith("paste ")) {
        const name = arg.slice(6).trim();
        const snippet = loadSnippet(name);
        if (!snippet) return `  Snippet "${name}" not found.`;
        return `  [${snippet.name}]:\n${snippet.content}`;
      }

      if (arg.startsWith("delete ")) {
        const name = arg.slice(7).trim();
        const deleted = deleteSnippet(name);
        return deleted ? `  Deleted snippet "${name}"` : `  Snippet "${name}" not found.`;
      }

      return "  Usage: /snippet save <name> <content> | list | paste <name> | delete <name>";
    }
    case "model_health": {
      const { listModels: getModels } = await import("../core/models.js");
      const models = await getModels();

      if (models.length === 0) return "  No models registered. Use 'kcode models add' to register models.";

      const lines = [`  Model Health Check (${models.length} model${models.length > 1 ? "s" : ""})\n`];

      // Ping all models in parallel
      const ping = async (model: { name: string; baseUrl: string }): Promise<{ name: string; status: string; latencyMs: number }> => {
        const start = Date.now();
        try {
          const resp = await fetch(`${model.baseUrl}/v1/models`, {
            method: "GET",
            headers: appConfig.apiKey ? { "Authorization": `Bearer ${appConfig.apiKey}` } : {},
            signal: AbortSignal.timeout(10000),
          });
          const latencyMs = Date.now() - start;
          if (resp.ok) return { name: model.name, status: "ok", latencyMs };
          return { name: model.name, status: `HTTP ${resp.status}`, latencyMs };
        } catch (err) {
          return { name: model.name, status: err instanceof Error ? err.message : "error", latencyMs: Date.now() - start };
        }
      };

      const results = await Promise.all(models.map(m => ping(m)));

      const maxNameLen = Math.max(...results.map(r => r.name.length), 8);
      for (const r of results) {
        const icon = r.status === "ok" ? "\u2713" : "\u2717";
        const latency = r.status === "ok" ? `${r.latencyMs}ms` : r.status;
        lines.push(`  ${icon} ${r.name.padEnd(maxNameLen)}  ${latency}`);
      }

      const okCount = results.filter(r => r.status === "ok").length;
      lines.push(`\n  ${okCount}/${results.length} models responding`);

      if (okCount > 0) {
        const avgLatency = Math.round(
          results.filter(r => r.status === "ok").reduce((a, b) => a + b.latencyMs, 0) / okCount
        );
        lines.push(`  Avg latency: ${avgLatency}ms`);
      }

      return lines.join("\n");
    }
    case "budget": {
      const state = conversationManager.getState();
      const usage = conversationManager.getUsage();
      const contextSize = appConfig.contextWindowSize ?? 200000;
      const usedTokens = usage.inputTokens + usage.outputTokens;
      const threshold = (appConfig.compactThreshold ?? 0.8) * contextSize;
      const remaining = Math.max(0, threshold - usedTokens);
      const pctUsed = Math.min(100, Math.round((usedTokens / contextSize) * 100));
      const pctThreshold = Math.round((appConfig.compactThreshold ?? 0.8) * 100);

      // Estimate tokens per message (average)
      const msgCount = state.messages.length;
      const tokPerMsg = msgCount > 0 ? Math.round(usedTokens / msgCount) : 0;
      const msgsUntilCompact = tokPerMsg > 0 ? Math.floor(remaining / tokPerMsg) : 0;

      // Visual bar showing used, threshold, and total
      const barLen = 40;
      const usedBar = Math.round(barLen * pctUsed / 100);
      const threshBar = Math.round(barLen * pctThreshold / 100);

      let bar = "";
      for (let i = 0; i < barLen; i++) {
        if (i < usedBar) bar += "\u2588";
        else if (i === threshBar) bar += "|";
        else bar += "\u2591";
      }

      const lines = [
        `  Context Budget Planner`,
        ``,
        `  [${bar}] ${pctUsed}%`,
        `  Used:      ${usedTokens.toLocaleString()} tokens`,
        `  Threshold: ${Math.round(threshold).toLocaleString()} tokens (${pctThreshold}%)`,
        `  Window:    ${contextSize.toLocaleString()} tokens`,
        `  Remaining: ${remaining.toLocaleString()} tokens until auto-compact`,
        ``,
        `  Estimates:`,
        `    Avg tokens/message: ~${tokPerMsg.toLocaleString()}`,
        `    Messages until compact: ~${msgsUntilCompact}`,
        `    Messages so far: ${msgCount}`,
        `    Tool calls: ${state.toolUseCount}`,
      ];

      // Warn if close to threshold
      if (pctUsed >= pctThreshold - 5) {
        lines.push(``, `  \u26A0 Approaching auto-compact threshold! Consider /compact manually.`);
      } else if (pctUsed >= pctThreshold * 0.7) {
        lines.push(``, `  \u2139 Context is ${pctUsed}% full. Plenty of room.`);
      }

      return lines.join("\n");
    }
    case "diff_session": {
      const files = conversationManager.getModifiedFiles();
      if (files.length === 0) return "  No files modified in this session.";

      const { execSync } = await import("node:child_process");
      const cwd = appConfig.workingDirectory;
      const lines = [`  Session Diff \u2014 ${files.length} file(s) modified\n`];

      let totalAdded = 0;
      let totalRemoved = 0;

      for (const f of files) {
        try {
          // Get diff stat for each file
          const stat = execSync(`git diff --numstat -- "${f}" 2>/dev/null`, { cwd, timeout: 3000 }).toString().trim();
          if (stat) {
            const parts = stat.split("\t");
            const added = parseInt(parts[0]) || 0;
            const removed = parseInt(parts[1]) || 0;
            totalAdded += added;
            totalRemoved += removed;
            lines.push(`  ${f}`);
            lines.push(`    +${added} -${removed}`);
          } else {
            // Check if it's a new untracked file
            const isUntracked = execSync(`git ls-files --others --exclude-standard -- "${f}" 2>/dev/null`, { cwd, timeout: 3000 }).toString().trim();
            if (isUntracked) {
              lines.push(`  ${f} (new file)`);
            } else {
              lines.push(`  ${f} (no git changes)`);
            }
          }
        } catch {
          lines.push(`  ${f} (not in git)`);
        }
      }

      // Summary
      lines.push(``);
      lines.push(`  Total: +${totalAdded} -${totalRemoved} across ${files.length} file(s)`);

      // Show combined diff preview (truncated)
      try {
        const fileArgs = files.map(f => `"${f}"`).join(" ");
        const diff = execSync(`git diff --stat -- ${fileArgs} 2>/dev/null`, { cwd, timeout: 5000 }).toString().trim();
        if (diff) {
          lines.push(``);
          const lastLine = diff.split("\n").pop() ?? "";
          lines.push(`  ${lastLine}`);
        }
      } catch { /* ignore */ }

      return lines.join("\n");
    }
    case "env": {
      const { execSync } = await import("node:child_process");
      const cwd = appConfig.workingDirectory;

      const detect = (cmd: string): string => {
        try {
          return execSync(`${cmd} 2>/dev/null`, { cwd, timeout: 5000 }).toString().trim().split("\n")[0];
        } catch {
          return "";
        }
      };

      const checks = [
        { name: "OS", cmd: "uname -sr" },
        { name: "Shell", cmd: "echo $SHELL" },
        { name: "Bun", cmd: "bun --version" },
        { name: "Node", cmd: "node --version" },
        { name: "npm", cmd: "npm --version" },
        { name: "Git", cmd: "git --version" },
        { name: "Python", cmd: "python3 --version" },
        { name: "Cargo", cmd: "cargo --version" },
        { name: "Go", cmd: "go version" },
        { name: "Docker", cmd: "docker --version" },
        { name: "GCC", cmd: "gcc --version | head -1" },
      ];

      const lines = [`  Development Environment\n`];
      const maxNameLen = Math.max(...checks.map(c => c.name.length));

      for (const { name, cmd } of checks) {
        const ver = detect(cmd);
        if (ver) {
          lines.push(`  \u2713 ${name.padEnd(maxNameLen)}  ${ver}`);
        }
      }

      // Git repo info
      const gitBranch = detect("git rev-parse --abbrev-ref HEAD");
      const gitRemote = detect("git remote get-url origin");
      if (gitBranch) {
        lines.push(``);
        lines.push(`  Git branch: ${gitBranch}`);
        if (gitRemote) lines.push(`  Remote:     ${gitRemote}`);
      }

      // Project info
      lines.push(``);
      lines.push(`  CWD: ${cwd}`);
      lines.push(`  KCode: v${appConfig.version ?? "?"}`);
      lines.push(`  Model: ${appConfig.model}`);

      return lines.join("\n");
    }
    case "estimate": {
      if (!args?.trim()) return "  Usage: /estimate <text or file path>";

      const input = args.trim();
      let text = input;

      // Check if it's a file path
      const { existsSync, readFileSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const filePath = resolve(appConfig.workingDirectory, input);
      let isFile = false;

      if (existsSync(filePath)) {
        try {
          const { statSync } = await import("node:fs");
          const fileStat = statSync(filePath);
          if (fileStat.size > 10 * 1024 * 1024) {
            return `  File too large (${(fileStat.size / (1024 * 1024)).toFixed(1)} MB). Max 10 MB for estimation.`;
          }
          text = readFileSync(filePath, "utf-8");
          isFile = true;
        } catch { /* use input as text */ }
      }

      // Simple token estimation: ~4 chars per token for English text, ~3 for code
      const charCount = text.length;
      const wordCount = text.split(/\s+/).filter(Boolean).length;
      const lineCount = text.split("\n").length;

      // Heuristic: code has more special chars
      const codeRatio = (text.match(/[{}()\[\];=<>|&]/g)?.length ?? 0) / Math.max(charCount, 1);
      const charsPerToken = codeRatio > 0.02 ? 3.2 : 4.0;
      const estimatedTokens = Math.round(charCount / charsPerToken);

      const contextSize = appConfig.contextWindowSize ?? 200000;
      const pct = Math.round((estimatedTokens / contextSize) * 100);

      const lines = [
        `  Token Estimate${isFile ? ` (${input})` : ""}`,
        ``,
        `  Characters:  ${charCount.toLocaleString()}`,
        `  Words:       ${wordCount.toLocaleString()}`,
        `  Lines:       ${lineCount.toLocaleString()}`,
        ``,
        `  Est. tokens: ~${estimatedTokens.toLocaleString()}`,
        `  Context:     ${pct}% of ${contextSize.toLocaleString()} window`,
        `  Type:        ${codeRatio > 0.02 ? "code" : "text"} (~${charsPerToken} chars/token)`,
      ];

      if (pct > 50) {
        lines.push(``, `  \u26A0 This would use ${pct}% of your context window.`);
      }

      return lines.join("\n");
    }
    case "alias": {
      const { addAlias, removeAlias, loadAliases } = await import("../core/aliases.js");
      const arg = args?.trim() ?? "list";

      if (arg === "list") {
        const aliases = loadAliases();
        if (aliases.length === 0) return "  No custom aliases. Usage: /alias set <shortcut> <expansion>";
        const lines = [`  Custom Aliases (${aliases.length}):\n`];
        for (const a of aliases) {
          lines.push(`  /${a.shortcut} \u2192 ${a.expansion}`);
        }
        return lines.join("\n");
      }

      if (arg.startsWith("set ")) {
        const rest = arg.slice(4).trim();
        const spaceIdx = rest.indexOf(" ");
        if (spaceIdx === -1) return "  Usage: /alias set <shortcut> <expansion>\n  Example: /alias set s /simplify";
        const shortcut = rest.slice(0, spaceIdx).replace(/^\//, ""); // strip leading /
        const expansion = rest.slice(spaceIdx + 1);
        addAlias(shortcut, expansion);
        return `  Alias set: /${shortcut} \u2192 ${expansion}`;
      }

      if (arg.startsWith("remove ") || arg.startsWith("delete ")) {
        const shortcut = arg.replace(/^(remove|delete)\s+/, "").trim().replace(/^\//, "");
        const removed = removeAlias(shortcut);
        return removed ? `  Alias /${shortcut} removed.` : `  Alias /${shortcut} not found.`;
      }

      return "  Usage: /alias set <shortcut> <expansion> | list | remove <shortcut>";
    }
    case "gallery": {
      const { TemplateManager } = await import("../core/templates.js");
      const tm = new TemplateManager(appConfig.workingDirectory);
      tm.load();
      const templates = tm.list();

      // Also show builtin skills as "built-in templates"
      const { builtinSkills } = await import("../core/builtin-skills.js");

      const lines = [`  Template Gallery\n`];

      // User templates
      if (templates.length > 0) {
        lines.push(`  \u2500\u2500 User Templates (${templates.length}) \u2500\u2500`);
        for (const t of templates) {
          const argStr = t.args.length > 0 ? ` [${t.args.join(", ")}]` : "";
          const preview = t.body.split("\n")[0].slice(0, 50);
          lines.push(`  /${t.name}${argStr}`);
          lines.push(`    ${t.description || preview}${t.body.length > 50 ? "..." : ""}`);
        }
        lines.push(``);
      }

      // Categorize builtin skills
      const categories: Record<string, typeof builtinSkills> = {
        "Git": builtinSkills.filter(s => ["commit", "diff", "branch", "log", "stash", "stashes", "blame", "resolve"].includes(s.name)),
        "Code Quality": builtinSkills.filter(s => ["simplify", "lint", "find-bug", "security", "security-review", "type", "test", "test-for", "auto-test"].includes(s.name)),
        "Session": builtinSkills.filter(s => ["context", "usage", "analytics", "budget", "compact", "export", "replay", "note", "bookmark", "search-chat", "diff-session", "profile", "session-tags", "auto-compact"].includes(s.name)),
        "Models": builtinSkills.filter(s => ["models", "compare", "consensus", "model-health", "ratelimit", "estimate", "project-cost"].includes(s.name)),
        "Utilities": builtinSkills.filter(s => ["explain", "doc", "deps", "depgraph", "todo", "batch", "loop", "env", "snippet", "alias", "chain", "workspace", "index", "retry"].includes(s.name)),
        "System": builtinSkills.filter(s => ["help", "clear", "rewind", "plugins", "theme", "config", "hooks", "pin", "unpin", "template", "plan", "stats", "doctor", "memory", "fork", "branches", "branch", "gallery"].includes(s.name)),
      };

      // Collect categorized skill names to find uncategorized ones
      const categorizedNames = new Set<string>();
      for (const skills of Object.values(categories)) {
        for (const s of skills) categorizedNames.add(s.name);
      }
      const uncategorized = builtinSkills.filter(s => !categorizedNames.has(s.name));
      if (uncategorized.length > 0) {
        categories["Other"] = uncategorized;
      }

      for (const [cat, skills] of Object.entries(categories)) {
        if (skills.length === 0) continue;
        lines.push(`  \u2500\u2500 ${cat} (${skills.length}) \u2500\u2500`);
        for (const s of skills) {
          const aliasStr = s.aliases.length > 0 ? ` (${s.aliases.join(", ")})` : "";
          lines.push(`  /${s.name}${aliasStr} \u2014 ${s.description}`);
        }
        lines.push(``);
      }

      lines.push(`  Total: ${builtinSkills.length} built-in + ${templates.length} user templates`);
      return lines.join("\n");
    }
    case "replay": {
      const state = conversationManager.getState();
      if (state.messages.length === 0) return "  No messages to replay.";

      const lines = [`  Session Replay (${state.messages.length} messages)\n`];
      let toolCallCount = 0;

      for (let i = 0; i < state.messages.length; i++) {
        const msg = state.messages[i];
        const num = `#${(i + 1).toString().padStart(3)}`;

        if (typeof msg.content === "string") {
          const preview = msg.content.split("\n")[0].slice(0, 70);
          const icon = msg.role === "user" ? "\u25B6" : "\u25C0";
          lines.push(`  ${num} ${icon} [${msg.role}] ${preview}${msg.content.length > 70 ? "..." : ""}`);
        } else {
          // Count blocks
          const textBlocks = msg.content.filter(b => b.type === "text");
          const toolBlocks = msg.content.filter(b => b.type === "tool_use");
          const resultBlocks = msg.content.filter(b => b.type === "tool_result");
          toolCallCount += toolBlocks.length;

          if (textBlocks.length > 0) {
            const firstText = textBlocks[0].type === "text" ? textBlocks[0].text : "";
            const preview = firstText.split("\n")[0].slice(0, 60);
            const icon = msg.role === "user" ? "\u25B6" : "\u25C0";
            lines.push(`  ${num} ${icon} [${msg.role}] ${preview}${firstText.length > 60 ? "..." : ""}`);
          }
          if (toolBlocks.length > 0) {
            const toolNames = toolBlocks.map(b => b.type === "tool_use" ? b.name : "?").join(", ");
            lines.push(`        \u2699 ${toolBlocks.length} tool(s): ${toolNames}`);
          }
          if (resultBlocks.length > 0) {
            const errors = resultBlocks.filter(b => b.type === "tool_result" && b.is_error).length;
            if (errors > 0) lines.push(`        \u2717 ${errors} error(s)`);
          }
        }
      }

      lines.push(``);
      lines.push(`  Summary: ${state.messages.length} messages, ${toolCallCount} tool calls`);
      return lines.join("\n");
    }
    case "depgraph": {
      if (!args?.trim()) return "  Usage: /depgraph <file path>";

      const { resolve: resolvePath } = await import("node:path");
      const { readFileSync, existsSync } = await import("node:fs");
      const { dirname, basename, relative } = await import("node:path");

      const filePath = resolvePath(appConfig.workingDirectory, args.trim());
      if (!existsSync(filePath)) return `  File not found: ${args.trim()}`;

      let content: string;
      try {
        content = readFileSync(filePath, "utf-8");
      } catch {
        return `  Cannot read: ${args.trim()}`;
      }

      // Extract imports (handles multiline imports)
      const importRegex = /(?:import\s+[\s\S]*?from\s+["'](.+?)["']|require\s*\(\s*["'](.+?)["']\s*\))/g;
      const imports: string[] = [];
      let match;
      while ((match = importRegex.exec(content)) !== null) {
        imports.push(match[1] ?? match[2]);
      }

      // Extract exports
      const exportRegex = /export\s+(?:default\s+)?(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/g;
      const exports: string[] = [];
      while ((match = exportRegex.exec(content)) !== null) {
        exports.push(match[1]);
      }
      // Also check for `export { ... }`
      const reExportRegex = /export\s*\{([^}]+)\}/g;
      while ((match = reExportRegex.exec(content)) !== null) {
        const names = match[1].split(",").map(s => s.trim().split(/\s+as\s+/).pop()?.trim()).filter(Boolean);
        exports.push(...(names as string[]));
      }

      const relPath = relative(appConfig.workingDirectory, filePath) || basename(filePath);
      const lines = [`  Dependency Graph: ${relPath}\n`];

      // Imports tree
      if (imports.length > 0) {
        lines.push(`  Imports (${imports.length}):`);
        for (let i = 0; i < imports.length; i++) {
          const isLast = i === imports.length - 1;
          const prefix = isLast ? "\u2514\u2500" : "\u251C\u2500";
          const imp = imports[i];
          const isLocal = imp.startsWith(".") || imp.startsWith("/");
          const tag = isLocal ? "" : " (external)";
          lines.push(`    ${prefix} ${imp}${tag}`);
        }
      } else {
        lines.push(`  No imports found.`);
      }

      lines.push(``);

      // Exports tree
      if (exports.length > 0) {
        lines.push(`  Exports (${exports.length}):`);
        for (let i = 0; i < exports.length; i++) {
          const isLast = i === exports.length - 1;
          const prefix = isLast ? "\u2514\u2500" : "\u251C\u2500";
          lines.push(`    ${prefix} ${exports[i]}`);
        }
      } else {
        lines.push(`  No exports found.`);
      }

      return lines.join("\n");
    }
    case "blame": {
      if (!args?.trim()) return "  Usage: /blame <file path>";

      const { execSync } = await import("node:child_process");
      const { resolve: resolvePath, relative } = await import("node:path");
      const cwd = appConfig.workingDirectory;
      const filePath = resolvePath(cwd, args.trim());
      const relPath = relative(cwd, filePath);

      try {
        const shortOutput = execSync(`git blame --date=short "${relPath}" 2>&1`, { cwd, timeout: 10000 }).toString().trim();
        const rawLines = shortOutput.split("\n");

        const lines = [`  Git Blame: ${relPath} (${rawLines.length} lines)\n`];

        // Show first 40 lines max
        const maxLines = 40;
        for (let i = 0; i < Math.min(rawLines.length, maxLines); i++) {
          lines.push(`  ${rawLines[i]}`);
        }
        if (rawLines.length > maxLines) {
          lines.push(`\n  ... ${rawLines.length - maxLines} more lines (use git blame directly for full output)`);
        }

        return lines.join("\n");
      } catch (err: any) {
        return `  Git error: ${err.stderr?.toString()?.trim() || err.message}`;
      }
    }
    case "project_cost": {
      const usage = conversationManager.getUsage();
      const state = conversationManager.getState();

      const { getModelPricing, calculateCost, formatCost } = await import("../core/pricing.js");
      const pricing = await getModelPricing(appConfig.model);

      const msgCount = state.messages.length;
      if (msgCount === 0) return "  No messages yet — cannot project costs.";

      const n = parseInt(args?.trim() || "") || 10;

      // Current averages
      const avgInputPerMsg = Math.round(usage.inputTokens / msgCount);
      const avgOutputPerMsg = Math.round(usage.outputTokens / msgCount);
      const currentCost = pricing ? calculateCost(pricing, usage.inputTokens, usage.outputTokens) : 0;

      // Project
      const projInputTokens = avgInputPerMsg * n;
      const projOutputTokens = avgOutputPerMsg * n;
      const projCost = pricing ? calculateCost(pricing, projInputTokens, projOutputTokens) : 0;
      const totalProjectedCost = currentCost + projCost;

      const lines = [
        `  Cost Projection \u2014 Next ${n} Messages`,
        ``,
        `  Current Session:`,
        `    Messages:      ${msgCount}`,
        `    Input tokens:  ${usage.inputTokens.toLocaleString()} (avg ${avgInputPerMsg.toLocaleString()}/msg)`,
        `    Output tokens: ${usage.outputTokens.toLocaleString()} (avg ${avgOutputPerMsg.toLocaleString()}/msg)`,
        `    Cost so far:   ${formatCost(currentCost)}`,
        ``,
        `  Projection (+${n} messages):`,
        `    Est. input:    +${projInputTokens.toLocaleString()} tokens`,
        `    Est. output:   +${projOutputTokens.toLocaleString()} tokens`,
        `    Est. cost:     +${formatCost(projCost)}`,
        `    Total:         ${formatCost(totalProjectedCost)}`,
      ];

      if (pricing) {
        lines.push(``, `  Rate: $${pricing.inputPer1M}/M in, $${pricing.outputPer1M}/M out`);
      } else {
        lines.push(``, `  \u2139 No pricing data for ${appConfig.model} (local model — free)`);
      }

      // Context budget check
      const contextSize = appConfig.contextWindowSize ?? 200000;
      const totalTokens = usage.inputTokens + usage.outputTokens + projInputTokens + projOutputTokens;
      const pct = Math.round((totalTokens / contextSize) * 100);
      if (pct > 80) {
        lines.push(``, `  \u26A0 Projected to use ${pct}% of context window — may trigger auto-compact`);
      }

      return lines.join("\n");
    }
    case "filesize": {
      const { execSync } = await import("node:child_process");
      const cwd = appConfig.workingDirectory;

      const rawPattern = args?.trim() || "**/*.*";
      // Sanitize pattern: only allow alphanumeric, *, ?, ., -, _, /
      const pattern = rawPattern.replace(/[^a-zA-Z0-9*?._\-\/]/g, "");
      if (!pattern) return "  Invalid pattern. Use glob characters like *.ts or **/*.js";

      // Use find to get files matching pattern, sorted by size
      let files: Array<{ path: string; size: number }> = [];
      try {
        const namePattern = pattern.includes("*") ? pattern.split("/").pop() || "*" : pattern;
        const output = execSync(`find . -type f -name '${namePattern.replace(/'/g, "")}' -not -path '*/node_modules/*' -not -path '*/.git/*' -printf '%s\\t%p\\n' 2>/dev/null | sort -rn | head -30`, {
          cwd,
          timeout: 10000,
        }).toString().trim();

        if (output) {
          for (const line of output.split("\n")) {
            const [sizeStr, ...pathParts] = line.split("\t");
            const filePath = pathParts.join("\t");
            const size = parseInt(sizeStr) || 0;
            if (filePath) files.push({ path: filePath.replace(/^\.\//, ""), size });
          }
        }
      } catch {
        return "  Error scanning files. Check the glob pattern.";
      }

      if (files.length === 0) return `  No files found matching: ${pattern}`;

      const maxSize = files[0]?.size ?? 1;
      const barWidth = 20;

      const formatSize = (bytes: number): string => {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
      };

      const lines = [`  File Sizes (top ${files.length}, pattern: ${pattern})\n`];
      for (const f of files) {
        const filled = Math.max(1, Math.round((f.size / maxSize) * barWidth));
        const bar = "\u2588".repeat(filled) + "\u2591".repeat(barWidth - filled);
        lines.push(`  ${bar} ${formatSize(f.size).padStart(10)}  ${f.path}`);
      }

      const totalSize = files.reduce((a, b) => a + b.size, 0);
      lines.push(`\n  Total: ${formatSize(totalSize)} across ${files.length} file(s)`);
      return lines.join("\n");
    }
    case "contributors": {
      const { execSync } = await import("node:child_process");
      const cwd = appConfig.workingDirectory;

      try {
        // Get contributor stats using git shortlog
        const shortlog = execSync(`git shortlog -sne HEAD 2>/dev/null`, { cwd, timeout: 10000 }).toString().trim();
        if (!shortlog) return "  No git history found.";

        const contributors = shortlog.split("\n").map(line => {
          const match = line.trim().match(/^(\d+)\s+(.+?)\s+<(.+?)>$/);
          if (!match) return null;
          return { commits: parseInt(match[1]), name: match[2], email: match[3] };
        }).filter(Boolean) as Array<{ commits: number; name: string; email: string }>;

        if (contributors.length === 0) return "  No contributors found.";

        const maxCommits = contributors[0]?.commits ?? 1;
        const barWidth = 15;

        const lines = [`  Git Contributors (${contributors.length})\n`];
        const maxNameLen = Math.max(...contributors.slice(0, 20).map(c => c.name.length), 6);

        for (const c of contributors.slice(0, 20)) {
          const filled = Math.max(1, Math.round((c.commits / maxCommits) * barWidth));
          const bar = "\u2588".repeat(filled) + "\u2591".repeat(barWidth - filled);
          lines.push(`  ${c.name.padEnd(maxNameLen)}  ${bar} ${c.commits.toString().padStart(5)} commits`);
        }

        if (contributors.length > 20) {
          lines.push(`\n  ... and ${contributors.length - 20} more contributors`);
        }

        // Total stats
        const totalCommits = contributors.reduce((a, b) => a + b.commits, 0);
        lines.push(`\n  Total: ${totalCommits} commits by ${contributors.length} contributor(s)`);

        return lines.join("\n");
      } catch (err: any) {
        return `  Git error: ${err.stderr?.toString()?.trim() || err.message}`;
      }
    }
    case "regex": {
      if (!args?.trim()) return "  Usage: /regex <pattern> <text or file path>\n  Example: /regex \"\\d+\\.\\d+\" package.json";

      const input = args.trim();
      // Parse: first quoted or unquoted token is the pattern, rest is text/file
      let pattern: string;
      let target: string;

      const quotedMatch = input.match(/^["'](.+?)["']\s+(.+)$/);
      if (quotedMatch) {
        pattern = quotedMatch[1];
        target = quotedMatch[2];
      } else {
        const spaceIdx = input.indexOf(" ");
        if (spaceIdx === -1) return "  Usage: /regex <pattern> <text or file path>";
        pattern = input.slice(0, spaceIdx);
        target = input.slice(spaceIdx + 1);
      }

      // Check if target is a file
      const { existsSync, readFileSync, statSync: statSyncFn } = await import("node:fs");
      const { resolve: resolvePath } = await import("node:path");
      let text = target;
      let isFile = false;
      const filePath = resolvePath(appConfig.workingDirectory, target);

      if (existsSync(filePath) && statSyncFn(filePath).isFile()) {
        if (statSyncFn(filePath).size > 1024 * 1024) return "  File too large (max 1 MB for regex testing).";
        text = readFileSync(filePath, "utf-8");
        isFile = true;
      }

      let regex: RegExp;
      try {
        regex = new RegExp(pattern, "g");
      } catch (err) {
        return `  Invalid regex: ${err instanceof Error ? err.message : String(err)}`;
      }

      // Guard against ReDoS: run regex with a timeout
      const matches: Array<{ index: number; match: string; groups?: string[] }> = [];
      const startTime = Date.now();
      let m;
      while ((m = regex.exec(text)) !== null && matches.length < 50) {
        if (Date.now() - startTime > 3000) {
          return `  Regex execution timed out (>3s). Pattern may cause catastrophic backtracking.`;
        }
        const groups = m.slice(1).length > 0 ? m.slice(1) : undefined;
        matches.push({ index: m.index, match: m[0], groups });
        if (m[0].length === 0) { regex.lastIndex++; } // prevent infinite loop on zero-length matches
        if (!regex.global) break;
      }

      if (matches.length === 0) return `  No matches for /${pattern}/${isFile ? ` in ${target}` : ""}`;

      const lines = [`  Regex: /${pattern}/g${isFile ? ` in ${target}` : ""}\n  ${matches.length} match(es)\n`];

      for (let i = 0; i < Math.min(matches.length, 20); i++) {
        const match = matches[i];
        const context = text.slice(Math.max(0, match.index - 20), match.index + match.match.length + 20).replace(/\n/g, "\\n");
        lines.push(`  [${i + 1}] "${match.match}" at index ${match.index}`);
        if (match.groups) {
          lines.push(`       Groups: ${match.groups.map((g, j) => `$${j + 1}="${g}"`).join(", ")}`);
        }
      }

      if (matches.length > 20) lines.push(`\n  ... ${matches.length - 20} more matches`);
      return lines.join("\n");
    }
    case "processes": {
      const { execSync } = await import("node:child_process");
      const cwd = appConfig.workingDirectory;

      const lines = [`  Project-Related Processes\n`];

      // Common dev process patterns
      const patterns = [
        { label: "Node/Bun", cmd: `ps aux | grep -E "(node|bun|tsx|ts-node)" | grep -v grep` },
        { label: "Python", cmd: `ps aux | grep -E "(python|uvicorn|gunicorn|flask)" | grep -v grep` },
        { label: "Go", cmd: `ps aux | grep -E "go (run|build|test)" | grep -v grep` },
        { label: "Docker", cmd: `ps aux | grep -E "docker" | grep -v grep | head -5` },
        { label: "Servers", cmd: `ps aux | grep -E "(vite|webpack|next|nuxt|nginx|httpd|caddy)" | grep -v grep` },
      ];

      let totalFound = 0;
      for (const { label, cmd } of patterns) {
        try {
          const output = execSync(`${cmd} 2>/dev/null`, { cwd, timeout: 5000 }).toString().trim();
          if (output) {
            const procs = output.split("\n");
            totalFound += procs.length;
            lines.push(`  \u2500\u2500 ${label} (${procs.length}) \u2500\u2500`);
            for (const proc of procs.slice(0, 5)) {
              // Extract PID and command
              const parts = proc.trim().split(/\s+/);
              const pid = parts[1] ?? "?";
              const cpu = parts[2] ?? "?";
              const mem = parts[3] ?? "?";
              const command = parts.slice(10).join(" ").slice(0, 60);
              lines.push(`  PID ${pid.padStart(6)}  CPU ${cpu}%  MEM ${mem}%  ${command}`);
            }
            if (procs.length > 5) lines.push(`    ... ${procs.length - 5} more`);
            lines.push(``);
          }
        } catch { /* not found */ }
      }

      // Show listening ports
      try {
        const ports = execSync(`ss -tlnp 2>/dev/null | tail -n +2 | head -10`, { cwd, timeout: 5000 }).toString().trim();
        if (ports) {
          const portLines = ports.split("\n");
          lines.push(`  \u2500\u2500 Listening Ports (${portLines.length}) \u2500\u2500`);
          for (const pl of portLines) {
            const parts = pl.trim().split(/\s+/);
            const addr = parts[3] ?? "?";
            const proc = parts[5]?.replace(/.*"(.+?)".*/, "$1") ?? "";
            lines.push(`  ${addr.padEnd(25)} ${proc}`);
          }
          lines.push(``);
        }
      } catch { /* ignore */ }

      if (totalFound === 0 && lines.length <= 1) {
        lines.push(`  No development processes detected.`);
      }

      return lines.join("\n");
    }
    case "filediff": {
      if (!args?.trim()) return "  Usage: /filediff <file1> <file2>";

      const parts = args.trim().split(/\s+/);
      if (parts.length < 2) return "  Usage: /filediff <file1> <file2>";

      const { resolve: resolvePath } = await import("node:path");
      const { existsSync } = await import("node:fs");
      const { execSync } = await import("node:child_process");
      const cwd = appConfig.workingDirectory;

      const file1 = resolvePath(cwd, parts[0]);
      const file2 = resolvePath(cwd, parts[1]);

      if (!existsSync(file1)) return `  File not found: ${parts[0]}`;
      if (!existsSync(file2)) return `  File not found: ${parts[1]}`;

      try {
        // Use diff command (returns exit code 1 if files differ, which is normal)
        // Escape single quotes in paths to prevent injection
        const esc = (s: string) => s.replace(/'/g, "'\\''");
        const output = execSync(`diff -u '${esc(file1)}' '${esc(file2)}' 2>&1; true`, { cwd, timeout: 10000 }).toString().trim();

        if (!output) return `  Files are identical: ${parts[0]} = ${parts[1]}`;

        const diffLines = output.split("\n");
        const lines = [`  File Diff: ${parts[0]} vs ${parts[1]}\n`];

        // Show first 50 lines of diff
        const maxLines = 50;
        for (let i = 0; i < Math.min(diffLines.length, maxLines); i++) {
          lines.push(`  ${diffLines[i]}`);
        }
        if (diffLines.length > maxLines) {
          lines.push(`\n  ... ${diffLines.length - maxLines} more lines`);
        }

        return lines.join("\n");
      } catch (err: any) {
        return `  Error: ${err.message}`;
      }
    }
    case "crons": {
      const { execSync } = await import("node:child_process");
      const lines = [`  Scheduled Tasks\n`];
      let found = false;

      // User crontab
      try {
        const crontab = execSync(`crontab -l 2>/dev/null`, { timeout: 5000 }).toString().trim();
        if (crontab && !crontab.includes("no crontab")) {
          found = true;
          const entries = crontab.split("\n").filter(l => l.trim() && !l.startsWith("#"));
          lines.push(`  \u2500\u2500 Crontab (${entries.length} entries) \u2500\u2500`);
          for (const entry of entries.slice(0, 15)) {
            lines.push(`  ${entry}`);
          }
          if (entries.length > 15) lines.push(`  ... ${entries.length - 15} more`);
          lines.push(``);
        }
      } catch { /* no crontab */ }

      // Systemd user timers
      try {
        const timers = execSync(`systemctl --user list-timers --no-pager 2>/dev/null`, { timeout: 5000 }).toString().trim();
        if (timers && timers.includes("NEXT")) {
          found = true;
          const timerLines = timers.split("\n");
          lines.push(`  \u2500\u2500 Systemd User Timers \u2500\u2500`);
          for (const tl of timerLines.slice(0, 10)) {
            lines.push(`  ${tl}`);
          }
          lines.push(``);
        }
      } catch { /* no systemd */ }

      // System timers (relevant ones)
      try {
        const sysTimers = execSync(`systemctl list-timers --no-pager 2>/dev/null | head -10`, { timeout: 5000 }).toString().trim();
        if (sysTimers && sysTimers.includes("NEXT")) {
          found = true;
          const sysLines = sysTimers.split("\n");
          lines.push(`  \u2500\u2500 System Timers \u2500\u2500`);
          for (const sl of sysLines) {
            lines.push(`  ${sl}`);
          }
          lines.push(``);
        }
      } catch { /* ignore */ }

      if (!found) {
        lines.push(`  No crontabs or timers found.`);
      }

      return lines.join("\n");
    }
    case "ports": {
      const { execSync } = await import("node:child_process");
      const lines = [`  Listening Ports\n`];

      try {
        const output = execSync(`ss -tlnp 2>/dev/null`, { timeout: 5000 }).toString().trim();
        const rows = output.split("\n").slice(1); // skip header

        if (rows.length === 0) {
          return "  No listening TCP ports found.";
        }

        // Common dev ports
        const knownPorts: Record<number, string> = {
          3000: "React/Next.js", 3001: "Dev server", 4000: "GraphQL",
          4200: "Angular", 5000: "Flask/Vite", 5173: "Vite",
          5432: "PostgreSQL", 6379: "Redis", 8000: "Django/FastAPI",
          8080: "HTTP alt", 8443: "HTTPS alt", 9090: "Prometheus",
          10091: "KCode LLM", 27017: "MongoDB",
        };

        const maxAddrLen = Math.max(...rows.map(r => (r.trim().split(/\s+/)[3] ?? "").length), 10);

        for (const row of rows) {
          const parts = row.trim().split(/\s+/);
          const addr = parts[3] ?? "?";
          const procInfo = parts[5] ?? "";
          const procName = procInfo.replace(/.*users:\(\("(.+?)".*/, "$1") || procInfo;
          const portMatch = addr.match(/:(\d+)$/);
          const port = portMatch ? parseInt(portMatch[1]) : 0;
          const label = knownPorts[port] ? ` (${knownPorts[port]})` : "";
          lines.push(`  ${addr.padEnd(maxAddrLen)}  ${procName}${label}`);
        }

        lines.push(`\n  ${rows.length} port(s) listening`);
      } catch {
        // Fallback to netstat
        try {
          const output = execSync(`netstat -tlnp 2>/dev/null | tail -n +3`, { timeout: 5000 }).toString().trim();
          if (output) {
            lines.push(output);
          } else {
            return "  Cannot detect listening ports (ss/netstat not available).";
          }
        } catch {
          return "  Cannot detect listening ports (ss/netstat not available).";
        }
      }

      return lines.join("\n");
    }
    case "tags": {
      const { execSync } = await import("node:child_process");
      const cwd = appConfig.workingDirectory;
      const arg = args?.trim() ?? "list";

      try {
        if (arg === "list" || !arg) {
          const output = execSync(`git tag -l --sort=-creatordate --format='%(creatordate:short) %(refname:short) %(subject)' 2>/dev/null | head -20`, { cwd, timeout: 5000 }).toString().trim();
          if (!output) return "  No tags found.";

          const lines = [`  Git Tags\n`];
          for (const line of output.split("\n")) {
            const parts = line.match(/^(\S+)\s+(\S+)\s*(.*)$/);
            if (parts) {
              lines.push(`  ${parts[2].padEnd(20)} ${parts[1]}  ${parts[3] || ""}`);
            } else {
              lines.push(`  ${line}`);
            }
          }

          // Count total
          const total = execSync(`git tag -l 2>/dev/null | wc -l`, { cwd, timeout: 3000 }).toString().trim();
          lines.push(`\n  ${total} tag(s) total`);
          return lines.join("\n");
        }

        if (arg.startsWith("create ")) {
          const rest = arg.slice(7).trim();
          const spaceIdx = rest.indexOf(" ");
          const tagName = spaceIdx > 0 ? rest.slice(0, spaceIdx) : rest;
          const message = spaceIdx > 0 ? rest.slice(spaceIdx + 1) : "";

          // Validate tag name: alphanumeric, dots, dashes only
          if (!/^[a-zA-Z0-9._\-]+$/.test(tagName)) {
            return "  Invalid tag name. Use alphanumeric, dots, dashes only.";
          }

          if (message) {
            execSync(`git tag -a '${tagName.replace(/'/g, "")}' -m '${message.replace(/'/g, "'\\''")}'`, { cwd, timeout: 5000 });
          } else {
            execSync(`git tag '${tagName.replace(/'/g, "")}'`, { cwd, timeout: 5000 });
          }
          return `  Created tag: ${tagName}${message ? ` ("${message}")` : ""}`;
        }

        if (arg.startsWith("log ") && arg.includes("..")) {
          const range = arg.slice(4).trim();
          // Validate range format
          if (!/^[a-zA-Z0-9._\-]+\.\.[a-zA-Z0-9._\-]+$/.test(range)) {
            return "  Usage: /tags log <tag1>..<tag2>";
          }
          const output = execSync(`git log --oneline '${range}' 2>&1`, { cwd, timeout: 10000 }).toString().trim();
          if (!output) return `  No commits between ${range}`;
          const logLines = output.split("\n");
          const lines = [`  Changelog: ${range} (${logLines.length} commits)\n`];
          for (const l of logLines.slice(0, 30)) {
            lines.push(`  ${l}`);
          }
          if (logLines.length > 30) lines.push(`\n  ... ${logLines.length - 30} more`);
          return lines.join("\n");
        }

        return "  Usage: /tags [list | create <name> [message] | log <tag1>..<tag2>]";
      } catch (err: any) {
        return `  Git error: ${err.stderr?.toString()?.trim() || err.message}`;
      }
    }
    case "file_history": {
      if (!args?.trim()) return "  Usage: /file-history <file path>";

      const { execSync } = await import("node:child_process");
      const { resolve: resolvePath, relative } = await import("node:path");
      const cwd = appConfig.workingDirectory;
      const filePath = resolvePath(cwd, args.trim());
      const relPath = relative(cwd, filePath);

      try {
        const output = execSync(`git log --oneline --follow --stat -- '${relPath.replace(/'/g, "'\\''")}'  2>&1 | head -60`, { cwd, timeout: 10000 }).toString().trim();
        if (!output) return `  No git history for: ${args.trim()}`;

        // Count total commits for the file
        const countOutput = execSync(`git log --oneline --follow -- '${relPath.replace(/'/g, "'\\''")}'  2>/dev/null | wc -l`, { cwd, timeout: 5000 }).toString().trim();

        const lines = [`  File History: ${relPath} (${countOutput} commits)\n`];
        for (const line of output.split("\n")) {
          lines.push(`  ${line}`);
        }

        return lines.join("\n");
      } catch (err: any) {
        return `  Git error: ${err.stderr?.toString()?.trim() || err.message}`;
      }
    }
    case "copy": {
      if (!args?.trim()) return "  Usage: /copy <text or file path>";

      const { existsSync, readFileSync, statSync: statSyncFn } = await import("node:fs");
      const { resolve: resolvePath } = await import("node:path");
      const { execSync } = await import("node:child_process");

      let text = args.trim();
      let isFile = false;
      const filePath = resolvePath(appConfig.workingDirectory, text);

      const fileStat = existsSync(filePath) ? statSyncFn(filePath) : null;
      if (fileStat?.isFile()) {
        if (fileStat.size > 1024 * 1024) return "  File too large for clipboard (max 1 MB).";
        text = readFileSync(filePath, "utf-8");
        isFile = true;
      }

      // Detect clipboard command
      const clipCmds = [
        { test: "which xclip", cmd: "xclip -selection clipboard" },
        { test: "which xsel", cmd: "xsel --clipboard --input" },
        { test: "which wl-copy", cmd: "wl-copy" },
        { test: "which pbcopy", cmd: "pbcopy" },
      ];

      let clipCmd: string | null = null;
      for (const { test, cmd } of clipCmds) {
        try {
          execSync(`${test} 2>/dev/null`, { timeout: 2000 });
          clipCmd = cmd;
          break;
        } catch { /* not available */ }
      }

      if (!clipCmd) return "  No clipboard tool found (install xclip, xsel, or wl-copy).";

      try {
        execSync(clipCmd, { input: text, timeout: 5000 });
        const preview = text.split("\n")[0].slice(0, 60);
        return `  Copied to clipboard (${text.length} chars)${isFile ? ` from ${args.trim()}` : ""}\n  ${preview}${text.length > 60 ? "..." : ""}`;
      } catch (err: any) {
        return `  Clipboard error: ${err.message}`;
      }
    }
    case "json": {
      if (!args?.trim()) return "  Usage: /json <file path or JSON text>";

      const input = args.trim();
      let text = input;
      let isFile = false;

      const { existsSync, readFileSync, statSync: statSyncFn } = await import("node:fs");
      const { resolve: resolvePath } = await import("node:path");
      const filePath = resolvePath(appConfig.workingDirectory, input);

      if (existsSync(filePath) && statSyncFn(filePath).isFile()) {
        if (statSyncFn(filePath).size > 5 * 1024 * 1024) return "  File too large (max 5 MB).";
        text = readFileSync(filePath, "utf-8");
        isFile = true;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        return `  Invalid JSON: ${err instanceof Error ? err.message : String(err)}`;
      }

      // Analyze structure
      const countKeys = (obj: unknown, depth = 0): { keys: number; maxDepth: number; arrays: number; objects: number } => {
        const result = { keys: 0, maxDepth: depth, arrays: 0, objects: 0 };
        if (depth > 100) return result;
        if (Array.isArray(obj)) {
          result.arrays++;
          for (const item of obj) {
            const sub = countKeys(item, depth + 1);
            result.keys += sub.keys;
            result.maxDepth = Math.max(result.maxDepth, sub.maxDepth);
            result.arrays += sub.arrays;
            result.objects += sub.objects;
          }
        } else if (obj && typeof obj === "object") {
          result.objects++;
          const entries = Object.entries(obj as Record<string, unknown>);
          result.keys += entries.length;
          for (const [, val] of entries) {
            const sub = countKeys(val, depth + 1);
            result.keys += sub.keys;
            result.maxDepth = Math.max(result.maxDepth, sub.maxDepth);
            result.arrays += sub.arrays;
            result.objects += sub.objects;
          }
        }
        return result;
      };

      const stats = countKeys(parsed);
      const formatted = JSON.stringify(parsed, null, 2);
      const preview = formatted.split("\n").slice(0, 30).join("\n");

      const lines = [
        `  JSON Inspector${isFile ? ` (${input})` : ""}\n`,
        `  Valid:    \u2713`,
        `  Type:     ${Array.isArray(parsed) ? "array" : typeof parsed}`,
        `  Keys:     ${stats.keys}`,
        `  Depth:    ${stats.maxDepth}`,
        `  Objects:  ${stats.objects}`,
        `  Arrays:   ${stats.arrays}`,
        `  Size:     ${text.length.toLocaleString()} chars`,
        ``,
        `  Preview:`,
      ];

      for (const line of preview.split("\n")) {
        lines.push(`  ${line}`);
      }
      if (formatted.split("\n").length > 30) {
        lines.push(`  ... ${formatted.split("\n").length - 30} more lines`);
      }

      return lines.join("\n");
    }
    case "disk": {
      const { execSync } = await import("node:child_process");
      const cwd = appConfig.workingDirectory;

      try {
        // Get top-level directory sizes
        const output = execSync(`du -h --max-depth=1 2>/dev/null | sort -rh | head -20`, { cwd, timeout: 15000 }).toString().trim();
        if (!output) return "  Cannot determine disk usage.";

        const entries = output.split("\n").map(line => {
          const match = line.match(/^([\d.]+[BKMGT]?)\s+(.+)$/);
          if (!match) return null;
          return { size: match[1], path: match[2].replace(/^\.\//, "") || "." };
        }).filter(Boolean) as Array<{ size: string; path: string }>;

        // Parse sizes for bar chart
        const parseBytes = (s: string): number => {
          const num = parseFloat(s);
          if (s.endsWith("G")) return num * 1024 * 1024 * 1024;
          if (s.endsWith("M")) return num * 1024 * 1024;
          if (s.endsWith("K")) return num * 1024;
          return num;
        };

        const withBytes = entries.map(e => ({ ...e, bytes: parseBytes(e.size) }));
        const maxBytes = withBytes[0]?.bytes ?? 1;
        const barWidth = 20;

        const lines = [`  Disk Usage: ${cwd}\n`];
        for (const e of withBytes.slice(0, 15)) {
          const filled = Math.max(1, Math.round((e.bytes / maxBytes) * barWidth));
          const bar = "\u2588".repeat(filled) + "\u2591".repeat(barWidth - filled);
          lines.push(`  ${bar} ${e.size.padStart(7)}  ${e.path}`);
        }

        if (withBytes.length > 15) {
          lines.push(`\n  ... ${withBytes.length - 15} more directories`);
        }

        // Total project size
        const total = withBytes.find(e => e.path === ".");
        if (total) {
          lines.push(`\n  Total project size: ${total.size}`);
        }

        return lines.join("\n");
      } catch (err: any) {
        return `  Error: ${err.message}`;
      }
    }
    case "http": {
      if (!args?.trim()) return "  Usage: /http [GET|POST|PUT|DELETE] <url> [body]";

      const parts = args.trim().split(/\s+/);
      let method = "GET";
      let url: string;
      let body: string | undefined;

      const httpMethods = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"];
      if (httpMethods.includes(parts[0]!.toUpperCase())) {
        method = parts[0]!.toUpperCase();
        url = parts[1] ?? "";
        body = parts.slice(2).join(" ") || undefined;
      } else {
        url = parts[0]!;
        body = parts.slice(1).join(" ") || undefined;
      }

      if (!url) return "  Usage: /http [METHOD] <url> [body]";
      if (!/^https?:\/\//i.test(url)) url = "https://" + url;

      try {
        const startTime = performance.now();
        const fetchOpts: RequestInit = { method, signal: AbortSignal.timeout(15000) };
        if (body && method !== "GET" && method !== "HEAD") {
          fetchOpts.body = body;
          fetchOpts.headers = { "Content-Type": "application/json" };
        }

        const resp = await fetch(url, fetchOpts);
        const elapsed = Math.round(performance.now() - startTime);
        const contentType = resp.headers.get("content-type") ?? "";
        // Limit response to 1 MB to avoid OOM
        const reader = resp.body?.getReader();
        let responseText = "";
        if (reader) {
          const decoder = new TextDecoder();
          let totalBytes = 0;
          const maxBytes = 1024 * 1024;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            totalBytes += value.byteLength;
            if (totalBytes > maxBytes) {
              responseText += decoder.decode(value, { stream: false });
              reader.cancel();
              responseText = responseText.slice(0, maxBytes) + "\n[truncated at 1 MB]";
              break;
            }
            responseText += decoder.decode(value, { stream: true });
          }
        }

        const lines = [
          `  HTTP ${method} ${url}\n`,
          `  Status:  ${resp.status} ${resp.statusText}`,
          `  Time:    ${elapsed}ms`,
          `  Type:    ${contentType}`,
          `  Size:    ${responseText.length.toLocaleString()} chars`,
        ];

        // Show headers summary
        const headerCount = [...resp.headers].length;
        lines.push(`  Headers: ${headerCount}`);
        lines.push(``);

        // Preview body
        if (contentType.includes("json")) {
          try {
            const json = JSON.parse(responseText);
            const formatted = JSON.stringify(json, null, 2);
            const preview = formatted.split("\n").slice(0, 25);
            lines.push(`  Response (JSON):`);
            for (const l of preview) lines.push(`  ${l}`);
            if (formatted.split("\n").length > 25) lines.push(`  ... ${formatted.split("\n").length - 25} more lines`);
          } catch {
            const preview = responseText.slice(0, 500);
            lines.push(`  Response:`);
            lines.push(`  ${preview}${responseText.length > 500 ? "..." : ""}`);
          }
        } else {
          const preview = responseText.slice(0, 500);
          lines.push(`  Response:`);
          for (const l of preview.split("\n").slice(0, 15)) lines.push(`  ${l}`);
          if (responseText.length > 500) lines.push(`  ... truncated`);
        }

        return lines.join("\n");
      } catch (err: any) {
        return `  HTTP error: ${err.message}`;
      }
    }
    case "encode": {
      if (!args?.trim()) return "  Usage: /encode base64|url|hex encode|decode <text>";

      const parts = args.trim().split(/\s+/);
      if (parts.length < 3) return "  Usage: /encode base64|url|hex encode|decode <text>";

      const format = parts[0]!.toLowerCase();
      const direction = parts[1]!.toLowerCase();
      const text = parts.slice(2).join(" ");

      if (!["base64", "url", "hex"].includes(format)) {
        return "  Formats: base64, url, hex";
      }
      if (!["encode", "decode"].includes(direction)) {
        return "  Direction: encode or decode";
      }

      try {
        let result: string;

        if (format === "base64") {
          if (direction === "encode") {
            result = Buffer.from(text, "utf-8").toString("base64");
          } else {
            result = Buffer.from(text, "base64").toString("utf-8");
          }
        } else if (format === "url") {
          if (direction === "encode") {
            result = encodeURIComponent(text);
          } else {
            result = decodeURIComponent(text);
          }
        } else {
          // hex
          if (direction === "encode") {
            result = Buffer.from(text, "utf-8").toString("hex");
          } else {
            result = Buffer.from(text, "hex").toString("utf-8");
          }
        }

        return [
          `  ${format.toUpperCase()} ${direction}`,
          ``,
          `  Input:  ${text.length > 80 ? text.slice(0, 80) + "..." : text}`,
          `  Output: ${result.length > 200 ? result.slice(0, 200) + "..." : result}`,
        ].join("\n");
      } catch (err: any) {
        return `  Error: ${err.message}`;
      }
    }
    case "checksum": {
      if (!args?.trim()) return "  Usage: /checksum [md5|sha256|sha512] <file or text>";

      const { createHash } = await import("node:crypto");
      const { existsSync, readFileSync, statSync: statSyncFn } = await import("node:fs");
      const { resolve: resolvePath } = await import("node:path");

      const parts = args.trim().split(/\s+/);
      let algo = "sha256";
      let target: string;

      if (["md5", "sha256", "sha512", "sha1"].includes(parts[0]!.toLowerCase())) {
        algo = parts[0]!.toLowerCase();
        target = parts.slice(1).join(" ");
      } else {
        target = args.trim();
      }

      if (!target) return "  Usage: /checksum [md5|sha256|sha512] <file or text>";

      let data: string | Buffer;
      let isFile = false;
      const filePath = resolvePath(appConfig.workingDirectory, target);

      const fileStat = existsSync(filePath) ? statSyncFn(filePath) : null;
      if (fileStat?.isFile()) {
        if (fileStat.size > 100 * 1024 * 1024) return "  File too large (max 100 MB).";
        data = readFileSync(filePath);
        isFile = true;
      } else {
        data = target;
      }

      const hash = createHash(algo).update(data).digest("hex");

      return [
        `  Checksum (${algo.toUpperCase()})`,
        ``,
        `  ${isFile ? "File" : "Text"}:  ${isFile ? target : (target.length > 60 ? target.slice(0, 60) + "..." : target)}`,
        `  Hash:  ${hash}`,
      ].join("\n");
    }
    case "outline": {
      if (!args?.trim()) return "  Usage: /outline <file path>";

      const { existsSync, readFileSync } = await import("node:fs");
      const { resolve: resolvePath, extname, relative } = await import("node:path");
      const cwd = appConfig.workingDirectory;
      const filePath = resolvePath(cwd, args.trim());

      if (!existsSync(filePath)) return `  File not found: ${args.trim()}`;

      const { statSync: statSyncOutline } = await import("node:fs");
      if (statSyncOutline(filePath).size > 5 * 1024 * 1024) return "  File too large for outline (max 5 MB).";

      const content = readFileSync(filePath, "utf-8");
      const ext = extname(filePath).toLowerCase();
      const relPath = relative(cwd, filePath);
      const fileLines = content.split("\n");
      const symbols: Array<{ line: number; kind: string; name: string }> = [];

      // Language-specific patterns
      if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
        for (let i = 0; i < fileLines.length; i++) {
          const l = fileLines[i]!;
          let m;
          if ((m = l.match(/^\s*export\s+(default\s+)?(async\s+)?function\s+(\w+)/))) symbols.push({ line: i + 1, kind: "fn", name: m[3]! });
          else if ((m = l.match(/^\s*(export\s+)?(async\s+)?function\s+(\w+)/))) symbols.push({ line: i + 1, kind: "fn", name: m[3]! });
          else if ((m = l.match(/^\s*export\s+(default\s+)?class\s+(\w+)/))) symbols.push({ line: i + 1, kind: "class", name: m[2]! });
          else if ((m = l.match(/^\s*class\s+(\w+)/))) symbols.push({ line: i + 1, kind: "class", name: m[1]! });
          else if ((m = l.match(/^\s*export\s+(default\s+)?interface\s+(\w+)/))) symbols.push({ line: i + 1, kind: "iface", name: m[2]! });
          else if ((m = l.match(/^\s*interface\s+(\w+)/))) symbols.push({ line: i + 1, kind: "iface", name: m[1]! });
          else if ((m = l.match(/^\s*export\s+(default\s+)?type\s+(\w+)/))) symbols.push({ line: i + 1, kind: "type", name: m[2]! });
          else if ((m = l.match(/^\s*type\s+(\w+)\s*=/))) symbols.push({ line: i + 1, kind: "type", name: m[1]! });
          else if ((m = l.match(/^\s*export\s+(const|let|var)\s+(\w+)/))) symbols.push({ line: i + 1, kind: "var", name: m[2]! });
          else if ((m = l.match(/^\s*const\s+(\w+)\s*=\s*(async\s+)?\(/))) symbols.push({ line: i + 1, kind: "fn", name: m[1]! });
        }
      } else if ([".py"].includes(ext)) {
        for (let i = 0; i < fileLines.length; i++) {
          const l = fileLines[i]!;
          let m;
          if ((m = l.match(/^class\s+(\w+)/))) symbols.push({ line: i + 1, kind: "class", name: m[1]! });
          else if ((m = l.match(/^(\s*)def\s+(\w+)/))) symbols.push({ line: i + 1, kind: m[1] ? "method" : "fn", name: m[2]! });
          else if ((m = l.match(/^(\s*)async\s+def\s+(\w+)/))) symbols.push({ line: i + 1, kind: m[1] ? "method" : "fn", name: m[2]! });
        }
      } else if ([".go"].includes(ext)) {
        for (let i = 0; i < fileLines.length; i++) {
          const l = fileLines[i]!;
          let m;
          if ((m = l.match(/^func\s+\((\w+)\s+\*?(\w+)\)\s+(\w+)/))) symbols.push({ line: i + 1, kind: "method", name: `${m[2]}.${m[3]}` });
          else if ((m = l.match(/^func\s+(\w+)/))) symbols.push({ line: i + 1, kind: "fn", name: m[1]! });
          else if ((m = l.match(/^type\s+(\w+)\s+struct/))) symbols.push({ line: i + 1, kind: "struct", name: m[1]! });
          else if ((m = l.match(/^type\s+(\w+)\s+interface/))) symbols.push({ line: i + 1, kind: "iface", name: m[1]! });
        }
      } else if ([".rs"].includes(ext)) {
        for (let i = 0; i < fileLines.length; i++) {
          const l = fileLines[i]!;
          let m;
          if ((m = l.match(/^\s*(pub\s+)?fn\s+(\w+)/))) symbols.push({ line: i + 1, kind: "fn", name: m[2]! });
          else if ((m = l.match(/^\s*(pub\s+)?struct\s+(\w+)/))) symbols.push({ line: i + 1, kind: "struct", name: m[2]! });
          else if ((m = l.match(/^\s*(pub\s+)?enum\s+(\w+)/))) symbols.push({ line: i + 1, kind: "enum", name: m[2]! });
          else if ((m = l.match(/^\s*(pub\s+)?trait\s+(\w+)/))) symbols.push({ line: i + 1, kind: "trait", name: m[2]! });
          else if ((m = l.match(/^\s*impl\s+(\w+)/))) symbols.push({ line: i + 1, kind: "impl", name: m[1]! });
        }
      } else if ([".swift"].includes(ext)) {
        for (let i = 0; i < fileLines.length; i++) {
          const l = fileLines[i]!;
          let m;
          if ((m = l.match(/^\s*(public\s+|private\s+|internal\s+|open\s+)?class\s+(\w+)/))) symbols.push({ line: i + 1, kind: "class", name: m[2]! });
          else if ((m = l.match(/^\s*(public\s+|private\s+|internal\s+|open\s+)?struct\s+(\w+)/))) symbols.push({ line: i + 1, kind: "struct", name: m[2]! });
          else if ((m = l.match(/^\s*(public\s+|private\s+|internal\s+|open\s+)?func\s+(\w+)/))) symbols.push({ line: i + 1, kind: "fn", name: m[2]! });
          else if ((m = l.match(/^\s*(public\s+|private\s+|internal\s+|open\s+)?enum\s+(\w+)/))) symbols.push({ line: i + 1, kind: "enum", name: m[2]! });
          else if ((m = l.match(/^\s*(public\s+|private\s+|internal\s+|open\s+)?protocol\s+(\w+)/))) symbols.push({ line: i + 1, kind: "proto", name: m[2]! });
        }
      } else {
        // Generic: look for common patterns
        for (let i = 0; i < fileLines.length; i++) {
          const l = fileLines[i]!;
          let m;
          if ((m = l.match(/^\s*(public|private|protected)?\s*(static\s+)?(void|int|string|boolean|async)?\s*(\w+)\s*\(/))) {
            if (!["if", "for", "while", "switch", "catch", "return", "else"].includes(m[4]!)) {
              symbols.push({ line: i + 1, kind: "fn", name: m[4]! });
            }
          }
        }
      }

      if (symbols.length === 0) return `  No symbols found in ${relPath}`;

      const kindIcons: Record<string, string> = {
        fn: "f", method: "m", class: "C", struct: "S", iface: "I",
        type: "T", var: "v", enum: "E", trait: "R", impl: "M", proto: "P",
      };

      const lines = [`  Outline: ${relPath} (${symbols.length} symbols, ${fileLines.length} lines)\n`];
      for (const sym of symbols) {
        const icon = kindIcons[sym.kind] ?? "?";
        lines.push(`  ${String(sym.line).padStart(5)}  [${icon}] ${sym.name}`);
      }

      return lines.join("\n");
    }
    case "weather": {
      const city = args?.trim() || "";
      const query = city ? encodeURIComponent(city) : "";

      try {
        const urlDetail = `https://wttr.in/${query}?format=%l%n%c+%C+%t+(feels+like+%f)%nHumidity:+%h%nWind:+%w%nPrecip:+%p%nUV:+%u%nMoon:+%m+%M`;
        const respDetail = await fetch(urlDetail, { signal: AbortSignal.timeout(8000), headers: { "User-Agent": "curl/8.0" } });
        const detail = (await respDetail.text()).trim();

        const lines = [`  Weather\n`];
        for (const l of detail.split("\n")) {
          lines.push(`  ${l}`);
        }
        return lines.join("\n");
      } catch (err: any) {
        return `  Weather error: ${err.message}`;
      }
    }
    case "lorem": {
      const parts = (args?.trim() || "paragraphs 3").split(/\s+/);
      const unit = parts[0]?.toLowerCase() ?? "paragraphs";
      const count = Math.min(Math.max(parseInt(parts[1] ?? "3") || 3, 1), 50);

      const loremWords = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt in culpa qui officia deserunt mollit anim id est laborum".split(" ");

      const genSentence = (): string => {
        const len = 8 + Math.floor(Math.random() * 12);
        const words: string[] = [];
        for (let i = 0; i < len; i++) {
          words.push(loremWords[Math.floor(Math.random() * loremWords.length)]!);
        }
        words[0] = words[0]!.charAt(0).toUpperCase() + words[0]!.slice(1);
        return words.join(" ") + ".";
      };

      const genParagraph = (): string => {
        const sentences = 3 + Math.floor(Math.random() * 4);
        const result: string[] = [];
        for (let i = 0; i < sentences; i++) result.push(genSentence());
        return result.join(" ");
      };

      let output: string;

      if (unit.startsWith("w")) {
        // words
        const words: string[] = [];
        for (let i = 0; i < count; i++) {
          words.push(loremWords[Math.floor(Math.random() * loremWords.length)]!);
        }
        words[0] = words[0]!.charAt(0).toUpperCase() + words[0]!.slice(1);
        output = words.join(" ") + ".";
      } else if (unit.startsWith("s")) {
        // sentences
        const sentences: string[] = [];
        for (let i = 0; i < count; i++) sentences.push(genSentence());
        output = sentences.join(" ");
      } else {
        // paragraphs
        const paragraphs: string[] = [];
        for (let i = 0; i < count; i++) paragraphs.push(genParagraph());
        output = paragraphs.join("\n\n");
      }

      const wordCount = output.split(/\s+/).length;
      const lines = [
        `  Lorem Ipsum (${count} ${unit.startsWith("w") ? "words" : unit.startsWith("s") ? "sentences" : "paragraphs"}, ${wordCount} words total)\n`,
      ];
      for (const l of output.split("\n")) {
        lines.push(`  ${l}`);
      }
      return lines.join("\n");
    }
    case "uuid": {
      const { randomUUID } = await import("node:crypto");
      const count = Math.min(Math.max(parseInt(args?.trim() || "1") || 1, 1), 100);

      const lines = [`  UUID v4${count > 1 ? ` (${count})` : ""}\n`];
      for (let i = 0; i < count; i++) {
        lines.push(`  ${randomUUID()}`);
      }
      return lines.join("\n");
    }
    case "color": {
      if (!args?.trim()) return "  Usage: /color <#hex | rgb(r,g,b) | hsl(h,s,l)>";

      const input = args.trim();
      let r = 0, g = 0, b = 0;
      let parsed = false;

      // Parse hex
      const hexMatch = input.match(/^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/);
      if (hexMatch) {
        let hex = hexMatch[1]!;
        if (hex.length === 3) hex = hex[0]! + hex[0]! + hex[1]! + hex[1]! + hex[2]! + hex[2]!;
        if (hex.length >= 6) {
          r = parseInt(hex.slice(0, 2), 16);
          g = parseInt(hex.slice(2, 4), 16);
          b = parseInt(hex.slice(4, 6), 16);
          parsed = true;
        }
      }

      // Parse rgb(r, g, b)
      if (!parsed) {
        const rgbMatch = input.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i);
        if (rgbMatch) {
          r = Math.min(255, parseInt(rgbMatch[1]!));
          g = Math.min(255, parseInt(rgbMatch[2]!));
          b = Math.min(255, parseInt(rgbMatch[3]!));
          parsed = true;
        }
      }

      // Parse hsl(h, s%, l%)
      if (!parsed) {
        const hslMatch = input.match(/hsl\(\s*(\d+)\s*,\s*(\d+)%?\s*,\s*(\d+)%?\s*\)/i);
        if (hslMatch) {
          const h = parseInt(hslMatch[1]!) / 360;
          const s = parseInt(hslMatch[2]!) / 100;
          const l = parseInt(hslMatch[3]!) / 100;
          // HSL to RGB conversion
          if (s === 0) {
            r = g = b = Math.round(l * 255);
          } else {
            const hue2rgb = (p: number, q: number, t: number) => {
              if (t < 0) t += 1;
              if (t > 1) t -= 1;
              if (t < 1 / 6) return p + (q - p) * 6 * t;
              if (t < 1 / 2) return q;
              if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
              return p;
            };
            const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
            const p = 2 * l - q;
            r = Math.round(hue2rgb(p, q, h + 1 / 3) * 255);
            g = Math.round(hue2rgb(p, q, h) * 255);
            b = Math.round(hue2rgb(p, q, h - 1 / 3) * 255);
          }
          parsed = true;
        }
      }

      if (!parsed) return "  Could not parse color. Use #hex, rgb(r,g,b), or hsl(h,s%,l%).";

      // Convert to all formats
      const hex = `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
      const max = Math.max(r, g, b) / 255;
      const min = Math.min(r, g, b) / 255;
      const l = (max + min) / 2;
      let h = 0, s = 0;
      if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        const rn = r / 255, gn = g / 255, bn = b / 255;
        if (rn === max) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
        else if (gn === max) h = ((bn - rn) / d + 2) / 6;
        else h = ((rn - gn) / d + 4) / 6;
      }

      // ANSI color preview block
      const preview = `\x1b[48;2;${r};${g};${b}m      \x1b[0m`;

      return [
        `  Color\n`,
        `  Preview: ${preview}`,
        `  HEX:     ${hex}`,
        `  RGB:     rgb(${r}, ${g}, ${b})`,
        `  HSL:     hsl(${Math.round(h * 360)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`,
        `  Decimal: ${(r << 16 | g << 8 | b) >>> 0}`,
      ].join("\n");
    }
    case "timestamp": {
      const input = args?.trim() || "";

      const now = new Date();
      const nowEpoch = Math.floor(now.getTime() / 1000);

      if (!input) {
        return [
          `  Timestamp\n`,
          `  Now (UTC):   ${now.toISOString()}`,
          `  Now (local): ${now.toLocaleString()}`,
          `  Epoch (s):   ${nowEpoch}`,
          `  Epoch (ms):  ${now.getTime()}`,
        ].join("\n");
      }

      // Try epoch (seconds or milliseconds)
      if (/^\d+$/.test(input)) {
        const num = parseInt(input);
        // If > 10 billion, it's likely milliseconds
        const date = num > 1e10 ? new Date(num) : new Date(num * 1000);
        if (isNaN(date.getTime())) return "  Invalid epoch value.";

        return [
          `  Epoch → Date\n`,
          `  Input:       ${input}${num > 1e10 ? " (ms)" : " (s)"}`,
          `  UTC:         ${date.toISOString()}`,
          `  Local:       ${date.toLocaleString()}`,
          `  Relative:    ${formatRelative(date, now)}`,
        ].join("\n");
      }

      // Try date string
      const date = new Date(input);
      if (isNaN(date.getTime())) return `  Cannot parse date: ${input}`;

      return [
        `  Date → Epoch\n`,
        `  Input:       ${input}`,
        `  UTC:         ${date.toISOString()}`,
        `  Epoch (s):   ${Math.floor(date.getTime() / 1000)}`,
        `  Epoch (ms):  ${date.getTime()}`,
        `  Relative:    ${formatRelative(date, now)}`,
      ].join("\n");

      function formatRelative(d: Date, ref: Date): string {
        const diff = ref.getTime() - d.getTime();
        const abs = Math.abs(diff);
        const suffix = diff > 0 ? "ago" : "from now";
        if (abs < 60000) return `${Math.round(abs / 1000)}s ${suffix}`;
        if (abs < 3600000) return `${Math.round(abs / 60000)}m ${suffix}`;
        if (abs < 86400000) return `${Math.round(abs / 3600000)}h ${suffix}`;
        return `${Math.round(abs / 86400000)}d ${suffix}`;
      }
    }
    case "csv": {
      if (!args?.trim()) return "  Usage: /csv <file path>";

      const { existsSync, readFileSync, statSync: statSyncFn } = await import("node:fs");
      const { resolve: resolvePath, relative, extname } = await import("node:path");
      const cwd = appConfig.workingDirectory;
      const filePath = resolvePath(cwd, args.trim());

      if (!existsSync(filePath)) return `  File not found: ${args.trim()}`;
      const stat = statSyncFn(filePath);
      if (!stat.isFile()) return "  Not a file.";
      if (stat.size > 10 * 1024 * 1024) return "  File too large (max 10 MB).";

      const content = readFileSync(filePath, "utf-8");
      const relPath = relative(cwd, filePath);
      const ext = extname(filePath).toLowerCase();

      // Detect delimiter
      const delimiter = ext === ".tsv" || content.split("\t").length > content.split(",").length ? "\t" : ",";
      const delimName = delimiter === "\t" ? "TAB" : "COMMA";

      const rows = content.split("\n").filter(l => l.trim());
      if (rows.length === 0) return "  Empty file.";

      // Parse with simple CSV logic (handles quoted fields)
      const parseRow = (line: string): string[] => {
        const fields: string[] = [];
        let current = "";
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
          const ch = line[i]!;
          if (ch === '"') {
            inQuotes = !inQuotes;
          } else if (ch === delimiter && !inQuotes) {
            fields.push(current.trim());
            current = "";
          } else {
            current += ch;
          }
        }
        fields.push(current.trim());
        return fields;
      };

      const headers = parseRow(rows[0]!);
      const dataRows = rows.slice(1).map(parseRow);

      // Column widths for preview
      const colWidths = headers.map((h, i) => {
        const values = [h, ...dataRows.slice(0, 10).map(r => r[i] ?? "")];
        return Math.min(Math.max(...values.map(v => v.length), 3), 25);
      });

      const lines = [
        `  CSV Inspector: ${relPath}\n`,
        `  Delimiter: ${delimName}`,
        `  Columns:   ${headers.length}`,
        `  Rows:      ${dataRows.length}`,
        `  Size:      ${(stat.size / 1024).toFixed(1)} KB`,
        ``,
        `  Columns: ${headers.map((h, i) => `${h} (${i + 1})`).join(", ")}`,
        ``,
      ];

      // Table preview (header + first 10 rows)
      const formatRow = (fields: string[]) =>
        fields.map((f, i) => (f.length > colWidths[i]! ? f.slice(0, colWidths[i]! - 1) + "\u2026" : f.padEnd(colWidths[i]!))).join("  ");

      lines.push(`  ${formatRow(headers)}`);
      lines.push(`  ${colWidths.map(w => "\u2500".repeat(w)).join("  ")}`);
      for (const row of dataRows.slice(0, 10)) {
        lines.push(`  ${formatRow(row)}`);
      }
      if (dataRows.length > 10) {
        lines.push(`\n  ... ${dataRows.length - 10} more rows`);
      }

      return lines.join("\n");
    }
    case "ip": {
      const { execSync } = await import("node:child_process");
      const lines = [`  Network Info\n`];

      // Public IP
      try {
        const resp = await fetch("https://ifconfig.me/ip", { signal: AbortSignal.timeout(5000), headers: { "User-Agent": "curl/8.0" } });
        const publicIp = (await resp.text()).trim();
        lines.push(`  Public IP:  ${publicIp}`);
      } catch {
        lines.push(`  Public IP:  (unavailable)`);
      }

      // Local interfaces
      try {
        const output = execSync(`ip -4 addr show 2>/dev/null | grep -oP '(?<=inet\\s)\\S+'`, { timeout: 3000 }).toString().trim();
        if (output) {
          lines.push(``);
          lines.push(`  Local Interfaces:`);
          for (const line of output.split("\n")) {
            lines.push(`    ${line}`);
          }
        }
      } catch {
        // Fallback: hostname -I
        try {
          const output = execSync(`hostname -I 2>/dev/null`, { timeout: 3000 }).toString().trim();
          if (output) {
            lines.push(`  Local IPs:  ${output}`);
          }
        } catch { /* skip */ }
      }

      // Hostname
      try {
        const hostname = execSync(`hostname 2>/dev/null`, { timeout: 2000 }).toString().trim();
        lines.push(`  Hostname:   ${hostname}`);
      } catch { /* skip */ }

      // Default gateway
      try {
        const gw = execSync(`ip route show default 2>/dev/null | grep -oP '(?<=via\\s)\\S+'`, { timeout: 3000 }).toString().trim();
        if (gw) lines.push(`  Gateway:    ${gw}`);
      } catch { /* skip */ }

      // DNS
      try {
        const dns = execSync(`grep '^nameserver' /etc/resolv.conf 2>/dev/null | head -3`, { timeout: 2000 }).toString().trim();
        if (dns) {
          const servers = dns.split("\n").map(l => l.replace("nameserver ", "").trim());
          lines.push(`  DNS:        ${servers.join(", ")}`);
        }
      } catch { /* skip */ }

      return lines.join("\n");
    }
    case "count": {
      const { existsSync, readFileSync, statSync: statSyncFn } = await import("node:fs");
      const { resolve: resolvePath, relative, extname } = await import("node:path");
      const { execSync } = await import("node:child_process");
      const cwd = appConfig.workingDirectory;
      const target = args?.trim() || ".";
      const targetPath = resolvePath(cwd, target);

      if (!existsSync(targetPath)) return `  Not found: ${target}`;

      const stat = statSyncFn(targetPath);

      if (stat.isFile()) {
        if (stat.size > 50 * 1024 * 1024) return "  File too large (max 50 MB).";
        const content = readFileSync(targetPath, "utf-8");
        const lineCount = content.split("\n").length;
        const wordCount = content.split(/\s+/).filter(Boolean).length;
        const charCount = content.length;
        const relPath = relative(cwd, targetPath);

        return [
          `  Count: ${relPath}\n`,
          `  Lines:      ${lineCount.toLocaleString()}`,
          `  Words:      ${wordCount.toLocaleString()}`,
          `  Characters: ${charCount.toLocaleString()}`,
          `  Size:       ${(stat.size / 1024).toFixed(1)} KB`,
        ].join("\n");
      }

      // Directory: count files by extension
      try {
        const output = execSync(
          `find '${targetPath.replace(/'/g, "'\\''")}' -type f -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null`,
          { cwd, timeout: 10000 }
        ).toString().trim();

        if (!output) return "  No files found.";

        const files = output.split("\n");
        const extCounts: Record<string, { count: number; lines: number }> = {};
        let totalLines = 0;
        let totalFiles = files.length;

        for (const file of files) {
          const ext = extname(file).toLowerCase() || "(no ext)";
          if (!extCounts[ext]) extCounts[ext] = { count: 0, lines: 0 };
          extCounts[ext]!.count++;
        }

        // Batch line count via wc -l (much faster than reading each file)
        try {
          const wcOutput = execSync(
            `find '${targetPath.replace(/'/g, "'\\''")}' -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -size -1M -exec wc -l {} + 2>/dev/null | tail -1`,
            { cwd, timeout: 15000 }
          ).toString().trim();
          const totalMatch = wcOutput.match(/^\s*(\d+)\s+total$/);
          if (totalMatch) totalLines = parseInt(totalMatch[1]!);
        } catch { /* skip line counting */ }

        const sorted = Object.entries(extCounts).sort((a, b) => b[1].count - a[1].count);
        const relDir = relative(cwd, targetPath) || ".";

        const lines = [
          `  Count: ${relDir}\n`,
          `  Total files: ${totalFiles.toLocaleString()}`,
          `  Total lines: ${totalLines > 0 ? totalLines.toLocaleString() : "(unknown)"}`,
          ``,
        ];

        const maxExtLen = Math.max(...sorted.map(([e]) => e.length), 5);
        lines.push(`  ${"Ext".padEnd(maxExtLen)}  ${"Files".padStart(6)}`);
        lines.push(`  ${"\u2500".repeat(maxExtLen)}  ${"\u2500".repeat(6)}`);

        for (const [ext, data] of sorted.slice(0, 20)) {
          lines.push(`  ${ext.padEnd(maxExtLen)}  ${String(data.count).padStart(6)}`);
        }
        if (sorted.length > 20) lines.push(`\n  ... ${sorted.length - 20} more extensions`);

        return lines.join("\n");
      } catch (err: any) {
        return `  Error: ${err.message}`;
      }
    }
    case "random": {
      const input = args?.trim() || "1-100";

      // Dice notation: NdM (e.g., 2d6, 1d20)
      const diceMatch = input.match(/^(\d+)d(\d+)$/i);
      if (diceMatch) {
        const n = Math.min(parseInt(diceMatch[1]!), 100);
        const sides = Math.min(parseInt(diceMatch[2]!), 1000);
        if (n < 1 || sides < 1) return "  Invalid dice: use NdM (e.g., 2d6).";
        const rolls: number[] = [];
        for (let i = 0; i < n; i++) {
          rolls.push(1 + Math.floor(Math.random() * sides));
        }
        const total = rolls.reduce((a, b) => a + b, 0);
        return [
          `  Dice Roll: ${n}d${sides}\n`,
          `  Rolls: ${rolls.join(", ")}`,
          `  Total: ${total}`,
          n > 1 ? `  Avg:   ${(total / n).toFixed(1)}` : "",
        ].filter(Boolean).join("\n");
      }

      // Pick from comma-separated list
      if (input.includes(",")) {
        const items = input.split(",").map(s => s.trim()).filter(Boolean);
        if (items.length < 2) return "  Provide at least 2 comma-separated items.";
        const pick = items[Math.floor(Math.random() * items.length)]!;
        return [
          `  Random Pick\n`,
          `  From: ${items.join(", ")}`,
          `  Pick: ${pick}`,
        ].join("\n");
      }

      // Range: min-max
      const rangeMatch = input.match(/^(-?\d+)\s*[-–]\s*(-?\d+)$/);
      if (rangeMatch) {
        const min = parseInt(rangeMatch[1]!);
        const max = parseInt(rangeMatch[2]!);
        if (min >= max) return "  Min must be less than max.";
        const result = min + Math.floor(Math.random() * (max - min + 1));
        return `  Random: ${result}  (range: ${min}–${max})`;
      }

      // Single number = 1 to N
      const num = parseInt(input);
      if (!isNaN(num) && num > 0) {
        const result = 1 + Math.floor(Math.random() * num);
        return `  Random: ${result}  (range: 1–${num})`;
      }

      return "  Usage: /random [min-max | NdM | item1,item2,...]\n  Examples: /random 1-100, /random 2d6, /random red,blue,green";
    }
    case "diff_stats": {
      const { execSync } = await import("node:child_process");
      const cwd = appConfig.workingDirectory;

      try {
        execSync(`git rev-parse --is-inside-work-tree 2>/dev/null`, { cwd, timeout: 3000 });
      } catch {
        return "  Not a git repository.";
      }

      const lines = [`  Repository Stats\n`];

      try {
        // Total commits
        const totalCommits = execSync(`git rev-list --count HEAD 2>/dev/null`, { cwd, timeout: 5000 }).toString().trim();
        lines.push(`  Total commits:  ${parseInt(totalCommits).toLocaleString()}`);

        // Contributors
        const contributors = execSync(`git shortlog -sn --no-merges HEAD 2>/dev/null | wc -l`, { cwd, timeout: 5000 }).toString().trim();
        lines.push(`  Contributors:   ${contributors}`);

        // First and last commit dates
        const firstCommit = execSync(`git rev-list --max-parents=0 HEAD 2>/dev/null | head -1`, { cwd, timeout: 5000 }).toString().trim();
        const firstDate = firstCommit ? execSync(`git log -1 --format='%ai' '${firstCommit}' 2>/dev/null`, { cwd, timeout: 3000 }).toString().trim() : "";
        const lastDate = execSync(`git log -1 --format='%ai' 2>/dev/null`, { cwd, timeout: 5000 }).toString().trim();
        if (firstDate) lines.push(`  First commit:   ${firstDate.slice(0, 10)}`);
        if (lastDate) lines.push(`  Last commit:    ${lastDate.slice(0, 10)}`);

        // Commits in last 7 days
        const weekCommits = execSync(`git rev-list --count --since='7 days ago' HEAD 2>/dev/null`, { cwd, timeout: 5000 }).toString().trim();
        lines.push(`  Last 7 days:    ${weekCommits} commits`);

        // Commits in last 30 days
        const monthCommits = execSync(`git rev-list --count --since='30 days ago' HEAD 2>/dev/null`, { cwd, timeout: 5000 }).toString().trim();
        lines.push(`  Last 30 days:   ${monthCommits} commits`);

        lines.push(``);

        // Most changed files (top 10)
        const hotFiles = execSync(`git log --pretty=format: --name-only 2>/dev/null | sort | uniq -c | sort -rn | head -10`, { cwd, timeout: 10000 }).toString().trim();
        if (hotFiles) {
          lines.push(`  Most Changed Files:`);
          for (const line of hotFiles.split("\n")) {
            const m = line.trim().match(/^(\d+)\s+(.+)$/);
            if (m && m[2]) lines.push(`    ${m[1]!.padStart(5)}  ${m[2]}`);
          }
        }

        lines.push(``);

        // Recent activity (commits per day, last 7 days)
        const dayActivity = execSync(`git log --format='%ad' --date=short --since='7 days ago' 2>/dev/null | sort | uniq -c | sort -rn`, { cwd, timeout: 5000 }).toString().trim();
        if (dayActivity) {
          lines.push(`  Daily Activity (last 7 days):`);
          for (const line of dayActivity.split("\n")) {
            const m = line.trim().match(/^(\d+)\s+(.+)$/);
            if (m) {
              const count = parseInt(m[1]!);
              const bar = "\u2588".repeat(Math.min(count, 30));
              lines.push(`    ${m[2]}  ${bar} ${count}`);
            }
          }
        }
      } catch (err: any) {
        lines.push(`  Error: ${err.message}`);
      }

      return lines.join("\n");
    }
    case "serve": {
      const { execSync } = await import("node:child_process");
      const cwd = appConfig.workingDirectory;
      const port = parseInt(args?.trim() || "10080") || 10080;

      if (port < 1024 || port > 65535) return "  Port must be between 1024 and 65535.";

      // Check if port is in use
      try {
        execSync(`ss -tlnp 2>/dev/null | grep -q ':${port} '`, { timeout: 3000 });
        return `  Port ${port} is already in use.`;
      } catch { /* port is free */ }

      // Try python3 http.server, then npx serve
      const cmds = [
        { test: "which python3", cmd: `python3 -m http.server ${port}`, name: "python3" },
        { test: "which npx", cmd: `npx -y serve -l ${port}`, name: "npx serve" },
        { test: "which php", cmd: `php -S 0.0.0.0:${port}`, name: "php" },
      ];

      let serverCmd: string | null = null;
      let serverName = "";
      for (const { test, cmd, name } of cmds) {
        try {
          execSync(`${test} 2>/dev/null`, { timeout: 2000 });
          serverCmd = cmd;
          serverName = name;
          break;
        } catch { /* not available */ }
      }

      if (!serverCmd) return "  No HTTP server found (install python3, npx, or php).";

      try {
        // Start in background
        execSync(`cd '${cwd.replace(/'/g, "'\\''")}' && nohup ${serverCmd} > /dev/null 2>&1 &`, {
          timeout: 3000,
          shell: "/bin/sh",
        });
        return [
          `  Static Server Started\n`,
          `  URL:     http://localhost:${port}`,
          `  Root:    ${cwd}`,
          `  Server:  ${serverName}`,
          `  Stop:    kill the ${serverName} process or use /processes`,
        ].join("\n");
      } catch (err: any) {
        return `  Failed to start server: ${err.message}`;
      }
    }
    case "open": {
      if (!args?.trim()) return "  Usage: /open <file path or URL>";

      const { execSync } = await import("node:child_process");
      const { resolve: resolvePath } = await import("node:path");
      const { existsSync } = await import("node:fs");
      const cwd = appConfig.workingDirectory;
      const target = args.trim();

      // Determine what to open
      let openTarget: string;
      if (/^https?:\/\//.test(target)) {
        openTarget = target;
      } else {
        const filePath = resolvePath(cwd, target);
        if (!existsSync(filePath)) return `  Not found: ${target}`;
        openTarget = filePath;
      }

      // Detect opener
      const openers = ["xdg-open", "open", "wslview"];
      let opener: string | null = null;
      for (const cmd of openers) {
        try {
          execSync(`which ${cmd} 2>/dev/null`, { timeout: 2000 });
          opener = cmd;
          break;
        } catch { /* not available */ }
      }

      if (!opener) return "  No system opener found (xdg-open, open, wslview).";

      try {
        execSync(`${opener} '${openTarget.replace(/'/g, "'\\''")}' 2>/dev/null &`, {
          timeout: 5000,
          shell: "/bin/sh",
        });
        return `  Opened: ${target}  (via ${opener})`;
      } catch (err: any) {
        return `  Error: ${err.message}`;
      }
    }
    case "qr": {
      if (!args?.trim()) return "  Usage: /qr <text or URL>";

      const text = args.trim();
      if (text.length > 2048) return "  Text too long for QR (max 2048 chars).";

      // QR encoding using a minimal implementation
      // We'll use the qrencode CLI if available, else generate with Unicode blocks
      const { execSync } = await import("node:child_process");

      try {
        // Try qrencode
        const output = execSync(
          `echo -n '${text.replace(/'/g, "'\\''")}' | qrencode -t UTF8 2>/dev/null`,
          { timeout: 5000 }
        ).toString();

        const lines = [`  QR Code\n`];
        for (const line of output.split("\n")) {
          lines.push(`  ${line}`);
        }
        lines.push(`\n  Data: ${text.length > 60 ? text.slice(0, 60) + "..." : text}`);
        return lines.join("\n");
      } catch {
        // Fallback: try python3
        try {
          const output = execSync(
            `python3 -c "import qrcode,sys; q=qrcode.QRCode(border=1); q.add_data(sys.stdin.read()); q.make(); q.print_ascii()" 2>/dev/null`,
            { timeout: 5000, input: text }
          ).toString();

          const lines = [`  QR Code\n`];
          for (const line of output.split("\n")) {
            lines.push(`  ${line}`);
          }
          lines.push(`\n  Data: ${text.length > 60 ? text.slice(0, 60) + "..." : text}`);
          return lines.join("\n");
        } catch {
          return "  QR generation requires 'qrencode' or python3 'qrcode' module.\n  Install: sudo dnf install qrencode  OR  pip install qrcode";
        }
      }
    }
    case "calc": {
      if (!args?.trim()) return "  Usage: /calc <expression>\n  Examples: /calc 2+3*4, /calc sqrt(144), /calc 2**10";

      const expr = args.trim();

      // Strict whitelist: only digits, operators, parens, dots, commas, spaces,
      // and known math function/constant names
      const allowedNames = new Set([
        "abs", "ceil", "floor", "round", "sqrt", "cbrt", "pow",
        "sin", "cos", "tan", "asin", "acos", "atan", "atan2",
        "log", "log2", "log10", "exp", "min", "max", "random",
        "PI", "E", "TAU",
      ]);

      // Tokenize: split into numbers, identifiers, and operators
      const tokens = expr.match(/[a-zA-Z_]\w*|\d+\.?\d*(?:[eE][+-]?\d+)?|[+\-*/().,%^*\s]+/g);
      if (!tokens || tokens.join("").replace(/\s/g, "") !== expr.replace(/\s/g, "")) {
        return "  Invalid expression. Only numbers, operators, and math functions allowed.";
      }

      // Validate every identifier token against the whitelist
      for (const tok of tokens) {
        if (/^[a-zA-Z_]/.test(tok) && !allowedNames.has(tok)) {
          return `  Unknown identifier: ${tok}. Allowed: ${[...allowedNames].join(", ")}`;
        }
      }

      // No brackets, backticks, quotes, or assignment allowed
      if (/[\[\]`'"\\{}=;]/.test(expr)) {
        return "  Invalid characters in expression.";
      }

      try {
        const mathFns: Record<string, unknown> = {
          abs: Math.abs, ceil: Math.ceil, floor: Math.floor, round: Math.round,
          sqrt: Math.sqrt, cbrt: Math.cbrt, pow: Math.pow,
          sin: Math.sin, cos: Math.cos, tan: Math.tan,
          asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
          log: Math.log, log2: Math.log2, log10: Math.log10,
          exp: Math.exp, min: Math.min, max: Math.max,
          PI: Math.PI, E: Math.E, TAU: Math.PI * 2, random: Math.random,
        };
        const keys = Object.keys(mathFns);
        const values = Object.values(mathFns);
        const fn = new Function(...keys, `"use strict"; return (${expr});`);
        const result = fn(...values);

        if (typeof result !== "number" && typeof result !== "bigint") {
          return `  Result: ${String(result)}`;
        }

        const lines = [`  Calc\n`];
        lines.push(`  Expression: ${expr}`);
        lines.push(`  Result:     ${result}`);

        // Show extra representations for integers
        if (typeof result === "number" && Number.isInteger(result) && result >= 0 && result <= 0xFFFFFFFF) {
          lines.push(`  Hex:        0x${result.toString(16).toUpperCase()}`);
          lines.push(`  Binary:     0b${result.toString(2)}`);
          lines.push(`  Octal:      0o${result.toString(8)}`);
        }

        return lines.join("\n");
      } catch (err: any) {
        return `  Error: ${err.message}`;
      }
    }
    case "stopwatch": {
      const input = args?.trim() || "0";

      // Parse duration
      const durationMatch = input.match(/^(\d+)\s*(s|sec|m|min|h|hr|hour)?$/i);
      if (!durationMatch) return "  Usage: /stopwatch <duration>\n  Examples: /stopwatch 30s, /stopwatch 5m, /stopwatch 1h";

      let seconds = parseInt(durationMatch[1]!);
      const unit = (durationMatch[2] ?? "s").toLowerCase();
      if (unit.startsWith("m")) seconds *= 60;
      else if (unit.startsWith("h")) seconds *= 3600;

      if (seconds <= 0) return "  Duration must be positive.";
      if (seconds > 86400) return "  Max duration: 24 hours.";

      const endTime = Date.now() + seconds * 1000;
      const formatTime = (ms: number) => {
        const totalSec = Math.ceil(ms / 1000);
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
        if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
        return `${s}s`;
      };

      const totalStr = formatTime(seconds * 1000);

      // We can't block the event loop, so report start time and end time
      const endDate = new Date(endTime);
      return [
        `  Timer Started\n`,
        `  Duration:  ${totalStr}`,
        `  Started:   ${new Date().toLocaleTimeString()}`,
        `  Ends at:   ${endDate.toLocaleTimeString()}`,
        `  Epoch end: ${Math.floor(endTime / 1000)}`,
        `\n  Tip: Use /timestamp ${Math.floor(endTime / 1000)} to check remaining time`,
      ].join("\n");
    }
    case "password": {
      const { randomBytes } = await import("node:crypto");
      const parts = (args?.trim() || "").split(/\s+/).filter(Boolean);

      let length = 20;
      let useSymbols = true;
      let count = 1;

      for (let i = 0; i < parts.length; i++) {
        if (parts[i] === "--no-symbols" || parts[i] === "-n") useSymbols = false;
        else if ((parts[i] === "--count" || parts[i] === "-c") && parts[i + 1]) { count = parseInt(parts[++i]!) || 1; }
        else if (/^\d+$/.test(parts[i]!)) length = parseInt(parts[i]!);
      }

      length = Math.min(Math.max(length, 8), 128);
      count = Math.min(Math.max(count, 1), 20);

      const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      const lower = "abcdefghijklmnopqrstuvwxyz";
      const digits = "0123456789";
      const symbols = "!@#$%^&*()-_=+[]{}|;:,.<>?";
      const charset = upper + lower + digits + (useSymbols ? symbols : "");

      const generate = (): string => {
        const chars: string[] = [];
        const maxValid = 256 - (256 % charset.length); // rejection sampling threshold
        let i = 0;
        while (chars.length < length) {
          const bytes = randomBytes(Math.max(length - chars.length, 32));
          for (let j = 0; j < bytes.length && chars.length < length; j++) {
            if (bytes[j]! < maxValid) {
              chars.push(charset[bytes[j]! % charset.length]!);
            }
          }
        }
        return chars.join("");
      };

      const lines = [`  Password Generator\n`];
      lines.push(`  Length:  ${length}`);
      lines.push(`  Symbols: ${useSymbols ? "yes" : "no"}`);
      lines.push(`  Charset: ${charset.length} chars`);
      lines.push(``);

      for (let i = 0; i < count; i++) {
        const pw = generate();
        // Estimate entropy
        const entropy = Math.round(Math.log2(charset.length) * length);
        lines.push(`  ${count > 1 ? `${i + 1}. ` : ""}${pw}  (${entropy}-bit)`);
      }

      return lines.join("\n");
    }
    case "diff_branch": {
      if (!args?.trim()) return "  Usage: /diff-branch <target branch>";

      const { execSync } = await import("node:child_process");
      const cwd = appConfig.workingDirectory;
      const target = args.trim();

      // Validate branch name
      if (!/^[a-zA-Z0-9._\-\/]+$/.test(target)) return "  Invalid branch name.";

      try {
        // Get current branch
        const current = execSync(`git branch --show-current 2>/dev/null`, { cwd, timeout: 3000 }).toString().trim() || "HEAD";

        // Check target exists
        try {
          execSync(`git rev-parse --verify '${target.replace(/'/g, "'\\''")}' 2>/dev/null`, { cwd, timeout: 3000 });
        } catch {
          return `  Branch not found: ${target}`;
        }

        // Merge base
        const mergeBase = execSync(`git merge-base '${current.replace(/'/g, "'\\''")}' '${target.replace(/'/g, "'\\''")}' 2>/dev/null`, { cwd, timeout: 5000 }).toString().trim().slice(0, 8);

        // Commit counts
        const ahead = execSync(`git rev-list --count '${target.replace(/'/g, "'\\''")}'..'${current.replace(/'/g, "'\\''")}' 2>/dev/null`, { cwd, timeout: 5000 }).toString().trim();
        const behind = execSync(`git rev-list --count '${current.replace(/'/g, "'\\''")}'..'${target.replace(/'/g, "'\\''")}' 2>/dev/null`, { cwd, timeout: 5000 }).toString().trim();

        // Diff stat
        const diffStat = execSync(`git diff --stat '${target.replace(/'/g, "'\\''")}' 2>/dev/null | tail -1`, { cwd, timeout: 10000 }).toString().trim();

        // Changed files list
        const changedFiles = execSync(`git diff --name-status '${target.replace(/'/g, "'\\''")}' 2>/dev/null | head -20`, { cwd, timeout: 10000 }).toString().trim();

        const lines = [
          `  Branch Comparison\n`,
          `  Current:    ${current}`,
          `  Target:     ${target}`,
          `  Merge base: ${mergeBase}`,
          `  Ahead:      ${ahead} commits`,
          `  Behind:     ${behind} commits`,
          ``,
        ];

        if (diffStat) lines.push(`  ${diffStat}`, ``);

        if (changedFiles) {
          lines.push(`  Changed Files:`);
          for (const line of changedFiles.split("\n")) {
            const [status, ...fileParts] = line.split("\t");
            const file = fileParts.join("\t");
            const statusLabel = status === "M" ? "modified" : status === "A" ? "added" : status === "D" ? "deleted" : status ?? "";
            lines.push(`    ${statusLabel.padEnd(9)} ${file}`);
          }
          const totalChanged = execSync(`git diff --name-only '${target.replace(/'/g, "'\\''")}' 2>/dev/null | wc -l`, { cwd, timeout: 5000 }).toString().trim();
          if (parseInt(totalChanged) > 20) lines.push(`\n    ... ${parseInt(totalChanged) - 20} more files`);
        }

        return lines.join("\n");
      } catch (err: any) {
        return `  Git error: ${err.stderr?.toString()?.trim() || err.message}`;
      }
    }
    case "mirrors": {
      const { execSync } = await import("node:child_process");
      const cwd = appConfig.workingDirectory;
      const arg = args?.trim() ?? "list";

      try {
        if (arg === "list" || !arg) {
          const output = execSync(`git remote -v 2>/dev/null`, { cwd, timeout: 5000 }).toString().trim();
          if (!output) return "  No remotes configured.";

          const lines = [`  Git Remotes\n`];

          // Group by remote name
          const remotes = new Map<string, { fetch?: string; push?: string }>();
          for (const line of output.split("\n")) {
            const m = line.match(/^(\S+)\s+(\S+)\s+\((\w+)\)$/);
            if (m) {
              if (!remotes.has(m[1]!)) remotes.set(m[1]!, {});
              const entry = remotes.get(m[1]!)!;
              if (m[3] === "fetch") entry.fetch = m[2]!;
              if (m[3] === "push") entry.push = m[2]!;
            }
          }

          for (const [name, urls] of remotes) {
            lines.push(`  ${name}`);
            if (urls.fetch) lines.push(`    fetch: ${urls.fetch}`);
            if (urls.push && urls.push !== urls.fetch) lines.push(`    push:  ${urls.push}`);

            // Last fetch time
            try {
              const fetchHead = execSync(`stat -c '%Y' '.git/refs/remotes/${name.replace(/'/g, "'\\''")}' 2>/dev/null || stat -c '%Y' .git/FETCH_HEAD 2>/dev/null`, { cwd, timeout: 3000 }).toString().trim();
              if (fetchHead) {
                const ago = Math.round((Date.now() / 1000) - parseInt(fetchHead));
                const agoStr = ago < 60 ? `${ago}s ago` : ago < 3600 ? `${Math.round(ago / 60)}m ago` : ago < 86400 ? `${Math.round(ago / 3600)}h ago` : `${Math.round(ago / 86400)}d ago`;
                lines.push(`    fetched: ${agoStr}`);
              }
            } catch { /* skip */ }
            lines.push(``);
          }

          return lines.join("\n");
        }

        if (arg.startsWith("add ")) {
          const addParts = arg.slice(4).trim().split(/\s+/);
          if (addParts.length < 2) return "  Usage: /mirrors add <name> <url>";
          const name = addParts[0]!;
          const url = addParts[1]!;
          if (!/^[a-zA-Z0-9_\-]+$/.test(name)) return "  Invalid remote name.";
          execSync(`git remote add '${name}' '${url.replace(/'/g, "'\\''")}' 2>&1`, { cwd, timeout: 5000 });
          return `  Added remote: ${name} → ${url}`;
        }

        if (arg.startsWith("remove ")) {
          const name = arg.slice(7).trim();
          if (!/^[a-zA-Z0-9_\-]+$/.test(name)) return "  Invalid remote name.";
          execSync(`git remote remove '${name}' 2>&1`, { cwd, timeout: 5000 });
          return `  Removed remote: ${name}`;
        }

        return "  Usage: /mirrors [list | add <name> <url> | remove <name>]";
      } catch (err: any) {
        return `  Git error: ${err.stderr?.toString()?.trim() || err.message}`;
      }
    }
    case "sort_lines": {
      if (!args?.trim()) return "  Usage: /sort-lines <file> [--reverse] [--numeric] [--unique]";

      const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
      const { resolve: resolvePath, relative } = await import("node:path");
      const cwd = appConfig.workingDirectory;

      const parts = args.trim().split(/\s+/);
      const flags = new Set(parts.filter(p => p.startsWith("--")));
      const filePart = parts.find(p => !p.startsWith("--"));
      if (!filePart) return "  Usage: /sort-lines <file> [--reverse] [--numeric] [--unique]";

      const filePath = resolvePath(cwd, filePart);
      if (!existsSync(filePath)) return `  File not found: ${filePart}`;

      const { statSync: statSyncFn } = await import("node:fs");
      const stat = statSyncFn(filePath);
      if (!stat.isFile()) return "  Not a file.";
      if (stat.size > 10 * 1024 * 1024) return "  File too large (max 10 MB).";

      const content = readFileSync(filePath, "utf-8");
      let lines = content.split("\n");

      // Remove trailing empty line if present
      if (lines[lines.length - 1] === "") lines.pop();

      const originalCount = lines.length;

      // Sort
      if (flags.has("--numeric")) {
        lines.sort((a, b) => {
          const na = parseFloat(a) || 0;
          const nb = parseFloat(b) || 0;
          return na - nb;
        });
      } else {
        lines.sort((a, b) => a.localeCompare(b));
      }

      if (flags.has("--reverse")) lines.reverse();
      if (flags.has("--unique")) lines = [...new Set(lines)];

      const relPath = relative(cwd, filePath);
      const removed = originalCount - lines.length;

      writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");

      return [
        `  Sorted: ${relPath}`,
        ``,
        `  Lines:   ${originalCount}${removed > 0 ? ` → ${lines.length} (${removed} duplicates removed)` : ""}`,
        `  Order:   ${flags.has("--numeric") ? "numeric" : "alphabetic"}${flags.has("--reverse") ? " (reversed)" : ""}`,
        `  Unique:  ${flags.has("--unique") ? "yes" : "no"}`,
      ].join("\n");
    }
    case "montecarlo": {
      const input = args?.trim() || "pi";
      const parts = input.split(/\s+/);
      const mode = parts[0]!.toLowerCase();

      if (mode === "pi") {
        const iterations = Math.min(parseInt(parts[1] ?? "1000000") || 1000000, 5000000);
        let inside = 0;

        const startTime = performance.now();
        for (let i = 0; i < iterations; i++) {
          const x = Math.random();
          const y = Math.random();
          if (x * x + y * y <= 1) inside++;
        }
        const elapsed = Math.round(performance.now() - startTime);

        const estimate = (4 * inside) / iterations;
        const error = Math.abs(estimate - Math.PI);

        return [
          `  Monte Carlo: Estimate Pi\n`,
          `  Iterations: ${iterations.toLocaleString()}`,
          `  Estimate:   ${estimate.toFixed(8)}`,
          `  Actual Pi:  ${Math.PI.toFixed(8)}`,
          `  Error:      ${error.toFixed(8)} (${(error / Math.PI * 100).toFixed(4)}%)`,
          `  Time:       ${elapsed}ms`,
        ].join("\n");
      }

      if (mode === "coin") {
        const flips = Math.min(parseInt(parts[1] ?? "10000") || 10000, 5000000);
        let heads = 0;

        const startTime = performance.now();
        for (let i = 0; i < flips; i++) {
          if (Math.random() < 0.5) heads++;
        }
        const elapsed = Math.round(performance.now() - startTime);
        const tails = flips - heads;

        return [
          `  Monte Carlo: Coin Flips\n`,
          `  Flips:  ${flips.toLocaleString()}`,
          `  Heads:  ${heads.toLocaleString()} (${(heads / flips * 100).toFixed(2)}%)`,
          `  Tails:  ${tails.toLocaleString()} (${(tails / flips * 100).toFixed(2)}%)`,
          `  Ratio:  ${(heads / tails).toFixed(4)}`,
          `  Time:   ${elapsed}ms`,
        ].join("\n");
      }

      if (mode === "dice") {
        const diceMatch = parts[1]?.match(/^(\d+)d(\d+)$/i);
        if (!diceMatch) return "  Usage: /montecarlo dice NdM [iterations]\n  Example: /montecarlo dice 2d6 100000";

        const n = Math.min(parseInt(diceMatch[1]!), 20);
        const sides = Math.min(parseInt(diceMatch[2]!), 100);
        const iterations = Math.min(parseInt(parts[2] ?? "100000") || 100000, 5000000);

        if (n < 1 || sides < 1) return "  Invalid dice notation.";

        const freq: Record<number, number> = {};
        const minVal = n;
        const maxVal = n * sides;

        const startTime = performance.now();
        for (let i = 0; i < iterations; i++) {
          let sum = 0;
          for (let d = 0; d < n; d++) {
            sum += 1 + Math.floor(Math.random() * sides);
          }
          freq[sum] = (freq[sum] ?? 0) + 1;
        }
        const elapsed = Math.round(performance.now() - startTime);

        // Build distribution
        const sorted = Object.entries(freq).map(([k, v]) => [parseInt(k), v] as [number, number]).sort((a, b) => a[0] - b[0]);
        const maxFreq = Math.max(...sorted.map(([, v]) => v));
        const barWidth = 25;

        const lines = [
          `  Monte Carlo: ${n}d${sides} Distribution\n`,
          `  Iterations: ${iterations.toLocaleString()}`,
          `  Range:      ${minVal}–${maxVal}`,
          `  Time:       ${elapsed}ms`,
          ``,
        ];

        // Show top values or full distribution if small enough
        const display = sorted.length <= 25 ? sorted : sorted.slice(0, 20);
        for (const [val, count] of display) {
          const pct = (count / iterations * 100).toFixed(1);
          const filled = Math.max(1, Math.round((count / maxFreq) * barWidth));
          const bar = "\u2588".repeat(filled);
          lines.push(`  ${String(val).padStart(4)}  ${bar} ${pct}%`);
        }
        if (sorted.length > 25) lines.push(`\n  ... ${sorted.length - 20} more values`);

        return lines.join("\n");
      }

      return "  Usage: /montecarlo pi [N] | coin [N] | dice NdM [N]\n  Examples: /montecarlo pi 1000000, /montecarlo coin 50000, /montecarlo dice 2d6 100000";
    }
    case "ascii": {
      if (!args?.trim()) return "  Usage: /ascii <text>";

      const text = args.trim().slice(0, 20); // limit length
      const { execSync } = await import("node:child_process");

      // Try figlet first, then toilet, then built-in
      const cmds = ["figlet", "toilet -f mono12"];
      for (const cmd of cmds) {
        try {
          const bin = cmd.split(" ")[0]!;
          execSync(`which ${bin} 2>/dev/null`, { timeout: 2000 });
          const output = execSync(`${cmd} '${text.replace(/'/g, "'\\''")}' 2>/dev/null`, { timeout: 5000 }).toString();
          const lines = [`  ASCII Art\n`];
          for (const line of output.split("\n")) {
            lines.push(`  ${line}`);
          }
          return lines.join("\n");
        } catch { /* not available */ }
      }

      // Built-in simple block letters
      const font: Record<string, string[]> = {
        A: ["  ##  ", " #  # ", " #### ", " #  # ", " #  # "],
        B: [" ### ", " #  #", " ### ", " #  #", " ### "],
        C: ["  ###", " #   ", " #   ", " #   ", "  ###"],
        D: [" ### ", " #  #", " #  #", " #  #", " ### "],
        E: [" ####", " #   ", " ### ", " #   ", " ####"],
        F: [" ####", " #   ", " ### ", " #   ", " #   "],
        G: ["  ###", " #   ", " # ##", " #  #", "  ## "],
        H: [" #  #", " #  #", " ####", " #  #", " #  #"],
        I: [" ### ", "  #  ", "  #  ", "  #  ", " ### "],
        J: ["  ###", "   # ", "   # ", " # # ", "  #  "],
        K: [" #  #", " # # ", " ##  ", " # # ", " #  #"],
        L: [" #   ", " #   ", " #   ", " #   ", " ####"],
        M: [" #   #", " ## ##", " # # #", " #   #", " #   #"],
        N: [" #  #", " ## #", " # ##", " #  #", " #  #"],
        O: ["  ## ", " #  #", " #  #", " #  #", "  ## "],
        P: [" ### ", " #  #", " ### ", " #   ", " #   "],
        Q: ["  ## ", " #  #", " # ##", " #  #", "  ## #"],
        R: [" ### ", " #  #", " ### ", " # # ", " #  #"],
        S: ["  ###", " #   ", "  ## ", "    #", " ### "],
        T: [" ####", "  #  ", "  #  ", "  #  ", "  #  "],
        U: [" #  #", " #  #", " #  #", " #  #", "  ## "],
        V: [" #  #", " #  #", " #  #", "  ## ", "  #  "],
        W: [" #   #", " #   #", " # # #", " ## ##", " #   #"],
        X: [" #  #", "  ## ", "  #  ", "  ## ", " #  #"],
        Y: [" #  #", "  ## ", "  #  ", "  #  ", "  #  "],
        Z: [" ####", "   # ", "  #  ", " #   ", " ####"],
        " ": ["     ", "     ", "     ", "     ", "     "],
        "0": ["  ## ", " #  #", " #  #", " #  #", "  ## "],
        "1": ["  #  ", " ##  ", "  #  ", "  #  ", " ### "],
        "2": ["  ## ", " #  #", "   # ", "  #  ", " ####"],
        "3": [" ### ", "    #", "  ## ", "    #", " ### "],
        "4": [" #  #", " #  #", " ####", "    #", "    #"],
        "5": [" ####", " #   ", " ### ", "    #", " ### "],
        "6": ["  ## ", " #   ", " ### ", " #  #", "  ## "],
        "7": [" ####", "    #", "   # ", "  #  ", "  #  "],
        "8": ["  ## ", " #  #", "  ## ", " #  #", "  ## "],
        "9": ["  ## ", " #  #", "  ###", "    #", "  ## "],
      };

      const upper = text.toUpperCase();
      const artLines: string[] = ["  ASCII Art\n"];
      for (let row = 0; row < 5; row++) {
        let line = "  ";
        for (const ch of upper) {
          const glyph = font[ch];
          line += glyph ? glyph[row]! : "     ";
          line += " ";
        }
        artLines.push(line);
      }
      return artLines.join("\n");
    }
    case "crontab": {
      if (!args?.trim()) return "  Usage: /crontab <cron expression>\n  Example: /crontab */5 * * * *";

      const parts = args.trim().split(/\s+/);
      if (parts.length < 5) return "  Invalid cron: need 5 fields (minute hour day month weekday)";

      const [minF, hourF, dayF, monthF, dowF] = parts.slice(0, 5);
      const fieldNames = ["Minute", "Hour", "Day", "Month", "Weekday"];
      const fieldRanges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
      const dowNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const monthNames = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const fields = [minF!, hourF!, dayF!, monthF!, dowF!];

      // Parse a single cron field into matching values
      const parseField = (field: string, min: number, max: number): number[] => {
        const values = new Set<number>();
        for (const part of field.split(",")) {
          const stepMatch = part.match(/^(.+)\/(\d+)$/);
          const step = stepMatch ? parseInt(stepMatch[2]!) : 1;
          const range = stepMatch ? stepMatch[1]! : part;

          if (range === "*") {
            for (let i = min; i <= max; i += step) values.add(i);
          } else if (range.includes("-")) {
            const [a, b] = range.split("-").map(Number);
            for (let i = a!; i <= b!; i += step) values.add(i);
          } else {
            values.add(parseInt(range));
          }
        }
        return [...values].filter(v => v >= min && v <= max).sort((a, b) => a - b);
      };

      const parsed = fields.map((f, i) => parseField(f, fieldRanges[i]![0]!, fieldRanges[i]![1]!));

      const lines = [
        `  Cron Expression: ${fields.join(" ")}\n`,
      ];

      // Describe each field
      for (let i = 0; i < 5; i++) {
        const vals = parsed[i]!;
        let desc: string;
        if (fields[i] === "*") desc = "every";
        else if (i === 4) desc = vals.map(v => dowNames[v]!).join(", ");
        else if (i === 3) desc = vals.map(v => monthNames[v]!).join(", ");
        else desc = vals.join(", ");
        lines.push(`  ${fieldNames[i]!.padEnd(8)} ${fields[i]!.padEnd(10)} → ${desc}`);
      }

      // Calculate next 5 runs
      lines.push(`\n  Next 5 runs:`);
      const now = new Date();
      let cursor = new Date(now);
      cursor.setSeconds(0, 0);
      cursor.setMinutes(cursor.getMinutes() + 1);
      let found = 0;

      for (let attempt = 0; attempt < 100000 && found < 5; attempt++) { // max ~69 days of minutes
        const m = cursor.getMinutes();
        const h = cursor.getHours();
        const d = cursor.getDate();
        const mo = cursor.getMonth() + 1;
        const dow = cursor.getDay();

        if (parsed[0]!.includes(m) && parsed[1]!.includes(h) && parsed[2]!.includes(d) && parsed[3]!.includes(mo) && parsed[4]!.includes(dow)) {
          lines.push(`    ${cursor.toLocaleString()}`);
          found++;
        }
        cursor.setMinutes(cursor.getMinutes() + 1);
      }

      if (found === 0) lines.push(`    (no matches in next 69 days)`);

      return lines.join("\n");
    }
    case "diff_lines": {
      if (!args?.trim() || !args.includes("|")) return "  Usage: /diff-lines <string1> | <string2>";

      const pipeIdx = args.indexOf("|");
      const left = args.slice(0, pipeIdx).trim();
      const right = args.slice(pipeIdx + 1).trim();

      if (!left && !right) return "  Both strings are empty.";
      if (left === right) return "  Strings are identical.";

      // Character-level diff
      const maxLen = Math.max(left.length, right.length);
      let diffChars = 0;
      let diffMap = "";

      for (let i = 0; i < maxLen; i++) {
        const lc = left[i] ?? "";
        const rc = right[i] ?? "";
        if (lc === rc) {
          diffMap += " ";
        } else {
          diffMap += "^";
          diffChars++;
        }
      }

      const similarity = maxLen > 0 ? ((1 - diffChars / maxLen) * 100).toFixed(1) : "100.0";

      // Truncate for display
      const displayLen = 80;
      const l = left.length > displayLen ? left.slice(0, displayLen) + "..." : left;
      const r = right.length > displayLen ? right.slice(0, displayLen) + "..." : right;
      const d = diffMap.length > displayLen ? diffMap.slice(0, displayLen) + "..." : diffMap;

      return [
        `  Line Diff\n`,
        `  A: ${l}`,
        `  B: ${r}`,
        `     ${d}`,
        ``,
        `  Length A:    ${left.length}`,
        `  Length B:    ${right.length}`,
        `  Differences: ${diffChars} chars`,
        `  Similarity:  ${similarity}%`,
      ].join("\n");
    }
    case "sysinfo": {
      const { execSync } = await import("node:child_process");
      const os = await import("node:os");

      const lines = [`  System Info\n`];

      // OS
      lines.push(`  OS:        ${os.type()} ${os.release()} (${os.arch()})`);
      lines.push(`  Hostname:  ${os.hostname()}`);

      // Kernel
      try {
        const kernel = execSync(`uname -r 2>/dev/null`, { timeout: 2000 }).toString().trim();
        lines.push(`  Kernel:    ${kernel}`);
      } catch { /* skip */ }

      // CPU
      const cpus = os.cpus();
      if (cpus.length > 0) {
        lines.push(`  CPU:       ${cpus[0]!.model.trim()}`);
        lines.push(`  Cores:     ${cpus.length}`);
        lines.push(`  Speed:     ${cpus[0]!.speed} MHz`);
      }

      // RAM
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      const memPct = (usedMem / totalMem * 100).toFixed(1);
      lines.push(`  RAM:       ${(usedMem / 1024 / 1024 / 1024).toFixed(1)} / ${(totalMem / 1024 / 1024 / 1024).toFixed(1)} GB (${memPct}%)`);

      // GPU
      try {
        const gpu = execSync(`nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits 2>/dev/null`, { timeout: 5000 }).toString().trim();
        if (gpu) {
          for (const line of gpu.split("\n")) {
            const [name, mem, driver] = line.split(", ");
            lines.push(`  GPU:       ${name} (${mem} MB, driver ${driver})`);
          }
        }
      } catch {
        try {
          const lspci = execSync(`lspci 2>/dev/null | grep -i 'vga\\|3d' | head -2`, { timeout: 3000 }).toString().trim();
          if (lspci) {
            for (const line of lspci.split("\n")) {
              const name = line.replace(/.*:\s*/, "");
              lines.push(`  GPU:       ${name}`);
            }
          }
        } catch { /* skip */ }
      }

      // Uptime
      const uptimeSec = os.uptime();
      const days = Math.floor(uptimeSec / 86400);
      const hours = Math.floor((uptimeSec % 86400) / 3600);
      const mins = Math.floor((uptimeSec % 3600) / 60);
      lines.push(`  Uptime:    ${days}d ${hours}h ${mins}m`);

      // Load average
      const load = os.loadavg();
      lines.push(`  Load:      ${load[0]!.toFixed(2)} ${load[1]!.toFixed(2)} ${load[2]!.toFixed(2)}`);

      // Disk
      try {
        const df = execSync(`df -h / 2>/dev/null | tail -1`, { timeout: 3000 }).toString().trim();
        const dfParts = df.split(/\s+/);
        if (dfParts.length >= 5) {
          lines.push(`  Disk (/):  ${dfParts[2]} / ${dfParts[1]} (${dfParts[4]})`);
        }
      } catch { /* skip */ }

      return lines.join("\n");
    }
    case "progress": {
      if (!args?.trim()) return "  Usage: /progress <value> [max] [label]\n  Examples: /progress 75, /progress 3 10 Tasks, /progress 50,80,30";

      const input = args.trim();

      // Multiple bars: comma-separated values
      if (input.includes(",") && !input.includes(" ")) {
        const values = input.split(",").map(v => parseFloat(v.trim())).filter(v => !isNaN(v));
        const max = Math.max(...values, 100);
        const barWidth = 30;

        const lines = [`  Progress Bars\n`];
        for (let i = 0; i < values.length; i++) {
          const val = values[i]!;
          const pct = Math.min(val / max * 100, 100);
          const filled = Math.round(pct / 100 * barWidth);
          const bar = "\u2588".repeat(filled) + "\u2591".repeat(barWidth - filled);
          lines.push(`  ${String(i + 1).padStart(3)}  ${bar}  ${val}/${max} (${pct.toFixed(0)}%)`);
        }
        return lines.join("\n");
      }

      const parts = input.split(/\s+/);
      const value = parseFloat(parts[0]!);
      if (isNaN(value)) return "  Value must be a number.";

      const max = parts[1] ? parseFloat(parts[1]) : 100;
      if (!max || max <= 0) return "  Max must be greater than 0.";
      const label = parts.slice(2).join(" ") || "";
      const pct = Math.min(value / max * 100, 100);
      const barWidth = 30;
      const filled = Math.round(pct / 100 * barWidth);
      const bar = "\u2588".repeat(filled) + "\u2591".repeat(barWidth - filled);

      return [
        `  Progress${label ? `: ${label}` : ""}\n`,
        `  ${bar}  ${value}/${max} (${pct.toFixed(1)}%)`,
        ``,
        `  ${"0".padEnd(barWidth / 2)}${"50%".padEnd(barWidth / 2)}100%`,
      ].join("\n");
    }
    case "jwt": {
      if (!args?.trim()) return "  Usage: /jwt <token>";

      const token = args.trim();
      if (token.length > 100000) return "  Token too large (max 100 KB).";
      const parts = token.split(".");

      if (parts.length !== 3) return "  Invalid JWT: expected 3 parts (header.payload.signature).";

      const decodeBase64Url = (str: string): string => {
        // Base64url to base64
        let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
        while (base64.length % 4) base64 += "=";
        return Buffer.from(base64, "base64").toString("utf-8");
      };

      try {
        const header = JSON.parse(decodeBase64Url(parts[0]!));
        const payload = JSON.parse(decodeBase64Url(parts[1]!));
        const sig = parts[2]!;

        const lines = [
          `  JWT Decode\n`,
          `  Header:`,
        ];
        for (const line of JSON.stringify(header, null, 2).split("\n")) {
          lines.push(`    ${line}`);
        }

        lines.push(`\n  Payload:`);
        for (const line of JSON.stringify(payload, null, 2).split("\n")) {
          lines.push(`    ${line}`);
        }

        // Decode common fields
        lines.push(`\n  Details:`);
        if (header.alg) lines.push(`    Algorithm: ${header.alg}`);
        if (header.typ) lines.push(`    Type:      ${header.typ}`);
        if (payload.sub) lines.push(`    Subject:   ${payload.sub}`);
        if (payload.iss) lines.push(`    Issuer:    ${payload.iss}`);
        if (payload.aud) lines.push(`    Audience:  ${Array.isArray(payload.aud) ? payload.aud.join(", ") : payload.aud}`);

        if (payload.iat) {
          const iat = new Date(payload.iat * 1000);
          lines.push(`    Issued:    ${iat.toISOString()}`);
        }
        if (payload.exp) {
          const exp = new Date(payload.exp * 1000);
          const now = new Date();
          const expired = exp < now;
          lines.push(`    Expires:   ${exp.toISOString()} ${expired ? "(EXPIRED)" : "(valid)"}`);
        }
        if (payload.nbf) {
          lines.push(`    Not Before: ${new Date(payload.nbf * 1000).toISOString()}`);
        }

        lines.push(`\n  Signature: ${sig.slice(0, 20)}...${sig.length > 20 ? ` (${sig.length} chars)` : ""}`);
        lines.push(`  \u26a0 Signature NOT verified (decode only)`);

        return lines.join("\n");
      } catch (err: any) {
        return `  Failed to decode JWT: ${err.message}`;
      }
    }
    case "dotenv": {
      const { existsSync, readFileSync, statSync: statSyncFn } = await import("node:fs");
      const { resolve: resolvePath, relative } = await import("node:path");
      const cwd = appConfig.workingDirectory;
      const filePath = resolvePath(cwd, args?.trim() || ".env");

      if (!existsSync(filePath)) return `  File not found: ${relative(cwd, filePath)}`;
      const stat = statSyncFn(filePath);
      if (!stat.isFile()) return "  Not a file.";
      if (stat.size > 1024 * 1024) return "  File too large (max 1 MB).";

      const content = readFileSync(filePath, "utf-8");
      const relPath = relative(cwd, filePath);
      const rawLines = content.split("\n");

      const keys: string[] = [];
      const duplicates: string[] = [];
      const empty: string[] = [];
      const comments = rawLines.filter(l => l.trim().startsWith("#")).length;
      const seen = new Set<string>();

      for (const line of rawLines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx < 0) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();

        keys.push(key);
        if (seen.has(key)) duplicates.push(key);
        seen.add(key);
        if (!val || val === '""' || val === "''") empty.push(key);
      }

      const lines = [
        `  Dotenv Inspector: ${relPath}\n`,
        `  Variables:   ${keys.length}`,
        `  Unique:      ${seen.size}`,
        `  Comments:    ${comments}`,
        `  Empty:       ${empty.length}`,
        `  Duplicates:  ${duplicates.length}`,
        ``,
        `  Keys:`,
      ];

      for (const key of [...seen].sort()) {
        const flags: string[] = [];
        if (duplicates.includes(key)) flags.push("DUP");
        if (empty.includes(key)) flags.push("EMPTY");
        lines.push(`    ${key}${flags.length ? `  [${flags.join(", ")}]` : ""}`);
      }

      if (duplicates.length > 0) {
        lines.push(`\n  \u26a0 Duplicate keys: ${[...new Set(duplicates)].join(", ")}`);
      }
      if (empty.length > 0) {
        lines.push(`  \u26a0 Empty values: ${empty.join(", ")}`);
      }

      return lines.join("\n");
    }
    case "table_fmt": {
      if (!args?.trim()) return "  Usage: /table-fmt header1,header2 | row1col1,row1col2 | row2col1,row2col2\n  Example: /table-fmt Name,Age,City | Alice,30,NYC | Bob,25,LA";

      const sections = args.split("|").map(s => s.trim()).filter(Boolean);
      if (sections.length < 1) return "  Provide at least headers.";

      const rows = sections.map(s => s.split(",").map(c => c.trim()));
      const headers = rows[0]!;
      const dataRows = rows.slice(1);
      const numCols = headers.length;

      // Calculate column widths
      const colWidths = headers.map((h, i) => {
        const values = [h, ...dataRows.map(r => r[i] ?? "")];
        return Math.max(...values.map(v => v.length), 3);
      });

      const formatRow = (cells: string[]) =>
        "| " + cells.map((c, i) => (c ?? "").padEnd(colWidths[i]!)).join(" | ") + " |";

      const separator = "| " + colWidths.map(w => "-".repeat(w)).join(" | ") + " |";

      const lines = [`  Markdown Table\n`];
      lines.push(`  ${formatRow(headers)}`);
      lines.push(`  ${separator}`);
      for (const row of dataRows) {
        lines.push(`  ${formatRow(row)}`);
      }

      return lines.join("\n");
    }
    case "git_graph": {
      const { execSync } = await import("node:child_process");
      const cwd = appConfig.workingDirectory;
      const count = Math.min(Math.max(parseInt(args?.trim() || "20") || 20, 5), 50);

      try {
        const output = execSync(
          `git log --graph --oneline --decorate --all -n ${count} 2>/dev/null`,
          { cwd, timeout: 10000 }
        ).toString().trim();

        if (!output) return "  No git history found.";

        const lines = [`  Git Graph (last ${count})\n`];
        for (const line of output.split("\n")) {
          lines.push(`  ${line}`);
        }

        // Branch summary
        try {
          const branches = execSync(`git branch -a 2>/dev/null | wc -l`, { cwd, timeout: 3000 }).toString().trim();
          const currentBranch = execSync(`git branch --show-current 2>/dev/null`, { cwd, timeout: 3000 }).toString().trim();
          lines.push(`\n  Current: ${currentBranch || "detached HEAD"}  |  Branches: ${branches}`);
        } catch { /* skip */ }

        return lines.join("\n");
      } catch (err: any) {
        return `  Git error: ${err.stderr?.toString()?.trim() || err.message}`;
      }
    }
    case "reverse": {
      if (!args?.trim()) return "  Usage: /reverse <text>\n  Options: --words (reverse word order), --lines (reverse line order)";

      const input = args.trim();
      let mode = "chars";
      let text = input;

      if (input.startsWith("--words ")) {
        mode = "words";
        text = input.slice(8);
      } else if (input.startsWith("--lines ")) {
        mode = "lines";
        text = input.slice(8);
      }

      let result: string;
      if (mode === "words") {
        result = text.split(/\s+/).reverse().join(" ");
      } else if (mode === "lines") {
        result = text.split("\n").reverse().join("\n");
      } else {
        result = [...text].reverse().join("");
      }

      return [
        `  Reverse (${mode})\n`,
        `  Input:  ${text.length > 80 ? text.slice(0, 80) + "..." : text}`,
        `  Output: ${result.length > 80 ? result.slice(0, 80) + "..." : result}`,
      ].join("\n");
    }
    case "uptime_check": {
      if (!args?.trim()) return "  Usage: /uptime-check <URL>";

      let url = args.trim();
      if (!/^https?:\/\//i.test(url)) url = "https://" + url;

      const lines = [`  Uptime Check: ${url}\n`];

      try {
        const startTime = performance.now();
        const resp = await fetch(url, {
          method: "HEAD",
          signal: AbortSignal.timeout(10000),
          redirect: "follow",
        });
        const latency = Math.round(performance.now() - startTime);

        const status = resp.status;
        const statusText = resp.statusText;
        const isUp = status >= 200 && status < 400;

        lines.push(`  Status:    ${isUp ? "\u2714" : "\u2718"} ${status} ${statusText}`);
        lines.push(`  Latency:   ${latency}ms`);

        // TLS info
        if (url.startsWith("https")) {
          lines.push(`  TLS:       \u2714 Secure`);
        } else {
          lines.push(`  TLS:       \u2718 Not encrypted`);
        }

        // Headers info
        const server = resp.headers.get("server");
        const contentType = resp.headers.get("content-type");
        const poweredBy = resp.headers.get("x-powered-by");
        if (server) lines.push(`  Server:    ${server}`);
        if (contentType) lines.push(`  Type:      ${contentType}`);
        if (poweredBy) lines.push(`  Powered:   ${poweredBy}`);

        // Redirects
        if (resp.redirected) {
          lines.push(`  Redirected: \u2714 (final: ${resp.url})`);
        }

        // Response size
        const contentLength = resp.headers.get("content-length");
        if (contentLength) lines.push(`  Size:      ${parseInt(contentLength).toLocaleString()} bytes`);

        lines.push(`\n  Verdict:   ${isUp ? "UP \u2714" : "DOWN \u2718"}`);
      } catch (err: any) {
        lines.push(`  Status:    \u2718 UNREACHABLE`);
        lines.push(`  Error:     ${err.message}`);
        lines.push(`\n  Verdict:   DOWN \u2718`);
      }

      return lines.join("\n");
    }
    case "chmod_calc": {
      if (!args?.trim()) return "  Usage: /chmod-calc <octal or symbolic>\n  Examples: /chmod-calc 755, /chmod-calc rwxr-xr-x";

      const input = args.trim();

      const octalToSymbolic = (octal: string): string => {
        const map: Record<string, string> = {
          "0": "---", "1": "--x", "2": "-w-", "3": "-wx",
          "4": "r--", "5": "r-x", "6": "rw-", "7": "rwx",
        };
        const digits = octal.padStart(3, "0").slice(-3);
        return digits.split("").map(d => map[d] ?? "---").join("");
      };

      const symbolicToOctal = (sym: string): string => {
        const map: Record<string, string> = {
          "---": "0", "--x": "1", "-w-": "2", "-wx": "3",
          "r--": "4", "r-x": "5", "rw-": "6", "rwx": "7",
        };
        const clean = sym.replace(/^[-d]/, "").slice(0, 9);
        if (clean.length !== 9) return "";
        const u = map[clean.slice(0, 3)] ?? "0";
        const g = map[clean.slice(3, 6)] ?? "0";
        const o = map[clean.slice(6, 9)] ?? "0";
        return u + g + o;
      };

      let octal: string;
      let symbolic: string;
      let mode: string;
      let specialBit = "";

      if (/^\d{3,4}$/.test(input)) {
        // Octal input
        const full = input.padStart(4, "0");
        const special = full[0]!;
        octal = full.slice(-3);
        symbolic = octalToSymbolic(octal);
        mode = "Octal → Symbolic";
        if (special === "1") specialBit = "sticky";
        else if (special === "2") specialBit = "setgid";
        else if (special === "4") specialBit = "setuid";
        else if (special === "6") specialBit = "setuid + setgid";
        else if (special === "5") specialBit = "setuid + sticky";
        else if (special === "3") specialBit = "setgid + sticky";
        else if (special === "7") specialBit = "setuid + setgid + sticky";
      } else if (/^[-drwx]{9,10}$/.test(input)) {
        // Symbolic input
        symbolic = input.replace(/^[-d]/, "").slice(0, 9);
        octal = symbolicToOctal(input);
        mode = "Symbolic → Octal";
        if (!octal) return "  Invalid symbolic permissions.";
      } else {
        return "  Invalid format. Use octal (755) or symbolic (rwxr-xr-x).";
      }

      const u = symbolic.slice(0, 3);
      const g = symbolic.slice(3, 6);
      const o = symbolic.slice(6, 9);
      const fullOctal = specialBit ? input.padStart(4, "0") : octal;

      const lines = [
        `  chmod Calculator: ${mode}\n`,
        `  Octal:    ${fullOctal}`,
        `  Symbolic: ${symbolic}`,
        ``,
        `  Owner:  ${u}  (${u.replace(/-/g, " ").trim() || "none"})`,
        `  Group:  ${g}  (${g.replace(/-/g, " ").trim() || "none"})`,
        `  Other:  ${o}  (${o.replace(/-/g, " ").trim() || "none"})`,
      ];

      if (specialBit) {
        lines.push(`  Special: ${specialBit}`);
      }

      lines.push(``, `  Command: chmod ${fullOctal} <file>`);

      return lines.join("\n");
    }
    case "semver": {
      if (!args?.trim()) return "  Usage: /semver <version> [bump major|minor|patch|prerelease]\n  Examples: /semver 1.2.3, /semver 1.2.3 bump minor";

      const input = args.trim();
      const parts = input.split(/\s+/);
      const raw = parts[0]!;
      const action2 = parts[1]?.toLowerCase();
      const bumpType = parts[2]?.toLowerCase();

      // Parse semver
      const match = raw.match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9.]+))?(?:\+([a-zA-Z0-9.]+))?$/);
      if (!match) return `  Invalid semver: ${raw}\n  Expected format: MAJOR.MINOR.PATCH[-prerelease][+build]`;

      let major = parseInt(match[1]!);
      let minor = parseInt(match[2]!);
      let patch = parseInt(match[3]!);
      const pre = match[4] || "";
      const build = match[5] || "";

      const lines = [`  Semver: ${raw}\n`];
      lines.push(`  Major:      ${major}`);
      lines.push(`  Minor:      ${minor}`);
      lines.push(`  Patch:      ${patch}`);
      if (pre) lines.push(`  Prerelease: ${pre}`);
      if (build) lines.push(`  Build:      ${build}`);

      if (action2 === "bump" && bumpType) {
        let bumped: string;
        if (bumpType === "major") {
          bumped = `${major + 1}.0.0`;
        } else if (bumpType === "minor") {
          bumped = `${major}.${minor + 1}.0`;
        } else if (bumpType === "patch") {
          bumped = `${major}.${minor}.${patch + 1}`;
        } else if (bumpType === "prerelease") {
          // Increment last numeric in prerelease, or append .0
          if (pre) {
            const preParts = pre.split(".");
            const last = preParts[preParts.length - 1]!;
            if (/^\d+$/.test(last)) {
              preParts[preParts.length - 1] = String(parseInt(last) + 1);
            } else {
              preParts.push("1");
            }
            bumped = `${major}.${minor}.${patch}-${preParts.join(".")}`;
          } else {
            bumped = `${major}.${minor}.${patch + 1}-0`;
          }
        } else {
          return `  Unknown bump type: ${bumpType}. Use major, minor, patch, or prerelease.`;
        }
        lines.push(`\n  Bump ${bumpType}: ${bumped}`);
      }

      return lines.join("\n");
    }
    case "gitignore": {
      const { existsSync, readFileSync, statSync: statSyncFn, appendFileSync } = await import("node:fs");
      const { resolve: resolvePath, relative } = await import("node:path");
      const cwd = appConfig.workingDirectory;
      const gitignorePath = resolvePath(cwd, ".gitignore");
      const input = args?.trim() || "";

      // /gitignore add <pattern>
      if (input.startsWith("add ")) {
        const pattern = input.slice(4).trim();
        if (!pattern) return "  Usage: /gitignore add <pattern>";

        // Check if pattern already exists
        if (existsSync(gitignorePath)) {
          const content = readFileSync(gitignorePath, "utf-8");
          const existingPatterns = content.split("\n").map(l => l.trim());
          if (existingPatterns.includes(pattern)) {
            return `  Pattern already in .gitignore: ${pattern}`;
          }
        }

        const suffix = existsSync(gitignorePath) ? "\n" + pattern + "\n" : pattern + "\n";
        appendFileSync(gitignorePath, suffix, "utf-8");
        return `  Added to .gitignore: ${pattern}`;
      }

      // /gitignore check <file>
      if (input.startsWith("check ")) {
        const file = input.slice(6).trim();
        if (!file) return "  Usage: /gitignore check <file>";
        try {
          const { execFileSync } = await import("node:child_process");
          const result = execFileSync("git", ["check-ignore", "-v", file], { cwd, timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
          return result ? `  Ignored: ${result}` : `  Not ignored: ${file}`;
        } catch {
          return `  Not ignored: ${file}`;
        }
      }

      // Default: inspect .gitignore
      if (!existsSync(gitignorePath)) return "  No .gitignore found in current directory.";
      const stat = statSyncFn(gitignorePath);
      if (stat.size > 512 * 1024) return "  .gitignore too large (max 512 KB).";

      const content = readFileSync(gitignorePath, "utf-8");
      const rawLines = content.split("\n");
      const patterns = rawLines.filter(l => l.trim() && !l.trim().startsWith("#"));
      const comments = rawLines.filter(l => l.trim().startsWith("#")).length;

      const lines = [
        `  .gitignore Inspector\n`,
        `  Patterns:  ${patterns.length}`,
        `  Comments:  ${comments}`,
        `  Size:      ${stat.size} bytes`,
        ``,
        `  Patterns:`,
      ];

      for (const p of patterns.slice(0, 50)) {
        lines.push(`    ${p.trim()}`);
      }
      if (patterns.length > 50) {
        lines.push(`    ... and ${patterns.length - 50} more`);
      }

      return lines.join("\n");
    }
    case "wordfreq": {
      const input = args?.trim();
      if (!input) return "  Usage: /wordfreq <text or file path> [--top N]";

      // Parse --top N
      let topN = 20;
      let text = input;
      const topMatch = input.match(/--top\s+(\d+)/);
      if (topMatch) {
        topN = Math.min(Math.max(parseInt(topMatch[1]!) || 20, 1), 100);
        text = input.replace(/--top\s+\d+/, "").trim();
      }

      // Try to read as file
      const { existsSync, readFileSync, statSync: statSyncFn } = await import("node:fs");
      const { resolve: resolvePath } = await import("node:path");
      const cwd = appConfig.workingDirectory;
      const filePath = resolvePath(cwd, text);

      if (existsSync(filePath)) {
        const stat = statSyncFn(filePath);
        if (stat.isFile() && stat.size <= 2 * 1024 * 1024) {
          text = readFileSync(filePath, "utf-8");
        }
      }

      // Count words
      const words = text.toLowerCase().match(/[a-zA-Z\u00C0-\u024F]+(?:'[a-zA-Z]+)?/g);
      if (!words || words.length === 0) return "  No words found.";

      const freq = new Map<string, number>();
      for (const w of words) {
        freq.set(w, (freq.get(w) || 0) + 1);
      }

      const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN);
      const maxCount = sorted[0]![1];
      const barWidth = 20;

      const lines = [`  Word Frequency (top ${Math.min(topN, sorted.length)} of ${freq.size} unique)\n`];
      lines.push(`  Total words: ${words.length}\n`);

      const maxWordLen = Math.max(...sorted.map(([w]) => w.length), 4);
      for (const [word, count] of sorted) {
        const bar = "\u2588".repeat(Math.max(1, Math.round((count / maxCount) * barWidth)));
        lines.push(`  ${word.padEnd(maxWordLen)}  ${String(count).padStart(5)}  ${bar}`);
      }

      return lines.join("\n");
    }
    case "network_ports": {
      const PORTS: Record<number, string> = {
        20: "FTP Data", 21: "FTP Control", 22: "SSH", 23: "Telnet",
        25: "SMTP", 53: "DNS", 67: "DHCP Server", 68: "DHCP Client",
        69: "TFTP", 80: "HTTP", 110: "POP3", 119: "NNTP",
        123: "NTP", 135: "MS RPC", 137: "NetBIOS Name", 138: "NetBIOS Datagram",
        139: "NetBIOS Session", 143: "IMAP", 161: "SNMP", 162: "SNMP Trap",
        179: "BGP", 194: "IRC", 389: "LDAP", 443: "HTTPS",
        445: "SMB", 465: "SMTPS", 514: "Syslog", 515: "LPD/LPR",
        543: "Kerberos Login", 544: "Kerberos Shell", 546: "DHCPv6 Client",
        547: "DHCPv6 Server", 554: "RTSP", 587: "SMTP Submission",
        631: "IPP/CUPS", 636: "LDAPS", 873: "rsync", 993: "IMAPS",
        995: "POP3S", 1080: "SOCKS", 1433: "MS SQL", 1434: "MS SQL Monitor",
        1521: "Oracle DB", 1723: "PPTP", 2049: "NFS", 2181: "ZooKeeper",
        3000: "Dev Server", 3306: "MySQL", 3389: "RDP", 4443: "Pharos",
        5000: "Flask/UPnP", 5432: "PostgreSQL", 5672: "AMQP/RabbitMQ",
        5900: "VNC", 6379: "Redis", 6443: "Kubernetes API",
        8000: "HTTP Alt", 8080: "HTTP Proxy", 8443: "HTTPS Alt",
        8888: "Jupyter", 9090: "Prometheus", 9200: "Elasticsearch",
        9300: "Elasticsearch Transport", 9418: "Git", 11211: "Memcached",
        27017: "MongoDB", 27018: "MongoDB Shard", 27019: "MongoDB Config",
      };

      const input = args?.trim();
      if (!input) {
        // Show all known ports
        const lines = [`  Well-Known Ports\n`];
        const sorted = Object.entries(PORTS).sort((a, b) => parseInt(a[0]) - parseInt(b[0]));
        for (const [port, name] of sorted) {
          lines.push(`  ${String(port).padStart(5)}  ${name}`);
        }
        return lines.join("\n");
      }

      // Lookup by port number
      const portNum = parseInt(input);
      if (!isNaN(portNum) && portNum > 0 && portNum <= 65535) {
        const name = PORTS[portNum];
        if (name) {
          return `  Port ${portNum}: ${name}`;
        }
        return `  Port ${portNum}: Unknown (no well-known service)`;
      }

      // Lookup by service name
      const query = input.toLowerCase();
      const matches = Object.entries(PORTS).filter(([, name]) =>
        name.toLowerCase().includes(query)
      );

      if (matches.length === 0) return `  No service matching "${input}" found.`;

      const lines = [`  Services matching "${input}"\n`];
      for (const [port, name] of matches) {
        lines.push(`  ${String(port).padStart(5)}  ${name}`);
      }
      return lines.join("\n");
    }
    case "wrap": {
      if (!args?.trim()) return "  Usage: /wrap [--width N] <text>\n  Default width: 80";

      let width = 80;
      let text = args.trim();

      const widthMatch = text.match(/^--width\s+(\d+)\s+/);
      if (widthMatch) {
        width = Math.min(Math.max(parseInt(widthMatch[1]!) || 80, 10), 200);
        text = text.slice(widthMatch[0].length);
      }

      // Try reading as file
      const { existsSync, readFileSync, statSync: statSyncFn } = await import("node:fs");
      const { resolve: resolvePath } = await import("node:path");
      const cwd = appConfig.workingDirectory;
      const filePath = resolvePath(cwd, text);

      if (existsSync(filePath)) {
        const stat = statSyncFn(filePath);
        if (stat.isFile() && stat.size <= 1024 * 1024) {
          text = readFileSync(filePath, "utf-8");
        }
      }

      // Word wrap
      const paragraphs = text.split(/\n\s*\n/);
      const wrapped = paragraphs.map(para => {
        const words = para.replace(/\n/g, " ").split(/\s+/).filter(Boolean);
        const resultLines: string[] = [];
        let currentLine = "";

        for (const word of words) {
          if (!currentLine) {
            currentLine = word;
          } else if (currentLine.length + 1 + word.length <= width) {
            currentLine += " " + word;
          } else {
            resultLines.push(currentLine);
            currentLine = word;
          }
        }
        if (currentLine) resultLines.push(currentLine);
        return resultLines.join("\n");
      });

      const result = wrapped.join("\n\n");
      const lineCount = result.split("\n").length;

      const lines = [`  Word Wrap (width: ${width})\n`];
      for (const line of result.split("\n").slice(0, 100)) {
        lines.push(`  ${line}`);
      }
      if (lineCount > 100) {
        lines.push(`  ... (${lineCount - 100} more lines)`);
      }
      lines.push(`\n  Lines: ${lineCount}  |  Width: ${width}`);

      return lines.join("\n");
    }
    case "char_info": {
      const input = args?.trim();
      if (!input) return "  Usage: /char-info <character(s)>\n  Examples: /char-info A, /char-info U+1F600, /char-info \u00e9\u00f1";

      const lines = [`  Unicode Character Info\n`];

      // Check if input is U+XXXX format
      const codePointMatch = input.match(/^[Uu]\+([0-9A-Fa-f]{1,6})$/);
      let chars: string[];

      if (codePointMatch) {
        const cp = parseInt(codePointMatch[1]!, 16);
        if (cp > 0x10FFFF) return "  Invalid codepoint (max U+10FFFF).";
        chars = [String.fromCodePoint(cp)];
      } else {
        // Spread to handle surrogate pairs correctly
        chars = [...input].slice(0, 20);
      }

      for (const char of chars) {
        const cp = char.codePointAt(0)!;
        const hex = cp.toString(16).toUpperCase().padStart(4, "0");

        // UTF-8 byte representation
        const encoder = new TextEncoder();
        const utf8Bytes = encoder.encode(char);
        const bytesStr = [...utf8Bytes].map(b => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");

        // Category heuristic
        let category = "Other";
        if (cp >= 0x41 && cp <= 0x5A) category = "Uppercase Letter";
        else if (cp >= 0x61 && cp <= 0x7A) category = "Lowercase Letter";
        else if (cp >= 0x30 && cp <= 0x39) category = "Digit";
        else if (cp >= 0x00 && cp <= 0x1F) category = "Control";
        else if (cp >= 0x20 && cp <= 0x2F) category = "Punctuation/Symbol";
        else if (cp >= 0x3A && cp <= 0x40) category = "Punctuation/Symbol";
        else if (cp >= 0x5B && cp <= 0x60) category = "Punctuation/Symbol";
        else if (cp >= 0x7B && cp <= 0x7E) category = "Punctuation/Symbol";
        else if (cp >= 0x80 && cp <= 0xFF) category = "Latin Extended";
        else if (cp >= 0x100 && cp <= 0x24F) category = "Latin Extended";
        else if (cp >= 0x370 && cp <= 0x3FF) category = "Greek";
        else if (cp >= 0x400 && cp <= 0x4FF) category = "Cyrillic";
        else if (cp >= 0x4E00 && cp <= 0x9FFF) category = "CJK Ideograph";
        else if (cp >= 0x3040 && cp <= 0x309F) category = "Hiragana";
        else if (cp >= 0x30A0 && cp <= 0x30FF) category = "Katakana";
        else if (cp >= 0xAC00 && cp <= 0xD7AF) category = "Hangul";
        else if (cp >= 0x0600 && cp <= 0x06FF) category = "Arabic";
        else if (cp >= 0x0590 && cp <= 0x05FF) category = "Hebrew";
        else if (cp >= 0x0900 && cp <= 0x097F) category = "Devanagari";
        else if (cp >= 0x1F600 && cp <= 0x1F64F) category = "Emoji (Faces)";
        else if (cp >= 0x1F300 && cp <= 0x1F5FF) category = "Emoji (Symbols)";
        else if (cp >= 0x1F680 && cp <= 0x1F6FF) category = "Emoji (Transport)";
        else if (cp >= 0x2600 && cp <= 0x26FF) category = "Misc Symbols";
        else if (cp >= 0x2700 && cp <= 0x27BF) category = "Dingbats";
        else if (cp >= 0x2000 && cp <= 0x206F) category = "General Punctuation";
        else if (cp >= 0x2190 && cp <= 0x21FF) category = "Arrows";
        else if (cp >= 0x2200 && cp <= 0x22FF) category = "Math Operators";
        else if (cp >= 0x2500 && cp <= 0x257F) category = "Box Drawing";
        else if (cp >= 0x2580 && cp <= 0x259F) category = "Block Elements";
        else if (cp >= 0xFE00 && cp <= 0xFE0F) category = "Variation Selector";
        else if (cp >= 0xE0000 && cp <= 0xE007F) category = "Tags";

        lines.push(`  '${char}'  U+${hex}`);
        lines.push(`    Decimal:   ${cp}`);
        lines.push(`    UTF-8:     ${bytesStr} (${utf8Bytes.length} byte${utf8Bytes.length > 1 ? "s" : ""})`);
        lines.push(`    Category:  ${category}`);
        lines.push(`    HTML:      &#${cp}; / &#x${hex};`);
        lines.push(``);
      }

      return lines.join("\n");
    }
    case "run_benchmark": {
      const { getModelBaseUrl } = await import("../core/models");
      const model = appConfig.model;
      const apiBase = await getModelBaseUrl(model, appConfig.apiBase);
      const url = `${apiBase}/v1/chat/completions`;

      const lines = [`  Model Benchmark: ${model}\n`];

      const tests = [
        { name: "Simple Q&A", prompt: "What is 2+2? Reply with just the number." },
        { name: "Code Gen", prompt: "Write a JavaScript function that reverses a string. Reply with just the code, no explanation." },
        { name: "Reasoning", prompt: "If all roses are flowers and some flowers fade quickly, can we conclude that some roses fade quickly? Answer yes or no with one sentence of reasoning." },
      ];

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (appConfig.apiKey) headers["Authorization"] = `Bearer ${appConfig.apiKey}`;

      let totalTokens = 0;
      let totalLatency = 0;

      for (const test of tests) {
        try {
          const start = performance.now();
          const resp = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({
              model,
              messages: [{ role: "user", content: test.prompt }],
              max_tokens: 256,
              stream: false,
            }),
            signal: AbortSignal.timeout(30000),
          });

          const latency = Math.round(performance.now() - start);
          totalLatency += latency;

          if (!resp.ok) {
            lines.push(`  ${test.name}: FAILED (HTTP ${resp.status})`);
            continue;
          }

          const data = await resp.json() as any;
          const reply = data.choices?.[0]?.message?.content ?? "(empty)";
          const tokens = data.usage?.total_tokens ?? 0;
          const completionTokens = data.usage?.completion_tokens ?? 0;
          const tokPerSec = latency > 0 ? Math.round((completionTokens / latency) * 1000) : 0;
          totalTokens += tokens;

          lines.push(`  ${test.name}`);
          lines.push(`    Latency:  ${latency}ms`);
          lines.push(`    Tokens:   ${tokens} (${completionTokens} completion)`);
          lines.push(`    Speed:    ${tokPerSec} tok/s`);
          lines.push(`    Reply:    ${reply.slice(0, 80).replace(/\n/g, " ")}${reply.length > 80 ? "..." : ""}`);
          lines.push(``);
        } catch (err: any) {
          lines.push(`  ${test.name}: ERROR — ${err.message}\n`);
        }
      }

      const avgLatency = tests.length > 0 ? Math.round(totalLatency / tests.length) : 0;
      lines.push(`  Summary`);
      lines.push(`    Avg latency: ${avgLatency}ms`);
      lines.push(`    Total tokens: ${totalTokens}`);
      lines.push(`    Endpoint: ${url}`);

      return lines.join("\n");
    }
    case "gpu": {
      const { execSync } = await import("node:child_process");
      const lines = [`  GPU Monitor\n`];

      // NVIDIA GPUs
      try {
        const raw = execSync(
          "nvidia-smi --query-gpu=index,name,temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw,power.limit,driver_version --format=csv,noheader,nounits",
          { timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }
        ).toString().trim();

        if (raw) {
          for (const line of raw.split("\n")) {
            const [idx, name, temp, util, memUsed, memTotal, powerDraw, powerLimit, driver] = line.split(",").map(s => s.trim());
            const memUsedMB = parseInt(memUsed!);
            const memTotalMB = parseInt(memTotal!);
            const memPct = memTotalMB > 0 ? Math.round((memUsedMB / memTotalMB) * 100) : 0;
            const barWidth = 20;
            const filledBar = Math.round((memPct / 100) * barWidth);
            const bar = "\u2588".repeat(filledBar) + "\u2591".repeat(barWidth - filledBar);

            lines.push(`  GPU ${idx}: ${name}`);
            lines.push(`    VRAM:   ${memUsed} / ${memTotal} MB (${memPct}%)  [${bar}]`);
            lines.push(`    Temp:   ${temp}\u00b0C`);
            lines.push(`    Util:   ${util}%`);
            lines.push(`    Power:  ${powerDraw}W / ${powerLimit}W`);
            lines.push(`    Driver: ${driver}`);
            lines.push(``);
          }
        }
      } catch {
        lines.push("  No NVIDIA GPU detected (nvidia-smi not available).\n");
      }

      // Check for AMD GPUs
      try {
        const amd = execSync("rocm-smi --showmeminfo vram --csv 2>/dev/null", { timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
        if (amd && amd.includes("vram")) {
          lines.push("  AMD GPU detected (rocm-smi available)");
          for (const line of amd.split("\n").slice(1, 5)) {
            lines.push(`    ${line.trim()}`);
          }
        }
      } catch { /* no AMD */ }

      // Check for running inference processes
      try {
        const procs = execSync("nvidia-smi --query-compute-apps=pid,name,used_gpu_memory --format=csv,noheader,nounits 2>/dev/null", { timeout: 3000, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
        if (procs) {
          lines.push(`  Running GPU Processes:`);
          for (const proc of procs.split("\n")) {
            const [pid, pname, mem] = proc.split(",").map(s => s.trim());
            lines.push(`    PID ${pid}: ${pname} (${mem} MB)`);
          }
        }
      } catch { /* skip */ }

      return lines.join("\n");
    }
    case "new_project": {
      const { listTemplates, findTemplate, createFromTemplate } = await import("../core/project-templates");
      const input = args?.trim();

      if (!input) {
        const templates = listTemplates();
        const lines = [`  Project Templates (${templates.length})\n`];
        for (const t of templates) {
          lines.push(`  ${t.name.padEnd(14)} ${t.description}  [${t.source}]`);
        }
        lines.push(``);
        lines.push(`  Usage: /new-project <template> <project-name>`);
        lines.push(`  Example: /new-project bun-ts my-app`);
        return lines.join("\n");
      }

      const parts = input.split(/\s+/);
      if (parts.length < 2) return "  Usage: /new-project <template> <project-name>";

      const templateName = parts[0]!;
      const projectName = parts[1]!;

      const template = findTemplate(templateName);
      if (!template) return `  Template not found: ${templateName}\n  Run /new-project to see available templates.`;

      // Validate project name
      if (!/^[a-zA-Z][\w.-]*$/.test(projectName)) {
        return "  Invalid project name. Use alphanumeric, hyphens, dots, underscores.";
      }

      const { resolve: resolvePath } = await import("node:path");
      const targetDir = resolvePath(appConfig.workingDirectory, projectName);

      const { existsSync } = await import("node:fs");
      if (existsSync(targetDir)) return `  Directory already exists: ${projectName}`;

      const result = createFromTemplate(template, projectName, targetDir);

      const lines = [
        `  Created ${projectName} from "${templateName}" template\n`,
        `  Files:`,
      ];
      for (const f of result.filesCreated) {
        lines.push(`    ${f}`);
      }
      if (result.postCreate) {
        lines.push(``);
        lines.push(`  Run: cd ${projectName} && ${result.postCreate}`);
      }

      return lines.join("\n");
    }
    case "cache": {
      const { getCacheStats, clearCache } = await import("../core/response-cache");
      const cmd = args?.trim().toLowerCase();

      if (cmd === "clear") {
        const cleared = clearCache();
        return `  Cleared ${cleared} cached responses.`;
      }

      const stats = getCacheStats();
      return [
        `  Response Cache\n`,
        `  Entries:     ${stats.entries} / 500`,
        `  Total hits:  ${stats.totalHits}`,
        `  Oldest:      ${stats.oldestDays} days`,
        `  TTL:         7 days`,
        ``,
        `  /cache clear — clear all cached responses`,
      ].join("\n");
    }
    case "effort": {
      const level = args?.trim().toLowerCase();
      if (!level || !["low", "medium", "high", "max"].includes(level)) {
        const current = appConfig.effortLevel ?? "medium";
        return [
          `  Effort Level: ${current}\n`,
          "  Usage: /effort <low|medium|high|max>",
          "",
          "  low    — Fast responses, max 4K tokens, temp 0.3",
          "  medium — Balanced (default), standard tokens",
          "  high   — Deep reasoning, max 32K tokens, temp 0.7",
          "  max    — Maximum reasoning, max 64K tokens, temp 0.9",
        ].join("\n");
      }
      (appConfig as any).effortLevel = level;
      return `  Effort level set to: ${level}`;
    }
    case "agents": {
      const { loadCustomAgents } = await import("../core/custom-agents");
      const cwd = appConfig.workingDirectory;
      const agents = loadCustomAgents(cwd);

      if (agents.length === 0) {
        return [
          "  Custom Agents\n",
          "  No custom agents defined.",
          "",
          "  Create agents as .md files in:",
          "    ~/.kcode/agents/     (user-wide)",
          "    .kcode/agents/       (project-specific)",
          "",
          "  Example ~/.kcode/agents/reviewer.md:",
          "  ---",
          '  name: reviewer',
          '  description: Code review specialist',
          '  model: deepseek-coder',
          '  tools: [Read, Glob, Grep]',
          '  permissionMode: plan',
          '  maxTurns: 10',
          "  ---",
          "  You are a code review specialist. Focus on bugs, security, and style.",
        ].join("\n");
      }

      const lines = [`  Custom Agents (${agents.length})\n`];
      for (const a of agents) {
        lines.push(`  ${a.name}`);
        lines.push(`    ${a.description}`);
        if (a.model) lines.push(`    Model: ${a.model}`);
        if (a.tools) lines.push(`    Tools: ${a.tools.join(", ")}`);
        if (a.maxTurns) lines.push(`    Max turns: ${a.maxTurns}`);
        if (a.permissionMode) lines.push(`    Permission: ${a.permissionMode}`);
        lines.push(`    Source: ${a.sourcePath}`);
        lines.push(``);
      }

      lines.push(`  Usage: Agent tool with type="<agent-name>"`);
      return lines.join("\n");
    }
    case "slug": {
      if (!args?.trim()) return "  Usage: /slug <text>\n  Example: /slug Hello World! This is a Test";

      const text = args.trim();

      // Normalize unicode, strip diacritics, lowercase, replace non-alnum with hyphens
      const slug = text
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")   // strip diacritics
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")       // non-alnum → hyphen
        .replace(/^-+|-+$/g, "")           // trim leading/trailing hyphens
        .replace(/-{2,}/g, "-");           // collapse multiple hyphens

      return [
        `  Slug Generator\n`,
        `  Input:  ${text.length > 80 ? text.slice(0, 80) + "..." : text}`,
        `  Slug:   ${slug}`,
        `  Length:  ${slug.length} chars`,
      ].join("\n");
    }
    case "diff_words": {
      if (!args?.trim() || !args.includes("|"))
        return "  Usage: /diff-words text1 | text2\n  Example: /diff-words the quick brown fox | the slow brown dog";

      const [left, right] = args.split("|", 2).map(s => s!.trim());
      if (!left || !right) return "  Provide two texts separated by |";

      const wordsA = left.split(/\s+/);
      const wordsB = right.split(/\s+/);

      // Simple LCS-based word diff
      const m = wordsA.length;
      const n = wordsB.length;

      // Guard against excessive input
      if (m > 500 || n > 500) return "  Input too long (max 500 words per side).";

      // Build LCS table
      const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
      for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
          if (wordsA[i - 1] === wordsB[j - 1]) {
            dp[i]![j] = dp[i - 1]![j - 1]! + 1;
          } else {
            dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
          }
        }
      }

      // Backtrack to produce diff
      const diff: { type: string; word: string }[] = [];
      let i = m, j = n;
      while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && wordsA[i - 1] === wordsB[j - 1]) {
          diff.unshift({ type: " ", word: wordsA[i - 1]! });
          i--; j--;
        } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
          diff.unshift({ type: "+", word: wordsB[j - 1]! });
          j--;
        } else {
          diff.unshift({ type: "-", word: wordsA[i - 1]! });
          i--;
        }
      }

      const removed = diff.filter(d => d.type === "-").length;
      const added = diff.filter(d => d.type === "+").length;
      const unchanged = diff.filter(d => d.type === " ").length;

      const lines = [`  Word Diff\n`];
      let line = "  ";
      for (const d of diff) {
        const token = d.type === "-" ? `[-${d.word}-]` : d.type === "+" ? `{+${d.word}+}` : d.word;
        if (line.length + token.length + 1 > 100) {
          lines.push(line);
          line = "  ";
        }
        line += (line.length > 2 ? " " : "") + token;
      }
      if (line.length > 2) lines.push(line);

      lines.push(``);
      lines.push(`  Removed: ${removed}  Added: ${added}  Unchanged: ${unchanged}`);

      return lines.join("\n");
    }
    case "headers": {
      if (!args?.trim()) return "  Usage: /headers <URL>";

      let url = args.trim();
      if (!/^https?:\/\//i.test(url)) url = "https://" + url;

      const lines = [`  HTTP Headers: ${url}\n`];

      try {
        const resp = await fetch(url, {
          method: "HEAD",
          signal: AbortSignal.timeout(10000),
          redirect: "follow",
        });

        lines.push(`  Status: ${resp.status} ${resp.statusText}\n`);

        const maxKeyLen = Math.max(...[...resp.headers.keys()].map(k => k.length), 4);
        const sorted = [...resp.headers.entries()].sort((a, b) => a[0].localeCompare(b[0]));
        for (const [key, value] of sorted) {
          lines.push(`  ${key.padEnd(maxKeyLen)}  ${value}`);
        }

        lines.push(`\n  Total: ${sorted.length} headers`);
        if (resp.redirected) {
          lines.push(`  Redirected to: ${resp.url}`);
        }
      } catch (err: any) {
        lines.push(`  Error: ${err.message}`);
      }

      return lines.join("\n");
    }
    case "extract_urls": {
      let text = args?.trim();
      if (!text) return "  Usage: /extract-urls <text or file path>";

      // Try reading as file
      const { existsSync, readFileSync, statSync: statSyncFn } = await import("node:fs");
      const { resolve: resolvePath } = await import("node:path");
      const cwd = appConfig.workingDirectory;
      const filePath = resolvePath(cwd, text);

      if (existsSync(filePath)) {
        const stat = statSyncFn(filePath);
        if (stat.isFile() && stat.size <= 2 * 1024 * 1024) {
          text = readFileSync(filePath, "utf-8");
        }
      }

      // Extract URLs
      const urlPattern = /https?:\/\/[^\s<>"')\]},;]+/gi;
      const matches = text.match(urlPattern);

      if (!matches || matches.length === 0) return "  No URLs found.";

      // Deduplicate preserving order
      const unique = [...new Set(matches)];

      const lines = [`  Extracted URLs (${unique.length} unique, ${matches.length} total)\n`];
      for (const [i, url] of unique.slice(0, 100).entries()) {
        lines.push(`  ${String(i + 1).padStart(3)}. ${url}`);
      }
      if (unique.length > 100) {
        lines.push(`  ... and ${unique.length - 100} more`);
      }

      return lines.join("\n");
    }
    case "nato": {
      if (!args?.trim()) return "  Usage: /nato <text>\n  Example: /nato Hello";

      const NATO: Record<string, string> = {
        A: "Alfa", B: "Bravo", C: "Charlie", D: "Delta", E: "Echo",
        F: "Foxtrot", G: "Golf", H: "Hotel", I: "India", J: "Juliet",
        K: "Kilo", L: "Lima", M: "Mike", N: "November", O: "Oscar",
        P: "Papa", Q: "Quebec", R: "Romeo", S: "Sierra", T: "Tango",
        U: "Uniform", V: "Victor", W: "Whiskey", X: "X-ray", Y: "Yankee",
        Z: "Zulu",
        "0": "Zero", "1": "One", "2": "Two", "3": "Three", "4": "Four",
        "5": "Five", "6": "Six", "7": "Seven", "8": "Eight", "9": "Niner",
      };

      const text = args.trim().slice(0, 200);
      const lines = [`  NATO Phonetic: ${text.length > 60 ? text.slice(0, 60) + "..." : text}\n`];

      const words: string[] = [];
      for (const char of text) {
        const upper = char.toUpperCase();
        if (NATO[upper]) {
          words.push(NATO[upper]!);
          lines.push(`  ${char}  →  ${NATO[upper]}`);
        } else if (char === " ") {
          words.push("(space)");
          lines.push(`     →  (space)`);
        }
      }

      lines.push(``);
      lines.push(`  Spoken: ${words.join(" ")}`);

      return lines.join("\n");
    }
    case "markdown_toc": {
      if (!args?.trim()) return "  Usage: /markdown-toc <file.md>";

      const { existsSync, readFileSync, statSync: statSyncFn } = await import("node:fs");
      const { resolve: resolvePath, relative } = await import("node:path");
      const cwd = appConfig.workingDirectory;
      const filePath = resolvePath(cwd, args.trim());

      if (!existsSync(filePath)) return `  File not found: ${args.trim()}`;
      const stat = statSyncFn(filePath);
      if (!stat.isFile()) return "  Not a file.";
      if (stat.size > 2 * 1024 * 1024) return "  File too large (max 2 MB).";

      const content = readFileSync(filePath, "utf-8");
      const relPath = relative(cwd, filePath);

      // Extract headings (skip code blocks)
      let inCodeBlock = false;
      const headings: { level: number; text: string; anchor: string }[] = [];

      for (const line of content.split("\n")) {
        if (line.trim().startsWith("```")) {
          inCodeBlock = !inCodeBlock;
          continue;
        }
        if (inCodeBlock) continue;

        const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
        if (headingMatch) {
          const level = headingMatch[1]!.length;
          const text = headingMatch[2]!.trim();
          const anchor = text
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, "")
            .replace(/\s+/g, "-")
            .replace(/-{2,}/g, "-");
          headings.push({ level, text, anchor });
        }
      }

      if (headings.length === 0) return `  No headings found in ${relPath}`;

      const minLevel = Math.min(...headings.map(h => h.level));
      const lines = [`  Table of Contents: ${relPath}\n`];

      for (const h of headings.slice(0, 100)) {
        const indent = "  ".repeat(h.level - minLevel);
        lines.push(`  ${indent}- [${h.text}](#${h.anchor})`);
      }
      if (headings.length > 100) {
        lines.push(`  ... and ${headings.length - 100} more`);
      }

      lines.push(``);
      lines.push(`  Headings: ${headings.length}  |  Levels: ${minLevel}-${Math.max(...headings.map(h => h.level))}`);

      return lines.join("\n");
    }
    case "swarm": {
      if (!args?.trim()) return [
        "  Agent Swarm\n",
        "  Run N agents in parallel on a task.\n",
        "  Usage:",
        "    /swarm <prompt>                    Run 4 agents with the prompt",
        "    /swarm <prompt> --agents 6         Use 6 agents",
        "    /swarm <prompt> --files '*.ts'     Distribute files among agents",
        "",
        "  Agents run in --permission deny mode (read-only).",
        "  Max 8 agents. Each agent gets a subset of files.",
      ].join("\n");

      // Parse args
      let prompt = args.trim();
      let agentCount = 4;
      let fileGlob = "";

      const agentsMatch = prompt.match(/--agents\s+(\d+)/);
      if (agentsMatch) {
        agentCount = Math.min(8, Math.max(1, parseInt(agentsMatch[1]!)));
        prompt = prompt.replace(/--agents\s+\d+/, "").trim();
      }

      const filesMatch = prompt.match(/--files\s+'([^']+)'/);
      if (filesMatch) {
        fileGlob = filesMatch[1]!;
        prompt = prompt.replace(/--files\s+'[^']+'/, "").trim();
      }

      if (!prompt) return "  Provide a task prompt for the swarm.";

      const { runSwarm, runSwarmOnFiles, formatSwarmResult } = await import("../core/swarm");
      const cwd = appConfig.workingDirectory;

      if (fileGlob) {
        // Find matching files
        const { execSync } = await import("node:child_process");
        try {
          const filesRaw = execSync(
            `find . -type f -name '${fileGlob.replace(/'/g, "")}' -not -path '*/node_modules/*' -not -path '*/.git/*' | head -100`,
            { cwd, timeout: 5000 }
          ).toString().trim();

          const files = filesRaw ? filesRaw.split("\n").map(f => f.replace(/^\.\//, "")) : [];
          if (files.length === 0) return `  No files matching: ${fileGlob}`;

          const result = await runSwarmOnFiles(prompt, files, cwd, agentCount, appConfig.model);
          return formatSwarmResult(result);
        } catch (err: any) {
          return `  Error finding files: ${err.message}`;
        }
      }

      // No files specified — create N identical task agents
      const tasks = Array.from({ length: agentCount }, (_, i) =>
        `${prompt}\n\nYou are agent ${i + 1}/${agentCount}. Be concise.`
      );
      const result = await runSwarm(prompt, tasks, cwd, appConfig.model);
      return formatSwarmResult(result);
    }
    case "sandbox": {
      const { getSandboxCapabilities, getDefaultSandboxConfig } = await import("../core/sandbox");
      const arg = args?.trim() ?? "status";
      const caps = getSandboxCapabilities();
      const cwd = appConfig.workingDirectory;

      if (arg === "status") {
        const lines = [
          "  Sandbox Status\n",
          `  Platform:    ${process.platform}`,
          `  bwrap:       ${caps.bwrap ? "\u2713 available" : "\u2717 not found"}`,
          `  unshare:     ${caps.unshare ? "\u2713 available" : "\u2717 not found"}`,
          `  Supported:   ${caps.available ? "yes (Linux)" : process.platform === "linux" ? "install bubblewrap" : "Linux only"}`,
          "",
          "  Sandbox modes:",
          "    off    — No isolation (default)",
          "    light  — Restricted PATH, blocked dangerous commands",
          "    strict — bwrap namespace isolation (PID, IPC, optional NET)",
          "",
          "  Configure in .kcode/settings.json:",
          '    { "sandbox": { "mode": "light", "allowNetwork": true } }',
        ];
        return lines.join("\n");
      }

      if (arg === "on" || arg === "strict") {
        if (!caps.available) {
          return process.platform === "linux"
            ? "  Install bubblewrap for strict sandbox: sudo dnf install bubblewrap"
            : "  Sandbox requires Linux with bubblewrap.";
        }
        return "  Sandbox enabled. Set in .kcode/settings.json:\n  { \"sandbox\": { \"mode\": \"strict\" } }";
      }

      if (arg === "off" || arg === "light") {
        return `  Sandbox mode: ${arg}. Set in .kcode/settings.json:\n  { "sandbox": { "mode": "${arg}" } }`;
      }

      return "  Usage: /sandbox [status | on | off | strict | light]";
    }
    case "dry_run": {
      if (!args?.trim()) return "  Usage: /dry-run <description of changes>\n  Simulates changes and shows diffs without writing to disk.";

      // Inject a system instruction that forces read-only mode
      const dryPrompt = `[DRY RUN MODE] The user wants to preview what changes would be made WITHOUT actually modifying any files.

IMPORTANT RULES:
- Do NOT use Edit, Write, MultiEdit, or any file-modifying tools
- Instead, for each change you would make, show the file path and a unified diff of what would change
- Use Read and Grep to understand the current state, then describe the exact changes as diffs
- Format each proposed change as:
  --- a/<file>
  +++ b/<file>
  @@ ... @@
  (unified diff lines)
- At the end, provide a summary: N files would be modified, M lines added, K lines removed

Task to preview: ${args.trim()}`;

      // Return the prompt for the AI to process in the conversation
      return `__dry_run_prompt__${dryPrompt}`;
    }

    case "auto_fix": {
      const rawTarget = args?.trim() || "build";
      const target = rawTarget.toLowerCase();
      const cwd = appConfig.workingDirectory;
      const { execSync } = await import("node:child_process");

      // Determine the command to run
      const { existsSync } = await import("node:fs");
      const { join } = await import("node:path");
      let command: string;

      if (target === "build") {
        if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bunfig.toml"))) command = "bun run build";
        else if (existsSync(join(cwd, "package.json"))) command = "npm run build";
        else if (existsSync(join(cwd, "Cargo.toml"))) command = "cargo build";
        else if (existsSync(join(cwd, "go.mod"))) command = "go build ./...";
        else command = "make";
      } else if (target === "test") {
        if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bunfig.toml"))) command = "bun test";
        else if (existsSync(join(cwd, "package.json"))) command = "npm test";
        else if (existsSync(join(cwd, "pytest.ini")) || existsSync(join(cwd, "pyproject.toml"))) command = "pytest";
        else if (existsSync(join(cwd, "go.mod"))) command = "go test ./...";
        else if (existsSync(join(cwd, "Cargo.toml"))) command = "cargo test";
        else command = "npm test";
      } else {
        // Custom command — only allow safe characters (no shell metacharacters)
        if (/[;&|`$(){}!<>]/.test(rawTarget)) {
          return "  Error: Custom commands cannot contain shell metacharacters. Use /auto-fix build or /auto-fix test.";
        }
        command = rawTarget;
      }

      // Run the command and capture errors
      let stdout = "";
      let stderr = "";
      let exitCode = 0;

      try {
        stdout = execSync(command, { cwd, timeout: 60000, stdio: "pipe" }).toString();
        return `  /auto-fix: "${command}" passed successfully. No errors to fix.`;
      } catch (err: any) {
        exitCode = err.status ?? 1;
        stderr = err.stderr?.toString() ?? "";
        stdout = err.stdout?.toString() ?? "";
      }

      // Build error context for the AI
      const errorOutput = (stderr || stdout).trim();
      if (!errorOutput) {
        return `  /auto-fix: "${command}" failed with exit code ${exitCode} but produced no output. Cannot diagnose.`;
      }
      // Sanitize backtick sequences to prevent prompt injection via error output
      const sanitized = errorOutput.replace(/`{3,}/g, "~~~");
      const truncated = sanitized.length > 4000 ? sanitized.slice(-4000) : sanitized;

      const fixPrompt = `[AUTO-FIX] The command "${command}" failed with exit code ${exitCode}.

Error output (last ${truncated.length} chars):
\`\`\`
${truncated}
\`\`\`

INSTRUCTIONS:
1. Analyze the error output to identify the root cause
2. Read the failing file(s) mentioned in the errors
3. Apply the minimal fix needed to resolve the errors
4. After fixing, run "${command}" again to verify the fix works
5. If the fix introduces new errors, iterate until the command passes
6. Report what you fixed and why`;

      return `__auto_fix_prompt__${fixPrompt}`;
    }

    case "btw": {
      if (!args?.trim()) return "  Usage: /btw <question>\n  Asks a quick side question without adding to conversation history.";

      const { getModelBaseUrl } = await import("../core/models.js");
      const baseUrl = await getModelBaseUrl(appConfig.model, appConfig.apiBase) ?? appConfig.apiBase ?? "http://localhost:10091";

      try {
        const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(appConfig.apiKey ? { Authorization: `Bearer ${appConfig.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: appConfig.model,
            messages: [
              { role: "system", content: "You are a helpful assistant. Answer concisely in 1-3 sentences." },
              { role: "user", content: args.trim() },
            ],
            max_tokens: 1024,
            stream: false,
          }),
        });

        if (!resp.ok) return `  /btw error: ${resp.status} ${resp.statusText}`;

        const data = await resp.json() as any;
        const answer = data.choices?.[0]?.message?.content ?? "(no response)";
        return `  [btw] ${answer}`;
      } catch (err) {
        return `  /btw error: ${err instanceof Error ? err.message : err}`;
      }
    }

    case "suggest_files": {
      const description = args?.trim() || "the current task";
      const { execSync } = await import("node:child_process");
      const cwd = appConfig.workingDirectory;

      try {
        // Get git-tracked files, sorted by recency
        const filesRaw = execSync("git ls-files --full-name", { cwd, encoding: "utf-8", timeout: 5000 });
        const allFiles = filesRaw.trim().split("\n").filter(Boolean);

        if (allFiles.length === 0) return "  No files found (not a git repo or empty).";

        // Get recently modified files
        let recentFiles: string[] = [];
        try {
          const recent = execSync("git log --diff-filter=M --name-only --pretty=format: -20", { cwd, encoding: "utf-8", timeout: 5000 });
          recentFiles = [...new Set(recent.trim().split("\n").filter(Boolean))].slice(0, 10);
        } catch { /* ignore */ }

        // Use keyword matching from description to find relevant files
        const keywords = description.toLowerCase().split(/\s+/).filter(w => w.length > 1);
        const scored = allFiles.map(f => {
          const lower = f.toLowerCase();
          let score = 0;
          for (const kw of keywords) {
            if (lower.includes(kw)) score += 2;
          }
          if (recentFiles.includes(f)) score += 3;
          // Boost source files over configs/docs
          if (lower.match(/\.(ts|tsx|js|jsx|py|go|rs|swift|java|c|cpp|rb)$/)) score += 1;
          return { file: f, score };
        }).filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 15);

        if (scored.length === 0) {
          // Fall back to recently modified
          if (recentFiles.length > 0) {
            return [
              `  Suggested Files (recently modified):\n`,
              ...recentFiles.map(f => `    ${f}`),
            ].join("\n");
          }
          return "  No matching files found. Try a more specific description.";
        }

        return [
          `  Suggested Files for: "${description}"\n`,
          ...scored.map(s => `  ${s.score >= 4 ? "*" : " "} ${s.file}`),
          "",
          "  * = high relevance",
        ].join("\n");
      } catch (err) {
        return `  Error: ${err instanceof Error ? err.message : err}`;
      }
    }

    case "telemetry": {
      const { isTelemetryEnabled, setTelemetryEnabled } = await import("../core/analytics.js");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");

      const current = isTelemetryEnabled();
      const arg = args?.trim().toLowerCase();

      if (arg === "on" || arg === "enable" || arg === "true" || arg === "yes") {
        setTelemetryEnabled(true);
        const settingsPath = join(homedir(), ".kcode", "settings.json");
        try {
          const file = Bun.file(settingsPath);
          const existing = (await file.exists()) ? await file.json() : {};
          existing.telemetry = true;
          await Bun.write(settingsPath, JSON.stringify(existing, null, 2) + "\n");
        } catch { /* ignore write errors */ }
        return "  Telemetry enabled. Anonymous tool usage analytics will be recorded locally.";
      }

      if (arg === "off" || arg === "disable" || arg === "false" || arg === "no") {
        setTelemetryEnabled(false);
        const settingsPath = join(homedir(), ".kcode", "settings.json");
        try {
          const file = Bun.file(settingsPath);
          const existing = (await file.exists()) ? await file.json() : {};
          existing.telemetry = false;
          await Bun.write(settingsPath, JSON.stringify(existing, null, 2) + "\n");
        } catch { /* ignore write errors */ }
        return "  Telemetry disabled. No analytics will be recorded.";
      }

      const status = current === true ? "enabled" : current === false ? "disabled" : "not set (disabled by default)";
      return [
        `  Telemetry Status: ${status}`,
        ``,
        `  KCode collects anonymous tool usage analytics stored locally`,
        `  in ~/.kcode/awareness.db. Data is never sent externally.`,
        ``,
        `  Usage: /telemetry on   \u2014 enable local analytics`,
        `         /telemetry off  \u2014 disable local analytics`,
      ].join("\n");
    }

    case "rename": {
      // Handled specially in processMessage since it needs setSessionName
      return `__rename__${args?.trim() ?? ""}`;
    }

    case "style": {
      const { getCurrentStyle, setCurrentStyle, listStyles } = await import("../core/output-styles.js");
      const styleName = args?.trim();

      if (!styleName) {
        // Show current style and list available styles
        const current = getCurrentStyle();
        const available = listStyles();
        const lines = [`  Current style: ${current}`, "", "  Available styles:"];
        for (const name of available) {
          const marker = name === current ? " (active)" : "";
          lines.push(`    ${name}${marker}`);
        }
        lines.push("", "  Usage: /style <name>");
        return lines.join("\n");
      }

      if (setCurrentStyle(styleName)) {
        return `  Output style switched to: ${styleName}`;
      }

      const available = listStyles();
      return `  Unknown style "${styleName}". Available: ${available.join(", ")}`;
    }

    case "profile": {
      const { getAnalyticsSummary } = await import("../core/analytics.js");
      const summary = getAnalyticsSummary(365);

      const errorRate = summary.totalToolCalls > 0
        ? ((summary.totalErrors / summary.totalToolCalls) * 100).toFixed(1)
        : "0.0";

      const topTools = summary.toolBreakdown.slice(0, 5);
      const topModel = summary.modelBreakdown[0];

      const lines = [
        `  User Profile`,
        `  ${"─".repeat(40)}`,
        ``,
        `  Total Sessions:    ${summary.totalSessions}`,
        `  Total Tool Calls:  ${summary.totalToolCalls}`,
        `  Error Rate:        ${errorRate}%`,
        `  Total Tokens:      ${(summary.totalInputTokens + summary.totalOutputTokens).toLocaleString()}`,
        `  Total Cost:        $${summary.totalCostUsd.toFixed(4)}`,
        ``,
      ];

      if (topModel) {
        lines.push(`  Favorite Model:    ${topModel.model} (${topModel.calls} calls)`);
        lines.push(``);
      }

      if (topTools.length > 0) {
        lines.push(`  Top 5 Tools:`);
        const maxNameLen = Math.max(...topTools.map(t => t.tool.length));
        for (const t of topTools) {
          const bar = "\u2588".repeat(Math.max(1, Math.round((t.count / topTools[0].count) * 20)));
          lines.push(`    ${t.tool.padEnd(maxNameLen + 2)}${bar} ${t.count} calls (${t.avgMs}ms avg)`);
        }
      }

      lines.push(`  ${"─".repeat(40)}`);
      return lines.join("\n");
    }

    case "session_tags": {
      // Handled specially in processMessage since it needs setSessionTags
      return `__session_tags__${args?.trim() ?? ""}`;
    }

    case "auto_compact": {
      const trimmed = args?.trim() ?? "";

      if (!trimmed) {
        const current = conversationManager.getCompactThreshold();
        if (current <= 0) {
          return `  Auto-compaction: OFF`;
        }
        return `  Auto-compaction threshold: ${Math.round(current * 100)}% of context window`;
      }

      if (trimmed === "off" || trimmed === "disable" || trimmed === "0") {
        conversationManager.setCompactThreshold(0);
        return `  Auto-compaction: OFF`;
      }

      const pct = parseInt(trimmed);
      if (isNaN(pct) || pct < 10 || pct > 99) {
        return `  Invalid threshold. Use a number between 10-99, or 'off'.`;
      }

      conversationManager.setCompactThreshold(pct / 100);
      return `  Auto-compaction threshold set to ${pct}% of context window.`;
    }

    case "mcp": {
      const { getMcpManager } = await import("../core/mcp");
      const manager = getMcpManager();
      const parts = (args ?? "").trim().split(/\s+/);
      const subCmd = parts[0] ?? "list";

      if (subCmd === "list" || subCmd === "") {
        const status = manager.getServerStatus();
        if (status.length === 0) {
          return "  No MCP servers connected.\n  Use /mcp add <name> <command> to add one.";
        }
        const lines = status.map((s) => {
          const icon = s.alive ? "\x1b[32m●\x1b[0m" : "\x1b[31m●\x1b[0m";
          const state = s.alive ? "connected" : "disconnected";
          return `  ${icon} ${s.name} — ${state} (${s.toolCount} tools)`;
        });
        return `  MCP Servers:\n${lines.join("\n")}`;
      }

      if (subCmd === "tools") {
        const tools = manager.discoverTools();
        if (tools.length === 0) return "  No MCP tools discovered.";
        const lines = tools.map((t) => `  ${t.name}\n    ${(t.description ?? "").slice(0, 100)}`);
        return `  MCP Tools (${tools.length}):\n${lines.join("\n")}`;
      }

      if (subCmd === "add") {
        const name = parts[1];
        const command = parts[2];
        if (!name || !command) return "  Usage: /mcp add <name> <command> [args...]";
        const serverArgs = parts.slice(3);
        try {
          await manager.addServer(name, { command, args: serverArgs.length > 0 ? serverArgs : undefined });
          // Re-register MCP tools so newly added server's tools are available
          manager.registerTools(tools);
          const toolCount = tools.getToolNames().filter((n: string) => n.startsWith(`mcp__${name}__`)).length;
          return `  Added MCP server "${name}" (${command}${serverArgs.length > 0 ? " " + serverArgs.join(" ") : ""}), registered ${toolCount} tool(s)`;
        } catch (err) {
          return `  Error adding MCP server: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      if (subCmd === "remove" || subCmd === "rm") {
        const name = parts[1];
        if (!name) return "  Usage: /mcp remove <name>";
        const removed = manager.removeServer(name);
        return removed
          ? `  Removed MCP server "${name}"`
          : `  MCP server "${name}" not found`;
      }

      if (subCmd === "auth") {
        const serverName = parts[1];
        if (!serverName) return "  Usage: /mcp auth <server-name>\n  Starts OAuth 2.0 flow for the specified MCP server.";

        const status = manager.getServerStatus();
        const serverInfo = status.find(s => s.name === serverName);
        if (!serverInfo) return `  MCP server "${serverName}" not found. Run /mcp list to see available servers.`;

        try {
          const { McpOAuthClient, discoverOAuthConfig } = await import("../core/mcp-oauth");

          // Try to get OAuth config from server settings
          const { join } = await import("node:path");
          const { homedir } = await import("node:os");
          const settingsPath = join(homedir(), ".kcode", "settings.json");
          let oauthConfig = null;
          try {
            const file = Bun.file(settingsPath);
            if (await file.exists()) {
              const settings = await file.json();
              const serverConfig = settings?.mcpServers?.[serverName];
              if (serverConfig?.oauth) {
                oauthConfig = serverConfig.oauth;
              } else if (serverConfig?.url) {
                // Try auto-discovery
                oauthConfig = await discoverOAuthConfig(serverConfig.url);
              }
            }
          } catch {}

          if (!oauthConfig || !oauthConfig.clientId) {
            return `  No OAuth config for "${serverName}".\n  Add oauth settings to ~/.kcode/settings.json:\n  {\n    "mcpServers": {\n      "${serverName}": {\n        "url": "https://...",\n        "oauth": {\n          "clientId": "YOUR_CLIENT_ID",\n          "authorizationUrl": "https://provider/authorize",\n          "tokenUrl": "https://provider/token"\n        }\n      }\n    }\n  }`;
          }

          const client = new McpOAuthClient(serverName, oauthConfig);
          const { url, port, waitForCallback } = await client.startAuthFlow();

          // Try to open browser
          try {
            const { execFileSync: execSync } = await import("node:child_process");
            const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
            execSync(openCmd, [url], { stdio: "pipe", timeout: 5000 });
          } catch {
            // Browser open failed, user can copy the URL
          }

          // Non-blocking — the callback will store tokens
          waitForCallback().then(() => {
            log.info("mcp", `OAuth authentication successful for "${serverName}"`);
          }).catch((err) => {
            log.warn("mcp", `OAuth authentication failed for "${serverName}": ${err instanceof Error ? err.message : String(err)}`);
          });

          return `  OAuth flow started for "${serverName}".\n  Open this URL in your browser:\n  ${url}\n\n  Callback listening on port ${port}...`;
        } catch (err) {
          return `  OAuth error: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      return `  Unknown subcommand: ${subCmd}\n  Usage: /mcp [list | tools | add <name> <command> | remove <name> | auth <name>]`;
    }

    case "agents": {
      const { listAllAgents, findCustomAgent } = await import("../core/custom-agents");
      const name = (args ?? "").trim();

      if (name) {
        const agent = findCustomAgent(name, process.cwd());
        if (!agent) return `  Agent "${name}" not found.`;
        const lines = [
          `  \x1b[1m${agent.name}\x1b[0m — ${agent.description}`,
          `  Source: ${agent.sourcePath}`,
        ];
        if (agent.model) lines.push(`  Model: ${agent.model}`);
        if (agent.effort) lines.push(`  Effort: ${agent.effort}`);
        if (agent.permissionMode) lines.push(`  Permission: ${agent.permissionMode}`);
        if (agent.maxTurns) lines.push(`  Max turns: ${agent.maxTurns}`);
        if (agent.tools) lines.push(`  Tools: ${agent.tools.join(", ")}`);
        if (agent.disallowedTools) lines.push(`  Disallowed: ${agent.disallowedTools.join(", ")}`);
        if (agent.skills) lines.push(`  Skills: ${agent.skills.join(", ")}`);
        if (agent.mcpServers) lines.push(`  MCP servers: ${Object.keys(agent.mcpServers).join(", ")}`);
        if (agent.hooks) lines.push(`  Hooks: ${agent.hooks.length} configured`);
        if (agent.memory) lines.push(`  Memory: enabled`);
        if (agent.apiBase) lines.push(`  API base: ${agent.apiBase}`);
        if (agent.apiKey) lines.push(`  API key: ****${agent.apiKey.slice(-4)}`);
        if (agent.systemPrompt) lines.push(`  System prompt: ${agent.systemPrompt.slice(0, 80)}${agent.systemPrompt.length > 80 ? "..." : ""}`);
        return lines.join("\n");
      }

      const all = listAllAgents(process.cwd());
      if (all.length === 0) {
        return "  No custom agents defined.\n  Create .md files in ~/.kcode/agents/ or .kcode/agents/ with YAML frontmatter.";
      }
      const lines = all.map((a) => {
        const flags: string[] = [];
        if (a.model) flags.push(a.model);
        if (a.effort) flags.push(a.effort);
        if (a.memory) flags.push("memory");
        if (a.mcpServers) flags.push(`${Object.keys(a.mcpServers).length} mcp`);
        const flagStr = flags.length > 0 ? ` (${flags.join(", ")})` : "";
        return `  \x1b[36m${a.name}\x1b[0m — ${a.description}${flagStr}`;
      });
      return `  ${all.length} agent(s) available:\n${lines.join("\n")}`;
    }

    default: {
      return `  Unknown built-in action: ${action}`;
    }
  }
}
