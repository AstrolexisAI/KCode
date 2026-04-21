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
        <Text color={theme.dimmed}>{count} finding{count !== 1 ? "s" : ""} need review</Text>
      </Text>
      <Text color={theme.dimmed}>{reason}</Text>
      <Text color={theme.dimmed}>{""}</Text>
      <Text dimColor>{"  Choose a model for re-verification (↑↓ navigate · Enter select · Esc skip):"}</Text>
      <Box flexDirection="column" marginTop={1} marginLeft={2}>
        {availableModels.map((m, i) => {
          const isSel = i === selectedIdx;
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
        <Box marginTop={1}>
          <Text dimColor>{"  ── "}</Text>
          <Text color="red">{"Skip (Esc / N)"}</Text>
        </Box>
      </Box>
    </Box>
  );
}
