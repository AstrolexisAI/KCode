// KCode - VirtualMessageList component
// Renders only messages in the visible viewport + buffer for performance.
// Replaces Static-based MessageList for conversations with many messages.
// Streaming content (thinking, text, bash) renders outside the virtual list.

import { Box, Text } from "ink";
import React, { memo, useCallback, useMemo } from "react";
import { useVirtualScroll } from "../hooks/useVirtualScroll.js";
import { useTheme } from "../ThemeContext.js";
import MarkdownRenderer from "./MarkdownRenderer.js";
import type { MessageEntry } from "./MessageList.js";
import Spinner from "./Spinner.js";
import ThinkingBlockComponent from "./ThinkingBlock.js";

// ─── Types ──────────────────────────────────────────────────────

export interface VirtualMessageListProps {
  /** Completed message entries */
  completed: MessageEntry[];
  /** Text currently streaming from the assistant */
  streamingText: string;
  /** Whether the assistant is currently responding */
  isLoading: boolean;
  /** Loading status message */
  loadingMessage?: string;
  /** Thinking text currently being streamed */
  streamingThinking?: string;
  /** Whether thinking is actively streaming */
  isThinking?: boolean;
  /** Current token count for this turn */
  turnTokens?: number;
  /** Timestamp (Date.now()) when the current turn started */
  turnStartTime?: number;
  /** Current spinner phase */
  spinnerPhase?: "thinking" | "streaming" | "tool";
  /** Live streaming output from a running Bash command */
  bashStreamOutput?: string;
  /** Whether virtual scroll keybindings should be active */
  scrollActive?: boolean;
  /** Override terminal rows (for testing) */
  terminalRows?: number;
}

// ─── Memoized entry renderer ────────────────────────────────────

interface VirtualEntryProps {
  entry: MessageEntry;
  entryKey: string;
}

const VirtualEntry = memo(function VirtualEntry({ entry }: VirtualEntryProps) {
  return <EntryRenderer entry={entry} />;
});

// ─── Scroll indicator ───────────────────────────────────────────

function ScrollIndicator({
  following,
  firstVisible,
  totalMessages,
}: {
  following: boolean;
  firstVisible: number;
  totalMessages: number;
}) {
  const { theme } = useTheme();

  if (totalMessages <= 0) return null;

  if (following) {
    return (
      <Box justifyContent="flex-end" paddingRight={1}>
        <Text color={theme.success} dimColor>
          {"[FOLLOWING]"}
        </Text>
      </Box>
    );
  }

  return (
    <Box justifyContent="flex-end" paddingRight={1}>
      <Text color={theme.warning} dimColor>
        {`[SCROLLED: ${firstVisible + 1}/${totalMessages}]`}
      </Text>
    </Box>
  );
}

// ─── Main component ─────────────────────────────────────────────

export default function VirtualMessageList({
  completed,
  streamingText,
  isLoading,
  loadingMessage,
  streamingThinking = "",
  isThinking = false,
  turnTokens = 0,
  turnStartTime,
  spinnerPhase = "thinking",
  bashStreamOutput = "",
  scrollActive = true,
  terminalRows,
}: VirtualMessageListProps) {
  const { range, following, setHeight } = useVirtualScroll({
    messages: completed,
    isActive: scrollActive,
    terminalRows,
  });

  // Slice only the messages we need to render
  const visibleMessages = useMemo(() => {
    if (completed.length === 0) return [];
    const start = range.renderStart;
    const end = Math.min(range.renderEnd, completed.length - 1);
    if (start > end) return [];
    const result: Array<{ entry: MessageEntry; key: string; index: number }> = [];
    for (let i = start; i <= end; i++) {
      result.push({
        entry: completed[i]!,
        key: `msg-${i}`,
        index: i,
      });
    }
    return result;
  }, [completed, range.renderStart, range.renderEnd]);

  return (
    <Box flexDirection="column">
      {/* Scroll position indicator */}
      {completed.length > 0 && (
        <ScrollIndicator
          following={following}
          firstVisible={range.firstVisible}
          totalMessages={completed.length}
        />
      )}

      {/* Top spacer for content above render window */}
      {range.spacerTop > 0 && <Box height={range.spacerTop} />}

      {/* Rendered messages in visible range */}
      {visibleMessages.map(({ entry, key }) => (
        <Box key={key} flexDirection="column">
          <VirtualEntry entry={entry} entryKey={key} />
        </Box>
      ))}

      {/* Bottom spacer for content below render window */}
      {range.spacerBottom > 0 && <Box height={range.spacerBottom} />}

      {/* Live thinking indicator while thinking_delta events stream in */}
      {isThinking && streamingThinking.length > 0 && (
        <ThinkingBlockComponent text={streamingThinking} isStreaming={true} />
      )}

      {/* Currently streaming text */}
      {streamingText.length > 0 && (
        <Box paddingLeft={0}>
          <MarkdownRenderer text={streamingText} />
        </Box>
      )}

      {/* Live streaming Bash output */}
      {bashStreamOutput.length > 0 && <BashStreamDisplay output={bashStreamOutput} />}

      {/* Loading spinner with tokens and elapsed time */}
      {isLoading && (
        <Box paddingLeft={2}>
          <Spinner
            message={loadingMessage ?? (isThinking ? "Reasoning..." : "Thinking...")}
            tokens={turnTokens}
            startTime={turnStartTime}
            phase={isThinking ? "thinking" : spinnerPhase}
          />
        </Box>
      )}
    </Box>
  );
}

// ─── Shared sub-components (mirrored from MessageList.tsx) ──────

function EntryRenderer({ entry }: { entry: MessageEntry }) {
  switch (entry.kind) {
    case "text":
      return <TextMessage role={entry.role} text={entry.text} />;
    case "tool_use":
      return <ToolUseMessage name={entry.name} summary={entry.summary} />;
    case "tool_result":
      return (
        <ToolResultMessage
          name={entry.name}
          result={entry.result}
          isError={entry.isError}
          durationMs={entry.durationMs}
        />
      );
    case "thinking":
      return <ThinkingMessage text={entry.text} />;
    case "banner":
      return <BannerMessage title={entry.title} subtitle={entry.subtitle} />;
    case "learn":
      return <LearnMessage text={entry.text} />;
    case "suggestion":
      return <SuggestionMessage suggestions={entry.suggestions} />;
    case "plan":
      return null;
    case "diff":
      return <DiffMessage filePath={entry.filePath} hunks={entry.hunks} />;
    case "partial_progress":
      return (
        <PartialProgressMessage
          toolsUsed={entry.toolsUsed}
          elapsedMs={entry.elapsedMs}
          filesModified={entry.filesModified}
          lastError={entry.lastError}
          summary={entry.summary}
        />
      );
    case "incomplete_response":
      return (
        <IncompleteResponseMessage
          continuations={entry.continuations}
          stopReason={entry.stopReason}
        />
      );
  }
}

function TextMessage({ role, text }: { role: "user" | "assistant"; text: string }) {
  const { theme } = useTheme();

  if (role === "user") {
    const isPaste = text.includes("\n") && text.length > 80;

    if (isPaste) {
      const lines = text.split("\n");
      const lineCount = lines.length;

      return (
        <Box flexDirection="column" paddingLeft={2}>
          <Box>
            <Text bold color={theme.userPrompt}>
              {"❯ "}
            </Text>
            <Text color={theme.accent}>{"📋 "}</Text>
            <Text bold color={theme.dimmed}>
              {`paste — ${lineCount} lines, ${text.length.toLocaleString()} chars`}
            </Text>
          </Box>
          <Box flexDirection="column" paddingLeft={4} marginTop={0}>
            {lines.map((line, i) => (
              <Text key={i} color={theme.dimmed}>
                {line || " "}
              </Text>
            ))}
          </Box>
        </Box>
      );
    }

    return (
      <Box paddingLeft={2}>
        <Text bold color={theme.userPrompt}>
          {"❯ "}
        </Text>
        <Text bold>{text}</Text>
      </Box>
    );
  }

  return (
    <Box paddingLeft={0}>
      <MarkdownRenderer text={text} />
    </Box>
  );
}

function ToolUseMessage({ name, summary }: { name: string; summary: string }) {
  const { theme } = useTheme();

  return (
    <Box paddingLeft={2}>
      <Text color={theme.toolUse} dimColor>
        {"⚡ "}
        {name}
        {summary ? `: ${summary}` : ""}
      </Text>
    </Box>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
}

function ToolResultMessage({
  name,
  result,
  isError,
  durationMs,
}: {
  name: string;
  result: string;
  isError?: boolean;
  durationMs?: number;
}) {
  const { theme } = useTheme();
  const safeResult = result ?? "";
  const durationStr =
    durationMs != null && durationMs > 100 ? ` (${formatDuration(durationMs)})` : "";

  if (isError) {
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Text color={theme.error}>
          {"✗ "}
          {name} failed{durationStr}
        </Text>
        <Text dimColor color={theme.error}>
          {"    "}
          {safeResult.slice(0, 200)}
        </Text>
      </Box>
    );
  }

  // Parse result lines for diff-aware coloring
  const lines = safeResult.split("\n");
  const headerLine = lines[0] ?? "";
  const bodyLines = lines.slice(1);

  // Determine if this is a diff result (Edit/Write with + or - prefixed lines)
  const hasDiffLines = bodyLines.some((l) => l.startsWith("  + ") || l.startsWith("  - "));

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text color={theme.toolResult} bold>
        {"✓ "}
        {headerLine}
        {durationStr}
      </Text>
      {hasDiffLines &&
        bodyLines.map((line, i) => {
          if (line.startsWith("  + ")) {
            return (
              <Text key={i} color={theme.success ?? "#9ece6a"}>
                {line}
              </Text>
            );
          }
          if (line.startsWith("  - ")) {
            return (
              <Text key={i} color={theme.error}>
                {line}
              </Text>
            );
          }
          if (line.trim().length > 0) {
            return (
              <Text key={i} dimColor>
                {line}
              </Text>
            );
          }
          return null;
        })}
      {!hasDiffLines && bodyLines.length > 0 && bodyLines.length <= 3 && (
        <Text dimColor>
          {"    "}
          {bodyLines.join("\n    ")}
        </Text>
      )}
    </Box>
  );
}

function ThinkingMessage({ text }: { text: string }) {
  return <ThinkingBlockComponent text={text} isStreaming={false} defaultExpanded={false} />;
}

function LearnMessage({ text }: { text: string }) {
  const { theme } = useTheme();

  return (
    <Box paddingLeft={2} marginTop={0} marginBottom={0}>
      <Text color={theme.accent} bold>
        {"✧ "}
      </Text>
      <Text color={theme.accent} italic>
        {text}
      </Text>
    </Box>
  );
}

function SuggestionMessage({
  suggestions,
}: {
  suggestions: { type: string; message: string; priority: string }[];
}) {
  const { theme } = useTheme();

  const icons: Record<string, string> = {
    test: "⚗",
    verify: "🔍",
    commit: "📦",
    cleanup: "🧹",
    safety: "⚠",
    optimize: "⚡",
  };
  return (
    <Box flexDirection="column" paddingLeft={2} marginTop={0}>
      {suggestions.map((s, i) => (
        <Text
          key={`sug-${i}`}
          color={s.priority === "high" ? theme.warning : theme.dimmed}
          dimColor={s.priority === "low"}
        >
          {icons[s.type] ?? "💡"} {s.message}
        </Text>
      ))}
    </Box>
  );
}

function BannerMessage({ title, subtitle }: { title: string; subtitle: string }) {
  const { theme } = useTheme();

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box gap={1}>
        <Text bold color={theme.primary}>
          {title}
        </Text>
        <Text color={theme.dimmed}>{subtitle}</Text>
      </Box>
    </Box>
  );
}

function BashStreamDisplay({ output }: { output: string }) {
  const { theme } = useTheme();

  const lines = output.split("\n");
  const displayLines = lines.length > 10 ? lines.slice(-10) : lines;
  const truncated = lines.length > 10;

  return (
    <Box flexDirection="column" paddingLeft={2} marginTop={0} marginBottom={0}>
      <Text color={theme.warning} bold>
        {"  streaming"}
      </Text>
      {truncated && (
        <Text dimColor color={theme.dimmed}>
          {"    "}...({lines.length - 10} lines above)
        </Text>
      )}
      {displayLines.map((line, i) => (
        <Text key={`stream-${i}`} dimColor>
          {"    "}
          {line}
        </Text>
      ))}
    </Box>
  );
}

function DiffMessage({ filePath, hunks }: { filePath: string; hunks: string }) {
  const { theme } = useTheme();

  const lines = hunks.split("\n");

  return (
    <Box flexDirection="column" paddingLeft={2} marginTop={0} marginBottom={0}>
      <Text bold color={theme.primary}>
        {"  "}
        {filePath}
      </Text>
      <Box flexDirection="column" paddingLeft={2}>
        {lines.map((line, i) => {
          let color = theme.dimmed;

          if (line.startsWith("+") && !line.startsWith("+++")) {
            color = theme.success;
          } else if (line.startsWith("-") && !line.startsWith("---")) {
            color = theme.error;
          } else if (line.startsWith("@@")) {
            color = theme.accent;
          } else if (line.startsWith("diff ") || line.startsWith("index ")) {
            color = theme.dimmed;
          }

          return (
            <Text key={`diff-${i}`} color={color}>
              {line}
            </Text>
          );
        })}
      </Box>
    </Box>
  );
}

function PartialProgressMessage({
  toolsUsed,
  elapsedMs,
  filesModified,
  lastError,
  summary,
}: {
  toolsUsed: number;
  elapsedMs: number;
  filesModified: string[];
  lastError?: string;
  summary: string;
}) {
  const { theme } = useTheme();
  const elapsed = Math.round(elapsedMs / 1000);

  return (
    <Box flexDirection="column" paddingLeft={2} marginTop={1} marginBottom={1}>
      <Text color={theme.warning} bold>
        {"--- Partial Progress ---"}
      </Text>
      <Text color={theme.dimmed}>{summary}</Text>
      <Text color={theme.dimmed}>
        {"  Tools used: "}
        {toolsUsed}
        {" | Time: "}
        {elapsed}
        {"s"}
      </Text>
      {filesModified.length > 0 && (
        <Box flexDirection="column" paddingLeft={2}>
          <Text color={theme.success}>{"Files modified:"}</Text>
          {filesModified.map((f, i) => (
            <Text key={i} color={theme.dimmed}>
              {"  "}
              {f}
            </Text>
          ))}
        </Box>
      )}
      {lastError && (
        <Box paddingLeft={2}>
          <Text color={theme.error}>
            {"Last error: "}
            {lastError}
          </Text>
        </Box>
      )}
    </Box>
  );
}

function IncompleteResponseMessage({
  continuations,
  stopReason,
}: {
  continuations: number;
  stopReason: string;
}) {
  const { theme } = useTheme();
  return (
    <Box paddingLeft={2} marginTop={0}>
      <Text color={theme.warning} dimColor>
        {"--- "}
        {stopReason === "max_tokens" || stopReason === "truncation_retry"
          ? `Response incomplete — model reached output limit (${continuations} continuation${continuations !== 1 ? "s" : ""} attempted)`
          : `Response may be incomplete (${stopReason})`}
        {" ---"}
      </Text>
    </Box>
  );
}
