// KCode - Message search hook
// Provides incremental search across conversation messages with pre-lowercased cache.
// Activated via Ctrl+F, navigate with n/N, close with Escape.

import { useInput } from "ink";
import { useCallback, useMemo, useRef, useState } from "react";
import type { MessageEntry } from "../components/MessageList.js";

// ─── Types ──────────────────────────────────────────────────────

export interface SearchMatch {
  /** Index of the message in the messages array */
  messageIndex: number;
  /** Character offset of match within the message text */
  charOffset: number;
}

export interface UseMessageSearchOptions {
  /** All message entries to search through */
  messages: MessageEntry[];
  /** Whether the search input should capture keystrokes */
  isActive: boolean;
  /** Callback when search wants to scroll to a message */
  onScrollToMessage?: (index: number) => void;
}

export interface UseMessageSearchResult {
  /** Whether search mode is active */
  isSearching: boolean;
  /** Current search query */
  query: string;
  /** All matches found */
  matches: SearchMatch[];
  /** Index into matches array for the current highlight */
  currentMatch: number;
  /** Activate search mode */
  openSearch: () => void;
  /** Deactivate search mode and clear results */
  closeSearch: () => void;
  /** Update the search query */
  searchMessages: (query: string) => void;
  /** Jump to next match */
  nextMatch: () => void;
  /** Jump to previous match */
  prevMatch: () => void;
  /** Clear search without closing */
  clearSearch: () => void;
}

// ─── Pure search function (exported for testability) ────────────

/**
 * Extract searchable text from a MessageEntry.
 */
export function extractText(entry: MessageEntry): string {
  switch (entry.kind) {
    case "text":
      return entry.text;
    case "tool_use":
      return `${entry.name} ${entry.summary}`;
    case "tool_result":
      return `${entry.name} ${entry.result}`;
    case "thinking":
      return entry.text;
    case "banner":
      return `${entry.title} ${entry.subtitle}`;
    case "learn":
      return entry.text;
    case "suggestion":
      return entry.suggestions.map((s) => s.message).join(" ");
    case "plan":
      return `${entry.title} ${entry.steps.map((s) => s.title).join(" ")}`;
    case "diff":
      return `${entry.filePath} ${entry.hunks}`;
    case "partial_progress":
      return `${entry.summary} ${entry.filesModified.join(" ")}`;
    case "incomplete_response":
      return entry.stopReason;
  }
}

/**
 * Find all matches of a query in a set of messages.
 * Pure function for testability.
 *
 * @param messages - Array of message entries
 * @param query - Search query (will be lowercased)
 * @param textCache - Pre-lowercased text cache (messageIndex -> lowercased text)
 * @returns Array of matches sorted by messageIndex then charOffset
 */
export function findMatches(
  messages: MessageEntry[],
  query: string,
  textCache: Map<number, string>,
): SearchMatch[] {
  if (!query || query.length === 0) return [];

  const lowerQuery = query.toLowerCase();
  const matches: SearchMatch[] = [];

  for (let i = 0; i < messages.length; i++) {
    let cached = textCache.get(i);
    if (cached === undefined) {
      cached = extractText(messages[i]!).toLowerCase();
      textCache.set(i, cached);
    }

    // Find all occurrences in this message
    let pos = 0;
    while (pos < cached.length) {
      const idx = cached.indexOf(lowerQuery, pos);
      if (idx === -1) break;
      matches.push({ messageIndex: i, charOffset: idx });
      pos = idx + 1; // advance past this match start to find overlapping matches
    }
  }

  return matches;
}

// ─── Hook ───────────────────────────────────────────────────────

export function useMessageSearch({
  messages,
  isActive,
  onScrollToMessage,
}: UseMessageSearchOptions): UseMessageSearchResult {
  const [isSearching, setIsSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [currentMatch, setCurrentMatch] = useState(0);

  // Pre-lowercased text cache — invalidated when messages change
  const textCacheRef = useRef<Map<number, string>>(new Map());
  const prevMessageLengthRef = useRef(0);

  // Invalidate cache when messages grow
  if (messages.length !== prevMessageLengthRef.current) {
    // Keep existing entries, new messages will be cached on demand
    prevMessageLengthRef.current = messages.length;
  }

  const openSearch = useCallback(() => {
    setIsSearching(true);
    setQuery("");
    setMatches([]);
    setCurrentMatch(0);
  }, []);

  const closeSearch = useCallback(() => {
    setIsSearching(false);
    setQuery("");
    setMatches([]);
    setCurrentMatch(0);
  }, []);

  const clearSearch = useCallback(() => {
    setQuery("");
    setMatches([]);
    setCurrentMatch(0);
  }, []);

  const searchMessages = useCallback(
    (newQuery: string) => {
      setQuery(newQuery);
      if (!newQuery || newQuery.length === 0) {
        setMatches([]);
        setCurrentMatch(0);
        return;
      }

      const found = findMatches(messages, newQuery, textCacheRef.current);
      setMatches(found);
      setCurrentMatch(found.length > 0 ? 0 : -1);

      // Scroll to first match
      if (found.length > 0 && onScrollToMessage) {
        onScrollToMessage(found[0]!.messageIndex);
      }
    },
    [messages, onScrollToMessage],
  );

  const nextMatch = useCallback(() => {
    if (matches.length === 0) return;
    const next = (currentMatch + 1) % matches.length;
    setCurrentMatch(next);
    if (onScrollToMessage && matches[next]) {
      onScrollToMessage(matches[next]!.messageIndex);
    }
  }, [matches, currentMatch, onScrollToMessage]);

  const prevMatch = useCallback(() => {
    if (matches.length === 0) return;
    const prev = (currentMatch - 1 + matches.length) % matches.length;
    setCurrentMatch(prev);
    if (onScrollToMessage && matches[prev]) {
      onScrollToMessage(matches[prev]!.messageIndex);
    }
  }, [matches, currentMatch, onScrollToMessage]);

  // Handle search-mode keybindings
  useInput(
    (input, key) => {
      if (!isActive) return;

      // Ctrl+F opens search
      if (key.ctrl && input === "f" && !isSearching) {
        openSearch();
        return;
      }

      if (!isSearching) return;

      // Escape closes search
      if (key.escape) {
        closeSearch();
        return;
      }

      // Enter / n: next match
      if (key.return || (input === "n" && !key.ctrl && !key.meta)) {
        nextMatch();
        return;
      }

      // N: previous match
      if (input === "N") {
        prevMatch();
        return;
      }

      // Backspace: remove last character
      if (key.backspace || key.delete) {
        const newQuery = query.slice(0, -1);
        searchMessages(newQuery);
        return;
      }

      // Regular character input (printable, non-control)
      if (input && input.length === 1 && !key.ctrl && !key.meta) {
        const newQuery = query + input;
        searchMessages(newQuery);
        return;
      }
    },
    { isActive },
  );

  return {
    isSearching,
    query,
    matches,
    currentMatch,
    openSearch,
    closeSearch,
    searchMessages,
    nextMatch,
    prevMatch,
    clearSearch,
  };
}
