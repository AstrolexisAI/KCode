// KCode - DiffViewer component
// Interactive diff viewer showing git diffs with turn-by-turn navigation

import { Box, Text, useInput } from "ink";
import React, { useEffect, useState } from "react";
import { useTheme } from "../ThemeContext.js";

interface DiffViewerProps {
  /** Array of per-turn diffs (unified diff strings). Index 0 = current working diff. */
  diffs: string[];
  /** Whether this component is actively receiving input */
  isActive?: boolean;
  /** Called when the user presses Escape to close */
  onClose?: () => void;
}

function parseDiffLine(line: string): { color: string; prefix: string } {
  if (line.startsWith("+++") || line.startsWith("---")) {
    return { color: "cyan", prefix: "" };
  }
  if (line.startsWith("@@")) {
    return { color: "magenta", prefix: "" };
  }
  if (line.startsWith("+")) {
    return { color: "green", prefix: "" };
  }
  if (line.startsWith("-")) {
    return { color: "red", prefix: "" };
  }
  if (line.startsWith("diff ")) {
    return { color: "yellow", prefix: "" };
  }
  return { color: "white", prefix: "" };
}

export default function DiffViewer({ diffs, isActive = true, onClose }: DiffViewerProps) {
  const { theme } = useTheme();
  const [turnIndex, setTurnIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const maxVisible = 30;

  // Clamp turnIndex when diffs change
  useEffect(() => {
    if (turnIndex >= diffs.length) {
      setTurnIndex(Math.max(0, diffs.length - 1));
    }
  }, [diffs.length]);

  useInput((input, key) => {
    if (!isActive) return;

    if (key.escape && onClose) {
      onClose();
      return;
    }

    // Left/right arrow: navigate turns
    if (key.leftArrow) {
      setTurnIndex((prev) => Math.max(0, prev - 1));
      setScrollOffset(0);
      return;
    }
    if (key.rightArrow) {
      setTurnIndex((prev) => Math.min(diffs.length - 1, prev + 1));
      setScrollOffset(0);
      return;
    }

    // Up/down arrow: scroll
    if (key.upArrow) {
      setScrollOffset((prev) => Math.max(0, prev - 1));
      return;
    }
    if (key.downArrow) {
      setScrollOffset((prev) => prev + 1);
      return;
    }
  });

  if (diffs.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color={theme.dimmed}>No diffs available.</Text>
      </Box>
    );
  }

  const currentDiff = diffs[turnIndex] ?? "";
  const lines = currentDiff.split("\n");
  const visibleLines = lines.slice(scrollOffset, scrollOffset + maxVisible);

  // Count additions and deletions
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }

  const label = turnIndex === 0 ? "Working diff" : `Turn ${turnIndex}`;

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Header bar */}
      <Box gap={2}>
        <Text bold color={theme.primary}>
          Diff Viewer
        </Text>
        <Text color={theme.dimmed}>|</Text>
        <Text color={theme.warning}>{label}</Text>
        <Text color={theme.dimmed}>
          ({turnIndex + 1}/{diffs.length})
        </Text>
        <Text color={theme.dimmed}>|</Text>
        <Text color="green">+{additions}</Text>
        <Text color="red">-{deletions}</Text>
        <Text color={theme.dimmed}>| {lines.length} lines</Text>
      </Box>

      {/* Navigation hint */}
      <Text color={theme.dimmed}>
        {" "}
        {"\u2190\u2192"} turns {"\u2191\u2193"} scroll Esc close
      </Text>

      {/* Diff content */}
      <Box flexDirection="column" marginTop={1}>
        {visibleLines.map((line, i) => {
          const { color } = parseDiffLine(line);
          return (
            <Text key={scrollOffset + i} color={color}>
              {line}
            </Text>
          );
        })}
      </Box>

      {scrollOffset + maxVisible < lines.length && (
        <Text color={theme.dimmed}>
          {" "}
          ... {lines.length - scrollOffset - maxVisible} more lines below
        </Text>
      )}
    </Box>
  );
}
