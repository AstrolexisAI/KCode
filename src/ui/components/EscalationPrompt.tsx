// KCode - Cloud Escalation Model Picker
// Shown after /scan when uncertain findings need cloud re-verification.
// User picks from available [analysis]/[reasoning] models, or skips.

import { Box, Text, useInput } from "ink";
import React, { useState } from "react";
import { useTheme } from "../ThemeContext.js";

export interface EscalationModel {
  name: string;
  provider: string;
  tags: string[];
}

interface EscalationPromptProps {
  count: number;
  reason: string;
  availableModels: EscalationModel[];
  isActive: boolean;
  /** Called with chosen model name, or null to skip */
  onChoice: (modelName: string | null) => void;
}

// Visible window for the list. Keeps the prompt readable even when
// 30+ models are registered. Selected item is always in view.
const VISIBLE_ROWS = 8;

export default function EscalationPrompt({
  count,
  reason,
  availableModels,
  isActive,
  onChoice,
}: EscalationPromptProps) {
  const { theme } = useTheme();
  const [selectedIdx, setSelectedIdx] = useState(0);

  useInput(
    (input, key) => {
      if (!isActive) return;
      if (key.upArrow || input === "k") {
        setSelectedIdx((i) => (i > 0 ? i - 1 : availableModels.length - 1));
      } else if (key.downArrow || input === "j") {
        setSelectedIdx((i) => (i < availableModels.length - 1 ? i + 1 : 0));
      } else if (key.pageUp || (key.ctrl && input === "u")) {
        setSelectedIdx((i) => Math.max(0, i - VISIBLE_ROWS));
      } else if (key.pageDown || (key.ctrl && input === "d")) {
        setSelectedIdx((i) => Math.min(availableModels.length - 1, i + VISIBLE_ROWS));
      } else if (input === "g") {
        setSelectedIdx(0);
      } else if (input === "G") {
        setSelectedIdx(availableModels.length - 1);
      } else if (key.return) {
        const chosen = availableModels[selectedIdx];
        onChoice(chosen ? chosen.name : null);
      } else if (key.escape || input === "n" || input === "N") {
        onChoice(null);
      }
    },
    { isActive },
  );

  if (!isActive) return null;

  // Compute visible window: center around selectedIdx when possible.
  const total = availableModels.length;
  const windowStart = Math.max(
    0,
    Math.min(selectedIdx - Math.floor(VISIBLE_ROWS / 2), total - VISIBLE_ROWS),
  );
  const windowEnd = Math.min(total, windowStart + VISIBLE_ROWS);
  const visibleModels = availableModels.slice(windowStart, windowEnd);
  const hasAbove = windowStart > 0;
  const hasBelow = windowEnd < total;

  return (
    <Box
      flexDirection="column"
      marginLeft={2}
      marginTop={1}
      marginBottom={1}
      borderStyle="round"
      borderColor={theme.warning}
      paddingX={2}
      paddingY={1}
    >
      <Text color={theme.warning} bold>
        {"☁  Second Opinion Available — "}
        <Text color={theme.dimmed}>
          {count} finding{count !== 1 ? "s" : ""} need review
        </Text>
      </Text>
      <Text color={theme.dimmed}>{reason}</Text>
      <Text color={theme.dimmed}>{""}</Text>
      <Text dimColor>
        {"  ↑↓ / jk · PgUp/PgDn · g/G · Enter select · Esc skip   "}
        <Text color={theme.primary} bold>
          [{selectedIdx + 1}/{total}]
        </Text>
      </Text>
      <Box flexDirection="column" marginTop={1} marginLeft={2}>
        {hasAbove && <Text dimColor>{"  ▲ " + windowStart + " more above"}</Text>}
        {visibleModels.map((m, i) => {
          const absoluteIdx = windowStart + i;
          const isSel = absoluteIdx === selectedIdx;
          const tagStr = m.tags.length > 0 ? "  " + m.tags.map((t) => `[${t}]`).join(" ") : "";
          return (
            <Box key={m.name} flexDirection="row">
              <Text color={isSel ? theme.primary : undefined} bold={isSel}>
                {isSel ? "▸ " : "  "}
                {m.name}
              </Text>
              {tagStr && <Text dimColor>{tagStr}</Text>}
            </Box>
          );
        })}
        {hasBelow && <Text dimColor>{"  ▼ " + (total - windowEnd) + " more below"}</Text>}
        <Box marginTop={1}>
          <Text dimColor>{"  ── "}</Text>
          <Text color="red">{"Skip (Esc / N)"}</Text>
        </Box>
      </Box>
    </Box>
  );
}
