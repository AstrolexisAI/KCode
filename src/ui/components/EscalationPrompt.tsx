// KCode - Cloud Escalation Prompt
// Modal that captures Y/N/Esc when cloud second opinion is available.
// Input prompt is hidden while this is active.

import { Box, Text, useInput } from "ink";
import React from "react";
import { useTheme } from "../ThemeContext.js";

interface EscalationPromptProps {
  count: number;
  provider: string;
  reason: string;
  isActive: boolean;
  onChoice: (approved: boolean) => void;
}

export default function EscalationPrompt({
  count,
  provider,
  reason,
  isActive,
  onChoice,
}: EscalationPromptProps) {
  const theme = useTheme();

  useInput(
    (input, key) => {
      if (!isActive) return;
      const lower = input.toLowerCase();
      if (lower === "y" || key.return) {
        onChoice(true);
      } else if (lower === "n" || key.escape) {
        onChoice(false);
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
        {"⚠️  Second Opinion Available"}
      </Text>
      <Text color={theme.dimmed}>{""}</Text>
      <Text>
        {"  "}{reason}
      </Text>
      <Text color={theme.dimmed}>{""}</Text>
      <Text>
        {"  Re-verify with "}
        <Text color="cyan" bold>{"☁ "}{provider}</Text>
        {"?"}
      </Text>
      <Text color={theme.dimmed}>{""}</Text>
      <Box gap={2} marginLeft={2}>
        <Text>
          <Text bold color="green" inverse>{" Y "}</Text>
          <Text color={theme.dimmed}>{" Escalate to cloud"}</Text>
        </Text>
        <Text>
          <Text bold color="red" inverse>{" N "}</Text>
          <Text color={theme.dimmed}>{" Skip (Esc)"}</Text>
        </Text>
      </Box>
    </Box>
  );
}
