// KCode - Cursor Synchronization for Collaboration

import { log } from "../logger";
import type { CollabEvent, CursorPosition } from "./types";

type EventListener = (event: CollabEvent) => void;

const STALE_TIMEOUT_MS = 60_000;
const DEBOUNCE_MS = 100;

export class CursorSync {
  private cursors = new Map<string, CursorPosition>();
  private listeners: Set<EventListener> = new Set();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Clean up stale cursors every 30s
    this.cleanupTimer = setInterval(() => this.cleanupStale(), 30_000);
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Update a participant's cursor position (debounced). */
  updateCursor(
    participantId: string,
    file: string,
    line: number,
    col: number,
    color: string,
  ): void {
    // Debounce rapid updates
    const existing = this.debounceTimers.get(participantId);
    if (existing) clearTimeout(existing);

    this.debounceTimers.set(
      participantId,
      setTimeout(() => {
        this.debounceTimers.delete(participantId);
        const position: CursorPosition = {
          participantId,
          file,
          line,
          col,
          color,
          updatedAt: Date.now(),
        };
        this.cursors.set(participantId, position);

        this.broadcast({
          type: "collab.cursor",
          data: { position },
          timestamp: Date.now(),
          participantId,
        });
      }, DEBOUNCE_MS),
    );
  }

  /** Update cursor immediately (no debounce). */
  updateCursorImmediate(
    participantId: string,
    file: string,
    line: number,
    col: number,
    color: string,
  ): void {
    const position: CursorPosition = {
      participantId,
      file,
      line,
      col,
      color,
      updatedAt: Date.now(),
    };
    this.cursors.set(participantId, position);

    this.broadcast({
      type: "collab.cursor",
      data: { position },
      timestamp: Date.now(),
      participantId,
    });
  }

  /** Get all active cursor positions. */
  getCursors(): Map<string, CursorPosition> {
    return new Map(this.cursors);
  }

  /** Get a specific participant's cursor. */
  getCursor(participantId: string): CursorPosition | undefined {
    return this.cursors.get(participantId);
  }

  /** Remove a participant's cursor. */
  removeCursor(participantId: string): void {
    this.cursors.delete(participantId);
    const timer = this.debounceTimers.get(participantId);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(participantId);
    }
  }

  /** Clean up stale cursors (no update for 60s). */
  cleanupStale(): number {
    const now = Date.now();
    let removed = 0;
    for (const [id, pos] of this.cursors) {
      if (now - pos.updatedAt > STALE_TIMEOUT_MS) {
        this.cursors.delete(id);
        removed++;
      }
    }
    if (removed > 0) {
      log.debug("collab/cursor", `Cleaned up ${removed} stale cursors`);
    }
    return removed;
  }

  /** Dispose of timers. */
  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.cursors.clear();
  }

  private broadcast(event: CollabEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        log.debug("collab/cursor", `Event listener error: ${err}`);
      }
    }
  }
}
