// KCode Bridge/Daemon Mode - Session Manager
// Manages multiple concurrent KCode sessions for the daemon.

import { randomUUID } from "node:crypto";
import { log } from "../core/logger";
import type { Session, SessionStatus, SpawnMode } from "./types";

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_MAX_SESSIONS = 20;
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const GC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ─── Internal Session State ─────────────────────────────────────

interface InternalSession {
  id: string;
  dir: string;
  spawnMode: SpawnMode;
  model: string;
  createdAt: Date;
  lastActivityAt: Date;
  status: SessionStatus;
  worktreePath?: string;
  clientCount: number;
  /** Callback invoked when the session is destroyed. */
  onDestroy?: () => void | Promise<void>;
}

// ─── Events ─────────────────────────────────────────────────────

export type SessionEventType = "created" | "destroyed" | "idle-timeout" | "status-changed";

export interface SessionEvent {
  type: SessionEventType;
  sessionId: string;
  reason?: string;
}

export type SessionEventListener = (event: SessionEvent) => void;

// ─── Session Manager ────────────────────────────────────────────

export class SessionManager {
  private sessions = new Map<string, InternalSession>();
  private gcTimer: ReturnType<typeof setInterval> | null = null;
  private listeners: SessionEventListener[] = [];

  readonly maxSessions: number;
  readonly idleTimeoutMs: number;

  constructor(opts?: { maxSessions?: number; idleTimeoutMs?: number; gcIntervalMs?: number }) {
    this.maxSessions = opts?.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.idleTimeoutMs = opts?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    const gcInterval = opts?.gcIntervalMs ?? GC_INTERVAL_MS;

    // Start GC timer
    this.gcTimer = setInterval(() => this.gc(), gcInterval);
    // Unref so it doesn't keep the process alive on its own
    if (this.gcTimer && typeof this.gcTimer === "object" && "unref" in this.gcTimer) {
      (this.gcTimer as NodeJS.Timeout).unref();
    }
  }

  // ─── Event System ───────────────────────────────────────────

  onEvent(listener: SessionEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private emit(event: SessionEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        log.error("session-manager", `Event listener error: ${err}`);
      }
    }
  }

  // ─── Session CRUD ─────────────────────────────────────────────

  /**
   * Create a new session.
   * Returns the session ID.
   */
  createSession(opts: {
    dir: string;
    spawnMode: SpawnMode;
    model?: string;
    worktreePath?: string;
    onDestroy?: () => void | Promise<void>;
  }): string {
    if (this.sessions.size >= this.maxSessions) {
      throw new Error(`Maximum sessions reached (${this.maxSessions})`);
    }

    const id = randomUUID();
    const now = new Date();

    const session: InternalSession = {
      id,
      dir: opts.dir,
      spawnMode: opts.spawnMode,
      model: opts.model ?? "default",
      createdAt: now,
      lastActivityAt: now,
      status: "idle",
      worktreePath: opts.worktreePath,
      clientCount: 0,
      onDestroy: opts.onDestroy,
    };

    this.sessions.set(id, session);
    log.info("session-manager", `Session created: ${id} (dir=${opts.dir}, mode=${opts.spawnMode})`);
    this.emit({ type: "created", sessionId: id });

    return id;
  }

  /**
   * Destroy a session, invoking its onDestroy callback if set.
   */
  async destroySession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    try {
      if (session.onDestroy) {
        await session.onDestroy();
      }
    } catch (err) {
      log.error("session-manager", `Error in session onDestroy (${sessionId}): ${err}`);
    }

    this.sessions.delete(sessionId);
    log.info("session-manager", `Session destroyed: ${sessionId}`);
    this.emit({ type: "destroyed", sessionId });
    return true;
  }

  /**
   * Get a session by ID. Returns undefined if not found.
   */
  getSession(sessionId: string): Session | undefined {
    const internal = this.sessions.get(sessionId);
    if (!internal) return undefined;
    return this.toPublicSession(internal);
  }

  /**
   * List all active sessions.
   */
  listSessions(): Session[] {
    return Array.from(this.sessions.values()).map((s) => this.toPublicSession(s));
  }

  /**
   * Get the count of active sessions.
   */
  get sessionCount(): number {
    return this.sessions.size;
  }

  // ─── Session State Updates ────────────────────────────────────

  /**
   * Mark a session as active (e.g., when a message is sent).
   */
  touchSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivityAt = new Date();
    }
  }

  /**
   * Update the status of a session.
   */
  setStatus(sessionId: string, status: SessionStatus): void {
    const session = this.sessions.get(sessionId);
    if (session && session.status !== status) {
      session.status = status;
      session.lastActivityAt = new Date();
      this.emit({ type: "status-changed", sessionId });
    }
  }

  /**
   * Increment or decrement the client count for a session.
   */
  adjustClientCount(sessionId: string, delta: number): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.clientCount = Math.max(0, session.clientCount + delta);
    }
  }

  /**
   * Check if a session exists.
   */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  // ─── Garbage Collection ───────────────────────────────────────

  /**
   * Run garbage collection: destroy idle sessions and sessions with no clients.
   * Returns the list of destroyed session IDs.
   */
  async gc(): Promise<string[]> {
    const now = Date.now();
    const destroyed: string[] = [];

    for (const [id, session] of this.sessions) {
      const idleMs = now - session.lastActivityAt.getTime();

      // Idle timeout
      if (idleMs > this.idleTimeoutMs) {
        log.info(
          "session-manager",
          `GC: destroying idle session ${id} (idle for ${Math.round(idleMs / 1000)}s)`,
        );
        this.emit({ type: "idle-timeout", sessionId: id, reason: "idle timeout" });
        await this.destroySession(id);
        destroyed.push(id);
        continue;
      }

      // No clients and idle — destroy
      if (session.clientCount <= 0 && session.status === "idle") {
        log.info("session-manager", `GC: destroying orphaned session ${id} (no clients)`);
        await this.destroySession(id);
        destroyed.push(id);
      }
    }

    return destroyed;
  }

  // ─── Shutdown ─────────────────────────────────────────────────

  /**
   * Shut down the session manager: stop GC, destroy all sessions.
   */
  async shutdown(): Promise<void> {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }

    const ids = Array.from(this.sessions.keys());
    for (const id of ids) {
      await this.destroySession(id);
    }

    this.listeners = [];
    log.info("session-manager", "Session manager shut down");
  }

  // ─── Private ──────────────────────────────────────────────────

  private toPublicSession(s: InternalSession): Session {
    return {
      id: s.id,
      dir: s.dir,
      spawnMode: s.spawnMode,
      model: s.model,
      createdAt: s.createdAt,
      lastActivityAt: s.lastActivityAt,
      status: s.status,
      worktreePath: s.worktreePath,
      clientCount: s.clientCount,
    };
  }
}
