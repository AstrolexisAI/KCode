// KCode - Main Ink application component
// Top-level component managing conversation flow and rendering

import React, { useState, useCallback, useRef, useEffect } from "react";
import { Box, Text, useInput, useApp } from "ink";
import type { ConversationManager } from "../core/conversation.js";
import type { KCodeConfig, StreamEvent, PermissionMode } from "../core/types.js";
import type { ToolRegistry } from "../core/tool-registry.js";
import { SkillManager } from "../core/skills.js";
import { useTheme } from "./ThemeContext.js";
import { handleBuiltinAction } from "./builtin-actions.js";
import { processStreamEvents } from "./stream-handler.js";
import type { TabInfo } from "./stream-handler.js";

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
import SudoPasswordPrompt from "./components/SudoPasswordPrompt.js";
import ContextGrid from "./components/ContextGrid.js";
import CloudMenu, { type CloudResult } from "./components/CloudMenu.js";
import ModelToggle, { type ModelToggleResult } from "./components/ModelToggle.js";

interface AppProps {
  config: KCodeConfig;
  conversationManager: ConversationManager;
  tools: ToolRegistry;
  initialSessionName?: string;
}

type AppMode = "input" | "responding" | "permission" | "sudo-password" | "cloud" | "toggle";

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
  useEffect(() => {
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
    return () => { conversationManager.getPermissions().setPromptFn(undefined); };
  }, [conversationManager]);

  // Sudo password prompt state
  const [sudoPasswordResolver, setSudoPasswordResolver] = useState<
    ((password: string | null) => void) | null
  >(null);

  // Wire up sudo password prompt callback so Bash tool can ask for password
  useEffect(() => {
    conversationManager.setSudoPasswordPromptFn(async () => {
      return new Promise<string | null>((resolve) => {
        setMode("sudo-password");
        setSudoPasswordResolver(() => (password: string | null) => {
          resolve(password);
        });
      });
    });
    return () => { conversationManager.setSudoPasswordPromptFn(undefined); };
  }, [conversationManager]);

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
      const budgetLabel = config.reasoningBudget === -1 ? "unlimited" : config.reasoningBudget !== undefined ? `${config.reasoningBudget} tokens` : "default";
      setCompleted((prev) => [
        ...prev,
        { kind: "text", role: "assistant", text: `  Thinking mode: ${config.thinking ? `ON (budget: ${budgetLabel})` : "OFF"}` },
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
        try {
          commandDepthRef.current = 1; // mark as inside chain (not incrementing per iteration)
          for (const cmd of commands) {
            await processMessage(cmd.trim());
          }
        } finally {
          commandDepthRef.current = 0;
        }
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
      await processStreamEvents(events, {
        config, conversationManager, tabRemovalTimers,
        setLoadingMessage, setLastKodiEvent, setIsThinking,
        setStreamingThinking, setCompleted, setStreamingText,
        setToolUseCount, setBashStreamOutput, setActiveTabs,
        setTokenCount, setTurnTokens, setSpinnerPhase,
        setRunningAgentCount, setWatcherSuggestions,
      });
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

  const handleSudoPassword = useCallback(
    (password: string | null) => {
      if (sudoPasswordResolver) {
        sudoPasswordResolver(password);
        setSudoPasswordResolver(null);
        setMode("responding");
      }
    },
    [sudoPasswordResolver],
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

        {mode === "sudo-password" && (
          <SudoPasswordPrompt
            onSubmit={handleSudoPassword}
            isActive={mode === "sudo-password"}
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
        isActive={mode !== "permission" && mode !== "sudo-password" && mode !== "cloud" && mode !== "toggle"}
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

