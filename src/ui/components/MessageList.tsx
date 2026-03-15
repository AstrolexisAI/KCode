// KCode - MessageList component
// Renders conversation messages with formatting for text, tool use, and tool results

import React from "react";
import { Box, Text, Static } from "ink";
import Spinner from "./Spinner.js";
import ThinkingBlockComponent from "./ThinkingBlock.js";
import { useTheme } from "../ThemeContext.js";

// --- Types for rendered message entries ---

export interface TextEntry {
  kind: "text";
  role: "user" | "assistant";
  text: string;
}

export interface ToolUseEntry {
  kind: "tool_use";
  name: string;
  summary: string;
}

export interface ToolResultEntry {
  kind: "tool_result";
  name: string;
  result: string;
  isError?: boolean;
}

export interface ThinkingEntry {
  kind: "thinking";
  text: string;
}

export interface BannerEntry {
  kind: "banner";
  title: string;
  subtitle: string;
}

export interface LearnEntry {
  kind: "learn";
  text: string;
}

export interface SuggestionEntry {
  kind: "suggestion";
  suggestions: { type: string; message: string; priority: string }[];
}

export type MessageEntry = TextEntry | ToolUseEntry | ToolResultEntry | ThinkingEntry | BannerEntry | LearnEntry | SuggestionEntry;

interface MessageListProps {
  /** Completed message entries (rendered via <Static>) */
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
}

export default function MessageList({
  completed,
  streamingText,
  isLoading,
  loadingMessage,
  streamingThinking = "",
  isThinking = false,
  turnTokens = 0,
  turnStartTime,
  spinnerPhase = "thinking",
}: MessageListProps) {
  return (
    <Box flexDirection="column">
      {/* Completed messages - rendered once and never re-rendered */}
      <Static items={completed.map((entry, i) => ({ ...entry, _key: `msg-${i}` }))}>
        {(entry) => (
          <Box key={entry._key} flexDirection="column">
            <EntryRenderer entry={entry} />
          </Box>
        )}
      </Static>

      {/* Live thinking indicator while thinking_delta events stream in */}
      {isThinking && streamingThinking.length > 0 && (
        <ThinkingBlockComponent
          text={streamingThinking}
          isStreaming={true}
        />
      )}

      {/* Currently streaming text */}
      {streamingText.length > 0 && (
        <Box paddingLeft={0}>
          <MarkdownText text={streamingText} />
        </Box>
      )}

      {/* Loading spinner with tokens and elapsed time */}
      {isLoading && (
        <Box paddingLeft={2}>
          <Spinner
            message={loadingMessage ?? "Thinking..."}
            tokens={turnTokens}
            startTime={turnStartTime}
            phase={spinnerPhase}
          />
        </Box>
      )}
    </Box>
  );
}

function EntryRenderer({ entry }: { entry: MessageEntry }) {
  switch (entry.kind) {
    case "text":
      return <TextMessage role={entry.role} text={entry.text} />;
    case "tool_use":
      return <ToolUseMessage name={entry.name} summary={entry.summary} />;
    case "tool_result":
      return <ToolResultMessage name={entry.name} result={entry.result} isError={entry.isError} />;
    case "thinking":
      return <ThinkingMessage text={entry.text} />;
    case "banner":
      return <BannerMessage title={entry.title} subtitle={entry.subtitle} />;
    case "learn":
      return <LearnMessage text={entry.text} />;
    case "suggestion":
      return <SuggestionMessage suggestions={entry.suggestions} />;
  }
}

function TextMessage({ role, text }: { role: "user" | "assistant"; text: string }) {
  const { theme } = useTheme();

  if (role === "user") {
    return (
      <Box paddingLeft={2}>
        <Text bold color={theme.userPrompt}>{"❯ "}</Text>
        <Text bold>{text}</Text>
      </Box>
    );
  }

  // Assistant text - render with markdown formatting
  return (
    <Box paddingLeft={0}>
      <MarkdownText text={text} />
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

function ToolResultMessage({
  name,
  result,
  isError,
}: {
  name: string;
  result: string;
  isError?: boolean;
}) {
  const { theme } = useTheme();

  if (isError) {
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Text color={theme.error}>{"✗ "}{name} failed</Text>
        <Text dimColor color={theme.error}>{"    "}{result.slice(0, 200)}</Text>
      </Box>
    );
  }

  const preview = result.split("\n").slice(0, 3).join("\n    ");
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text color={theme.toolResult} dimColor>{"✓ "}{name}</Text>
      {preview.length > 0 && preview.length < 500 && (
        <Text dimColor>{"    "}{preview}</Text>
      )}
    </Box>
  );
}

function ThinkingMessage({ text }: { text: string }) {
  return (
    <ThinkingBlockComponent
      text={text}
      isStreaming={false}
      defaultExpanded={false}
    />
  );
}

function LearnMessage({ text }: { text: string }) {
  const { theme } = useTheme();

  return (
    <Box paddingLeft={2} marginTop={0} marginBottom={0}>
      <Text color={theme.accent} bold>{"✧ "}</Text>
      <Text color={theme.accent} italic>{text}</Text>
    </Box>
  );
}

function SuggestionMessage({ suggestions }: { suggestions: { type: string; message: string; priority: string }[] }) {
  const { theme } = useTheme();

  const icons: Record<string, string> = {
    test: "⚗", verify: "🔍", commit: "📦", cleanup: "🧹", safety: "⚠", optimize: "⚡",
  };
  return (
    <Box flexDirection="column" paddingLeft={2} marginTop={0}>
      {suggestions.map((s, i) => (
        <Text key={`sug-${i}`} color={s.priority === "high" ? theme.warning : theme.dimmed} dimColor={s.priority === "low"}>
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
        <Text bold color={theme.primary}>{title}</Text>
        <Text color={theme.dimmed}>{subtitle}</Text>
      </Box>
    </Box>
  );
}

/** Render inline markdown formatting (bold, code, links) within a single line */
function renderInline(line: string, keyPrefix: string, theme: import("../../core/theme.js").Theme): React.ReactElement {
  // Split by inline patterns: **bold**, `code`, [text](url)
  const parts: React.ReactElement[] = [];
  let remaining = line;
  let partIndex = 0;

  while (remaining.length > 0) {
    // Find the earliest match among our patterns
    const boldMatch = remaining.match(/\*\*(.+?)\*\*/);
    const codeMatch = remaining.match(/`([^`]+)`/);
    const linkMatch = remaining.match(/\[([^\]]+)\]\(([^)]+)\)/);

    // Determine which match comes first
    type MatchInfo = { type: "bold" | "code" | "link"; index: number; fullMatch: string };
    const candidates: MatchInfo[] = [];
    if (boldMatch?.index !== undefined) candidates.push({ type: "bold", index: boldMatch.index, fullMatch: boldMatch[0] });
    if (codeMatch?.index !== undefined) candidates.push({ type: "code", index: codeMatch.index, fullMatch: codeMatch[0] });
    if (linkMatch?.index !== undefined) candidates.push({ type: "link", index: linkMatch.index, fullMatch: linkMatch[0] });

    if (candidates.length === 0) {
      // No more patterns - emit the rest as plain text
      if (remaining.length > 0) {
        parts.push(<Text key={`${keyPrefix}-${partIndex++}`}>{remaining}</Text>);
      }
      break;
    }

    // Pick the earliest match
    candidates.sort((a, b) => a.index - b.index);
    const first = candidates[0]!;

    // Emit text before the match
    if (first.index > 0) {
      parts.push(<Text key={`${keyPrefix}-${partIndex++}`}>{remaining.slice(0, first.index)}</Text>);
    }

    // Emit the formatted match
    if (first.type === "bold") {
      const content = boldMatch![1]!;
      parts.push(<Text key={`${keyPrefix}-${partIndex++}`} bold>{content}</Text>);
    } else if (first.type === "code") {
      const content = codeMatch![1]!;
      parts.push(<Text key={`${keyPrefix}-${partIndex++}`} color={theme.warning}>{content}</Text>);
    } else if (first.type === "link") {
      const linkText = linkMatch![1]!;
      const linkUrl = linkMatch![2]!;
      parts.push(
        <Text key={`${keyPrefix}-${partIndex++}`}>{linkText} </Text>,
      );
      parts.push(
        <Text key={`${keyPrefix}-${partIndex++}`} color={theme.dimmed}>({linkUrl})</Text>,
      );
    }

    remaining = remaining.slice(first.index + first.fullMatch.length);
  }

  if (parts.length === 0) {
    return <Text key={keyPrefix}>{""}</Text>;
  }
  if (parts.length === 1) {
    return parts[0]!;
  }
  return <Text key={keyPrefix}>{parts}</Text>;
}

/** Markdown text renderer for assistant messages */
function MarkdownText({ text }: { text: string }): React.ReactElement {
  const { theme } = useTheme();
  const lines = text.split("\n");
  const elements: React.ReactElement[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Code block: ```lang ... ```
    const codeBlockStart = line.match(/^```(\w*)$/);
    if (codeBlockStart) {
      const lang = codeBlockStart[1] || "";
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.match(/^```\s*$/)) {
        codeLines.push(lines[i]!);
        i++;
      }
      // Skip closing ```
      i++;

      elements.push(
        <Box key={`block-${elements.length}`} flexDirection="column" borderStyle="single" borderColor={theme.dimmed} paddingLeft={1} paddingRight={1} marginTop={0} marginBottom={0}>
          {lang && <Text color={theme.dimmed}>{lang}</Text>}
          <Text color={theme.warning}>{codeLines.join("\n")}</Text>
        </Box>,
      );
      continue;
    }

    // Headers: # ## ###
    const headerMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headerMatch) {
      elements.push(
        <Text key={`line-${elements.length}`} bold color={theme.primary}>{headerMatch[2]!}</Text>,
      );
      i++;
      continue;
    }

    // List items: - item or * item
    const listMatch = line.match(/^[\s]*[-*]\s+(.+)$/);
    if (listMatch) {
      const indent = line.match(/^(\s*)/)?.[1] ?? "";
      elements.push(
        <Text key={`line-${elements.length}`}>{indent}  {"• "}{renderInline(listMatch[1]!, `li-${elements.length}`, theme)}</Text>,
      );
      i++;
      continue;
    }

    // Numbered list items: 1. item
    const numListMatch = line.match(/^[\s]*(\d+)\.\s+(.+)$/);
    if (numListMatch) {
      const indent = line.match(/^(\s*)/)?.[1] ?? "";
      elements.push(
        <Text key={`line-${elements.length}`}>{indent}  {numListMatch[1]!}. {renderInline(numListMatch[2]!, `nl-${elements.length}`, theme)}</Text>,
      );
      i++;
      continue;
    }

    // Regular line with inline formatting
    elements.push(
      <Box key={`line-${elements.length}`}>
        {renderInline(line, `p-${elements.length}`, theme)}
      </Box>,
    );
    i++;
  }

  return (
    <Box flexDirection="column">
      {elements}
    </Box>
  );
}
