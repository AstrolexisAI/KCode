// KCode - Main Ink application component
// Top-level component managing conversation flow and rendering

import { Box, Text, useApp } from "ink";
import React, { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationManager } from "../core/conversation.js";
import { getRateLimitUsage } from "../core/request-builder.js";
import { SkillManager } from "../core/skills.js";
import { getSubscription, type SubscriptionTier } from "../core/subscription.js";
import { CHARS_PER_TOKEN } from "../core/token-budget.js";
import type { ToolRegistry } from "../core/tool-registry.js";
import type { KCodeConfig } from "../core/types.js";
import { getActivePlan, loadLatestPlan, onPlanChange, type Plan } from "../tools/plan.js";
import ActivePlanPanel from "./components/ActivePlanPanel.js";
import AgentPanel from "./components/AgentPanel.js";
import CloudMenu, { type CloudResult } from "./components/CloudMenu.js";
import ContextGrid from "./components/ContextGrid.js";
import EscalationPrompt from "./components/EscalationPrompt.js";
import Header from "./components/Header.js";
import InputPrompt from "./components/InputPrompt.js";
import InteractiveQuestion from "./components/InteractiveQuestion.js";
import { KeybindingProvider } from "./components/KeybindingContext.js";
import KodiCompanion, { type KodiEvent } from "./components/Kodi.js";
import KodiAdvisorMenu, { type KodiAdvisorMenuResult } from "./components/KodiAdvisorMenu.js";
import MessageList, { type MessageEntry } from "./components/MessageList.js";
import ModelToggle, { type ModelToggleResult } from "./components/ModelToggle.js";
import PermissionDialog, {
  type PermissionChoice,
  type PermissionRequest,
} from "./components/PermissionDialog.js";
import QuestionDialog from "./components/QuestionDialog.js";
import Spinner from "./components/Spinner.js";
import SudoPasswordPrompt from "./components/SudoPasswordPrompt.js";
import ToolTabs from "./components/ToolTabs.js";
import VirtualMessageList from "./components/VirtualMessageList.js";
import { useAppEffects } from "./hooks/useAppEffects.js";
import { useKeyBindings } from "./hooks/useKeyBindings.js";
import { useMessageProcessor } from "./hooks/useMessageProcessor.js";
import type { TabInfo } from "./stream-handler.js";
import { useTheme } from "./ThemeContext.js";

interface AppProps {
  config: KCodeConfig;
  conversationManager: ConversationManager;
  tools: ToolRegistry;
  initialSessionName?: string;
}

type AppMode =
  | "input"
  | "responding"
  | "permission"
  | "sudo-password"
  | "cloud"
  | "toggle"
  | "kodi-advisor"
  | "escalation";

export default function App({ config, conversationManager, tools, initialSessionName }: AppProps) {
  const { exit } = useApp();
  const { theme, switchTheme } = useTheme();
  // Skills manager - created once per component instance
  const [skillManager] = useState(() => {
    const sm = new SkillManager(config.workingDirectory);
    sm.load();
    return sm;
  });

  // Auto-discover new cloud models on TUI startup. Fires in the
  // background so it never blocks the UI mount — a 6-hour throttle
  // inside maybeAutoDiscover prevents hammering provider APIs across
  // back-to-back kcode launches. New models (e.g. Opus 4.7 the day it
  // ships) land in ~/.kcode/models.json and become available in the
  // `/model` switcher after the next kcode restart.
  useEffect(() => {
    void (async () => {
      try {
        const { maybeAutoDiscover } = await import("../core/model-discovery.js");
        await maybeAutoDiscover();
      } catch {
        // Best-effort: never surface discovery failures to the user.
      }
    })();
  }, []);

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
    names.add("/auth");
    names.add("/cloud");
    names.add("/api-key");
    names.add("/provider");
    names.add("/toggle");
    names.add("/model");
    names.add("/switch");
    names.add("/license");
    names.add("/login");
    names.add("/logout");
    names.add("/kodi-advisor");
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
    descs["/auth"] = "OAuth login/status/logout for cloud AI providers (Anthropic, OpenAI, Gemini)";
    descs["/cloud"] = "Configure cloud API providers (Anthropic, OpenAI, Gemini, etc.)";
    descs["/api-key"] = "Configure cloud API providers";
    descs["/provider"] = "Configure cloud API providers";
    descs["/toggle"] = "Switch between local and cloud models";
    descs["/model"] = "Switch between local and cloud models";
    descs["/switch"] = "Switch between local and cloud models";
    descs["/license"] = "Show license status or activate a license";
    descs["/login"] = "Log in to Astrolexis (opens browser — PKCE OAuth)";
    descs["/logout"] = "Log out of Astrolexis and clear cached subscription";
    descs["/kodi-advisor"] = "Manage the Kodi Advisor model (download/start/stop/delete)";
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
  // Running USD cost for the current session. Updated after every turn
  // by looking up the active model's pricing and applying it to the
  // cumulative input/output token counts from conversationManager.
  // For local models (mark5/mark6, no pricing entry) this stays at 0.
  const [sessionCostUsd, setSessionCostUsd] = useState(0);
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

  // Subscription tier — fetched once at mount so Kodi can render the
  // tier badge, trigger the entrance flex, and gate tier-aware
  // speech. Refreshes silently in the background every 15 min in case
  // the user upgrades mid-session. Runs against the 1h memory/disk
  // cache inside getSubscription(), so the cost is at most one
  // /api/subscription HTTP call per quarter hour.
  const [subscriptionTier, setSubscriptionTier] = useState<SubscriptionTier | undefined>(undefined);
  const [subscriptionFeatures, setSubscriptionFeatures] = useState<string[] | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const sub = await getSubscription();
        if (cancelled) return;
        setSubscriptionTier(sub.tier);
        setSubscriptionFeatures(sub.features);
      } catch {
        // Not logged in / offline / no cache → fall through to free
        // without surfacing an error in the UI.
      }
    };
    load();
    const interval = setInterval(load, 15 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // Kodi advisor first-run prompt. Enterprise users get asked once,
  // the first time they start the TUI, whether they want the Kodi
  // Advisor model downloaded. A decline (`n` in the menu) writes
  // kodiAdvisor.declined = true and we never ask again until they
  // run `/kodi-advisor reset`. Users on any other tier never see
  // the prompt — the current deterministic Kodi stays as-is.
  const [firstRunKodiAdvisor, setFirstRunKodiAdvisor] = useState(false);
  useEffect(() => {
    if (subscriptionTier !== "enterprise") return;
    let cancelled = false;
    (async () => {
      try {
        const { loadUserSettingsRaw } = await import("../core/config.js");
        const { getInstalledKodiCandidate } = await import("../core/kodi-model.js");
        const raw = await loadUserSettingsRaw();
        const advisor = (raw.kodiAdvisor ?? {}) as { declined?: boolean; modelId?: string };
        const alreadyDeclined = Boolean(advisor.declined);
        const alreadyInstalled = Boolean(getInstalledKodiCandidate());
        if (cancelled) return;
        if (!alreadyDeclined && !alreadyInstalled) {
          setFirstRunKodiAdvisor(true);
          setMode("kodi-advisor");
        }
      } catch {
        // Settings read failure shouldn't block the UI.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [subscriptionTier]);

  const handleKodiAdvisorMenuDone = useCallback(async (result: KodiAdvisorMenuResult) => {
    setMode("input");
    setFirstRunKodiAdvisor(false);
    if (result.action === "declined") {
      try {
        const { loadUserSettingsRaw, saveUserSettingsRaw } = await import("../core/config.js");
        const raw = await loadUserSettingsRaw();
        const advisor = (raw.kodiAdvisor ?? {}) as Record<string, unknown>;
        raw.kodiAdvisor = { ...advisor, declined: true };
        saveUserSettingsRaw(raw);
      } catch {
        /* best effort */
      }
    } else if (result.action === "downloaded") {
      try {
        const { loadUserSettingsRaw, saveUserSettingsRaw } = await import("../core/config.js");
        const raw = await loadUserSettingsRaw();
        const advisor = (raw.kodiAdvisor ?? {}) as Record<string, unknown>;
        raw.kodiAdvisor = {
          ...advisor,
          modelId: result.candidateId,
          declined: false,
        };
        saveUserSettingsRaw(raw);
      } catch {
        /* best effort */
      }
    }
  }, []);

  const [watcherSuggestions, setWatcherSuggestions] = useState<string[]>([]);
  const [sessionName, setSessionName] = useState<string>(initialSessionName ?? "");
  const [sessionTags, setSessionTags] = useState<string[]>([]);

  // Engine creation progress (polled from global engineState)
  const [engineProgress, setEngineProgress] = useState<{
    active: boolean;
    phase: string;
    step: number;
    totalSteps: number;
    siteType: string;
    startTime: number;
  } | null>(null);

  // Background scan progress (polled from global scanState)
  const [scanProgress, setScanProgress] = useState<{
    active: boolean;
    phase: string;
    verified: number;
    total: number;
    confirmed: number;
    elapsed: number;
    cancelled: boolean;
  } | null>(null);
  const [escalationData, setEscalationData] = useState<{
    count: number;
    reason: string;
    availableModels: Array<{ name: string; provider: string; tags: string[] }>;
  } | null>(null);
  const [showContextGrid, setShowContextGrid] = useState(false);
  const [lastKodiEvent, setLastKodiEvent] = useState<KodiEvent | null>(null);
  // Plan panel: starts null, only set by onPlanChange (not from DB restore)
  const [activePlan, setActivePlan] = useState<Plan | null>(null);

  // Wire auto-agent progress to Kodi panel
  useEffect(() => {
    conversationManager.onAgentProgress = (statuses) => {
      setLastKodiEvent({
        type: statuses.some((a) => a.status === "running") ? "agent_progress" : "agent_done",
        detail: `${statuses.filter((a) => a.status === "done").length}/${statuses.length} done`,
        agentStatuses: statuses.map((a) => ({
          name: a.name,
          stepTitle: a.stepTitle,
          status: a.status,
          durationMs: a.durationMs,
        })),
      });
    };
    return () => {
      conversationManager.onAgentProgress = null;
    };
  }, [conversationManager]);

  // Virtual scroll feature flag — set via KCODE_VIRTUAL_SCROLL=1 env var
  const [useVirtualScrollEnabled] = useState(() => process.env.KCODE_VIRTUAL_SCROLL === "1");

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

  // Only show plans that are explicitly created/updated during this session.
  // Do NOT read from getActivePlan() on mount — that contains DB-restored
  // plans from previous sessions. Only react to onPlanChange events.
  // Auto-close the plan panel when all steps reach "done" status.
  useEffect(() => {
    return onPlanChange((plan) => {
      if (plan && plan.steps.length > 0 && plan.steps.every((s) => s.status === "done")) {
        // All steps completed — clear the plan automatically
        setActivePlan(null);
      } else {
        setActivePlan(plan);
      }
    });
  }, []);

  // Per-model session breakdown — aggregated from TurnCostEntry.model
  const [sessionModelBreakdown, setSessionModelBreakdown] = useState<
    Array<{
      model: string;
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
      turns: number;
    }>
  >([]);

  // Recompute running USD cost + per-model breakdown whenever token count changes.
  // recordTurnCost already has the correct price for each turn, so
  // summing `costUsd` across turnCosts gives the real session spend.
  // Local models store costUsd=0 — they contribute nothing.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const turnCosts = conversationManager.getTurnCosts();
        if (cancelled) return;
        const total = turnCosts.reduce((sum, t) => sum + (t.costUsd ?? 0), 0);
        setSessionCostUsd(total);

        // Per-model aggregation
        const byModel = new Map<
          string,
          { inputTokens: number; outputTokens: number; costUsd: number; turns: number }
        >();
        for (const t of turnCosts) {
          if (!t.model) continue;
          // Include local models (costUsd=0) so they appear in mini-Kodi team
          // Mark them as "local" provider for display purposes
          const existing = byModel.get(t.model) ?? {
            inputTokens: 0,
            outputTokens: 0,
            costUsd: 0,
            turns: 0,
          };
          byModel.set(t.model, {
            inputTokens: existing.inputTokens + (t.inputTokens ?? 0),
            outputTokens: existing.outputTokens + (t.outputTokens ?? 0),
            costUsd: existing.costUsd + (t.costUsd ?? 0),
            turns: existing.turns + 1,
          });
        }
        const breakdown = [...byModel.entries()]
          .map(([model, v]) => ({ model, ...v }))
          .sort((a, b) => b.costUsd - a.costUsd);
        setSessionModelBreakdown(breakdown);
      } catch {
        // Silent — if anything fails, show 0 rather than crash.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tokenCount, config.model, conversationManager]);

  // Poll background scan progress (scanState is mutated by the /scan handler)
  useEffect(() => {
    const timer = setInterval(async () => {
      try {
        const { scanState } = await import("../core/audit-engine/scan-state.js");
        if (scanState.active || scanState.result || scanState.error) {
          setScanProgress({
            active: scanState.active,
            phase: scanState.phase,
            verified: scanState.verified,
            total: scanState.total,
            confirmed: scanState.confirmed,
            elapsed: (Date.now() - scanState.startTime) / 1000,
            cancelled: scanState.cancelled === true,
          });
          // Switch to escalation mode when prompt is pending
          if (scanState.pendingEscalation && !escalationData) {
            setEscalationData({
              count: scanState.pendingEscalation.count,
              reason: scanState.pendingEscalation.reason,
              availableModels: scanState.pendingEscalation.availableModels,
            });
            setMode("escalation");
            setLastKodiEvent({ type: "agent_spawn", detail: "☁ second opinion?" });
          }
          if (scanState.escalated > 0) {
            setLastKodiEvent({
              type: "agent_progress",
              detail: `☁ ${scanState.escalated} escalated`,
            });
          }

          if (!scanState.active && scanState.result) {
            const reportText = scanState.result.reportText;
            setCompleted((prev) => [
              ...prev,
              { kind: "text", role: "assistant", text: reportText },
            ]);
            scanState.result = undefined;
            setScanProgress(null);
          }
          if (!scanState.active && scanState.error) {
            setCompleted((prev) => [
              ...prev,
              { kind: "text", role: "assistant", text: `  ✗ Scan error: ${scanState.error}` },
            ]);
            scanState.error = undefined;
            setScanProgress(null);
          }
        } else if (scanProgress !== null) {
          setScanProgress(null);
        }
      } catch {
        /* scan-state module not loaded */
      }

      // Also poll PR generation state
      try {
        const { prState } = await import("../core/audit-engine/pr-state.js");
        if (prState.active) {
          setScanProgress({
            active: true,
            phase: `PR: ${prState.step}`,
            verified: 0,
            total: 0,
            confirmed: 0,
            elapsed: (Date.now() - prState.startTime) / 1000,
            cancelled: false,
          });
        } else if (prState.result) {
          // Capture before clearing to avoid race with React render
          const text = prState.result.prDescription;
          prState.result = undefined;
          setScanProgress(null);
          if (text) {
            setCompleted((prev) => [...prev, { kind: "text", role: "assistant", text }]);
          }
        } else if (prState.error) {
          const errMsg = prState.error;
          prState.error = undefined;
          setScanProgress(null);
          setCompleted((prev) => [
            ...prev,
            { kind: "text", role: "assistant", text: `  ✗ PR error: ${errMsg}` },
          ]);
        }
      } catch {
        /* pr-state module not loaded */
      }
    }, 200);
    return () => clearInterval(timer);
  }, [scanProgress]);

  // Poll engine creation progress
  useEffect(() => {
    const timer = setInterval(async () => {
      try {
        const { engineState } = await import("../core/engine-progress.js");
        if (engineState.active) {
          setEngineProgress({
            active: engineState.active,
            phase: engineState.phase,
            step: engineState.step,
            totalSteps: engineState.totalSteps,
            siteType: engineState.siteType,
            startTime: engineState.startTime,
          });
        } else if (engineProgress?.active) {
          setEngineProgress(null);
        }
      } catch {
        /* not loaded */
      }
    }, 150);
    return () => clearInterval(timer);
  }, [engineProgress]);

  // Terminal tab title — professional block-progress indicator
  useEffect(() => {
    const isWorking =
      mode === "responding" || (scanProgress?.active ?? false) || mode === "escalation";

    if (isWorking) {
      const frames = [
        "▰▱▱▱ KCode",
        "▰▰▱▱ KCode",
        "▰▰▰▱ KCode",
        "▰▰▰▰ KCode",
        "▱▰▰▰ KCode",
        "▱▱▰▰ KCode",
        "▱▱▱▰ KCode",
        "▱▱▱▱ KCode",
      ];
      let frame = 0;
      const timer = setInterval(() => {
        process.stdout.write(`\x1b]0;${frames[frame % frames.length]}\x07`);
        frame++;
      }, 250);
      return () => {
        clearInterval(timer);
        process.stdout.write(`\x1b]0;▪ KCode\x07`);
      };
    }
    process.stdout.write(`\x1b]0;▪ KCode\x07`);
  }, [mode, scanProgress?.active]);

  // Ask user if they want to resume the previous session's model.
  // Smart flow: only ask ONCE. If user already confirmed this model
  // in a previous session, auto-switch without asking.
  const [pendingLastModel, setPendingLastModel] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const { loadUserSettingsRaw } = await import("../core/config.js");
        const settings = await loadUserSettingsRaw();
        const lastModel = settings.lastSessionModel as string | undefined;
        const confirmedModel = settings.confirmedModel as string | undefined;

        if (!lastModel || lastModel === config.model) return;

        // If user previously confirmed this model, auto-switch silently
        if (lastModel === confirmedModel) {
          const prevModel = config.model;
          config.model = lastModel;
          config.modelExplicitlySet = true;
          conversationManager.getConfig().model = lastModel;
          conversationManager.getConfig().modelExplicitlySet = true;
          const { getModelContextSize } = await import("../core/models.js");
          const ctxSize = await getModelContextSize(lastModel);
          if (ctxSize) {
            config.contextWindowSize = ctxSize;
            conversationManager.getConfig().contextWindowSize = ctxSize;
          }
          // Fire ModelSwitch hook for the restored preference
          try {
            conversationManager.getHooks().fireAndForget("ModelSwitch", {
              previousModel: prevModel,
              newModel: lastModel,
              trigger: "saved-preference",
            });
          } catch {
            /* non-fatal */
          }
          setCompleted((prev) => [
            ...prev,
            { kind: "text", role: "assistant", text: `  Using ${lastModel} (saved preference).` },
          ]);
          return;
        }

        // Model changed since last confirmation — ask the user
        setPendingLastModel(lastModel);
      } catch {
        // Ignore — settings may not exist yet
      }
    })();
  }, []);

  const handleModelResumeChoice = useCallback(
    (key: string) => {
      if (!pendingLastModel) return;
      if (key === "y") {
        const lastModel = pendingLastModel;
        setPendingLastModel(null);
        (async () => {
          config.model = lastModel;
          config.modelExplicitlySet = true;
          conversationManager.getConfig().model = lastModel;
          conversationManager.getConfig().modelExplicitlySet = true;
          const { getModelContextSize } = await import("../core/models.js");
          const ctxSize = await getModelContextSize(lastModel);
          if (ctxSize) {
            config.contextWindowSize = ctxSize;
            conversationManager.getConfig().contextWindowSize = ctxSize;
          }
          // Save as confirmed — won't ask again on next startup
          const { saveUserSettingsRaw } = await import("../core/config.js");
          await saveUserSettingsRaw({ confirmedModel: lastModel });
          setCompleted((prev) => [
            ...prev,
            {
              kind: "text",
              role: "assistant",
              text: `  Switched to ${lastModel} from previous session.`,
            },
          ]);
        })();
      } else {
        setPendingLastModel(null);
        (async () => {
          // Save current model as confirmed — won't ask again
          const { saveUserSettingsRaw } = await import("../core/config.js");
          await saveUserSettingsRaw({
            confirmedModel: config.model,
            lastSessionModel: config.model,
          });
        })();
        setCompleted((prev) => [
          ...prev,
          { kind: "text", role: "assistant", text: `  Continuing with ${config.model}.` },
        ]);
      }
    },
    [pendingLastModel, config],
  );

  // Message processing: slash commands, LLM sending, queue draining
  const { handleSubmit, messageQueueRef } = useMessageProcessor({
    config,
    conversationManager,
    tools,
    skillManager,
    mode,
    sessionStart,
    sessionNotes,
    sessionName,
    sessionTags,
    tabRemovalTimers,
    switchTheme,
    exit,
    setMode,
    setCompleted,
    setStreamingText,
    setStreamingThinking,
    setIsThinking,
    setLoadingMessage,
    setTokenCount,
    setTurnTokens,
    setTurnStartTime,
    setSpinnerPhase,
    setToolUseCount,
    setRunningAgentCount,
    setActiveTabs,
    setBashStreamOutput,
    setSessionNotes,
    setSessionName,
    setSessionTags,
    setWatcherSuggestions,
    setShowContextGrid,
    setMessageQueue,
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

  const handleEscalationChoice = useCallback(async (modelName: string | null) => {
    try {
      const { scanState } = await import("../core/audit-engine/scan-state.js");
      scanState.escalationModelChoice = modelName;
    } catch {
      /* ignore */
    }
    setEscalationData(null);
    setTimeout(() => setMode("input"), 50);
    setCompleted((prev) => [
      ...prev,
      {
        kind: "text",
        role: "assistant",
        text: modelName
          ? `  ☁ Escalating to ${modelName} for second opinion...`
          : "  ⏭ Skipped cloud verification.",
      },
    ]);
  }, []);

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
        setCompleted((prev) => [
          ...prev,
          { kind: "text", role: "assistant", text: "  Cloud setup cancelled." },
        ]);
        setMode("input");
        return;
      }

      try {
        const { loadUserSettingsRaw, saveUserSettingsRaw } = await import("../core/config.js");
        const { addModel } = await import("../core/models.js");
        const provider = result.provider;

        if (result.viaOAuth && !result.apiKey) {
          // OAuth tokens-only flow (OpenAI Codex, Gemini) — tokens stored in keychain,
          // no API key to save in settings. The request-builder resolves tokens at runtime.
        } else {
          // Save API key to settings (raw to preserve extra fields)
          const settings = await loadUserSettingsRaw();
          settings[provider.settingsKey] = result.apiKey;
          await saveUserSettingsRaw(settings);

          // Set env var for current session
          process.env[provider.envVar] = result.apiKey;
        }

        // Update current config — use the provider-specific key field when available
        if (result.apiKey) {
          if (provider.id === "anthropic") {
            config.anthropicApiKey = result.apiKey;
          } else if (provider.settingsKey && provider.settingsKey in config) {
            (config as unknown as Record<string, unknown>)[provider.settingsKey] = result.apiKey;
          } else {
            config.apiKey = result.apiKey;
          }
        }

        // Fetch models live from the provider API — no hardcoded names.
        // IMPORTANT: discover FIRST, then replace. Never delete before confirming success.
        const { fetchProviderModels } = await import("../core/cloud-model-discovery.js");
        const { getModelProvider, listModels, removeModel } = await import("../core/models.js");

        // For OAuth flows result.apiKey may be empty — get the token from keychain
        let discoveryKey = result.apiKey ?? "";
        if (!discoveryKey && provider.id === "anthropic") {
          try {
            const { getClaudeCodeToken } = await import("../core/auth/claude-code-bridge.js");
            discoveryKey = (await getClaudeCodeToken()) ?? "";
          } catch {
            /* not available */
          }
        }

        const discovered = await fetchProviderModels(provider.id, provider.baseUrl, discoveryKey);

        if (discovered.length > 0) {
          // Discovery succeeded — now safe to remove stale entries and register fresh ones
          const existing = await listModels();
          for (const m of existing.filter((m) => m.baseUrl === provider.baseUrl)) {
            await removeModel(m.name);
          }
          for (const m of discovered) {
            const modelProvider = await getModelProvider(m.id);
            await addModel({
              name: m.id,
              baseUrl: provider.baseUrl,
              provider: modelProvider,
              contextSize: m.contextWindow,
              description: `${provider.name} cloud model`,
            });
          }
        }
        // If discovery failed (empty), keep whatever was registered previously — don't break things.

        const modelsToRegister = discovered;

        // Switch active model to the first discovered model, or keep current if nothing found
        const existingForProvider = (await listModels()).filter(
          (m) => m.baseUrl === provider.baseUrl,
        );
        const newModel = discovered[0]?.id ?? existingForProvider[0]?.name ?? config.model;
        config.model = newModel;
        config.modelExplicitlySet = true;
        conversationManager.getConfig().model = newModel;
        conversationManager.getConfig().modelExplicitlySet = true;

        // Persist last used model + confirm it (won't ask on next startup)
        await saveUserSettingsRaw({ lastSessionModel: newModel, confirmedModel: newModel });

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
            text: `  ☁  ${provider.name} configured!${result.viaOAuth ? " (via OAuth)" : ""}\n  ${result.viaOAuth && !result.apiKey ? "OAuth tokens stored in system keychain" : "API key saved to ~/.kcode/settings.json"}\n  Registered models: ${modelsToRegister.length > 0 ? `${modelsToRegister.length} (fetched from API)` : "none — check API key"}\n  Active model switched to: ${newModel}`,
          },
        ]);
      } catch (err) {
        setCompleted((prev) => [
          ...prev,
          {
            kind: "text",
            role: "assistant",
            text: `  Error saving config: ${err instanceof Error ? err.message : err}`,
          },
        ]);
      }

      setMode("input");
    },
    [config],
  );

  const handleToggleDone = useCallback(
    async (result: ModelToggleResult | null) => {
      if (!result) {
        // Give Ink one tick to unmount ModelToggle's useInput before
        // InputPrompt's useInput re-registers — prevents focus race condition.
        setTimeout(() => setMode("input"), 50);
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

      // Auto-compact if current context exceeds new model's window
      if (ctxSize) {
        const { estimateContextTokens } = await import("../core/context-manager.js");
        const state = conversationManager.getState();
        const currentTokens = estimateContextTokens("", state.messages);
        const threshold = ctxSize * 0.9; // 90% — must fit, not just be near threshold
        if (currentTokens >= threshold && state.messages.length > 4) {
          setCompleted((prev) => [
            ...prev,
            {
              kind: "text",
              role: "assistant",
              text: `  ⚠ Context (${Math.round(currentTokens / 1000)}K tokens) exceeds ${newModel} window (${Math.round(ctxSize / 1000)}K). Auto-compacting...`,
            },
          ]);
          const { CompactionManager } = await import("../core/compaction.js");
          const compactor = new CompactionManager(config.apiKey, config.model, config.apiBase);
          const keepLast = 4;
          const toPrune = state.messages.slice(0, -keepLast);
          const kept = state.messages.slice(-keepLast);
          const summary = await compactor.compact(toPrune);
          if (summary) {
            conversationManager.restoreMessages([summary, ...kept]);
            setCompleted((prev) => [
              ...prev,
              {
                kind: "text",
                role: "assistant",
                text: `  ✓ Compacted ${toPrune.length} messages into summary. Ready for ${newModel}.`,
              },
            ]);
          } else {
            setCompleted((prev) => [
              ...prev,
              {
                kind: "text",
                role: "assistant",
                text: `  ⚠ Auto-compaction failed. Run /compact manually before sending a message.`,
              },
            ]);
          }
        }
      }

      // Update API key if switching to a cloud provider
      const { getModelProvider } = await import("../core/models.js");
      const provider = await getModelProvider(newModel);
      if (provider === "anthropic" && process.env.ANTHROPIC_API_KEY) {
        config.anthropicApiKey = process.env.ANTHROPIC_API_KEY;
      }

      // Persist last used model + confirm it (won't ask on next startup)
      import("../core/config.js").then(({ saveUserSettingsRaw }) =>
        saveUserSettingsRaw({ lastSessionModel: newModel, confirmedModel: newModel }),
      );

      // Fire ModelSwitch hook (non-blocking)
      try {
        conversationManager.getHooks().fireAndForget("ModelSwitch", {
          previousModel: config.model,
          newModel,
          trigger: "user",
        });
      } catch {
        /* non-fatal */
      }

      const isLocal =
        result.model.baseUrl.includes("localhost") || result.model.baseUrl.includes("127.0.0.1");
      const label = isLocal ? "🖥  Local" : "☁  Cloud";

      setCompleted((prev) => [
        ...prev,
        {
          kind: "text",
          role: "assistant",
          text: `  ${label}: Switched to ${newModel}${result.model.description ? ` — ${result.model.description}` : ""}`,
        },
      ]);

      setTimeout(() => setMode("input"), 0);
    },
    [config],
  );

  // Interactive question selector — computed once before render
  const lastEntry = completed[completed.length - 1];
  const interactiveQuestion =
    lastEntry?.kind === "question_highlight" &&
    lastEntry.options &&
    lastEntry.options.length >= 2 &&
    mode === "input" ? (
      <InteractiveQuestion
        question={lastEntry.question}
        options={lastEntry.options}
        onSelect={(answer) => handleSubmit(answer)}
        onCancel={() => {
          // Remove the question_highlight entry to dismiss the selector
          setCompleted((prev) => prev.filter((e) => e !== lastEntry));
        }}
        isActive={mode === "input" && !pendingLastModel}
      />
    ) : null;

  return (
    <KeybindingProvider>
      <Box flexDirection="column">
        {useVirtualScrollEnabled ? (
          <VirtualMessageList
            completed={completed}
            streamingText={streamingText}
            streamingThinking={streamingThinking}
            isThinking={isThinking}
            bashStreamOutput={bashStreamOutput}
            scrollActive={mode === "input"}
          />
        ) : (
          <MessageList
            completed={completed}
            streamingText={streamingText}
            streamingThinking={streamingThinking}
            isThinking={isThinking}
            bashStreamOutput={bashStreamOutput}
          />
        )}

        {watcherSuggestions.length > 0 && mode === "input" && (
          <Box marginLeft={2} marginBottom={1} flexDirection="column">
            {watcherSuggestions.map((s, i) => (
              <Text key={i} dimColor>
                {"  ✱ "}
                {s}
              </Text>
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
          <SudoPasswordPrompt onSubmit={handleSudoPassword} isActive={mode === "sudo-password"} />
        )}

        {mode === "cloud" && <CloudMenu isActive={mode === "cloud"} onDone={handleCloudDone} />}

        {mode === "toggle" && (
          <ModelToggle
            isActive={mode === "toggle"}
            currentModel={config.model}
            onDone={handleToggleDone}
          />
        )}

        {mode === "kodi-advisor" && (
          <KodiAdvisorMenu firstRun={firstRunKodiAdvisor} onClose={handleKodiAdvisorMenuDone} />
        )}

        {/* Background scan/pr progress bar */}
        {scanProgress && scanProgress.active && (
          <Box marginLeft={2} marginBottom={0} flexDirection="column">
            <Text color="cyan">
              {"  ◆ "}
              {scanProgress.phase}
              {` — ${scanProgress.elapsed.toFixed(1)}s`}
            </Text>
            {scanProgress.total > 0
              ? (() => {
                  const pct = Math.round((scanProgress.verified / scanProgress.total) * 100);
                  const filled = Math.round((scanProgress.verified / scanProgress.total) * 20);
                  return (
                    <Text color="cyan">
                      {"    ["}
                      {"█".repeat(filled)}
                      {"░".repeat(20 - filled)}
                      {"] "}
                      {scanProgress.verified}/{scanProgress.total}
                      {` (${pct}%) — `}
                      {scanProgress.confirmed} confirmed
                      {(scanProgress as any).escalated > 0 && (
                        <Text color="yellow">{` — ${(scanProgress as any).escalated} ☁ escalated`}</Text>
                      )}
                    </Text>
                  );
                })()
              : (() => {
                  // v2.10.387 — indeterminate bar for the discovery + scanning
                  // phases (which run before total is known). Without this, the
                  // user saw a static phase line for 5-10s and thought /scan
                  // was hung. The bar now animates a moving "■" inside the
                  // 20-cell width tied to elapsed seconds, so the polling
                  // re-render every 200ms shows visible motion.
                  const width = 20;
                  const pos = Math.floor(scanProgress.elapsed * 4) % (width * 2 - 2);
                  const head = pos < width ? pos : width * 2 - 2 - pos;
                  const cells: string[] = Array(width).fill("░");
                  cells[head] = "█";
                  if (head > 0) cells[head - 1] = "▓";
                  if (head < width - 1) cells[head + 1] = "▓";
                  return (
                    <Text color="cyan">
                      {"    ["}
                      {cells.join("")}
                      {"]"}
                    </Text>
                  );
                })()}
            {/* v2.10.385 — cancellation hint. Without this, the only
                way out of a long scan was Ctrl+C, which exits KCode.
                Esc is wired in InputPrompt.tsx + file-actions-audit.ts. */}
            <Text color="gray" dimColor>
              {scanProgress.cancelled ? "    ⏸ cancelling..." : "    Press Esc to cancel"}
            </Text>
          </Box>
        )}

        {/* Engine progress bar (project creation) */}
        {engineProgress && engineProgress.active && (
          <Box marginLeft={2} marginBottom={0} flexDirection="column">
            <Text color="magenta">
              {"  ◆ "}
              {engineProgress.phase}
            </Text>
            {engineProgress.totalSteps > 0 &&
              (() => {
                const pct = Math.round((engineProgress.step / engineProgress.totalSteps) * 100);
                const filled = Math.round((engineProgress.step / engineProgress.totalSteps) * 20);
                const elapsed = ((Date.now() - engineProgress.startTime) / 1000).toFixed(1);
                return (
                  <Text color="magenta">
                    {"    ["}
                    {"█".repeat(filled)}
                    {"░".repeat(20 - filled)}
                    {"] "}
                    {`${pct}% — ${engineProgress.siteType} — ${elapsed}s`}
                  </Text>
                );
              })()}
          </Box>
        )}

        {/* Escalation model picker — shown after /scan when uncertain findings need cloud review */}
        {mode === "escalation" && escalationData && (
          <EscalationPrompt
            count={escalationData.count}
            reason={escalationData.reason}
            availableModels={escalationData.availableModels}
            isActive={mode === "escalation"}
            onChoice={handleEscalationChoice}
          />
        )}

        {activeTabs.length > 0 && <ToolTabs tabs={activeTabs} selectedIndex={selectedTabIndex} />}

        {showContextGrid &&
          config.contextWindowSize &&
          config.contextWindowSize > 0 &&
          (() => {
            const state = conversationManager.getState();
            let systemTokens = 0;
            let messageTokens = 0;
            let toolTokens = 0;
            for (const msg of state.messages) {
              if (typeof msg.content === "string") {
                const est = Math.round(msg.content.length / CHARS_PER_TOKEN);
                if (msg.role === "user") messageTokens += est;
                else messageTokens += est;
              } else if (Array.isArray(msg.content)) {
                for (const block of msg.content) {
                  if (block.type === "text") {
                    messageTokens += Math.round(block.text.length / CHARS_PER_TOKEN);
                  } else if (block.type === "tool_result") {
                    const c =
                      typeof block.content === "string"
                        ? block.content
                        : JSON.stringify(block.content);
                    toolTokens += Math.round(c.length / CHARS_PER_TOKEN);
                  } else if (block.type === "tool_use") {
                    toolTokens += Math.round(JSON.stringify(block.input).length / CHARS_PER_TOKEN);
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

        {/* Agent pool panel — auto-hides when empty */}
        <AgentPanel />

        {/* Kodi companion — hidden during /model (toggle) so it doesn't compete
            with the picker's re-renders and cause visual flicker on arrow keys */}
        {mode !== "toggle" && (
          <KodiCompanion
            mode={mode}
            toolUseCount={toolUseCount}
            tokenCount={tokenCount}
            sessionCostUsd={sessionCostUsd}
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
            subscriptionUsage5h={getRateLimitUsage()?.fiveHour}
            subscriptionUsage7d={getRateLimitUsage()?.sevenDay}
            tier={subscriptionTier}
            tierFeatures={subscriptionFeatures}
            sessionModelBreakdown={sessionModelBreakdown}
          />
        )}
        <ActivePlanPanel plan={activePlan} />
        {pendingLastModel && (
          <QuestionDialog
            title="Resume Previous Model"
            message={`Last session used ${pendingLastModel}. Switch to it?`}
            detail={`Current model: ${config.model}`}
            options={[
              { key: "y", label: `Yes, use ${pendingLastModel}` },
              { key: "n", label: `No, keep ${config.model}` },
            ]}
            onChoice={handleModelResumeChoice}
            isActive={!!pendingLastModel}
          />
        )}
        {interactiveQuestion}

        {mode === "responding" && (
          <Box paddingLeft={2}>
            <Spinner
              message={loadingMessage || (isThinking ? "Reasoning..." : "Thinking...")}
              tokens={turnTokens}
              startTime={turnStartTime}
              phase={isThinking ? "thinking" : spinnerPhase}
            />
          </Box>
        )}

        <InputPrompt
          onSubmit={handleSubmit}
          isActive={
            !pendingLastModel &&
            !interactiveQuestion &&
            mode !== "permission" &&
            mode !== "sudo-password" &&
            mode !== "cloud" &&
            mode !== "toggle" &&
            mode !== "kodi-advisor" &&
            mode !== "escalation"
          }
          isQueuing={mode === "responding"}
          queueSize={messageQueue.length}
          model={config.model}
          cwd={config.workingDirectory}
          completions={slashCompletions}
          commandDescriptions={commandDescriptions}
        />
      </Box>
    </KeybindingProvider>
  );
}
