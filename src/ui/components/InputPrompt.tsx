// KCode - InputPrompt component
// Text input with prompt character, history, and multi-line support

import React, { useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";

interface InputPromptProps {
  /** Called when the user submits input (Enter key) */
  onSubmit: (value: string) => void;
  /** Whether input is currently active (disabled during response streaming) */
  isActive: boolean;
  /** Model name to show in prompt */
  model?: string;
  /** Working directory to show in prompt */
  cwd?: string;
}

export default function InputPrompt({ onSubmit, isActive, model, cwd }: InputPromptProps) {
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  const submit = useCallback(() => {
    const trimmed = value.trim();
    if (trimmed.length === 0) return;

    setHistory((prev) => [trimmed, ...prev]);
    setHistoryIndex(-1);
    setValue("");
    setCursor(0);
    onSubmit(trimmed);
  }, [value, onSubmit]);

  useInput(
    (input, key) => {
      if (!isActive) return;

      if (key.return) {
        submit();
        return;
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

  return (
    <Box flexDirection="column">
      <Box gap={1}>
        {model && <Text color="green">{model}</Text>}
        {shortCwd && <Text dimColor>{shortCwd}</Text>}
        <Text bold color="green">{"❯"}</Text>
        <Text>
          {before}
          <Text inverse>{cursorChar}</Text>
          {after}
        </Text>
      </Box>
    </Box>
  );
}
