// KCode - InteractiveDiff Component
// Interactive terminal UI for reviewing diffs hunk-by-hunk.
// Allows accepting, rejecting, and navigating through changes with keyboard controls.

import React, { useState, useCallback, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import type { DiffHunk, DiffResult } from "../../core/diff/types.js";
import {
  acceptHunk,
  rejectHunk,
  acceptAll as acceptAllHunks,
  rejectAll as rejectAllHunks,
  getStats,
} from "../../core/diff/hunk-operations.js";
import HunkSelector from "./HunkSelector.js";

export interface InteractiveDiffProps {
  /** The diff result to review */
  diff: DiffResult;
  /** Called when the user finalizes the review (presses q) */
  onComplete: (hunks: DiffHunk[]) => void;
  /** Whether this component is actively receiving input (default true) */
  isActive?: boolean;
}

/**
 * InteractiveDiff provides a full-screen terminal interface for reviewing
 * file diffs hunk-by-hunk. Users can accept, reject, or skip individual
 * hunks, or batch-accept/reject all remaining.
 */
export default function InteractiveDiff({
  diff,
  onComplete,
  isActive = true,
}: InteractiveDiffProps): React.ReactElement {
  const [hunks, setHunks] = useState<DiffHunk[]>(() => [...diff.hunks]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [displayMode, setDisplayMode] = useState<"inline" | "side-by-side">("inline");
  const [scrollOffset, setScrollOffset] = useState(0);

  const maxVisibleHunks = 5;

  const stats = useMemo(() => getStats(hunks), [hunks]);

  const clampIndex = useCallback(
    (idx: number) => Math.max(0, Math.min(idx, hunks.length - 1)),
    [hunks.length],
  );

  const moveToNext = useCallback(() => {
    setCurrentIndex((prev) => {
      const next = clampIndex(prev + 1);
      // Adjust scroll if moving past visible window
      if (next >= scrollOffset + maxVisibleHunks) {
        setScrollOffset(next - maxVisibleHunks + 1);
      }
      return next;
    });
  }, [clampIndex, scrollOffset]);

  const moveToPrev = useCallback(() => {
    setCurrentIndex((prev) => {
      const next = clampIndex(prev - 1);
      if (next < scrollOffset) {
        setScrollOffset(next);
      }
      return next;
    });
  }, [clampIndex, scrollOffset]);

  useInput(
    (input, key) => {
      if (!isActive || hunks.length === 0) return;

      // Navigation
      if (key.upArrow) {
        moveToPrev();
        return;
      }
      if (key.downArrow) {
        moveToNext();
        return;
      }

      // Accept current hunk
      if (key.return) {
        setHunks((prev) => {
          const currentHunk = prev[currentIndex];
          if (!currentHunk) return prev;
          return acceptHunk(prev, currentHunk.id);
        });
        // Auto-advance to next pending hunk
        if (currentIndex < hunks.length - 1) {
          moveToNext();
        }
        return;
      }

      // Reject current hunk
      if (input === "x") {
        setHunks((prev) => {
          const currentHunk = prev[currentIndex];
          if (!currentHunk) return prev;
          return rejectHunk(prev, currentHunk.id);
        });
        if (currentIndex < hunks.length - 1) {
          moveToNext();
        }
        return;
      }

      // Accept all remaining
      if (input === "a") {
        setHunks((prev) => {
          const updated = [...prev];
          for (let i = 0; i < updated.length; i++) {
            if (updated[i].status === "pending") {
              updated[i] = { ...updated[i], status: "accepted" };
            }
          }
          return updated;
        });
        return;
      }

      // Reject all remaining
      if (input === "r") {
        setHunks((prev) => {
          const updated = [...prev];
          for (let i = 0; i < updated.length; i++) {
            if (updated[i].status === "pending") {
              updated[i] = { ...updated[i], status: "rejected" };
            }
          }
          return updated;
        });
        return;
      }

      // Toggle display mode
      if (input === "d") {
        setDisplayMode((prev) =>
          prev === "inline" ? "side-by-side" : "inline",
        );
        return;
      }

      // Finalize
      if (input === "q") {
        onComplete(hunks);
        return;
      }
    },
    { isActive },
  );

  if (hunks.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="cyan">
          Interactive Diff
        </Text>
        <Text dimColor>No changes to review.</Text>
      </Box>
    );
  }

  // Visible window
  const visibleStart = scrollOffset;
  const visibleEnd = Math.min(scrollOffset + maxVisibleHunks, hunks.length);
  const visibleHunks = hunks.slice(visibleStart, visibleEnd);

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Header */}
      <Box gap={2} marginBottom={1}>
        <Text bold color="cyan">
          Interactive Diff
        </Text>
        <Text dimColor>|</Text>
        <Text color="white" bold>
          {diff.filePath || "untitled"}
        </Text>
        <Text dimColor>|</Text>
        <Text color="yellow">
          Hunk {currentIndex + 1}/{hunks.length}
        </Text>
        <Text dimColor>|</Text>
        <Text color="green">{stats.accepted} accepted</Text>
        <Text color="red">{stats.rejected} rejected</Text>
        <Text color="yellow">{stats.pending} pending</Text>
        {stats.modified > 0 && (
          <Text color="blue">{stats.modified} modified</Text>
        )}
      </Box>

      {/* Display mode indicator */}
      <Box marginBottom={1}>
        <Text dimColor>
          Mode: {displayMode === "inline" ? "Inline (unified)" : "Side-by-side"}
        </Text>
      </Box>

      {/* Scroll indicator (above) */}
      {visibleStart > 0 && (
        <Text dimColor>  ... {visibleStart} hunk(s) above</Text>
      )}

      {/* Hunks */}
      <Box flexDirection="column">
        {visibleHunks.map((hunk, i) => {
          const absoluteIndex = visibleStart + i;
          return (
            <HunkSelector
              key={hunk.id}
              hunk={hunk}
              isCurrent={absoluteIndex === currentIndex}
              mode={displayMode}
            />
          );
        })}
      </Box>

      {/* Scroll indicator (below) */}
      {visibleEnd < hunks.length && (
        <Text dimColor>
          ... {hunks.length - visibleEnd} hunk(s) below
        </Text>
      )}

      {/* Keybinding hints */}
      <Box marginTop={1} gap={2} flexWrap="wrap">
        <Text dimColor>
          {"\u2191\u2193"} navigate
        </Text>
        <Text dimColor>Enter accept</Text>
        <Text dimColor>x reject</Text>
        <Text dimColor>a accept-all</Text>
        <Text dimColor>r reject-all</Text>
        <Text dimColor>d toggle-view</Text>
        <Text dimColor>q finalize</Text>
      </Box>
    </Box>
  );
}
