// KCode - Kodi Companion
// An intelligent AI companion that lives in the terminal header.
// Uses a layered animation engine for fluid, contextual expressiveness.
// Falls back to hardcoded speech chips; optionally uses LLM for unique reactions.

import { Box, Text } from "ink";
import React, { useCallback, useEffect, useRef, useState } from "react";
import type { KodiAnimState, KodiEvent, KodiMood } from "../kodi-animation.js";
import { KodiAnimEngine, SPEECH_CHIPS } from "../kodi-animation.js";
import { useTheme } from "../ThemeContext.js";

// Re-export types for external consumers
export type { KodiEvent, KodiMood };

interface KodiProps {
  mode: string;
  toolUseCount: number;
  tokenCount: number;
  activeToolName: string | null;
  isThinking: boolean;
  runningAgents: number;
  sessionElapsedMs: number;
  lastEvent: KodiEvent | null;
  model: string;
  version: string;
  workingDirectory: string;
  permissionMode?: string;
  activeProfile?: string;
  contextWindowSize?: number;
  sessionName?: string;
  sessionStartTime?: number;
}

// ─── LLM Reaction Generator ────────────────────────────────────

const KODI_SYSTEM = `You are Kodi, a tiny ASCII companion living inside a coding terminal (KCode).
You have a playful, witty personality. You're encouraging but not cheesy.
You react to coding events with short, punchy commentary.
You can be sarcastic, funny, nerdy, supportive, or dramatic — mix it up!
You're self-aware that you're a tiny ASCII character watching someone code.

Rules:
- Reply with ONLY your reaction text (no quotes, no prefix, no explanation)
- MAX 10 words. Shorter is better. Aim for 3-8 words.
- Be creative — never repeat yourself
- Match the energy: celebrations should be hype, errors should be empathetic
- You can use *actions* like *flexes* or *hides behind monitor*
- You can use unicode symbols sparingly: ⚡ ✨ 🔥 💀 ☕ etc.`;

let _llmBaseUrl: string | null = null;
let _pendingRequest: AbortController | null = null;
let _lastLlmCall = 0;
const LLM_COOLDOWN_MS = 5000;

async function getLlmBaseUrl(): Promise<string> {
  if (_llmBaseUrl) return _llmBaseUrl;
  try {
    const { getModelBaseUrl, getDefaultModel } = await import("../../core/models.js");
    const defaultModel = await getDefaultModel();
    _llmBaseUrl = await getModelBaseUrl(defaultModel);
    return _llmBaseUrl;
  } catch {
    return "http://localhost:10091";
  }
}

async function generateReaction(context: string): Promise<string | null> {
  const now = Date.now();
  if (now - _lastLlmCall < LLM_COOLDOWN_MS) return null;
  if (_pendingRequest) _pendingRequest.abort();

  _lastLlmCall = now;
  const controller = new AbortController();
  _pendingRequest = controller;

  try {
    const baseUrl = await getLlmBaseUrl();
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        messages: [
          { role: "system", content: KODI_SYSTEM },
          { role: "user", content: context },
        ],
        max_tokens: 30,
        temperature: 1.0,
        top_p: 0.95,
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text || text.length > 80) return null;
    return text.replace(/^["']|["']$/g, "");
  } catch {
    return null;
  } finally {
    if (_pendingRequest === controller) _pendingRequest = null;
  }
}

function buildContext(
  event: KodiEvent,
  stats: { tools: number; tokens: number; elapsed: number; agents: number },
): string {
  const parts: string[] = [];
  switch (event.type) {
    case "tool_start":
      parts.push(`User just triggered the ${event.detail ?? "a"} tool.`);
      break;
    case "tool_done":
      parts.push(`The ${event.detail ?? "a"} tool just finished successfully.`);
      if (event.detail === "TestRunner") parts.push("All tests passed!");
      if (event.detail === "GitCommit") parts.push("Code was committed!");
      break;
    case "tool_error":
      parts.push(`The ${event.detail ?? "a"} tool just FAILED.`);
      break;
    case "thinking":
      parts.push("The AI is now doing deep reasoning — neurons firing.");
      break;
    case "streaming":
      parts.push("The AI is writing its response to the user.");
      break;
    case "turn_end":
      parts.push("The AI just finished responding. Waiting for user input.");
      break;
    case "compaction":
      parts.push("Context window is getting full — conversation is being compacted.");
      break;
    case "agent_spawn":
      parts.push("A sub-agent was just spawned for a parallel task!");
      break;
    case "error":
      parts.push(`An error occurred: ${event.detail ?? "unknown error"}`);
      break;
    case "idle":
      if (stats.elapsed > 120_000)
        parts.push("User has been idle for over 2 minutes. You're getting sleepy.");
      else parts.push("Waiting for the user.");
      break;
    default:
      parts.push(`Event: ${event.type}`);
  }
  parts.push(
    `Session: ${stats.tools} tools, ${Math.round(stats.tokens / 1000)}k tok, ${stats.agents} agents.`,
  );
  return parts.join(" ");
}

// ─── Helpers ────────────────────────────────────────────────────

function formatTime(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h${(mins % 60).toString().padStart(2, "0")}m`;
}

// ─── Component ──────────────────────────────────────────────────

const TICK_MS = 200; // 5fps — enough for terminal, light on CPU

export default function KodiCompanion({
  mode,
  toolUseCount,
  tokenCount,
  activeToolName,
  isThinking,
  runningAgents,
  sessionElapsedMs,
  lastEvent,
  model,
  version,
  workingDirectory,
  permissionMode,
  activeProfile,
  contextWindowSize,
  sessionName,
  sessionStartTime,
}: KodiProps) {
  const { theme } = useTheme();
  const engineRef = useRef<KodiAnimEngine | null>(null);
  const [frame, setFrame] = useState<KodiAnimState | null>(null);
  const [llmReaction, setLlmReaction] = useState<string | null>(null);
  const lastToolMilestone = useRef(0);
  const lastTokenMilestone = useRef(0);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const eventCountRef = useRef(0);

  // Initialize engine once
  if (!engineRef.current) {
    engineRef.current = new KodiAnimEngine();
    engineRef.current.say("let's code!", 4000);
  }
  const engine = engineRef.current;

  // Animation tick loop
  useEffect(() => {
    const timer = setInterval(() => {
      setFrame(engine.tick(TICK_MS));
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [engine]);

  // Update elapsed time every 10s
  useEffect(() => {
    if (!sessionStartTime) return;
    const timer = setInterval(() => setElapsed(Date.now() - sessionStartTime), 10000);
    return () => clearInterval(timer);
  }, [sessionStartTime]);

  // Sync context into engine
  useEffect(() => {
    engine.runningAgents = runningAgents;
  }, [runningAgents]);
  useEffect(() => {
    engine.contextPressure =
      contextWindowSize && contextWindowSize > 0 ? Math.min(1, tokenCount / contextWindowSize) : 0;
  }, [tokenCount, contextWindowSize]);

  // React to events
  const handleEvent = useCallback(
    (event: KodiEvent) => {
      eventCountRef.current++;
      engine.react(event);

      // Try LLM reaction (non-blocking)
      const ctx = buildContext(event, {
        tools: toolUseCount,
        tokens: tokenCount,
        elapsed: sessionElapsedMs,
        agents: runningAgents,
      });
      generateReaction(ctx).then((r) => {
        if (r) {
          setLlmReaction(r);
          engine.say(r, 5000);
        }
      });
    },
    [engine, toolUseCount, tokenCount, sessionElapsedMs, runningAgents],
  );

  useEffect(() => {
    if (!lastEvent) return;

    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }

    handleEvent(lastEvent);

    // Idle progression
    idleTimerRef.current = setTimeout(() => {
      engine.windDown(30_000);
      idleTimerRef.current = setTimeout(() => {
        engine.windDown(120_000);
      }, 90_000);
    }, 30_000);

    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, [lastEvent, handleEvent]);

  // Milestones
  useEffect(() => {
    if (toolUseCount >= 100 && lastToolMilestone.current < 100) {
      lastToolMilestone.current = 100;
      engine.react({ type: "tool_done", detail: "milestone_100_tools" });
      engine.setMood("celebrating");
    } else if (toolUseCount >= 50 && lastToolMilestone.current < 50) {
      lastToolMilestone.current = 50;
      engine.react({ type: "tool_done", detail: "milestone_50_tools" });
    } else if (toolUseCount >= 10 && lastToolMilestone.current < 10) {
      lastToolMilestone.current = 10;
      engine.react({ type: "tool_done", detail: "milestone_10_tools" });
    }
  }, [toolUseCount]);

  useEffect(() => {
    if (tokenCount >= 100_000 && lastTokenMilestone.current < 100_000) {
      lastTokenMilestone.current = 100_000;
      engine.react({ type: "tool_done", detail: "milestone_100k_tokens" });
    }
  }, [tokenCount]);

  // ─── Computed values ────────────────────────────────────────

  const home = process.env.HOME ?? "";
  const shortCwd =
    home && workingDirectory.startsWith(home)
      ? "~" + workingDirectory.slice(home.length)
      : workingDirectory;

  const displayMood = frame?.mood ?? "idle";
  const moodColor =
    displayMood === "happy" || displayMood === "celebrating" || displayMood === "excited"
      ? theme.success
      : displayMood === "worried"
        ? theme.error
        : displayMood === "angry"
          ? theme.error
          : displayMood === "reasoning"
            ? theme.accent
            : displayMood === "thinking" || displayMood === "working"
              ? theme.warning
              : displayMood === "mischievous"
                ? "#ff69b4"
                : displayMood === "crazy"
                  ? "#ff00ff"
                  : displayMood === "smug"
                    ? "#ffd700"
                    : displayMood === "sleeping"
                      ? theme.dimmed
                      : theme.primary;

  const ctxPct =
    contextWindowSize && contextWindowSize > 0 && tokenCount > 0
      ? Math.min(100, Math.round((tokenCount / contextWindowSize) * 100))
      : 0;
  const ctxBarLen = 10;
  const ctxFilled = Math.round((ctxBarLen * ctxPct) / 100);
  const ctxBar = "\u2588".repeat(ctxFilled) + "\u2591".repeat(ctxBarLen - ctxFilled);
  const ctxColor = ctxPct > 85 ? theme.error : ctxPct > 60 ? theme.warning : theme.success;

  const pmColor =
    permissionMode === "auto"
      ? theme.warning
      : permissionMode === "deny"
        ? theme.error
        : permissionMode === "plan"
          ? (theme.info ?? theme.primary)
          : theme.dimmed;

  // ─── Render ─────────────────────────────────────────────────

  // Pre-composed lines from engine — all same width, guaranteed aligned
  const lines = frame?.lines ?? [
    " ╭───────╮   ",
    " │ o  .o │   ",
    " ╰───┬───╯   ",
    "    /|\\      ",
    "    / \\      ",
  ];
  const bubble = frame?.bubble ?? "";

  return (
    <Box flexDirection="row" borderStyle="round" borderColor={theme.dimmed} paddingX={1} width={process.stdout.columns || 80}>
      {/* Kodi sprite — pre-composed, fixed-width lines */}
      <Box flexDirection="column" width={15}>
        {lines.map((line, i) => (
          <Text key={i} color={moodColor}>
            {line}
          </Text>
        ))}
      </Box>
      {/* Info panel */}
      <Box flexDirection="column" flexGrow={1} marginLeft={1}>
        {/* Line 1: Brand */}
        <Box gap={1}>
          <Text bold color={theme.primary}>
            KCode
          </Text>
          <Text color={theme.dimmed}>v{version}</Text>
          <Text color={theme.dimmed}>—</Text>
          <Text color={theme.dimmed}>Kulvex Code by Astrolexis</Text>
        </Box>
        {/* Line 2: Model + mode + cwd */}
        <Box gap={1}>
          <Text color={theme.success}>{model}</Text>
          {permissionMode && (
            <>
              <Text color={theme.dimmed}>•</Text>
              <Text color={pmColor}>{permissionMode}</Text>
            </>
          )}
          {activeProfile && (
            <>
              <Text color={theme.dimmed}>•</Text>
              <Text color={theme.info ?? theme.primary}>[{activeProfile}]</Text>
            </>
          )}
          <Text color={theme.dimmed}>•</Text>
          <Text color={theme.dimmed}>{shortCwd}</Text>
        </Box>
        {/* Line 3: Metrics */}
        <Box gap={1}>
          {(tokenCount > 0 || toolUseCount > 0) && (
            <>
              <Text color={theme.dimmed}>tok:{tokenCount.toLocaleString()}</Text>
              <Text color={theme.dimmed}>•</Text>
              <Text color={theme.dimmed}>tools:{toolUseCount}</Text>
            </>
          )}
          {runningAgents > 0 && (
            <>
              <Text color={theme.dimmed}>•</Text>
              <Text color={theme.warning}>agents:{runningAgents}</Text>
            </>
          )}
          {contextWindowSize && contextWindowSize > 0 && tokenCount > 0 && (
            <>
              <Text color={theme.dimmed}>•</Text>
              <Text color={ctxColor}>
                [{ctxBar}] {ctxPct}%
              </Text>
            </>
          )}
          {sessionName && (
            <>
              <Text color={theme.dimmed}>•</Text>
              <Text color={theme.warning}>{sessionName}</Text>
            </>
          )}
          {sessionStartTime && elapsed > 0 && (
            <>
              <Text color={theme.dimmed}>•</Text>
              <Text color={theme.dimmed}>{formatTime(elapsed)}</Text>
            </>
          )}
        </Box>
        {/* Line 4: Speech chip */}
        <Box>
          {bubble ? (
            <>
              <Text color={moodColor}>{"💬 "}</Text>
              <Text color={moodColor} italic>
                {bubble}
              </Text>
            </>
          ) : (
            <Text color={theme.dimmed}> </Text>
          )}
        </Box>
        {/* Line 5: spacer */}
        <Text> </Text>
      </Box>
    </Box>
  );
}
