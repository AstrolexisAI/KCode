// KCode - HunkSelector Component
// Reusable component for rendering a single diff hunk with syntax coloring,
// line numbers, and status indicators. Supports inline and side-by-side modes.

import { Box, Text } from "ink";
import type React from "react";
import type { DiffHunk } from "../../core/diff/types.js";

export interface HunkSelectorProps {
  /** The hunk to display */
  hunk: DiffHunk;
  /** Whether this hunk is the currently focused hunk */
  isCurrent: boolean;
  /** Display mode: unified inline or side-by-side columns */
  mode: "inline" | "side-by-side";
}

/** Status indicators for each hunk review state */
const STATUS_INDICATORS: Record<DiffHunk["status"], { symbol: string; color: string }> = {
  accepted: { symbol: "\u2713", color: "green" },
  rejected: { symbol: "\u2717", color: "red" },
  pending: { symbol: "?", color: "yellow" },
  modified: { symbol: "\u270E", color: "blue" },
};

/**
 * Format a line number with consistent padding.
 */
function padLineNum(num: number, width = 4): string {
  return String(num).padStart(width, " ");
}

/**
 * HunkSelector renders a single DiffHunk in either inline or side-by-side mode.
 */
export default function HunkSelector({
  hunk,
  isCurrent,
  mode,
}: HunkSelectorProps): React.ReactElement {
  const { symbol, color: statusColor } = STATUS_INDICATORS[hunk.status];

  const borderColor = isCurrent ? "cyan" : undefined;
  const dimmed = !isCurrent;

  return (
    <Box
      flexDirection="column"
      borderStyle={isCurrent ? "round" : undefined}
      borderColor={borderColor}
      paddingX={isCurrent ? 1 : 0}
      marginBottom={1}
    >
      {/* Hunk header */}
      <Box gap={1}>
        <Text color={statusColor} bold>
          {symbol}
        </Text>
        <Text color="magenta" dimColor={dimmed}>
          @@ -{hunk.startLineOld},{hunk.linesRemoved.length} +{hunk.startLineNew},
          {hunk.linesAdded.length} @@
        </Text>
        <Text color={statusColor} dimColor={dimmed}>
          [{hunk.status}]
        </Text>
      </Box>

      {mode === "inline" ? (
        <InlineView hunk={hunk} dimmed={dimmed} />
      ) : (
        <SideBySideView hunk={hunk} dimmed={dimmed} />
      )}
    </Box>
  );
}

/**
 * Inline (unified) diff view with +/- prefixes.
 */
function InlineView({ hunk, dimmed }: { hunk: DiffHunk; dimmed: boolean }): React.ReactElement {
  const lines: React.ReactElement[] = [];
  let key = 0;

  // Context before
  for (let i = 0; i < hunk.context.before.length; i++) {
    const lineNum = hunk.startLineOld - hunk.context.before.length + i;
    lines.push(
      <Box key={key++}>
        <Text dimColor>{padLineNum(lineNum)} </Text>
        <Text dimColor> {hunk.context.before[i]}</Text>
      </Box>,
    );
  }

  // Removed lines
  for (let i = 0; i < hunk.linesRemoved.length; i++) {
    const lineNum = hunk.startLineOld + i;
    lines.push(
      <Box key={key++}>
        <Text dimColor>{padLineNum(lineNum)} </Text>
        <Text color="red" dimColor={dimmed}>
          - {hunk.linesRemoved[i]}
        </Text>
      </Box>,
    );
  }

  // Added lines
  for (let i = 0; i < hunk.linesAdded.length; i++) {
    const lineNum = hunk.startLineNew + i;
    lines.push(
      <Box key={key++}>
        <Text dimColor>{padLineNum(lineNum)} </Text>
        <Text color="green" dimColor={dimmed}>
          + {hunk.linesAdded[i]}
        </Text>
      </Box>,
    );
  }

  // Context after
  for (let i = 0; i < hunk.context.after.length; i++) {
    const lineNum = hunk.endLineOld + 1 + i;
    lines.push(
      <Box key={key++}>
        <Text dimColor>{padLineNum(lineNum)} </Text>
        <Text dimColor> {hunk.context.after[i]}</Text>
      </Box>,
    );
  }

  return <Box flexDirection="column">{lines}</Box>;
}

/**
 * Side-by-side diff view with two columns.
 */
function SideBySideView({ hunk, dimmed }: { hunk: DiffHunk; dimmed: boolean }): React.ReactElement {
  const maxRows = Math.max(
    hunk.context.before.length + hunk.linesRemoved.length + hunk.context.after.length,
    hunk.context.before.length + hunk.linesAdded.length + hunk.context.after.length,
  );

  const leftLines: Array<{ num: number | null; text: string; type: "ctx" | "del" }> = [];
  const rightLines: Array<{ num: number | null; text: string; type: "ctx" | "add" }> = [];

  // Context before (same on both sides)
  for (let i = 0; i < hunk.context.before.length; i++) {
    const lineNum = hunk.startLineOld - hunk.context.before.length + i;
    const lineNumNew = hunk.startLineNew - hunk.context.before.length + i;
    leftLines.push({ num: lineNum, text: hunk.context.before[i]!, type: "ctx" });
    rightLines.push({ num: lineNumNew, text: hunk.context.before[i]!, type: "ctx" });
  }

  // Changed lines
  for (let i = 0; i < hunk.linesRemoved.length; i++) {
    leftLines.push({
      num: hunk.startLineOld + i,
      text: hunk.linesRemoved[i]!,
      type: "del",
    });
  }
  for (let i = 0; i < hunk.linesAdded.length; i++) {
    rightLines.push({
      num: hunk.startLineNew + i,
      text: hunk.linesAdded[i]!,
      type: "add",
    });
  }

  // Pad shorter side
  while (leftLines.length < rightLines.length) {
    leftLines.push({ num: null, text: "", type: "ctx" });
  }
  while (rightLines.length < leftLines.length) {
    rightLines.push({ num: null, text: "", type: "ctx" });
  }

  // Context after (same on both sides)
  for (let i = 0; i < hunk.context.after.length; i++) {
    const lineNum = hunk.endLineOld + 1 + i;
    const lineNumNew = hunk.endLineNew + 1 + i;
    leftLines.push({ num: lineNum, text: hunk.context.after[i]!, type: "ctx" });
    rightLines.push({ num: lineNumNew, text: hunk.context.after[i]!, type: "ctx" });
  }

  const rows: React.ReactElement[] = [];
  for (let i = 0; i < leftLines.length; i++) {
    const left = leftLines[i]!;
    const right = rightLines[i]!;
    rows.push(
      <Box key={i} gap={1}>
        {/* Left column (old) */}
        <Box width={40}>
          <Text dimColor>{left.num !== null ? padLineNum(left.num) : "    "} </Text>
          <Text
            color={left.type === "del" ? "red" : undefined}
            dimColor={left.type === "ctx" || dimmed}
          >
            {left.type === "del" ? "- " : "  "}
            {left.text}
          </Text>
        </Box>

        {/* Separator */}
        <Text dimColor>{"\u2502"}</Text>

        {/* Right column (new) */}
        <Box width={40}>
          <Text dimColor>{right.num !== null ? padLineNum(right.num) : "    "} </Text>
          <Text
            color={right.type === "add" ? "green" : undefined}
            dimColor={right.type === "ctx" || dimmed}
          >
            {right.type === "add" ? "+ " : "  "}
            {right.text}
          </Text>
        </Box>
      </Box>,
    );
  }

  return (
    <Box flexDirection="column">
      {/* Column headers */}
      <Box gap={1}>
        <Box width={40}>
          <Text bold dimColor={dimmed}>
            Original
          </Text>
        </Box>
        <Text dimColor>{"\u2502"}</Text>
        <Box width={40}>
          <Text bold dimColor={dimmed}>
            Modified
          </Text>
        </Box>
      </Box>
      {rows}
    </Box>
  );
}
