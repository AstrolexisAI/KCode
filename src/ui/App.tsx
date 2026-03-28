// KCode - Main Ink application component
// Top-level component managing conversation flow and rendering

import React, { useState, useCallback, useRef } from "react";
import { Box, Text, useApp } from "ink";
import type { ConversationManager } from "../core/conversation.js";
import type { KCodeConfig } from "../core/types.js";
import type { ToolRegistry } from "../core/tool-registry.js";
import { SkillManager } from "../core/skills.js";
import { useTheme } from "./ThemeContext.js";

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

import { useKeyBindings } from "./hooks/useKeyBindings.js";
import { useAppEffects } from "./hooks/useAppEffects.js";
import { useMessageProcessor } from "./hooks/useMessageProcessor.js";
import type { TabInfo } from "./stream-handler.js";

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
  const [activeTabs, setActiveTabs] = useState<Array<TabInfo>>([]);
  const [bashStreamOutput, setBashStreamOutput] = useState("");
  const tabRemovalTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const [selectedTabIndex, setSelectedTabIndex] = useState(0);
  const [sessionStart] = useState(() => Date.now());
  const [sessionNotes, setSessionNotes] = useState<Array<{ time: string; text: string }>>([]);
  const [watcherSuggestions, setWatcherSuggestions] = useState<string[]>([]);
  const [sessionName, setSessionName] = useState<string>(initialSessionName ?? "");
  const [sessionTags, setSessionTags] = useState<string[]>([]);
  const [showContextGrid, setShowContextGrid] = useState(false);
  const [lastKodiEvent, setLastKodiEvent] = useState<KodiEvent | null>(null);

  // Message queue — user can type while KCode is responding
  const [messageQueue, setMessageQueue] = useState<string[]>([]);

  // Permission dialog state
  const [permissionRequest, setPermissionRequest] = useState<PermissionRequest | null>(null);
  const [permissionResolver, setPermissionResolver] = useState<
    ((choice: PermissionChoice) => void) | null
  >(null);

  // Sudo password prompt state
  const [sudoPasswordResolver, setSudoPasswordResolver] = useState<
    ((password: string | null) => void) | null
  >(null);

  // --- Hooks ---

  // Lifecycle effects: permission/sudo wiring, trust callbacks, file watcher, tab cleanup
  useAppEffects({
    conversationManager,
    workingDirectory: config.workingDirectory,
    tabRemovalTimers,
    setMode,
    setCompleted,
    setPermissionRequest,
    setPermissionResolver,
    setSudoPasswordResolver,
    setWatcherSuggestions,
  });

  // Message processing: slash commands, LLM sending, queue draining
  const { handleSubmit, messageQueueRef } = useMessageProcessor({
    config, conversationManager, tools, skillManager,
    mode, sessionStart, sessionNotes, sessionName, sessionTags,
    tabRemovalTimers, switchTheme, exit,
    setMode, setCompleted, setStreamingText, setStreamingThinking,
    setIsThinking, setLoadingMessage, setTokenCount, setTurnTokens,
    setTurnStartTime, setSpinnerPhase, setToolUseCount, setRunningAgentCount,
    setActiveTabs, setBashStreamOutput, setSessionNotes, setSessionName,
    setSessionTags, setWatcherSuggestions, setShowContextGrid, setMessageQueue,
    setLastKodiEvent,
  });

  // Global keyboard shortcuts (Escape, Alt+T, Ctrl+C, Shift+Tab)
  useKeyBindings({
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
  });

  // --- Handlers ---

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
        activeProfile={config.activeProfile}
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
