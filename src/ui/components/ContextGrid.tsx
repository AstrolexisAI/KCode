// KCode - ContextGrid component
// Visual grid showing context window usage as colored cells

import React from "react";
import { Box, Text } from "ink";
import { useTheme } from "../ThemeContext.js";

interface ContextBreakdown {
  /** Total tokens used */
  totalTokens: number;
  /** Context window size (max tokens) */
  contextWindowSize: number;
  /** Estimated tokens from system prompt */
  systemTokens: number;
  /** Estimated tokens from user messages */
  messageTokens: number;
  /** Estimated tokens from tool results */
  toolTokens: number;
}

interface ContextGridProps {
  breakdown: ContextBreakdown;
}

export default function ContextGrid({ breakdown }: ContextGridProps) {
  const { theme } = useTheme();
  const { totalTokens, contextWindowSize, systemTokens, messageTokens, toolTokens } = breakdown;

  if (contextWindowSize <= 0) return null;

  const pct = Math.min(100, Math.round((totalTokens / contextWindowSize) * 100));
  const remaining = Math.max(0, contextWindowSize - totalTokens);

  // Calculate percentages for each category
  const totalCategorized = systemTokens + messageTokens + toolTokens;
  const scale = totalCategorized > 0 ? totalTokens / totalCategorized : 0;

  const systemCells = Math.round((systemTokens * scale / contextWindowSize) * 100);
  const messageCells = Math.round((messageTokens * scale / contextWindowSize) * 100);
  const toolCells = Math.round((toolTokens * scale / contextWindowSize) * 100);
  const freeCells = Math.max(0, 100 - systemCells - messageCells - toolCells);

  // Build the grid — each cell is ~1% of context
  // Use a compact 50-char bar (each char = 2%)
  const barLen = 50;
  const toBar = (cells: number) => Math.round(cells / 2);

  const sysBar = toBar(systemCells);
  const msgBar = toBar(messageCells);
  const toolBar = toBar(toolCells);
  const freeBar = Math.max(0, barLen - sysBar - msgBar - toolBar);

  const gridParts: Array<{ char: string; color: string }> = [];
  for (let i = 0; i < sysBar; i++) gridParts.push({ char: "\u2588", color: "red" });
  for (let i = 0; i < msgBar; i++) gridParts.push({ char: "\u2588", color: "yellow" });
  for (let i = 0; i < toolBar; i++) gridParts.push({ char: "\u2588", color: "blue" });
  for (let i = 0; i < freeBar; i++) gridParts.push({ char: "\u2591", color: "green" });

  const statusColor = pct > 85 ? theme.error : pct > 60 ? theme.warning : theme.success;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box gap={1}>
        <Text bold color={theme.primary}>Context</Text>
        <Text color={theme.dimmed}>[</Text>
        {gridParts.map((p, i) => (
          <Text key={i} color={p.color}>{p.char}</Text>
        ))}
        <Text color={theme.dimmed}>]</Text>
        <Text bold color={statusColor}>{pct}%</Text>
      </Box>
      <Box gap={2} paddingLeft={2}>
        <Text color={theme.dimmed}>
          {totalTokens.toLocaleString()}/{contextWindowSize.toLocaleString()} tok
        </Text>
        <Text color={theme.dimmed}>~{Math.round(remaining / 1000)}k remaining</Text>
        <Text color={theme.dimmed}>|</Text>
        <Text color="red">{"\u25A0"} sys</Text>
        <Text color="yellow">{"\u25A0"} msg</Text>
        <Text color="blue">{"\u25A0"} tool</Text>
        <Text color="green">{"\u25A0"} free</Text>
      </Box>
    </Box>
  );
}
