// KCode - ToolTabs component
// Interactive tab bar showing active running tools/agents with status indicators

import { Box, Text } from "ink";
import React, { useEffect, useState } from "react";
import { useTheme } from "../ThemeContext.js";

// ─── Types ──────────────────────────────────────────────────────

export interface ToolTab {
  toolUseId: string;
  name: string;
  summary: string;
  status: "queued" | "running" | "done" | "error";
  startTime: number;
  durationMs?: number;
}

interface ToolTabsProps {
  tabs: ToolTab[];
  selectedIndex: number;
}

// ─── Helpers ────────────────────────────────────────────────────

function formatElapsed(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return `${mins}m${rem.toString().padStart(2, "0")}s`;
}

const STATUS_ICONS: Record<string, string> = {
  queued: "⧖",
  running: "◐",
  done: "✓",
  error: "✗",
};

const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"];

// ─── Component ──────────────────────────────────────────────────

export default function ToolTabs({ tabs, selectedIndex }: ToolTabsProps) {
  const { theme } = useTheme();
  const [frame, setFrame] = useState(0);
  const [now, setNow] = useState(Date.now());

  // Animate spinner for running tabs
  useEffect(() => {
    const hasRunning = tabs.some((t) => t.status === "running");
    if (!hasRunning) return;
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER_FRAMES.length);
      setNow(Date.now());
    }, 150);
    return () => clearInterval(timer);
  }, [tabs.length, tabs.some((t) => t.status === "running")]);

  if (tabs.length === 0) return null;

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={0}>
        {tabs.map((tab, i) => {
          const isSelected = i === selectedIndex;
          const isRunning = tab.status === "running";
          const isDone = tab.status === "done";
          const isError = tab.status === "error";

          // Status icon — animated for running
          const icon = isRunning ? SPINNER_FRAMES[frame] : (STATUS_ICONS[tab.status] ?? "?");

          // Color based on status
          const tabColor = isError
            ? theme.error
            : isDone
              ? theme.success
              : isRunning
                ? theme.warning
                : theme.dimmed;

          // Elapsed time
          const elapsed = isRunning
            ? formatElapsed(now - tab.startTime)
            : tab.durationMs
              ? formatElapsed(tab.durationMs)
              : "";

          // Tab label: truncate summary
          const label = tab.summary ? tab.summary.slice(0, 40) : tab.name;

          // Border style for selected tab
          const borderColor = isSelected ? tabColor : theme.dimmed;

          return (
            <Box key={tab.toolUseId} paddingX={0} marginRight={0}>
              {/* Tab with top border to indicate selection */}
              <Text color={borderColor}>{isSelected ? "┃" : "│"}</Text>
              <Text color={isSelected ? tabColor : theme.dimmed} bold={isSelected}>
                {" "}
                {icon} {tab.name}
                {tab.summary ? ": " : ""}
              </Text>
              {tab.summary && (
                <Text color={isSelected ? theme.assistantText : theme.dimmed}>{label}</Text>
              )}
              {elapsed && <Text color={theme.dimmed}> ({elapsed})</Text>}
              <Text color={borderColor}> {isSelected ? "┃" : "│"}</Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
