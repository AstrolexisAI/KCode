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
  contextWindowSize?: number;
  runningAgents?: number;
  sessionName?: string;
  permissionMode?: string;
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

function ContextBar({ used, total, theme }: { used: number; total: number; theme: any }) {
  if (total <= 0) return null;
  const pct = Math.min(100, Math.round((used / total) * 100));
  const barLen = 10;
  const filled = Math.round(barLen * pct / 100);
  const bar = "\u2588".repeat(filled) + "\u2591".repeat(barLen - filled);

  // Color based on usage: green < 60%, yellow 60-85%, red > 85%
  const color = pct > 85 ? theme.error : pct > 60 ? theme.warning : theme.success;

  return (
    <Text color={color}>[{bar}] {pct}%</Text>
  );
}

export default function Header({ model, workingDirectory, tokenCount, toolUseCount, sessionStartTime, contextWindowSize, runningAgents = 0, sessionName, permissionMode }: HeaderProps) {
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
      {sessionName && (
        <>
          <Text color={theme.dimmed}>|</Text>
          <Text color={theme.warning}>{sessionName}</Text>
        </>
      )}
      <Text color={theme.dimmed}>|</Text>
      <Text color={theme.success}>{model}</Text>
      {permissionMode && (
        <>
          <Text color={theme.dimmed}>|</Text>
          <Text color={permissionMode === "auto" ? theme.warning : permissionMode === "plan" ? theme.info ?? theme.primary : theme.dimmed}>{permissionMode}</Text>
        </>
      )}
      <Text color={theme.dimmed}>|</Text>
      <Text color={theme.dimmed}>{shortCwd}</Text>
      {(tokenCount > 0 || toolUseCount > 0) && (
        <>
          <Text color={theme.dimmed}>|</Text>
          <Text color={theme.dimmed}>tok:{tokenCount.toLocaleString()}</Text>
          <Text color={theme.dimmed}>tools:{toolUseCount}</Text>
        </>
      )}
      {runningAgents > 0 && (
        <>
          <Text color={theme.dimmed}>|</Text>
          <Text color={theme.warning}>agents:{runningAgents}</Text>
        </>
      )}
      {contextWindowSize && contextWindowSize > 0 && tokenCount > 0 && (
        <>
          <Text color={theme.dimmed}>|</Text>
          <ContextBar used={tokenCount} total={contextWindowSize} theme={theme} />
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
