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

// ─── ASCII Art Sprites (5 lines tall, ~10 chars wide) ───────────
// Each sprite is an array of 5 lines

const SPRITES: Record<KodiMood, string[][]> = {
  idle: [[
    "   ╭───╮   ",
    "   │• ◡•│   ",
    "   ╰─┬─╯   ",
    "    /|\\    ",
    "    / \\    ",
  ]],
  happy: [[
    "   ╭───╮   ",
    "   │^ ◡^│   ",
    "   ╰─┬─╯   ",
    "   \\|/    ",
    "    / \\    ",
  ], [
    "   ╭───╮   ",
    "   │◕ ◡◕│   ",
    "   ╰─┬─╯   ",
    "    /|\\    ",
    "    / \\    ",
  ]],
  excited: [[
    "  ╭─────╮  ",
    "  │★ ◡ ★│  ",
    "  ╰──┬──╯  ",
    "  \\(|)/   ",
    "    / \\    ",
  ], [
    "  ╭─────╮  ",
    "  │✧ ▽ ✧│  ",
    "  ╰──┬──╯  ",
    "   \\|/    ",
    "    / \\    ",
  ]],
  thinking: [[
    "   ╭───╮ ? ",
    "   │• _ •│  ",
    "   ╰─┬─╯   ",
    "    /|     ",
    "    / \\    ",
  ], [
    "   ╭───╮   ",
    "   │◦ ‿ ◦│ …",
    "   ╰─┬─╯   ",
    "     |\\    ",
    "    / \\    ",
  ]],
  working: [[
    "   ╭───╮ ⚡",
    "   │• ‸ •│  ",
    "   ╰─┬─╯   ",
    "    /|\\  ▌ ",
    "    / \\    ",
  ], [
    "   ╭───╮ ⚙ ",
    "   │◦ ‸ ◦│  ",
    "   ╰─┬─╯   ",
    "    /|\\  ▌ ",
    "    / \\    ",
  ]],
  worried: [[
    "   ╭───╮   ",
    "   │° △ °│  ",
    "   ╰─┬─╯   ",
    "    /|\\    ",
    "    / \\    ",
  ], [
    "   ╭───╮ ! ",
    "   │• ~ •│  ",
    "   ╰─┬─╯   ",
    "    /|\\    ",
    "    / \\    ",
  ]],
  sleeping: [[
    "   ╭───╮   ",
    "   │- _ -│ z",
    "   ╰─┬─╯ z ",
    "    /|  z   ",
    "    / \\    ",
  ]],
  celebrating: [[
    " ✦╭─────╮✦ ",
    "  │★ ▽ ★│  ",
    "  ╰──┬──╯  ",
    " ♪\\(|)/♪  ",
    "    / \\    ",
  ], [
    " ♪╭─────╮♪ ",
    "  │◕ ▽ ◕│  ",
    "  ╰──┬──╯  ",
    "  \\(|)/   ",
    "   _/ \\_   ",
  ]],
  curious: [[
    "   ╭───╮   ",
    "   │• ᵕ •│ ?",
    "   ╰─┬─╯   ",
    "    /|     ",
    "    / \\    ",
  ]],
};

// ─── Reaction Lines ─────────────────────────────────────────────

const REACTIONS: Record<string, string[]> = {
  tool_Bash:       ["Running your command...", "Shell time!", "Executing...", "Let me run that!"],
  tool_Read:       ["Reading that file...", "Let me peek inside...", "Checking the code..."],
  tool_Write:      ["Writing code!", "Creating file...", "Crafting something new!"],
  tool_Edit:       ["Editing... surgical precision!", "Tweaking the code...", "Making changes..."],
  tool_Grep:       ["Searching the codebase...", "Hunting patterns...", "Scanning files..."],
  tool_Glob:       ["Finding files...", "File detective mode!", "Globbing away..."],
  tool_GitCommit:  ["Committing changes!", "Saving progress!", "Snapshot time!"],
  tool_GitStatus:  ["Checking git status...", "Repo health check!"],
  tool_TestRunner: ["Running tests... fingers crossed!", "Test time!", "Validating..."],
  tool_WebSearch:  ["Searching the web...", "Browsing...", "Let me look that up!"],
  tool_WebFetch:   ["Fetching that page...", "Downloading content..."],
  tool_Agent:      ["Spawning agent!", "Clone deployed!", "Teamwork activated!"],
  tool_MultiEdit:  ["Multi-edit mode!", "Refactoring...", "Bulk changes incoming!"],
  tool_default:    ["Working on it...", "Processing...", "On it, boss!"],

  done_success:    ["Done! Nailed it!", "Got it! ✓", "All good!", "There ya go!", "Easy peasy!"],
  done_error:      ["Oops! Something failed...", "Uh oh... let me check", "Error! But we'll fix it", "Yikes! That didn't work"],

  thinking:        ["Hmm... let me think...", "Pondering this one...", "Processing... give me a sec", "Analyzing the situation..."],
  streaming:       ["Composing a response...", "Writing my thoughts...", "Here's what I think..."],
  idle_short:      ["Ready for action!", "What's next?", "Standing by!", "At your service!", "Awaiting orders!"],
  idle_long:       ["Still here... take your time!", "Waiting patiently...", "*stretches*", "No rush, I'm here!"],
  idle_very_long:  ["*yawns* getting sleepy...", "You there? I'm still here!", "*whistles a tune*", "Maybe a coffee break?"],

  test_pass:       ["ALL TESTS PASSED! Ship it!", "Green across the board!", "Victory is ours!", "Tests: CRUSHED IT!"],
  test_fail:       ["Tests failed! Back to debugging!", "Bugs detected! Let's hunt them!", "Not quite... let's fix this!"],
  commit:          ["Committed! Progress saved!", "Another milestone!", "Checkpoint reached!"],
  compaction:      ["Compacting memory... brb!", "Making room in my brain...", "Spring cleaning!"],
  agent_spawn:     ["Agent deployed! Divide & conquer!", "Team is growing!", "More hands on deck!"],
  error:           ["Something broke! Don't panic!", "Error encountered... we got this!", "Ouch! Let's figure this out"],

  tools_10:        ["10 tools used! Productive session!", "Getting warmed up!"],
  tools_50:        ["50 tools! We're in BEAST MODE!", "Unstoppable!"],
  tools_100:       ["100 TOOLS! LEGENDARY SESSION!", "Absolute coding machine!"],
  tokens_50k:      ["50k tokens deep! Epic journey!", "Deep in the code mines!"],
  tokens_100k:     ["100k tokens! MARATHON SESSION!", "We've written a novel!"],

  startup:         ["Let's code!", "Ready to roll!", "Hello, world!", "Let's build something amazing!", "Booting up... systems online!"],
};

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
  const [sprite, setSprite] = useState(SPRITES.idle[0]!);
  const lastToolMilestone = useRef(0);
  const lastTokenMilestone = useRef(0);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [elapsed, setElapsed] = useState(0);

  // Update elapsed time every 10s
  useEffect(() => {
    if (!sessionStartTime) return;
    const timer = setInterval(() => setElapsed(Date.now() - sessionStartTime), 10000);
    return () => clearInterval(timer);
  }, [sessionStartTime]);

  // Helper to set mood + sprite + reaction together
  const react = (newMood: KodiMood, reactionKey: string) => {
    setMood(newMood);
    setSprite(pick(SPRITES[newMood]));
    setReaction(pick(REACTIONS[reactionKey] ?? REACTIONS.tool_default!));
  };

  // React to events
  useEffect(() => {
    if (!lastEvent) return;

    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }

    switch (lastEvent.type) {
      case "tool_start": {
        const key = `tool_${lastEvent.detail ?? "default"}`;
        react("working", REACTIONS[key] ? key : "tool_default");
        break;
      }
      case "tool_done": {
        if (lastEvent.detail === "TestRunner") react("celebrating", "test_pass");
        else if (lastEvent.detail === "GitCommit") react("celebrating", "commit");
        else react("happy", "done_success");
        break;
      }
      case "tool_error":
      case "test_fail":
        react("worried", "done_error");
        break;
      case "thinking":
        react("thinking", "thinking");
        break;
      case "streaming":
        react("happy", "streaming");
        break;
      case "compaction":
        react("thinking", "compaction");
        break;
      case "agent_spawn":
        react("excited", "agent_spawn");
        break;
      case "error":
        react("worried", "error");
        break;
      case "turn_end":
      case "idle":
        react("idle", "idle_short");
        break;
    }

    // Idle progression timers
    idleTimerRef.current = setTimeout(() => {
      react("idle", "idle_long");
      idleTimerRef.current = setTimeout(() => {
        react("sleeping", "idle_very_long");
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
      react("celebrating", "tools_100");
    } else if (toolUseCount >= 50 && lastToolMilestone.current < 50) {
      lastToolMilestone.current = 50;
      react("excited", "tools_50");
    } else if (toolUseCount >= 10 && lastToolMilestone.current < 10) {
      lastToolMilestone.current = 10;
      react("happy", "tools_10");
    }
  }, [toolUseCount]);

  useEffect(() => {
    if (tokenCount >= 100_000 && lastTokenMilestone.current < 100_000) {
      lastTokenMilestone.current = 100_000;
      react("excited", "tokens_100k");
    } else if (tokenCount >= 50_000 && lastTokenMilestone.current < 50_000) {
      lastTokenMilestone.current = 50_000;
      react("happy", "tokens_50k");
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
  // Layout: Kodi sprite on the left, info panel on the right
  //
  // ╭───────────────────────────────────────────────────────────╮
  // │    ╭───╮      KCode v1.0.0 — Kulvex Code by Astrolexis  │
  // │    │• ◡•│     mnemo:mark5-80b • auto • ~/project         │
  // │    ╰─┬─╯      tok:1,234 • tools:5 • [████░░░░░░] 12%    │
  // │     /|\       "Ready for action!"                         │
  // │     / \                                                   │
  // ╰───────────────────────────────────────────────────────────╯

  return (
    <Box flexDirection="column">
      <Box paddingX={1}>
        <Text color={theme.dimmed}>{"╭" + "─".repeat(72) + "╮"}</Text>
      </Box>
      <Box flexDirection="row" paddingX={1}>
        {/* Kodi sprite */}
        <Box flexDirection="column" width={14}>
          {sprite.map((line, i) => (
            <Box key={i} paddingX={1}>
              <Text color={moodColor}>{line}</Text>
            </Box>
          ))}
        </Box>
        {/* Info panel */}
        <Box flexDirection="column" flexGrow={1}>
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
          {/* Line 5: empty for spacing */}
          <Text> </Text>
        </Box>
      </Box>
      <Box paddingX={1}>
        <Text color={theme.dimmed}>{"╰" + "─".repeat(72) + "╯"}</Text>
      </Box>
    </Box>
  );
}
