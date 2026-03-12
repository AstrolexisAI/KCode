// KCode - MessageList component
// Renders conversation messages with formatting for text, tool use, and tool results

import React from "react";
import { Box, Text, Static } from "ink";
import Spinner from "./Spinner.js";
import ThinkingBlockComponent from "./ThinkingBlock.js";

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

export type MessageEntry = TextEntry | ToolUseEntry | ToolResultEntry | ThinkingEntry | BannerEntry;

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
}

export default function MessageList({
  completed,
  streamingText,
  isLoading,
  loadingMessage,
  streamingThinking = "",
  isThinking = false,
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
          <Text>{streamingText}</Text>
        </Box>
      )}

      {/* Loading spinner */}
      {isLoading && (
        <Box paddingLeft={2}>
          <Spinner message={loadingMessage ?? "Thinking..."} />
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
  }
}

function TextMessage({ role, text }: { role: "user" | "assistant"; text: string }) {
  if (role === "user") {
    return (
      <Box paddingLeft={2}>
        <Text bold color="green">{"❯ "}</Text>
        <Text bold>{text}</Text>
      </Box>
    );
  }

  // Assistant text - render with basic markdown-like formatting
  return (
    <Box paddingLeft={0}>
      <Text>{formatText(text)}</Text>
    </Box>
  );
}

function ToolUseMessage({ name, summary }: { name: string; summary: string }) {
  return (
    <Box paddingLeft={2}>
      <Text dimColor>
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
  if (isError) {
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Text color="red">{"✗ "}{name} failed</Text>
        <Text dimColor color="red">{"    "}{result.slice(0, 200)}</Text>
      </Box>
    );
  }

  const preview = result.split("\n").slice(0, 3).join("\n    ");
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text color="green" dimColor>{"✓ "}{name}</Text>
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

function BannerMessage({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box gap={1}>
        <Text bold color="cyan">{title}</Text>
        <Text dimColor>{subtitle}</Text>
      </Box>
    </Box>
  );
}

/** Simple text formatting - bold (**text**) and inline code (`code`) */
function formatText(text: string): string {
  // For Ink, we return plain text; chalk-based formatting
  // would need to be applied at a lower level. Ink's <Text>
  // handles the actual rendering.
  return text;
}
