// KCode - QuestionDialog component
// Reusable modal for yes/no questions to the user
// Used for model resume prompt, auto-test confirmation, etc.

import { Box, Text, useInput } from "ink";
import React from "react";
import { useTheme } from "../ThemeContext.js";

export interface QuestionOption {
  key: string;
  label: string;
  color?: string;
}

interface QuestionDialogProps {
  title: string;
  message: string;
  detail?: string;
  options?: QuestionOption[];
  onChoice: (key: string) => void;
  isActive: boolean;
}

export default function QuestionDialog({
  title,
  message,
  detail,
  options,
  onChoice,
  isActive,
}: QuestionDialogProps) {
  const { theme } = useTheme();

  const defaultOptions: QuestionOption[] = options ?? [
    { key: "y", label: "Yes", color: theme.success },
    { key: "n", label: "No", color: theme.error },
  ];

  useInput(
    (input, key) => {
      if (!isActive) return;
      const pressed = input.toLowerCase();
      // Match by key
      const matched = defaultOptions.find((o) => o.key.toLowerCase() === pressed);
      if (matched) {
        onChoice(matched.key);
        return;
      }
      // Enter defaults to first option
      if (key.return) {
        onChoice(defaultOptions[0]!.key);
        return;
      }
      // Escape defaults to last option
      if (key.escape) {
        onChoice(defaultOptions[defaultOptions.length - 1]!.key);
      }
    },
    { isActive },
  );

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.info ?? theme.primary}
      paddingX={1}
      marginY={0}
      width={process.stdout.columns || 80}
    >
      <Text bold color={theme.info ?? theme.primary}>
        {"?  " + title}
      </Text>
      <Box marginTop={1}>
        <Text>{message}</Text>
      </Box>
      {detail && (
        <Box>
          <Text color={theme.dimmed}>{detail}</Text>
        </Box>
      )}
      <Box marginTop={1} gap={2}>
        {defaultOptions.map((opt) => (
          <Text key={opt.key}>
            <Text bold color={opt.color ?? theme.primary}>
              [{opt.key}]
            </Text>
            <Text> {opt.label}</Text>
          </Text>
        ))}
      </Box>
    </Box>
  );
}
