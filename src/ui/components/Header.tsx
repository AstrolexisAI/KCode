// KCode - Header component
// Compact status bar that stays at the bottom, just above the input prompt

import React from "react";
import { Box, Text } from "ink";

interface HeaderProps {
  model: string;
  workingDirectory: string;
  tokenCount: number;
  toolUseCount: number;
}

export default function Header({ model, workingDirectory, tokenCount, toolUseCount }: HeaderProps) {
  // Shorten the CWD for display
  const home = process.env.HOME ?? "";
  const shortCwd = home && workingDirectory.startsWith(home)
    ? "~" + workingDirectory.slice(home.length)
    : workingDirectory;

  return (
    <Box gap={1} paddingX={1}>
      <Text bold color="cyan">KCode</Text>
      <Text dimColor>|</Text>
      <Text color="green">{model}</Text>
      <Text dimColor>|</Text>
      <Text dimColor>{shortCwd}</Text>
      {(tokenCount > 0 || toolUseCount > 0) && (
        <>
          <Text dimColor>|</Text>
          <Text dimColor>tok:{tokenCount.toLocaleString()}</Text>
          <Text dimColor>tools:{toolUseCount}</Text>
        </>
      )}
    </Box>
  );
}
