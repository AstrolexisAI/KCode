// KCode - Kodi Companion
// An intelligent AI companion that lives in the terminal header.
// Reacts to events (tool use, errors, idle time, etc.) with personality.

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

// ─── ASCII Art Faces ────────────────────────────────────────────

const FACES: Record<KodiMood, string[]> = {
  idle:        ["(• ◡ •)"],
  happy:       ["(^ ◡ ^)"],
  excited:     ["(★ ◡ ★)", "(✧ ◡ ✧)", "(◕ ◡ ◕)"],
  thinking:    ["(• _ •)", "(• ‿ •)", "(◦ _ ◦)"],
  working:     ["(• ‸ •)", "(◦ ‸ ◦)"],
  worried:     ["(• ~ •)", "(° △ °)"],
  sleeping:    ["(- _ -)zzz"],
  celebrating: ["\\(★ ▽ ★)/", "\\(◕ ▽ ◕)/", "♪(^ ◡ ^)♪"],
  curious:     ["(• ᵕ •)?", "(◦ ‿ ◦)?"],
};

// ─── Reaction Lines ─────────────────────────────────────────────
// Kodi picks from these based on events. Short, punchy, personality-driven.

const REACTIONS: Record<string, string[]> = {
  // Tool events
  tool_Bash:       ["running your command...", "shell time!", "executing...", "let me run that"],
  tool_Read:       ["reading...", "let me see that file", "peeking inside..."],
  tool_Write:      ["writing code!", "creating...", "crafting that file"],
  tool_Edit:       ["editing...", "surgical precision!", "tweaking..."],
  tool_Grep:       ["searching...", "hunting patterns...", "scanning the codebase"],
  tool_Glob:       ["finding files...", "file detective mode"],
  tool_GitCommit:  ["committing!", "saving progress!", "snapshot time!"],
  tool_GitStatus:  ["checking git...", "repo status check"],
  tool_TestRunner: ["running tests...", "fingers crossed!", "test time!"],
  tool_WebSearch:  ["searching the web...", "browsing...", "googling..."],
  tool_WebFetch:   ["fetching page...", "downloading..."],
  tool_Agent:      ["spawning agent!", "clone deployed!", "teamwork!"],
  tool_MultiEdit:  ["multi-edit!", "refactoring...", "bulk changes!"],
  tool_default:    ["working on it...", "processing...", "on it!"],

  // Tool results
  done_success:    ["done!", "nailed it!", "got it!", "✓ done", "all good!", "there ya go"],
  done_error:      ["oops!", "hmm, that failed", "uh oh...", "error!", "yikes"],

  // States
  thinking:        ["hmm...", "let me think...", "pondering...", "processing...", "analyzing..."],
  streaming:       ["writing...", "composing...", "generating..."],
  idle_short:      ["ready!", "what's next?", "standing by", "at your service", "sup?"],
  idle_long:       ["still here...", "waiting patiently", "take your time", "*stretches*"],
  idle_very_long:  ["*yawns*", "getting sleepy...", "you there?", "*whistles*"],

  // Special events
  test_pass:       ["tests passed!", "all green!", "victory!", "ship it!"],
  test_fail:       ["tests failed!", "bugs detected!", "back to it!"],
  commit:          ["committed!", "progress saved!", "milestone!"],
  compaction:      ["compacting memory...", "cleaning up...", "making room..."],
  agent_spawn:     ["agent deployed!", "team growing!", "divide & conquer"],
  error:           ["something broke!", "error encountered", "we'll fix it"],

  // Session milestones
  tools_10:        ["10 tools used!", "productive session!"],
  tools_50:        ["50 tools! beast mode!", "unstoppable!"],
  tools_100:       ["100 tools! legendary!", "coding machine!"],
  tokens_50k:      ["50k tokens deep!", "deep session!"],
  tokens_100k:     ["100k tokens! marathon!", "epic session!"],

  // Startup
  startup:         ["let's code!", "ready to roll!", "hello, world!", "let's build something!", "booting up..."],
};

// ─── Helper ─────────────────────────────────────────────────────

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

// ─── Component ──────────────────────────────────────────────────

export default function KodiCompanion({
  mode, toolUseCount, tokenCount, activeToolName, isThinking,
  runningAgents, sessionElapsedMs, lastEvent, model, version,
  workingDirectory, permissionMode, contextWindowSize, sessionName,
  sessionStartTime,
}: KodiProps) {
  const { theme } = useTheme();
  const [mood, setMood] = useState<KodiMood>("idle");
  const [reaction, setReaction] = useState(pick(REACTIONS.startup!));
  const [face, setFace] = useState(pick(FACES.idle));
  const lastToolCountRef = useRef(0);
  const lastTokenMilestone = useRef(0);
  const lastToolMilestone = useRef(0);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [elapsed, setElapsed] = useState(0);

  // Update elapsed time every 10s
  useEffect(() => {
    if (!sessionStartTime) return;
    const timer = setInterval(() => setElapsed(Date.now() - sessionStartTime), 10000);
    return () => clearInterval(timer);
  }, [sessionStartTime]);

  // React to events
  useEffect(() => {
    if (!lastEvent) return;

    // Clear idle timer
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }

    switch (lastEvent.type) {
      case "tool_start": {
        const toolName = lastEvent.detail ?? "default";
        const key = `tool_${toolName}`;
        const reactions = REACTIONS[key] ?? REACTIONS.tool_default!;
        setMood("working");
        setReaction(pick(reactions));
        setFace(pick(FACES.working));
        break;
      }
      case "tool_done": {
        const isTest = lastEvent.detail === "TestRunner";
        const isCommit = lastEvent.detail === "GitCommit";
        if (isTest) {
          setMood("celebrating");
          setReaction(pick(REACTIONS.test_pass!));
          setFace(pick(FACES.celebrating));
        } else if (isCommit) {
          setMood("celebrating");
          setReaction(pick(REACTIONS.commit!));
          setFace(pick(FACES.celebrating));
        } else {
          setMood("happy");
          setReaction(pick(REACTIONS.done_success!));
          setFace(pick(FACES.happy));
        }
        break;
      }
      case "tool_error":
      case "test_fail":
        setMood("worried");
        setReaction(pick(REACTIONS.done_error!));
        setFace(pick(FACES.worried));
        break;
      case "thinking":
        setMood("thinking");
        setReaction(pick(REACTIONS.thinking!));
        setFace(pick(FACES.thinking));
        break;
      case "streaming":
        setMood("happy");
        setReaction(pick(REACTIONS.streaming!));
        setFace(pick(FACES.happy));
        break;
      case "compaction":
        setMood("thinking");
        setReaction(pick(REACTIONS.compaction!));
        setFace(pick(FACES.thinking));
        break;
      case "agent_spawn":
        setMood("excited");
        setReaction(pick(REACTIONS.agent_spawn!));
        setFace(pick(FACES.excited));
        break;
      case "error":
        setMood("worried");
        setReaction(pick(REACTIONS.error!));
        setFace(pick(FACES.worried));
        break;
      case "turn_end":
      case "idle":
        setMood("idle");
        setReaction(pick(REACTIONS.idle_short!));
        setFace(pick(FACES.idle));
        break;
    }

    // Set idle timer for personality idle messages
    idleTimerRef.current = setTimeout(() => {
      setMood("idle");
      setReaction(pick(REACTIONS.idle_long!));
      setFace(pick(FACES.idle));

      // Deeper idle
      idleTimerRef.current = setTimeout(() => {
        setMood("sleeping");
        setReaction(pick(REACTIONS.idle_very_long!));
        setFace(pick(FACES.sleeping));
      }, 120_000); // 2 min → sleeping
    }, 30_000); // 30s → long idle

    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, [lastEvent]);

  // Milestone reactions
  useEffect(() => {
    if (toolUseCount >= 100 && lastToolMilestone.current < 100) {
      lastToolMilestone.current = 100;
      setMood("celebrating");
      setReaction(pick(REACTIONS.tools_100!));
      setFace(pick(FACES.celebrating));
    } else if (toolUseCount >= 50 && lastToolMilestone.current < 50) {
      lastToolMilestone.current = 50;
      setMood("excited");
      setReaction(pick(REACTIONS.tools_50!));
      setFace(pick(FACES.excited));
    } else if (toolUseCount >= 10 && lastToolMilestone.current < 10) {
      lastToolMilestone.current = 10;
      setMood("happy");
      setReaction(pick(REACTIONS.tools_10!));
      setFace(pick(FACES.happy));
    }
  }, [toolUseCount]);

  useEffect(() => {
    if (tokenCount >= 100_000 && lastTokenMilestone.current < 100_000) {
      lastTokenMilestone.current = 100_000;
      setMood("excited");
      setReaction(pick(REACTIONS.tokens_100k!));
      setFace(pick(FACES.excited));
    } else if (tokenCount >= 50_000 && lastTokenMilestone.current < 50_000) {
      lastTokenMilestone.current = 50_000;
      setReaction(pick(REACTIONS.tokens_50k!));
    }
  }, [tokenCount]);

  // Shorten CWD
  const home = process.env.HOME ?? "";
  const shortCwd = home && workingDirectory.startsWith(home)
    ? "~" + workingDirectory.slice(home.length)
    : workingDirectory;

  // Mood color
  const moodColor = mood === "happy" || mood === "celebrating" || mood === "excited"
    ? theme.success
    : mood === "worried" ? theme.error
    : mood === "thinking" || mood === "working" ? theme.warning
    : mood === "sleeping" ? theme.dimmed
    : theme.primary;

  // Context bar
  const ctxPct = contextWindowSize && contextWindowSize > 0 && tokenCount > 0
    ? Math.min(100, Math.round((tokenCount / contextWindowSize) * 100))
    : 0;
  const ctxBarLen = 8;
  const ctxFilled = Math.round(ctxBarLen * ctxPct / 100);
  const ctxBar = "\u2588".repeat(ctxFilled) + "\u2591".repeat(ctxBarLen - ctxFilled);
  const ctxColor = ctxPct > 85 ? theme.error : ctxPct > 60 ? theme.warning : theme.success;

  // Permission mode color
  const pmColor = permissionMode === "auto" ? theme.warning
    : permissionMode === "deny" ? theme.error
    : permissionMode === "plan" ? (theme.info ?? theme.primary)
    : theme.dimmed;

  return (
    <Box flexDirection="column">
      {/* Top line: Brand + Kodi face + reaction */}
      <Box gap={1} paddingX={1}>
        <Text bold color={theme.primary}>KCode</Text>
        <Text color={theme.dimmed}>v{version}</Text>
        <Text color={theme.dimmed}>•</Text>
        <Text color={theme.dimmed}>Kulvex Code by Astrolexis</Text>
        <Text color={theme.dimmed}>│</Text>
        <Text color={moodColor}>{face}</Text>
        <Text color={theme.dimmed} italic>{reaction}</Text>
      </Box>
      {/* Bottom line: Status bar */}
      <Box gap={1} paddingX={1}>
        <Text color={theme.success}>{model}</Text>
        {permissionMode && (
          <>
            <Text color={theme.dimmed}>•</Text>
            <Text color={pmColor}>{permissionMode}</Text>
          </>
        )}
        <Text color={theme.dimmed}>•</Text>
        <Text color={theme.dimmed}>{shortCwd}</Text>
        {(tokenCount > 0 || toolUseCount > 0) && (
          <>
            <Text color={theme.dimmed}>•</Text>
            <Text color={theme.dimmed}>tok:{tokenCount.toLocaleString()}</Text>
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
      <Box paddingX={1}>
        <Text color={theme.dimmed}>{"─".repeat(70)}</Text>
      </Box>
    </Box>
  );
}
