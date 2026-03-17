// KCode - Header component
// Compact status bar that stays at the bottom, just above the input prompt

import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { useTheme } from "../ThemeContext.js";

interface HeaderProps {
  model: string;
  workingDirectory: string;
  tokenCount: number;
  toolUseCount: number;
  sessionStartTime?: number;
}

function formatSessionTime(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h${remMins.toString().padStart(2, "0")}m`;
}

export default function Header({ model, workingDirectory, tokenCount, toolUseCount, sessionStartTime }: HeaderProps) {
  const { theme } = useTheme();
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!sessionStartTime) return;
    const timer = setInterval(() => {
      setElapsed(Date.now() - sessionStartTime);
    }, 10000); // Update every 10s
    return () => clearInterval(timer);
  }, [sessionStartTime]);

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
      {sessionStartTime && elapsed > 0 && (
        <>
          <Text color={theme.dimmed}>|</Text>
          <Text color={theme.dimmed}>{formatSessionTime(elapsed)}</Text>
        </>
      )}
    </Box>
  );
}
