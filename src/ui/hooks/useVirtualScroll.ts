// KCode - Virtual scroll hook for terminal-based message virtualization
// Tracks scroll offset, visible range, follow mode, and height cache
// Only renders messages in the visible viewport + buffer for performance

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useInput } from "ink";
import type { MessageEntry } from "../components/MessageList.js";

// ─── Constants ──────────────────────────────────────────────────

/** Number of extra messages to render above/below the viewport */
export const BUFFER_SIZE = 5;

/** Default estimated height (in terminal rows) for unmeasured messages */
export const DEFAULT_HEIGHT = 3;

/** Lines per page-up/page-down */
const HALF_PAGE_MULTIPLIER = 0.5;

/** Lines per mouse wheel tick */
const WHEEL_LINES = 3;

// ─── Pure calculation functions (exported for testability) ──────

export interface VisibleRange {
  /** First message index to render (including buffer) */
  renderStart: number;
  /** Last message index to render (including buffer), inclusive */
  renderEnd: number;
  /** First message index actually visible in viewport */
  firstVisible: number;
  /** Last message index actually visible in viewport */
  lastVisible: number;
  /** Total content height in rows across all messages */
  totalHeight: number;
  /** Height of content above the render window (for spacer) */
  spacerTop: number;
  /** Height of content below the render window (for spacer) */
  spacerBottom: number;
}

/**
 * Calculate which messages are visible given scroll state.
 * Pure function — no side effects, fully testable.
 */
export function calculateVisibleRange(
  messageCount: number,
  heights: Map<string, number>,
  scrollOffset: number,
  terminalRows: number,
  bufferSize: number,
  getMessageId: (index: number) => string,
): VisibleRange {
  if (messageCount === 0) {
    return {
      renderStart: 0,
      renderEnd: -1,
      firstVisible: 0,
      lastVisible: -1,
      totalHeight: 0,
      spacerTop: 0,
      spacerBottom: 0,
    };
  }

  // 1. Compute total height
  let totalHeight = 0;
  for (let i = 0; i < messageCount; i++) {
    totalHeight += heights.get(getMessageId(i)) ?? DEFAULT_HEIGHT;
  }

  // Clamp scroll offset
  const maxScroll = Math.max(0, totalHeight - terminalRows);
  const clampedOffset = Math.max(0, Math.min(scrollOffset, maxScroll));

  // 2. Find first visible message
  let accumulated = 0;
  let firstVisible = 0;
  for (let i = 0; i < messageCount; i++) {
    const h = heights.get(getMessageId(i)) ?? DEFAULT_HEIGHT;
    if (accumulated + h > clampedOffset) {
      firstVisible = i;
      break;
    }
    accumulated += h;
    // If we exhaust all messages, firstVisible stays at last
    if (i === messageCount - 1) {
      firstVisible = i;
    }
  }

  // 3. Find last visible message
  let visibleHeight = 0;
  let lastVisible = firstVisible;
  // Account for partial first message visibility
  const firstMsgHeight = heights.get(getMessageId(firstVisible)) ?? DEFAULT_HEIGHT;
  const firstMsgVisiblePortion = accumulated + firstMsgHeight - clampedOffset;
  visibleHeight += firstMsgVisiblePortion;

  for (let i = firstVisible + 1; i < messageCount; i++) {
    if (visibleHeight >= terminalRows) break;
    const h = heights.get(getMessageId(i)) ?? DEFAULT_HEIGHT;
    visibleHeight += h;
    lastVisible = i;
  }

  // 4. Apply buffer
  const renderStart = Math.max(0, firstVisible - bufferSize);
  const renderEnd = Math.min(messageCount - 1, lastVisible + bufferSize);

  // 5. Calculate spacer heights
  let spacerTop = 0;
  for (let i = 0; i < renderStart; i++) {
    spacerTop += heights.get(getMessageId(i)) ?? DEFAULT_HEIGHT;
  }

  let spacerBottom = 0;
  for (let i = renderEnd + 1; i < messageCount; i++) {
    spacerBottom += heights.get(getMessageId(i)) ?? DEFAULT_HEIGHT;
  }

  return {
    renderStart,
    renderEnd,
    firstVisible,
    lastVisible,
    totalHeight,
    spacerTop,
    spacerBottom,
  };
}

/**
 * Compute max scroll offset for a given total height and terminal rows.
 */
export function maxScrollOffset(totalHeight: number, terminalRows: number): number {
  return Math.max(0, totalHeight - terminalRows);
}

// ─── Hook ───────────────────────────────────────────────────────

export interface UseVirtualScrollOptions {
  /** All message entries */
  messages: MessageEntry[];
  /** Whether the hook should handle key input (disable when not in scroll mode) */
  isActive: boolean;
  /** Terminal rows available for the message area */
  terminalRows?: number;
}

export interface UseVirtualScrollResult {
  /** The calculated visible range */
  range: VisibleRange;
  /** Whether follow mode is active (auto-scroll to bottom) */
  following: boolean;
  /** Current scroll offset in rows */
  scrollOffset: number;
  /** Height cache (message key -> measured height) */
  heightCache: Map<string, number>;
  /** Report measured height for a message */
  setHeight: (key: string, height: number) => void;
  /** Scroll to bottom and re-enable follow mode */
  scrollToBottom: () => void;
  /** Scroll to a specific message index */
  scrollToMessage: (index: number) => void;
  /** Invalidate height cache (e.g., on terminal resize) */
  invalidateHeights: () => void;
}

/**
 * Get a stable ID for a message entry based on its index.
 * Messages don't have IDs, so we use a positional key.
 */
function messageKey(index: number): string {
  return `msg-${index}`;
}

export function useVirtualScroll({
  messages,
  isActive,
  terminalRows: terminalRowsOverride,
}: UseVirtualScrollOptions): UseVirtualScrollResult {
  const [scrollOffset, setScrollOffset] = useState(0);
  const [following, setFollowing] = useState(true);
  const [heightCache, setHeightCache] = useState<Map<string, number>>(() => new Map());
  const prevMessageCount = useRef(messages.length);
  const prevColumns = useRef(process.stdout.columns || 80);

  // Terminal dimensions
  const terminalRows = terminalRowsOverride ?? (process.stdout.rows || 24);

  // Build getMessageId callback for calculateVisibleRange
  const getMessageId = useCallback((index: number) => messageKey(index), []);

  // Calculate visible range
  const range = useMemo(
    () =>
      calculateVisibleRange(
        messages.length,
        heightCache,
        scrollOffset,
        terminalRows,
        BUFFER_SIZE,
        getMessageId,
      ),
    [messages.length, heightCache, scrollOffset, terminalRows, getMessageId],
  );

  // Follow mode: auto-scroll when new messages arrive
  useEffect(() => {
    if (following && messages.length > prevMessageCount.current) {
      const max = maxScrollOffset(range.totalHeight, terminalRows);
      setScrollOffset(max);
    }
    prevMessageCount.current = messages.length;
  }, [messages.length, following, range.totalHeight, terminalRows]);

  // Invalidate height cache on terminal column resize
  useEffect(() => {
    const checkResize = () => {
      const currentColumns = process.stdout.columns || 80;
      if (currentColumns !== prevColumns.current) {
        prevColumns.current = currentColumns;
        setHeightCache(new Map());
      }
    };
    process.stdout.on("resize", checkResize);
    return () => {
      process.stdout.off("resize", checkResize);
    };
  }, []);

  // Height reporting
  const setHeight = useCallback((key: string, height: number) => {
    setHeightCache((prev) => {
      if (prev.get(key) === height) return prev;
      const next = new Map(prev);
      next.set(key, height);
      return next;
    });
  }, []);

  // Scroll to bottom
  const scrollToBottom = useCallback(() => {
    const max = maxScrollOffset(range.totalHeight, terminalRows);
    setScrollOffset(max);
    setFollowing(true);
  }, [range.totalHeight, terminalRows]);

  // Scroll to specific message
  const scrollToMessage = useCallback(
    (index: number) => {
      let offset = 0;
      for (let i = 0; i < Math.min(index, messages.length); i++) {
        offset += heightCache.get(messageKey(i)) ?? DEFAULT_HEIGHT;
      }
      setScrollOffset(offset);
      setFollowing(false);
    },
    [messages.length, heightCache],
  );

  // Invalidate heights
  const invalidateHeights = useCallback(() => {
    setHeightCache(new Map());
  }, []);

  // Scroll helper
  const scrollBy = useCallback(
    (delta: number) => {
      setScrollOffset((prev) => {
        const max = maxScrollOffset(range.totalHeight, terminalRows);
        const next = Math.max(0, Math.min(prev + delta, max));
        // Disable follow mode when scrolling up
        if (delta < 0) {
          setFollowing(false);
        }
        // Re-enable follow mode when scrolling to bottom
        if (next >= max) {
          setFollowing(true);
        } else if (delta < 0) {
          setFollowing(false);
        }
        return next;
      });
    },
    [range.totalHeight, terminalRows],
  );

  // Keybindings
  useInput(
    (input, key) => {
      if (!isActive) return;

      const halfPage = Math.max(1, Math.floor(terminalRows * HALF_PAGE_MULTIPLIER));

      // j / Down arrow: scroll down 1 line
      if (input === "j" || key.downArrow) {
        scrollBy(1);
        return;
      }

      // k / Up arrow: scroll up 1 line
      if (input === "k" || key.upArrow) {
        scrollBy(-1);
        return;
      }

      // Page Down / Ctrl+D: scroll down half page
      if (key.pageDown || (key.ctrl && input === "d")) {
        scrollBy(halfPage);
        return;
      }

      // Page Up / Ctrl+U: scroll up half page
      if (key.pageUp || (key.ctrl && input === "u")) {
        scrollBy(-halfPage);
        return;
      }

      // g / Home: scroll to top
      if (input === "g" && !key.ctrl && !key.meta) {
        setScrollOffset(0);
        setFollowing(false);
        return;
      }

      // G / End: scroll to bottom (follow mode)
      if (input === "G") {
        scrollToBottom();
        return;
      }
    },
    { isActive },
  );

  return {
    range,
    following,
    scrollOffset,
    heightCache,
    setHeight,
    scrollToBottom,
    scrollToMessage,
    invalidateHeights,
  };
}
