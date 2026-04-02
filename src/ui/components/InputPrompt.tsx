// KCode - InputPrompt component
// Text input with prompt character, history, multi-line support, and tab completion

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { Box, Text, useInput } from "ink";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { isVimModeEnabled, type VimMode } from "../../core/keybindings.js";
import { kcodePath } from "../../core/paths.js";
import { setPasteHandler } from "../paste-handler.js";
import { isPasting } from "../paste-stream.js";
import { useTheme } from "../ThemeContext.js";

// ─── Persistent Input History ──────────────────────────────────

const HISTORY_FILE = kcodePath("input_history");
const MAX_HISTORY = 500;

function loadPersistentHistory(): string[] {
  try {
    if (!existsSync(HISTORY_FILE)) return [];
    const content = readFileSync(HISTORY_FILE, "utf-8");
    // Each line is a JSON-encoded string to handle multi-line inputs safely
    const entries: string[] = [];
    for (const line of content.split("\n")) {
      if (line.length === 0) continue;
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed === "string") entries.push(parsed);
      } catch {
        // Legacy plain-text line — import as-is
        entries.push(line);
      }
    }
    return entries.slice(0, MAX_HISTORY);
  } catch {
    return [];
  }
}

function savePersistentHistory(entries: string[]): void {
  try {
    const dir = dirname(HISTORY_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // JSON-encode each entry to safely handle newlines and special chars
    const lines = entries.slice(0, MAX_HISTORY).map((e) => JSON.stringify(e));
    writeFileSync(HISTORY_FILE, lines.join("\n") + "\n", "utf-8");
  } catch {
    // Silently ignore write failures
  }
}

interface CommandInfo {
  name: string;
  description: string;
}

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
  /** Map of command name to description for preview dropdown */
  commandDescriptions?: Record<string, string>;
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
        const dirPart = partial.endsWith("/")
          ? partial
          : partial.slice(0, partial.length - prefix.length);
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
  if (strings.length === 1) return strings[0]!;

  let prefix = strings[0]!;
  for (let i = 1; i < strings.length; i++) {
    while (!strings[i]!.startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
      if (prefix.length === 0) return "";
    }
  }
  return prefix;
}

export default function InputPrompt({
  onSubmit,
  isActive,
  isQueuing = false,
  queueSize = 0,
  model,
  cwd,
  completions = [],
  commandDescriptions = {},
}: InputPromptProps) {
  const { theme } = useTheme();
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);

  // Synchronous cursor ref: tracks cursor position between React renders.
  const cursorRef = useRef(0);
  cursorRef.current = cursor; // Sync ref with state on each render

  const [history, setHistory] = useState<string[]>(() => loadPersistentHistory());
  const [historyIndex, setHistoryIndex] = useState(-1);

  // Tab completion state
  const [tabMatches, setTabMatches] = useState<string[]>([]);
  const [tabIndex, setTabIndex] = useState(0);
  const [tabOriginal, setTabOriginal] = useState("");

  // Command preview dropdown state
  const [dropdownIndex, setDropdownIndex] = useState(0);

  // Vim mode state (enabled via ~/.kcode/keybindings.json)
  const [vimMode, setVimMode] = useState<VimMode>(isVimModeEnabled() ? "normal" : "insert");

  // ─── Input buffer ──────────────────────────────────────────────
  // All character input accumulates in a buffer. A flush timer fires
  // after 32ms of no input, inserting the entire buffer into value
  // as a single atomic operation. This eliminates race conditions
  // from interleaved setState calls during rapid paste events.
  //
  // pasteActiveRef stays true for 80ms after the last flush, covering
  // inter-chunk gaps when the OS splits a paste into multiple stdin
  // reads. Enter checks both the buffer AND pasteActiveRef to decide
  // whether to insert \n or submit.
  const inputBufferRef = useRef("");
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pasteActiveRef = useRef(false);
  const pasteSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const INPUT_FLUSH_MS = 32;
  const PASTE_SETTLE_MS = 80;

  const flushInputBuffer = useCallback(() => {
    const buf = inputBufferRef.current;
    inputBufferRef.current = "";
    flushTimerRef.current = null;
    if (buf.length === 0) return;

    // Mark paste as active — persists for PASTE_SETTLE_MS after last flush
    pasteActiveRef.current = true;
    if (pasteSettleTimerRef.current) clearTimeout(pasteSettleTimerRef.current);
    pasteSettleTimerRef.current = setTimeout(() => {
      pasteActiveRef.current = false;
    }, PASTE_SETTLE_MS);

    const pos = cursorRef.current;
    cursorRef.current = pos + buf.length;
    setValue((prev) => prev.slice(0, pos) + buf + prev.slice(pos));
    setCursor(cursorRef.current);
  }, []);

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    flushTimerRef.current = setTimeout(flushInputBuffer, INPUT_FLUSH_MS);
  }, [flushInputBuffer]);

  // Cleanup timers on unmount
  useEffect(
    () => () => {
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
      if (pasteSettleTimerRef.current) clearTimeout(pasteSettleTimerRef.current);
    },
    [],
  );

  // ─── Paste handler ──────────────────────────────────────────
  // Receives complete paste content from the stdin interceptor
  // (installed in render.tsx). The interceptor detects paste at the
  // byte level — either via bracketed paste sequences or by detecting
  // newlines mixed with printable chars in a single stdin data event.
  // The paste is inserted atomically with one setValue call.
  useEffect(() => {
    const handler = (text: string) => {
      if (!isActive) return;
      // Flush any pending buffer first
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      const pending = inputBufferRef.current;
      inputBufferRef.current = "";
      const allNew = pending + text;

      const pos = cursorRef.current;
      cursorRef.current = pos + allNew.length;
      setValue((prev) => prev.slice(0, pos) + allNew + prev.slice(pos));
      setCursor(cursorRef.current);
    };
    setPasteHandler(handler);
    return () => {
      setPasteHandler(null);
    };
  }, [isActive]);

  const resetTabState = useCallback(() => {
    setTabMatches([]);
    setTabIndex(0);
    setTabOriginal("");
  }, []);

  const submit = useCallback(() => {
    // Flush any pending buffered input before submitting
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    // Compute final value: current state + any pending buffer
    const pending = inputBufferRef.current;
    inputBufferRef.current = "";
    const finalValue =
      pending.length > 0
        ? value.slice(0, cursorRef.current) + pending + value.slice(cursorRef.current)
        : value;

    if (finalValue.trim().length === 0) return;

    setHistory((prev) => {
      const forHistory = finalValue.trim();
      const deduped = prev[0] === forHistory ? prev : [forHistory, ...prev];
      const clamped = deduped.slice(0, MAX_HISTORY);
      savePersistentHistory(clamped);
      return clamped;
    });
    setHistoryIndex(-1);
    setValue("");
    setCursor(0);
    cursorRef.current = 0;
    resetTabState();
    pasteActiveRef.current = false;
    if (pasteSettleTimerRef.current) {
      clearTimeout(pasteSettleTimerRef.current);
      pasteSettleTimerRef.current = null;
    }
    onSubmit(finalValue);
  }, [value, onSubmit, resetTabState]);

  const handleTab = useCallback(() => {
    // If we're already cycling through matches, advance to next
    if (tabMatches.length > 1) {
      const nextIndex = (tabIndex + 1) % tabMatches.length;
      setTabIndex(nextIndex);
      const completed = tabMatches[nextIndex]!;
      setValue(completed);
      setCursor(completed.length);
      return;
    }

    const currentValue = tabMatches.length > 0 ? tabOriginal : value;

    // Slash command completion
    if (currentValue.startsWith("/") && !currentValue.includes(" ")) {
      const prefix = currentValue.toLowerCase();
      const matches = completions.filter((c) => c.toLowerCase().startsWith(prefix)).sort();

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
        setValue(matches[0]!);
        setCursor(matches[0]!.length);
      }
      return;
    }

    // File path completion — extract last word
    const words = currentValue.split(/\s+/);
    const lastWord = words[words.length - 1] ?? "";
    const isPathLike =
      lastWord.includes("/") || lastWord.startsWith("~") || lastWord.startsWith(".");

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
      setValue(fullMatches[0]!);
      setCursor(fullMatches[0]!.length);
    }
  }, [value, tabMatches, tabIndex, tabOriginal, completions, resetTabState]);

  useInput(
    (input, key) => {
      if (!isActive) return;

      // Skip all input while a paste is being captured by the stdin
      // interceptor. The paste content is injected atomically via the
      // paste handler — Ink's character events must be ignored.
      if (isPasting) return;

      // Vim normal mode handling
      if (vimMode === "normal") {
        if (input === "i") {
          setVimMode("insert");
          return;
        }
        if (input === "a") {
          setCursor((c) => Math.min(value.length, c + 1));
          setVimMode("insert");
          return;
        }
        if (input === "A") {
          setCursor(value.length);
          setVimMode("insert");
          return;
        }
        if (input === "I") {
          setCursor(0);
          setVimMode("insert");
          return;
        }
        if (input === "h" || key.leftArrow) {
          setCursor((c) => Math.max(0, c - 1));
          return;
        }
        if (input === "l" || key.rightArrow) {
          setCursor((c) => Math.min(value.length - 1, c + 1));
          return;
        }
        if (input === "0") {
          setCursor(0);
          return;
        }
        if (input === "$") {
          setCursor(value.length);
          return;
        }
        if (input === "w") {
          const m = value.slice(cursor).match(/^\s*\S+\s*/);
          setCursor((c) => (m ? c + m[0].length : value.length));
          return;
        }
        if (input === "b") {
          const m = value.slice(0, cursor).match(/\S+\s*$/);
          setCursor((c) => (m ? c - m[0].length : 0));
          return;
        }
        if (input === "x") {
          setValue((v) => v.slice(0, cursor) + v.slice(cursor + 1));
          return;
        }
        if (input === "d" && key.ctrl) {
          setCursor(0);
          setValue("");
          return;
        } // dd-like clear
        return; // Block all other input in normal mode
      }

      // Escape enters vim normal mode (if vim mode is enabled)
      if (key.escape && isVimModeEnabled()) {
        setVimMode("normal");
        return;
      }

      if (key.return) {
        // Alt+Enter (Meta+Return): always submit, even during paste
        if (key.meta) {
          submit();
          return;
        }

        // If dropdown is visible and an item is selected, fill it and submit
        if (dropdownItems.length > 0 && value.length > 1) {
          const selected = dropdownItems[dropdownIndex];
          if (selected) {
            const completed = selected.name + " ";
            setValue(completed);
            setCursor(completed.length);
            setDropdownIndex(0);
            return;
          }
        }

        // If the input buffer has pending characters OR paste is still
        // active (buffer was recently flushed), this Enter is part of a
        // paste — append \n to the buffer instead of submitting.
        if (inputBufferRef.current.length > 0 || pasteActiveRef.current) {
          inputBufferRef.current += "\n";
          scheduleFlush();
          return;
        }

        // No active paste: submit normally
        submit();
        return;
      }

      if (key.tab) {
        // If dropdown is visible, fill the selected item
        if (dropdownItems.length > 0) {
          const selected = dropdownItems[dropdownIndex];
          if (selected) {
            const completed = selected.name + " ";
            setValue(completed);
            setCursor(completed.length);
            setDropdownIndex(0);
            resetTabState();
            return;
          }
        }
        handleTab();
        return;
      }

      // Any non-tab key resets tab completion state
      if (tabMatches.length > 0) {
        resetTabState();
      }

      if (key.backspace || key.delete) {
        // If buffer has pending input, remove from buffer first
        if (inputBufferRef.current.length > 0) {
          inputBufferRef.current = inputBufferRef.current.slice(0, -1);
          scheduleFlush();
          return;
        }
        if (cursor > 0) {
          setValue((prev) => prev.slice(0, cursor - 1) + prev.slice(cursor));
          setCursor((prev) => prev - 1);
        }
        return;
      }

      // Ctrl+D: delete char under cursor, or exit if empty
      if (key.ctrl && input === "d") {
        if (value.length === 0) {
          // Will be handled by App.tsx global handler
          return;
        }
        if (cursor < value.length) {
          setValue(value.slice(0, cursor) + value.slice(cursor + 1));
        }
        return;
      }

      // Dropdown navigation when command preview is visible
      if (key.upArrow && dropdownItems.length > 0) {
        setDropdownIndex((prev) => Math.max(0, prev - 1));
        return;
      }

      if (key.downArrow && dropdownItems.length > 0) {
        setDropdownIndex((prev) => Math.min(dropdownItems.length - 1, prev + 1));
        return;
      }

      // History navigation (when dropdown is not visible)
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

      // ─── Readline shortcuts ───────────────────────────────
      // Ctrl+A: Move cursor to beginning
      if (key.ctrl && input === "a") {
        setCursor(0);
        return;
      }

      // Ctrl+E: Move cursor to end
      if (key.ctrl && input === "e") {
        setCursor(value.length);
        return;
      }

      // Ctrl+U: Delete from cursor to beginning
      if (key.ctrl && input === "u") {
        setValue(value.slice(cursor));
        setCursor(0);
        return;
      }

      // Ctrl+K: Delete from cursor to end
      if (key.ctrl && input === "k") {
        setValue(value.slice(0, cursor));
        return;
      }

      // Ctrl+W: Delete word backwards
      if (key.ctrl && input === "w") {
        const before = value.slice(0, cursor);
        const after = value.slice(cursor);
        // Find the start of the previous word
        const trimmed = before.trimEnd();
        const lastSpace = trimmed.lastIndexOf(" ");
        const newBefore = lastSpace === -1 ? "" : before.slice(0, lastSpace + 1);
        setValue(newBefore + after);
        setCursor(newBefore.length);
        return;
      }

      // Alt+B: Move cursor back one word
      if (key.meta && input === "b") {
        const before = value.slice(0, cursor);
        const match = before.match(/\S+\s*$/);
        setCursor(match ? cursor - match[0].length : 0);
        return;
      }

      // Alt+F: Move cursor forward one word
      if (key.meta && input === "f") {
        const after = value.slice(cursor);
        const match = after.match(/^\s*\S+/);
        setCursor(match ? cursor + match[0].length : value.length);
        return;
      }

      // Alt+D: Delete word forward
      if (key.meta && input === "d") {
        const after = value.slice(cursor);
        const match = after.match(/^\s*\S+/);
        if (match) {
          setValue(value.slice(0, cursor) + after.slice(match[0].length));
        }
        return;
      }

      // Regular character input — buffer and schedule flush
      if (input && !key.ctrl && !key.meta) {
        inputBufferRef.current += input;
        scheduleFlush();
        setDropdownIndex(0);
      }
    },
    { isActive },
  );

  // Compute command dropdown matches
  const showDropdown = value.startsWith("/") && !value.includes(" ") && value.length >= 1;
  const dropdownItems: CommandInfo[] = showDropdown
    ? completions
        .filter((c) => c.toLowerCase().startsWith(value.toLowerCase()))
        .sort()
        .map((c) => ({ name: c, description: commandDescriptions[c] ?? "" }))
    : [];
  const maxDropdown = 12;
  const visibleItems = dropdownItems.slice(0, maxDropdown);

  if (!isActive) {
    return null;
  }

  // Shorten CWD for display
  const home = process.env.HOME ?? "";
  const shortCwd = cwd && home && cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd;

  // ─── Multiline / paste detection ────────────────────────────
  const isMultiline = value.includes("\n");
  const lineCount = isMultiline ? value.split("\n").length : 1;

  // Single-line display — truncate around cursor to prevent terminal line-wrap artifacts
  const termWidth = process.stdout.columns || 80;
  const singleLineDisplay = !isMultiline ? value : "";
  const cursorPos = Math.min(cursor, singleLineDisplay.length);

  // Calculate prefix width: model + space + cwd + space + promptChar + space + vimIndicator
  const prefixWidth =
    (model ? model.length + 1 : 0) +
    (shortCwd ? shortCwd.length + 1 : 0) +
    (isVimModeEnabled() ? 4 : 0) + // "[N] " or "[I] "
    2; // promptChar + trailing space

  const maxInputWidth = Math.max(10, termWidth - prefixWidth - 2); // 2 for cursor + safety margin
  let visibleStart = 0;
  let visibleEnd = singleLineDisplay.length;

  if (singleLineDisplay.length > maxInputWidth) {
    // Keep cursor roughly centered in the visible window
    const half = Math.floor(maxInputWidth / 2);
    visibleStart = Math.max(0, cursorPos - half);
    visibleEnd = visibleStart + maxInputWidth;
    if (visibleEnd > singleLineDisplay.length) {
      visibleEnd = singleLineDisplay.length;
      visibleStart = Math.max(0, visibleEnd - maxInputWidth);
    }
  }

  const before = singleLineDisplay.slice(visibleStart, cursorPos);
  const cursorChar = singleLineDisplay[cursorPos] ?? " ";
  const after = singleLineDisplay.slice(cursorPos + 1, visibleEnd);

  // Compute hint text for tab completion
  let hint = "";
  if (tabMatches.length > 1 && tabIndex >= 0) {
    hint = ` (${tabIndex + 1}/${tabMatches.length})`;
  } else if (tabMatches.length > 1 && tabIndex === -1) {
    hint = ` (${tabMatches.length} matches, Tab to cycle)`;
  }

  const vimIndicator = isVimModeEnabled() ? (vimMode === "normal" ? "[N] " : "[I] ") : "";
  const promptChar = isQueuing ? "+" : "❯";
  const promptColor = isQueuing
    ? theme.warning
    : vimMode === "normal"
      ? theme.accent
      : theme.success;
  const queueHint =
    isQueuing && queueSize > 0 ? ` [${queueSize} queued]` : isQueuing ? " [will queue]" : "";

  // Paste compact summary
  const pasteFirstLine = isMultiline ? (value.split("\n")[0] || "").slice(0, 50) : "";
  const pasteSummary = isMultiline
    ? `${lineCount} lines, ${value.length.toLocaleString()} chars`
    : "";

  return (
    <Box flexDirection="column">
      {/* ─── Prompt line ──────────────────────────────────── */}
      <Box gap={1}>
        {model && <Text color={promptColor}>{model}</Text>}
        {shortCwd && <Text color={theme.dimmed}>{shortCwd}</Text>}
        <Text bold color={promptColor}>
          {vimIndicator}
          {promptChar}
        </Text>
        {isMultiline ? (
          <Text>
            <Text color={theme.accent}>{"📋 "}</Text>
            <Text color={theme.dimmed} italic>
              {pasteSummary}
            </Text>
            <Text color={promptColor}>{" — ↵ send"}</Text>
          </Text>
        ) : (
          <Text>
            {visibleStart > 0 && <Text color={theme.dimmed}>{"◀"}</Text>}
            {before}
            <Text inverse>{cursorChar}</Text>
            {after}
            {visibleEnd < singleLineDisplay.length && <Text color={theme.dimmed}>{"▶"}</Text>}
            {hint && <Text color={theme.dimmed}>{hint}</Text>}
            {queueHint && <Text color={theme.warning}>{queueHint}</Text>}
          </Text>
        )}
      </Box>

      {/* ─── Paste preview (compact) ──────────────────────── */}
      {isMultiline && (
        <Box marginLeft={4}>
          <Text color={theme.dimmed}>
            {pasteFirstLine}
            {pasteFirstLine.length < (value.split("\n")[0] || "").length ? "…" : ""}
          </Text>
        </Box>
      )}

      {/* ─── Command dropdown ─────────────────────────────── */}
      {visibleItems.length > 0 && (
        <Box flexDirection="column" marginLeft={2} marginTop={0}>
          {visibleItems.map((item, i) => {
            const isSelected = i === dropdownIndex;
            return (
              <Box key={item.name} gap={1}>
                <Text color={isSelected ? theme.primary : theme.dimmed}>
                  {isSelected ? "❯" : " "}
                </Text>
                <Text bold={isSelected} color={isSelected ? theme.primary : theme.secondary}>
                  {item.name}
                </Text>
                {item.description && <Text color={theme.dimmed}>{item.description}</Text>}
              </Box>
            );
          })}
          {dropdownItems.length > maxDropdown && (
            <Text color={theme.dimmed}> … {dropdownItems.length - maxDropdown} more</Text>
          )}
        </Box>
      )}
    </Box>
  );
}
