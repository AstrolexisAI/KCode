// KCode - MessageList component
// Renders conversation messages with formatting for text, tool use, and tool results

import { Box, Static, Text } from "ink";
import React from "react";
import { CHARS_PER_TOKEN } from "../../core/token-budget.js";
import { useTheme } from "../ThemeContext.js";
import MarkdownRenderer from "./MarkdownRenderer.js";
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
  durationMs?: number;
}

export interface ThinkingEntry {
  kind: "thinking";
  text: string;
  /** Thinking blocks merged into this entry when a reasoning model emits several in sequence. */
  blockCount?: number;
  /** Total character count across all merged blocks (may differ from text.length when merged). */
  totalChars?: number;
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

export interface PlanEntry {
  kind: "plan";
  title: string;
  steps: Array<{ id: string; title: string; status: string }>;
}

export interface DiffEntry {
  kind: "diff";
  filePath: string;
  hunks: string;
}

export interface PartialProgressEntry {
  kind: "partial_progress";
  toolsUsed: number;
  elapsedMs: number;
  filesModified: string[];
  lastError?: string;
  summary: string;
}

export interface IncompleteResponseEntry {
  kind: "incomplete_response";
  continuations: number;
  stopReason: string;
}

export interface QuestionHighlightEntry {
  kind: "question_highlight";
  question: string;
  options?: string[];
}

export type MessageEntry =
  | TextEntry
  | ToolUseEntry
  | ToolResultEntry
  | ThinkingEntry
  | BannerEntry
  | LearnEntry
  | SuggestionEntry
  | PlanEntry
  | DiffEntry
  | PartialProgressEntry
  | IncompleteResponseEntry
  | QuestionHighlightEntry;

interface MessageListProps {
  /** Completed message entries (rendered via <Static>) */
  completed: MessageEntry[];
  /** Text currently streaming from the assistant */
  streamingText: string;
  /** Thinking text currently being streamed */
  streamingThinking?: string;
  /** Whether thinking is actively streaming */
  isThinking?: boolean;
  /** Live streaming output from a running Bash command */
  bashStreamOutput?: string;
}

export default function MessageList({
  completed,
  streamingText,
  streamingThinking = "",
  isThinking = false,
  bashStreamOutput = "",
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
      // Plan is rendered in the persistent ActivePlanPanel instead
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
    case "question_highlight":
      // If options exist, InteractiveQuestion renders this — skip static render
      if (entry.options && entry.options.length >= 2) return null;
      return <QuestionHighlightMessage question={entry.question} />;
  }
}

function TextMessage({ role, text }: { role: "user" | "assistant"; text: string }) {
  const { theme } = useTheme();

  if (role === "user") {
    // Detect paste: multiline user input with substantial content
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
            <Text
              bold
              color={theme.dimmed}
            >{`paste — ${lineCount} lines, ${text.length.toLocaleString()} chars`}</Text>
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

  // Assistant text - render with streaming markdown renderer
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

function ThinkingMessage({ text, blockCount = 1, totalChars }: ThinkingEntry) {
  const { theme } = useTheme();
  const chars = totalChars ?? text.length;
  const tok = Math.round(chars / CHARS_PER_TOKEN);
  const tokLabel = tok >= 1000 ? `${(tok / 1000).toFixed(1)}K` : String(tok);
  // Multi-block: inline compact summary — no expansion, all info on one line
  if (blockCount > 1) {
    return (
      <Box paddingLeft={2}>
        <Text color={theme.accent} dimColor>
          {"🧠 "}
          {tokLabel}
          {" tok · "}
          {blockCount}
          {" blocks ▸"}
        </Text>
      </Box>
    );
  }
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

function PlanMessage({
  title,
  steps,
}: {
  title: string;
  steps: Array<{ id: string; title: string; status: string }>;
}) {
  const { theme } = useTheme();

  const statusIcons: Record<string, string> = {
    pending: "[ ]",
    in_progress: "[~]",
    done: "[x]",
    skipped: "[-]",
  };

  const statusColors: Record<string, string> = {
    pending: theme.dimmed,
    in_progress: theme.warning,
    done: theme.success,
    skipped: theme.dimmed,
  };

  const done = steps.filter((s) => s.status === "done").length;
  const total = steps.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  // Progress bar
  const barLen = 20;
  const filled = Math.round((done / total) * barLen);
  const bar = "=".repeat(filled) + " ".repeat(barLen - filled);

  return (
    <Box flexDirection="column" paddingLeft={2} marginTop={0} marginBottom={0}>
      <Text bold color={theme.primary}>
        {title} ({done}/{total} - {pct}%)
      </Text>
      <Text color={theme.dimmed}> [{bar}]</Text>
      {steps.map((step, i) => (
        <Text key={`plan-step-${i}`} color={statusColors[step.status] ?? theme.dimmed}>
          {"  "}
          {statusIcons[step.status] ?? "[ ]"} {step.id}. {step.title}
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

  // Show only the last 10 lines of output for a compact live view
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
          let prefix = " ";

          if (line.startsWith("+") && !line.startsWith("+++")) {
            color = theme.success;
            prefix = "+";
          } else if (line.startsWith("-") && !line.startsWith("---")) {
            color = theme.error;
            prefix = "-";
          } else if (line.startsWith("@@")) {
            color = theme.accent;
            prefix = "@";
          } else if (line.startsWith("diff ") || line.startsWith("index ")) {
            color = theme.dimmed;
            prefix = " ";
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

function QuestionHighlightMessage({ question }: { question: string }) {
  const { theme } = useTheme();
  return (
    <Box
      borderStyle="round"
      borderColor={theme.info ?? theme.accent}
      paddingX={1}
      marginLeft={2}
      marginTop={0}
      width={(process.stdout.columns || 80) - 4}
    >
      <Text color={theme.info ?? theme.accent}>{"?  "}</Text>
      <Text bold>{question}</Text>
    </Box>
  );
}
