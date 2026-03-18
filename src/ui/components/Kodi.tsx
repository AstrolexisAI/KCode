// KCode - Kodi Companion
// An intelligent AI companion that lives in the terminal header.
// Uses the LLM to generate contextual, unique reactions in real-time.
// Falls back to hardcoded reactions when the LLM is unavailable or busy.

import React, { useState, useEffect, useRef } from "react";
import { Box, Text } from "ink";
import { useTheme } from "../ThemeContext.js";

// ─── Types ──────────────────────────────────────────────────────

export type KodiMood = "idle" | "happy" | "excited" | "thinking" | "working" | "worried" | "sleeping" | "celebrating" | "curious";

export interface KodiEvent {
  type: "tool_start" | "tool_done" | "tool_error" | "thinking" | "streaming" | "idle" | "turn_end" | "compaction" | "agent_spawn" | "test_pass" | "test_fail" | "commit" | "error";
  detail?: string;
}

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
  contextWindowSize?: number;
  sessionName?: string;
  sessionStartTime?: number;
}

// ─── ASCII Art Sprites (5 lines tall) ───────────────────────────

// Each sprite line must be exactly 11 chars wide to fit in the 14-col box (with 1-char padding each side + 1 spare)
const SPRITES: Record<KodiMood, string[][]> = {
  idle: [[
    "  ╭───╮  ",
    "  │• ◡•│  ",
    "  ╰─┬─╯  ",
    "   /|\\   ",
    "   / \\   ",
  ], [
    "  ╭───╮  ",
    "  │◦ ◡◦│  ",
    "  ╰─┬─╯  ",
    "   /|\\   ",
    "   / \\   ",
  ]],
  happy: [[
    "  ╭───╮  ",
    "  │^ ◡^│  ",
    "  ╰─┬─╯  ",
    "  \\|/   ",
    "   / \\   ",
  ], [
    "  ╭───╮  ",
    "  │◕ ◡◕│  ",
    "  ╰─┬─╯  ",
    "   /|\\   ",
    "   / \\   ",
  ], [
    "  ╭───╮ ♥",
    "  │^ ‿^│  ",
    "  ╰─┬─╯  ",
    "   /|\\   ",
    "   / \\   ",
  ]],
  excited: [[
    " ╭─────╮ ",
    " │★ ◡ ★│ ",
    " ╰──┬──╯ ",
    " \\(|)/  ",
    "   / \\   ",
  ], [
    " ╭─────╮ ",
    " │✧ ▽ ✧│ ",
    " ╰──┬──╯ ",
    "  \\|/   ",
    "   / \\   ",
  ], [
    " ╭─────╮!",
    " │◕ ◡ ◕│ ",
    " ╰──┬──╯ ",
    "  \\|/   ",
    "  _/ \\_  ",
  ]],
  thinking: [[
    "  ╭───╮ ?",
    "  │• _ •│ ",
    "  ╰─┬─╯  ",
    "   /|    ",
    "   / \\   ",
  ], [
    "  ╭───╮  ",
    "  │◦ ‿◦│…",
    "  ╰─┬─╯  ",
    "    |\\   ",
    "   / \\   ",
  ], [
    "  ╭───╮  ",
    "  │• ‿•│  ",
    "  ╰─┬─╯  ",
    "   /|    ",
    "   / \\   ",
  ]],
  working: [[
    "  ╭───╮ ⚡",
    "  │• ‸•│  ",
    "  ╰─┬─╯  ",
    "   /|\\ ▌ ",
    "   / \\   ",
  ], [
    "  ╭───╮ ⚙",
    "  │◦ ‸◦│  ",
    "  ╰─┬─╯  ",
    "   /|\\ ▌ ",
    "   / \\   ",
  ], [
    "  ╭───╮ ▶",
    "  │- ‸-│  ",
    "  ╰─┬─╯  ",
    "   /|\\   ",
    "   / \\   ",
  ]],
  worried: [[
    "  ╭───╮  ",
    "  │° △°│  ",
    "  ╰─┬─╯  ",
    "   /|\\   ",
    "   / \\   ",
  ], [
    "  ╭───╮ !",
    "  │• ~•│  ",
    "  ╰─┬─╯  ",
    "   /|\\   ",
    "   / \\   ",
  ], [
    "  ╭───╮  ",
    "  │; _;│  ",
    "  ╰─┬─╯  ",
    "   /|\\   ",
    "   / \\   ",
  ]],
  sleeping: [[
    "  ╭───╮  ",
    "  │- _-│z ",
    "  ╰─┬─╯  ",
    "   /|\\   ",
    "   / \\   ",
  ], [
    "  ╭───╮  ",
    "  │_ __│Z ",
    "  ╰─┬─╯  ",
    "   /|\\   ",
    "   / \\   ",
  ]],
  celebrating: [[
    " ╭─────╮ ",
    " │★ ▽ ★│ ",
    " ╰──┬──╯ ",
    " \\(|)/♪ ",
    "   / \\   ",
  ], [
    " ╭─────╮ ",
    " │◕ ▽ ◕│ ",
    " ╰──┬──╯ ",
    " \\(|)/  ",
    "  _/ \\_  ",
  ], [
    " ╭─────╮ ",
    " │^ ▽ ^│ ",
    " ╰──┬──╯ ",
    " \\(|)/  ",
    "   / \\   ",
  ]],
  curious: [[
    "  ╭───╮  ",
    "  │• ᵕ•│?",
    "  ╰─┬─╯  ",
    "   /|    ",
    "   / \\   ",
  ], [
    "  ╭───╮ ?",
    "  │◦ ‿◦│  ",
    "  ╰─┬─╯  ",
    "    |\\   ",
    "   / \\   ",
  ]],
};

// ─── Fallback Reactions (used instantly while LLM generates) ────

const FALLBACKS: Record<string, string[]> = {
  tool_start:    ["On it!", "Working...", "Let me handle that!"],
  tool_done:     ["Done!", "Got it!", "All good!"],
  tool_error:    ["Oops!", "That didn't work...", "Let me check..."],
  thinking:      ["Hmm...", "Thinking...", "Let me ponder..."],
  streaming:     ["Writing...", "Here goes...", "Composing..."],
  idle:          ["Ready!", "What's next?", "Standing by!"],
  turn_end:      ["All done!", "Back to you!", "Your turn!"],
  compaction:    ["Cleaning up memory...", "Making room..."],
  agent_spawn:   ["Agent deployed!", "Teamwork!", "Reinforcements!"],
  error:         ["Something broke!", "We'll fix it!", "Uh oh..."],
  commit:        ["Committed!", "Saved!", "Progress!"],
  test_pass:     ["Tests passed!", "All green!", "Ship it!"],
  test_fail:     ["Tests failed!", "Bugs found!", "Back to it!"],
  milestone:     ["Milestone!", "Level up!", "Amazing!"],
  startup:       ["Let's code!", "Ready to roll!", "Hello, world!"],
};

// ─── LLM Reaction Generator ────────────────────────────────────

const KODI_SYSTEM = `You are Kodi, a tiny ASCII companion living inside a coding terminal (KCode).
You have a playful, witty personality. You're encouraging but not cheesy.
You react to coding events with short, punchy commentary.
You can be sarcastic, funny, nerdy, supportive, or dramatic — mix it up!
You occasionally reference coding memes, pop culture, or make puns.
You're self-aware that you're a tiny ASCII character watching someone code.

Rules:
- Reply with ONLY your reaction text (no quotes, no prefix, no explanation)
- MAX 10 words. Shorter is better. Aim for 3-8 words.
- Be creative — never repeat yourself
- Match the energy: celebrations should be hype, errors should be empathetic
- You can use *actions* like *flexes* or *hides behind monitor*
- You can use unicode symbols sparingly: ⚡ ✨ 🔥 💀 ☕ etc.`;

let _llmBaseUrl: string | null = null;

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

let _pendingRequest: AbortController | null = null;
let _lastLlmCall = 0;
const LLM_COOLDOWN_MS = 5000; // Don't call LLM more than once every 5 seconds

async function generateReaction(context: string): Promise<string | null> {
  const now = Date.now();
  if (now - _lastLlmCall < LLM_COOLDOWN_MS) return null;

  // Abort previous pending request
  if (_pendingRequest) {
    _pendingRequest.abort();
  }

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
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text || text.length > 80) return null;
    // Strip quotes if the model wrapped them
    return text.replace(/^["']|["']$/g, "");
  } catch {
    return null;
  } finally {
    if (_pendingRequest === controller) _pendingRequest = null;
  }
}

// ─── Helpers ────────────────────────────────────────────────────

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function formatTime(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h${remMins.toString().padStart(2, "0")}m`;
}

function buildContext(event: KodiEvent, stats: { tools: number; tokens: number; elapsed: number; agents: number }): string {
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
      parts.push(`The ${event.detail ?? "a"} tool just FAILED with an error.`);
      break;
    case "thinking":
      parts.push("The AI is now deep in thought, processing the user's request.");
      break;
    case "streaming":
      parts.push("The AI is writing its response to the user.");
      break;
    case "turn_end":
      parts.push("The AI just finished responding. Waiting for user input.");
      break;
    case "compaction":
      parts.push("Context window is getting full — conversation is being compacted/summarized.");
      break;
    case "agent_spawn":
      parts.push("A sub-agent was just spawned to work on a parallel task!");
      break;
    case "error":
      parts.push(`An error occurred: ${event.detail ?? "unknown error"}`);
      break;
    case "idle":
      if (stats.elapsed > 120_000) parts.push("User has been idle for over 2 minutes. You're getting sleepy.");
      else if (stats.elapsed > 30_000) parts.push("User has been idle for a while. You're waiting patiently.");
      else parts.push("Waiting for the user to do something.");
      break;
    default:
      parts.push(`Event: ${event.type}`);
  }

  parts.push(`Session stats: ${stats.tools} tools used, ${Math.round(stats.tokens / 1000)}k tokens, ${stats.agents} agents running.`);

  return parts.join(" ");
}

// ─── Component ──────────────────────────────────────────────────

export default function KodiCompanion({
  mode, toolUseCount, tokenCount, activeToolName, isThinking,
  runningAgents, sessionElapsedMs, lastEvent, model, version,
  workingDirectory, permissionMode, contextWindowSize, sessionName,
  sessionStartTime,
}: KodiProps) {
  const { theme } = useTheme();
  const [mood, setMood] = useState<KodiMood>("idle");
  const [reaction, setReaction] = useState(pick(FALLBACKS.startup!));
  const [sprite, setSprite] = useState(SPRITES.idle[0]!);
  const lastToolMilestone = useRef(0);
  const lastTokenMilestone = useRef(0);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const eventCountRef = useRef(0);

  // Update elapsed time every 10s
  useEffect(() => {
    if (!sessionStartTime) return;
    const timer = setInterval(() => setElapsed(Date.now() - sessionStartTime), 10000);
    return () => clearInterval(timer);
  }, [sessionStartTime]);

  // Helper to set mood + sprite + fallback, then try LLM
  const react = (newMood: KodiMood, fallbackKey: string, event?: KodiEvent) => {
    setMood(newMood);
    setSprite(pick(SPRITES[newMood]));
    setReaction(pick(FALLBACKS[fallbackKey] ?? FALLBACKS.idle!));

    // Try to get an LLM-generated reaction (async, non-blocking)
    if (event) {
      const ctx = buildContext(event, {
        tools: toolUseCount,
        tokens: tokenCount,
        elapsed: sessionElapsedMs,
        agents: runningAgents,
      });
      generateReaction(ctx).then((llmReaction) => {
        if (llmReaction) setReaction(llmReaction);
      });
    }
  };

  // React to events
  useEffect(() => {
    if (!lastEvent) return;
    eventCountRef.current++;

    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }

    switch (lastEvent.type) {
      case "tool_start":
        react("working", "tool_start", lastEvent);
        break;
      case "tool_done":
        if (lastEvent.detail === "TestRunner") react("celebrating", "test_pass", lastEvent);
        else if (lastEvent.detail === "GitCommit") react("celebrating", "commit", lastEvent);
        else react("happy", "tool_done", lastEvent);
        break;
      case "tool_error":
      case "test_fail":
        react("worried", "tool_error", lastEvent);
        break;
      case "thinking":
        react("thinking", "thinking", lastEvent);
        break;
      case "streaming":
        react("happy", "streaming", lastEvent);
        break;
      case "compaction":
        react("thinking", "compaction", lastEvent);
        break;
      case "agent_spawn":
        react("excited", "agent_spawn", lastEvent);
        break;
      case "error":
        react("worried", "error", lastEvent);
        break;
      case "turn_end":
        react("idle", "turn_end", lastEvent);
        break;
      case "idle":
        react("idle", "idle", lastEvent);
        break;
    }

    // Idle progression timers with LLM reactions
    idleTimerRef.current = setTimeout(() => {
      const idleEvent: KodiEvent = { type: "idle", detail: "long" };
      react("idle", "idle", idleEvent);

      idleTimerRef.current = setTimeout(() => {
        const sleepEvent: KodiEvent = { type: "idle", detail: "very_long" };
        react("sleeping", "idle", sleepEvent);
      }, 120_000);
    }, 30_000);

    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, [lastEvent]);

  // Milestone reactions
  useEffect(() => {
    if (toolUseCount >= 100 && lastToolMilestone.current < 100) {
      lastToolMilestone.current = 100;
      const ev: KodiEvent = { type: "tool_done", detail: `milestone_100_tools` };
      react("celebrating", "milestone", ev);
    } else if (toolUseCount >= 50 && lastToolMilestone.current < 50) {
      lastToolMilestone.current = 50;
      const ev: KodiEvent = { type: "tool_done", detail: `milestone_50_tools` };
      react("excited", "milestone", ev);
    } else if (toolUseCount >= 10 && lastToolMilestone.current < 10) {
      lastToolMilestone.current = 10;
      const ev: KodiEvent = { type: "tool_done", detail: `milestone_10_tools` };
      react("happy", "milestone", ev);
    }
  }, [toolUseCount]);

  useEffect(() => {
    if (tokenCount >= 100_000 && lastTokenMilestone.current < 100_000) {
      lastTokenMilestone.current = 100_000;
      const ev: KodiEvent = { type: "tool_done", detail: "milestone_100k_tokens" };
      react("excited", "milestone", ev);
    } else if (tokenCount >= 50_000 && lastTokenMilestone.current < 50_000) {
      lastTokenMilestone.current = 50_000;
      const ev: KodiEvent = { type: "tool_done", detail: "milestone_50k_tokens" };
      react("happy", "milestone", ev);
    }
  }, [tokenCount]);

  // ─── Computed values ────────────────────────────────────────

  const home = process.env.HOME ?? "";
  const shortCwd = home && workingDirectory.startsWith(home)
    ? "~" + workingDirectory.slice(home.length)
    : workingDirectory;

  const moodColor = mood === "happy" || mood === "celebrating" || mood === "excited"
    ? theme.success
    : mood === "worried" ? theme.error
    : mood === "thinking" || mood === "working" ? theme.warning
    : mood === "sleeping" ? theme.dimmed
    : theme.primary;

  const ctxPct = contextWindowSize && contextWindowSize > 0 && tokenCount > 0
    ? Math.min(100, Math.round((tokenCount / contextWindowSize) * 100))
    : 0;
  const ctxBarLen = 10;
  const ctxFilled = Math.round(ctxBarLen * ctxPct / 100);
  const ctxBar = "\u2588".repeat(ctxFilled) + "\u2591".repeat(ctxBarLen - ctxFilled);
  const ctxColor = ctxPct > 85 ? theme.error : ctxPct > 60 ? theme.warning : theme.success;

  const pmColor = permissionMode === "auto" ? theme.warning
    : permissionMode === "deny" ? theme.error
    : permissionMode === "plan" ? (theme.info ?? theme.primary)
    : theme.dimmed;

  // ─── Render ─────────────────────────────────────────────────

  return (
    <Box flexDirection="row" borderStyle="round" borderColor={theme.dimmed} paddingX={1}>
      {/* Kodi sprite */}
      <Box flexDirection="column" width={12}>
        {sprite.map((line, i) => (
          <Text key={i} color={moodColor}>{line}</Text>
        ))}
      </Box>
      {/* Info panel */}
      <Box flexDirection="column" flexGrow={1} marginLeft={1}>
        {/* Line 1: Brand */}
        <Box gap={1}>
          <Text bold color={theme.primary}>KCode</Text>
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
              <Text color={ctxColor}>[{ctxBar}] {ctxPct}%</Text>
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
        {/* Line 4: Kodi's reaction speech bubble */}
        <Box>
          <Text color={moodColor}>{"💬 "}</Text>
          <Text color={moodColor} italic>{reaction}</Text>
        </Box>
        {/* Line 5: spacer */}
        <Text> </Text>
      </Box>
    </Box>
  );
}
