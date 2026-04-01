// KCode - ThinkingBlock component
// Visually striking display for model thinking/reasoning content

import { Box, Text } from "ink";
import React, { useEffect, useRef, useState } from "react";
import { CHARS_PER_TOKEN } from "../../core/token-budget.js";
import { useTheme } from "../ThemeContext.js";

interface ThinkingBlockProps {
  /** The thinking text content */
  text: string;
  /** Whether thinking is still streaming */
  isStreaming: boolean;
  /** Whether to start expanded (default: false) */
  defaultExpanded?: boolean;
}

const MAX_PREVIEW_LINES = 4;
const BRAIN = "🧠";

// Pulsing frames for the live thinking indicator
const PULSE_FRAMES = ["⣀", "⣤", "⣶", "⣿", "⣶", "⣤"];
const SPARK_FRAMES = ["✦", "✧", "✦", "✧", "⚡", "✦"];

export default function ThinkingBlock({
  text,
  isStreaming,
  defaultExpanded = false,
}: ThinkingBlockProps) {
  const { theme } = useTheme();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [frame, setFrame] = useState(0);
  const startTimeRef = useRef(Date.now());

  // Animate pulse during streaming
  useEffect(() => {
    if (!isStreaming) return;
    const timer = setInterval(() => {
      setFrame((prev) => prev + 1);
    }, 120);
    return () => clearInterval(timer);
  }, [isStreaming]);

  const charCount = text.length;
  const lineCount = text.split("\n").length;
  const elapsed = Math.round((Date.now() - startTimeRef.current) / 1000);

  // Violet/purple — always use accent (purple across all themes)
  const violet = theme.accent;

  // While streaming — full-width glowing banner
  if (isStreaming) {
    const pulse = PULSE_FRAMES[frame % PULSE_FRAMES.length];
    const spark = SPARK_FRAMES[frame % SPARK_FRAMES.length];

    // Show last few lines as live preview
    const lines = text.split("\n");
    const previewLines = lines.slice(-MAX_PREVIEW_LINES);
    const tokEstimate = Math.round(charCount / CHARS_PER_TOKEN);
    const statsText = `${tokEstimate > 0 ? `~${tokEstimate} tok` : ""}${elapsed > 0 ? ` · ${elapsed}s` : ""}`;

    return (
      <Box flexDirection="column" paddingLeft={1}>
        {/* Header banner */}
        <Box>
          <Text color={violet} bold>
            {spark} {BRAIN} Reasoning {pulse}
          </Text>
          {statsText && (
            <Text color={violet} dimColor>
              {"  "}
              {statsText}
            </Text>
          )}
        </Box>
        {/* Live preview with violet left border */}
        {charCount > 0 && (
          <Box
            flexDirection="column"
            paddingLeft={1}
            borderStyle="bold"
            borderLeft={true}
            borderRight={false}
            borderTop={false}
            borderBottom={false}
            borderColor={violet}
          >
            {previewLines.map((line, i) => (
              <Text key={i} color={violet} dimColor italic>
                {line.length > 120 ? line.slice(0, 120) + "…" : line}
              </Text>
            ))}
            {lines.length > MAX_PREVIEW_LINES && (
              <Text dimColor color={violet}>
                {"  ⋮ "}
                {lines.length - MAX_PREVIEW_LINES} more lines above
              </Text>
            )}
          </Box>
        )}
      </Box>
    );
  }

  // Completed thinking — collapsed view
  if (!expanded) {
    const tokEstimate = Math.round(charCount / CHARS_PER_TOKEN);
    return (
      <Box paddingLeft={1}>
        <Text color={violet}>{BRAIN} </Text>
        <Text color={violet} dimColor>
          Reasoned ({tokEstimate > 1000 ? `${(tokEstimate / 1000).toFixed(1)}K` : tokEstimate} tok,{" "}
          {lineCount} {lineCount === 1 ? "line" : "lines"}) ▸
        </Text>
      </Box>
    );
  }

  // Completed thinking — expanded view
  const lines = text.split("\n");

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text color={violet}>
        {BRAIN}{" "}
        <Text color={violet} dimColor>
          Reasoned ({charCount} chars) ▾
        </Text>
      </Text>
      <Box
        flexDirection="column"
        paddingLeft={1}
        borderStyle="bold"
        borderLeft={true}
        borderRight={false}
        borderTop={false}
        borderBottom={false}
        borderColor={violet}
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
