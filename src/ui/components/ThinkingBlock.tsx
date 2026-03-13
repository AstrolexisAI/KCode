// KCode - ThinkingBlock component
// Collapsible display for model thinking/reasoning content

import React, { useState } from "react";
import { Box, Text } from "ink";
import { useTheme } from "../ThemeContext.js";

interface ThinkingBlockProps {
  /** The thinking text content */
  text: string;
  /** Whether thinking is still streaming */
  isStreaming: boolean;
  /** Whether to start expanded (default: false) */
  defaultExpanded?: boolean;
}

const BORDER_CHAR = "│";
const MAX_PREVIEW_LENGTH = 60;

export default function ThinkingBlock({
  text,
  isStreaming,
  defaultExpanded = false,
}: ThinkingBlockProps) {
  const { theme } = useTheme();
  const [expanded, setExpanded] = useState(defaultExpanded);

  const charCount = text.length;
  const lineCount = text.split("\n").length;

  // While streaming, show a live preview
  if (isStreaming) {
    const lastLine = text.split("\n").pop() ?? "";
    const preview =
      lastLine.length > MAX_PREVIEW_LENGTH
        ? lastLine.slice(0, MAX_PREVIEW_LENGTH) + "..."
        : lastLine;

    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Text dimColor color={theme.warning}>
          {"💭 Thinking"}
          {charCount > 0 ? ` (${charCount} chars)...` : "..."}
        </Text>
        {charCount > 0 && (
          <Box paddingLeft={1}>
            <Text dimColor>
              {BORDER_CHAR} {preview}
            </Text>
          </Box>
        )}
      </Box>
    );
  }

  // Completed thinking - collapsed view
  if (!expanded) {
    return (
      <Box paddingLeft={2}>
        <Text color={theme.dimmed}>
          {"💭 Thinking ("}
          {charCount} chars, {lineCount} {lineCount === 1 ? "line" : "lines"}
          {") ▸ collapsed"}
        </Text>
      </Box>
    );
  }

  // Completed thinking - expanded view
  const lines = text.split("\n");

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text color={theme.dimmed}>
        {"💭 Thinking ("}
        {charCount} chars{") ▾ expanded"}
      </Text>
      <Box
        flexDirection="column"
        paddingLeft={1}
        borderStyle="single"
        borderLeft={true}
        borderRight={false}
        borderTop={false}
        borderBottom={false}
        borderColor={theme.dimmed}
      >
        {lines.map((line, i) => (
          <Text key={i} dimColor italic>
            {line}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
