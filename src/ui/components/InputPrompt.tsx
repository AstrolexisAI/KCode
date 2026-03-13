// KCode - InputPrompt component
// Text input with prompt character, history, multi-line support, and tab completion

import React, { useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { readdirSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";

interface InputPromptProps {
  /** Called when the user submits input (Enter key) */
  onSubmit: (value: string) => void;
  /** Whether input is currently active */
  isActive: boolean;
  /** Whether messages are being queued (KCode is responding) */
  isQueuing?: boolean;
  /** Number of messages in the queue */
  queueSize?: number;
  /** Model name to show in prompt */
  model?: string;
  /** Working directory to show in prompt */
  cwd?: string;
  /** List of completable strings (slash commands, etc.) */
  completions?: string[];
}

/**
 * Try to complete a file path. Returns matching entries with `/` appended for directories.
 */
function getFileCompletions(partial: string): string[] {
  try {
    const expanded = partial.startsWith("~")
      ? (process.env.HOME ?? "") + partial.slice(1)
      : partial;

    const dir = partial.endsWith("/") ? expanded : dirname(expanded);
    const prefix = partial.endsWith("/") ? "" : basename(expanded);
    const resolvedDir = resolve(dir);

    const entries = readdirSync(resolvedDir, { withFileTypes: true });
    const matches: string[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith(".") && !prefix.startsWith(".")) continue;
      if (entry.name.startsWith(prefix)) {
        const suffix = entry.isDirectory() ? "/" : "";
        // Reconstruct the path with the original prefix style
        const dirPart = partial.endsWith("/") ? partial : partial.slice(0, partial.length - prefix.length);
        matches.push(dirPart + entry.name + suffix);
      }
    }

    return matches.sort();
  } catch {
    return [];
  }
}

/**
 * Find the longest common prefix among an array of strings.
 */
function commonPrefix(strings: string[]): string {
  if (strings.length === 0) return "";
  if (strings.length === 1) return strings[0];

  let prefix = strings[0];
  for (let i = 1; i < strings.length; i++) {
    while (!strings[i].startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
      if (prefix.length === 0) return "";
    }
  }
  return prefix;
}

export default function InputPrompt({ onSubmit, isActive, isQueuing = false, queueSize = 0, model, cwd, completions = [] }: InputPromptProps) {
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  // Tab completion state
  const [tabMatches, setTabMatches] = useState<string[]>([]);
  const [tabIndex, setTabIndex] = useState(0);
  const [tabOriginal, setTabOriginal] = useState("");

  const resetTabState = useCallback(() => {
    setTabMatches([]);
    setTabIndex(0);
    setTabOriginal("");
  }, []);

  const submit = useCallback(() => {
    const trimmed = value.trim();
    if (trimmed.length === 0) return;

    setHistory((prev) => [trimmed, ...prev]);
    setHistoryIndex(-1);
    setValue("");
    setCursor(0);
    resetTabState();
    onSubmit(trimmed);
  }, [value, onSubmit, resetTabState]);

  const handleTab = useCallback(() => {
    // If we're already cycling through matches, advance to next
    if (tabMatches.length > 1) {
      const nextIndex = (tabIndex + 1) % tabMatches.length;
      setTabIndex(nextIndex);
      const completed = tabMatches[nextIndex];
      setValue(completed);
      setCursor(completed.length);
      return;
    }

    const currentValue = tabMatches.length > 0 ? tabOriginal : value;

    // Slash command completion
    if (currentValue.startsWith("/") && !currentValue.includes(" ")) {
      const prefix = currentValue.toLowerCase();
      const matches = completions
        .filter((c) => c.toLowerCase().startsWith(prefix))
        .sort();

      if (matches.length === 0) return;

      if (matches.length === 1) {
        // Exact single match — fill it in with trailing space
        const completed = matches[0] + " ";
        setValue(completed);
        setCursor(completed.length);
        resetTabState();
        return;
      }

      // Multiple matches — fill common prefix, set up cycling
      const cp = commonPrefix(matches);
      if (cp.length > currentValue.length) {
        setValue(cp);
        setCursor(cp.length);
        setTabMatches(matches);
        setTabIndex(-1);
        setTabOriginal(currentValue);
      } else {
        // Common prefix equals current input — start cycling
        setTabMatches(matches);
        setTabIndex(0);
        setTabOriginal(currentValue);
        setValue(matches[0]);
        setCursor(matches[0].length);
      }
      return;
    }

    // File path completion — extract last word
    const words = currentValue.split(/\s+/);
    const lastWord = words[words.length - 1] ?? "";
    const isPathLike = lastWord.includes("/") || lastWord.startsWith("~") || lastWord.startsWith(".");

    if (!isPathLike || lastWord.length === 0) return;

    const fileMatches = getFileCompletions(lastWord);
    if (fileMatches.length === 0) return;

    const prefixPart = currentValue.slice(0, currentValue.length - lastWord.length);

    if (fileMatches.length === 1) {
      const completed = prefixPart + fileMatches[0];
      setValue(completed);
      setCursor(completed.length);
      resetTabState();
      return;
    }

    // Multiple file matches
    const cp = commonPrefix(fileMatches);
    const fullMatches = fileMatches.map((m) => prefixPart + m);

    if (cp.length > lastWord.length) {
      const completed = prefixPart + cp;
      setValue(completed);
      setCursor(completed.length);
      setTabMatches(fullMatches);
      setTabIndex(-1);
      setTabOriginal(currentValue);
    } else {
      setTabMatches(fullMatches);
      setTabIndex(0);
      setTabOriginal(currentValue);
      setValue(fullMatches[0]);
      setCursor(fullMatches[0].length);
    }
  }, [value, tabMatches, tabIndex, tabOriginal, completions, resetTabState]);

  useInput(
    (input, key) => {
      if (!isActive) return;

      if (key.return) {
        submit();
        return;
      }

      if (key.tab) {
        handleTab();
        return;
      }

      // Any non-tab key resets tab completion state
      if (tabMatches.length > 0) {
        resetTabState();
      }

      if (key.backspace || key.delete) {
        if (cursor > 0) {
          setValue((prev) => prev.slice(0, cursor - 1) + prev.slice(cursor));
          setCursor((prev) => prev - 1);
        }
        return;
      }

      // History navigation
      if (key.upArrow) {
        if (history.length > 0 && historyIndex < history.length - 1) {
          const newIndex = historyIndex + 1;
          setHistoryIndex(newIndex);
          const histEntry = history[newIndex] ?? "";
          setValue(histEntry);
          setCursor(histEntry.length);
        }
        return;
      }

      if (key.downArrow) {
        if (historyIndex > 0) {
          const newIndex = historyIndex - 1;
          setHistoryIndex(newIndex);
          const histEntry = history[newIndex] ?? "";
          setValue(histEntry);
          setCursor(histEntry.length);
        } else if (historyIndex === 0) {
          setHistoryIndex(-1);
          setValue("");
          setCursor(0);
        }
        return;
      }

      // Cursor movement
      if (key.leftArrow) {
        setCursor((prev) => Math.max(0, prev - 1));
        return;
      }

      if (key.rightArrow) {
        setCursor((prev) => Math.min(value.length, prev + 1));
        return;
      }

      // Regular character input
      if (input && !key.ctrl && !key.meta) {
        setValue((prev) => prev.slice(0, cursor) + input + prev.slice(cursor));
        setCursor((prev) => prev + input.length);
      }
    },
    { isActive },
  );

  if (!isActive) {
    return null;
  }

  // Shorten CWD for display
  const home = process.env.HOME ?? "";
  const shortCwd = cwd && home && cwd.startsWith(home)
    ? "~" + cwd.slice(home.length)
    : cwd;

  // Render value with cursor
  const before = value.slice(0, cursor);
  const cursorChar = value[cursor] ?? " ";
  const after = value.slice(cursor + 1);

  // Compute hint text for tab completion
  let hint = "";
  if (tabMatches.length > 1 && tabIndex >= 0) {
    hint = ` (${tabIndex + 1}/${tabMatches.length})`;
  } else if (tabMatches.length > 1 && tabIndex === -1) {
    hint = ` (${tabMatches.length} matches, Tab to cycle)`;
  }

  const promptChar = isQueuing ? "+" : "❯";
  const promptColor = isQueuing ? "yellow" : "green";
  const queueHint = isQueuing && queueSize > 0 ? ` [${queueSize} queued]` : isQueuing ? " [will queue]" : "";

  return (
    <Box flexDirection="column">
      <Box gap={1}>
        {model && <Text color={promptColor}>{model}</Text>}
        {shortCwd && <Text dimColor>{shortCwd}</Text>}
        <Text bold color={promptColor}>{promptChar}</Text>
        <Text>
          {before}
          <Text inverse>{cursorChar}</Text>
          {after}
          {hint && <Text dimColor>{hint}</Text>}
          {queueHint && <Text color="yellow">{queueHint}</Text>}
        </Text>
      </Box>
    </Box>
  );
}
