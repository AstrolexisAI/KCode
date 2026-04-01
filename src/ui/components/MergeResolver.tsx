// KCode - MergeResolver Component
// Interactive terminal UI for resolving three-way merge conflicts.
// Presents each conflict with base/ours/theirs panels and resolution controls.

import React, { useState, useCallback, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import type { MergeConflict, MergeResult } from "../../core/diff/types.js";
import { getThreeWayMerge } from "../../core/diff/three-way-merge.js";

export interface MergeResolverProps {
  /** The merge result containing conflicts to resolve */
  mergeResult: MergeResult;
  /** Called when the user saves and exits with the fully resolved content */
  onComplete: (resolved: string) => void;
  /** Whether this component is actively receiving input (default true) */
  isActive?: boolean;
}

/**
 * MergeResolver provides a terminal interface for resolving merge conflicts.
 * Conflicts are displayed one at a time with three panels (base, ours, theirs)
 * and keyboard shortcuts for choosing resolutions.
 */
export default function MergeResolver({
  mergeResult,
  onComplete,
  isActive = true,
}: MergeResolverProps): React.ReactElement {
  const [result, setResult] = useState<MergeResult>(() => ({
    ...mergeResult,
    conflicts: mergeResult.conflicts.map((c) => ({ ...c })),
  }));
  const [currentIndex, setCurrentIndex] = useState(0);
  const [editBuffer, setEditBuffer] = useState<string | null>(null);

  const merger = useMemo(() => getThreeWayMerge(), []);

  const resolvedCount = useMemo(
    () => result.conflicts.filter((c) => c.resolution != null).length,
    [result.conflicts],
  );

  const currentConflict = result.conflicts[currentIndex] ?? null;

  const resolveCurrentConflict = useCallback(
    (resolution: MergeConflict["resolution"], customContent?: string) => {
      if (!currentConflict) return;
      setResult((prev) =>
        merger.resolveConflict(prev, currentConflict.id, resolution, customContent),
      );
    },
    [currentConflict, merger],
  );

  useInput(
    (input, key) => {
      if (!isActive || result.conflicts.length === 0) return;

      // If in edit mode, handle specially
      if (editBuffer !== null) {
        if (key.escape) {
          setEditBuffer(null);
          return;
        }
        // In a real implementation, this would be a full text editor.
        // For terminal use, we accept the combined ours+theirs as the custom edit.
        if (key.return) {
          resolveCurrentConflict("custom", editBuffer);
          setEditBuffer(null);
          return;
        }
        return;
      }

      // Navigation
      if (input === "n" || key.downArrow) {
        setCurrentIndex((prev) =>
          Math.min(prev + 1, result.conflicts.length - 1),
        );
        return;
      }
      if (input === "p" || key.upArrow) {
        setCurrentIndex((prev) => Math.max(prev - 1, 0));
        return;
      }

      // Choose OURS
      if (input === "1") {
        resolveCurrentConflict("ours");
        // Auto-advance if possible
        if (currentIndex < result.conflicts.length - 1) {
          setCurrentIndex((prev) => prev + 1);
        }
        return;
      }

      // Choose THEIRS
      if (input === "2") {
        resolveCurrentConflict("theirs");
        if (currentIndex < result.conflicts.length - 1) {
          setCurrentIndex((prev) => prev + 1);
        }
        return;
      }

      // Choose BOTH (concatenate ours + theirs)
      if (input === "3") {
        resolveCurrentConflict("both");
        if (currentIndex < result.conflicts.length - 1) {
          setCurrentIndex((prev) => prev + 1);
        }
        return;
      }

      // Edit manually
      if (input === "e" && currentConflict) {
        // Pre-fill edit buffer with ours + theirs combined
        const combined = [...currentConflict.ours, ...currentConflict.theirs].join("\n");
        setEditBuffer(combined);
        return;
      }

      // Save and exit
      if (input === "s") {
        const resolved = merger.applyResolutions(result);
        onComplete(resolved);
        return;
      }
    },
    { isActive },
  );

  if (result.conflicts.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="cyan">
          Merge Resolver
        </Text>
        <Text color="green">No conflicts to resolve. All changes merged automatically.</Text>
        <Text dimColor>Auto-resolved: {result.autoResolved} change(s)</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Header */}
      <Box gap={2} marginBottom={1}>
        <Text bold color="cyan">
          Merge Resolver
        </Text>
        <Text dimColor>|</Text>
        <Text color="yellow">
          Conflict {currentIndex + 1}/{result.conflicts.length}
        </Text>
        <Text dimColor>|</Text>
        <Text color="green">{resolvedCount} resolved</Text>
        <Text color="red">
          {result.conflicts.length - resolvedCount} remaining
        </Text>
        <Text dimColor>|</Text>
        <Text dimColor>Auto-merged: {result.autoResolved}</Text>
      </Box>

      {/* Current conflict display */}
      {currentConflict && (
        <Box flexDirection="column">
          {/* Location info */}
          <Box marginBottom={1}>
            <Text dimColor>
              Lines {currentConflict.startLine}-{currentConflict.endLine}
            </Text>
            {currentConflict.resolution && (
              <Text color="green"> [resolved: {currentConflict.resolution}]</Text>
            )}
          </Box>

          {/* BASE panel */}
          <Box flexDirection="column" marginBottom={1}>
            <Text bold dimColor>
              [BASE]
            </Text>
            <Box
              flexDirection="column"
              borderStyle="single"
              borderColor="gray"
              paddingX={1}
            >
              {currentConflict.base.length > 0 ? (
                currentConflict.base.map((line, i) => (
                  <Text key={`base-${i}`} dimColor>
                    {padLineNum(currentConflict.startLine + i)} {line}
                  </Text>
                ))
              ) : (
                <Text dimColor italic>
                  (empty)
                </Text>
              )}
            </Box>
          </Box>

          {/* OURS panel */}
          <Box flexDirection="column" marginBottom={1}>
            <Text bold color="cyan">
              [OURS] (1)
            </Text>
            <Box
              flexDirection="column"
              borderStyle="single"
              borderColor="cyan"
              paddingX={1}
            >
              {currentConflict.ours.length > 0 ? (
                currentConflict.ours.map((line, i) => (
                  <Text key={`ours-${i}`} color="cyan">
                    {line}
                  </Text>
                ))
              ) : (
                <Text dimColor italic>
                  (empty)
                </Text>
              )}
            </Box>
          </Box>

          {/* THEIRS panel */}
          <Box flexDirection="column" marginBottom={1}>
            <Text bold color="yellow">
              [THEIRS] (2)
            </Text>
            <Box
              flexDirection="column"
              borderStyle="single"
              borderColor="yellow"
              paddingX={1}
            >
              {currentConflict.theirs.length > 0 ? (
                currentConflict.theirs.map((line, i) => (
                  <Text key={`theirs-${i}`} color="yellow">
                    {line}
                  </Text>
                ))
              ) : (
                <Text dimColor italic>
                  (empty)
                </Text>
              )}
            </Box>
          </Box>

          {/* Edit mode indicator */}
          {editBuffer !== null && (
            <Box
              flexDirection="column"
              marginBottom={1}
              borderStyle="double"
              borderColor="blue"
              paddingX={1}
            >
              <Text bold color="blue">
                [EDIT MODE]
              </Text>
              <Text>{editBuffer}</Text>
              <Text dimColor>Press Enter to apply, Esc to cancel</Text>
            </Box>
          )}
        </Box>
      )}

      {/* Keybinding hints */}
      <Box marginTop={1} gap={2} flexWrap="wrap">
        <Text dimColor>1 ours</Text>
        <Text dimColor>2 theirs</Text>
        <Text dimColor>3 both</Text>
        <Text dimColor>e edit</Text>
        <Text dimColor>n/p navigate</Text>
        <Text dimColor>s save</Text>
      </Box>
    </Box>
  );
}

/**
 * Pad line number for display.
 */
function padLineNum(num: number, width = 4): string {
  return String(num).padStart(width, " ");
}
