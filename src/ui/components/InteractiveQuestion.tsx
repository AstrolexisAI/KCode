// KCode - InteractiveQuestion component
// Shows a selectable list of options when the LLM asks a multiple-choice question.
// User navigates with arrow keys / numbers and submits with Enter.

import { Box, Text, useInput } from "ink";
import React, { useState } from "react";
import { useTheme } from "../ThemeContext.js";

interface InteractiveQuestionProps {
  question: string;
  options: string[];
  onSelect: (answer: string) => void;
  onCancel: () => void;
  isActive: boolean;
}

export default function InteractiveQuestion({
  question,
  options,
  onSelect,
  onCancel,
  isActive,
}: InteractiveQuestionProps) {
  const { theme } = useTheme();
  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput(
    (input, key) => {
      if (!isActive) return;

      if (key.escape) {
        onCancel();
      } else if (key.upArrow || input === "k") {
        setSelectedIndex((i) => (i > 0 ? i - 1 : options.length - 1));
      } else if (key.downArrow || input === "j") {
        setSelectedIndex((i) => (i < options.length - 1 ? i + 1 : 0));
      } else if (key.return) {
        onSelect(options[selectedIndex]!);
      } else {
        // Number keys: 1-9 select directly
        const num = parseInt(input);
        if (num >= 1 && num <= options.length) {
          onSelect(options[num - 1]!);
        }
      }
    },
    { isActive },
  );

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.info ?? theme.accent}
      paddingX={1}
      marginLeft={2}
      marginTop={0}
      width={(process.stdout.columns || 80) - 4}
    >
      <Text color={theme.info ?? theme.accent}>
        {"?  "}
        <Text bold>{question}</Text>
      </Text>
      <Box marginTop={1} flexDirection="column">
        {options.map((opt, i) => {
          const isSelected = i === selectedIndex;
          return (
            <Box key={i} gap={1}>
              <Text color={isSelected ? theme.primary : theme.dimmed} bold={isSelected}>
                {isSelected ? "▸ " : "  "}
                <Text color={theme.dimmed}>{i + 1}.</Text> {opt}
              </Text>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>↑↓ or 1-{options.length} to select, Enter to confirm, Esc to dismiss</Text>
      </Box>
    </Box>
  );
}
