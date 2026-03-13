// KCode - Header component
// Compact status bar that stays at the bottom, just above the input prompt

import React from "react";
import { Box, Text } from "ink";
import { useTheme } from "../ThemeContext.js";

interface HeaderProps {
  model: string;
  workingDirectory: string;
  tokenCount: number;
  toolUseCount: number;
}

export default function Header({ model, workingDirectory, tokenCount, toolUseCount }: HeaderProps) {
  const { theme } = useTheme();

  // Shorten the CWD for display
  const home = process.env.HOME ?? "";
  const shortCwd = home && workingDirectory.startsWith(home)
    ? "~" + workingDirectory.slice(home.length)
    : workingDirectory;

  return (
    <Box gap={1} paddingX={1}>
      <Text bold color={theme.primary}>KCode</Text>
      <Text color={theme.dimmed}>|</Text>
      <Text color={theme.success}>{model}</Text>
      <Text color={theme.dimmed}>|</Text>
      <Text color={theme.dimmed}>{shortCwd}</Text>
      {(tokenCount > 0 || toolUseCount > 0) && (
        <>
          <Text color={theme.dimmed}>|</Text>
          <Text color={theme.dimmed}>tok:{tokenCount.toLocaleString()}</Text>
          <Text color={theme.dimmed}>tools:{toolUseCount}</Text>
        </>
      )}
    </Box>
  );
}
