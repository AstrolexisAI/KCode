// KCode - Voice Indicator Component
// Shows recording state, audio level, and partial transcription in the terminal UI.

import { Box, Text } from "ink";
import React from "react";
import type { VoiceState } from "../../core/voice/types.js";
import { useTheme } from "../ThemeContext.js";

// ─── Types ─────────────────────────────────────────────────────

interface VoiceIndicatorProps {
  /** Current voice session state */
  state: VoiceState;
  /** Audio level (0.0 to 1.0) */
  level: number;
  /** Partial transcription text while processing */
  partialText: string;
}

// ─── Level Bar ─────────────────────────────────────────────────

const LEVEL_CHARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

function levelToBar(level: number): string {
  // Clamp level to [0, 1]
  const clamped = Math.max(0, Math.min(1, level));
  // 8 bar segments to show overall level
  const barLength = 8;
  const filled = Math.round(clamped * barLength);
  let bar = "";
  for (let i = 0; i < barLength; i++) {
    if (i < filled) {
      // Use progressively taller blocks for filled segments
      const charIdx = Math.min(LEVEL_CHARS.length - 1, Math.round((i / barLength) * (LEVEL_CHARS.length - 1)));
      bar += LEVEL_CHARS[charIdx];
    } else {
      bar += LEVEL_CHARS[0];
    }
  }
  return bar;
}

// ─── State Label ───────────────────────────────────────────────

function stateLabel(state: VoiceState): { icon: string; label: string } {
  switch (state) {
    case "idle":
      return { icon: "○", label: "Voice idle" };
    case "calibrating":
      return { icon: "◎", label: "Calibrating..." };
    case "listening":
      return { icon: "●", label: "Listening" };
    case "processing":
      return { icon: "◉", label: "Transcribing..." };
    case "speaking":
      return { icon: "◆", label: "Speaking" };
    default:
      return { icon: "?", label: "Unknown" };
  }
}

// ─── Component ─────────────────────────────────────────────────

export default function VoiceIndicator({ state, level, partialText }: VoiceIndicatorProps) {
  const { theme } = useTheme();

  if (state === "idle") return null;

  const { icon, label } = stateLabel(state);

  const stateColor =
    state === "listening"
      ? theme.success
      : state === "processing"
        ? theme.warning
        : state === "speaking"
          ? theme.accent
          : theme.dimmed;

  return (
    <Box flexDirection="row" gap={1}>
      <Text color={stateColor}>{icon}</Text>
      <Text color={stateColor}>{label}</Text>
      {state === "listening" && (
        <Text color={theme.accent}>{levelToBar(level)}</Text>
      )}
      {partialText && (
        <Text color={theme.dimmed} italic>
          {partialText.length > 60 ? "..." + partialText.slice(-57) : partialText}
        </Text>
      )}
    </Box>
  );
}
