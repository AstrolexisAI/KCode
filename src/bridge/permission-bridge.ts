// KCode Bridge/Daemon Mode - Permission Bridge
// Bridges permission requests from ConversationManager to connected WebSocket clients.

import { randomUUID } from "node:crypto";
import { log } from "../core/logger";
import { createMessage } from "./protocol";
import type { PermissionRequestMessage, PermissionResponseMessage } from "./types";

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_PERMISSION_TIMEOUT_MS = 30_000; // 30 seconds

// ─── Pending Request ────────────────────────────────────────────

interface PendingPermissionRequest {
  requestId: string;
  sessionId: string;
  resolve: (allowed: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ─── Permission Bridge ──────────────────────────────────────────

export class PermissionBridge {
  private pending = new Map<string, PendingPermissionRequest>();
  private timeoutMs: number;
  private broadcastFn: ((sessionId: string, msg: PermissionRequestMessage) => void) | null = null;

  constructor(opts?: { timeoutMs?: number }) {
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
  }

  /**
   * Set the broadcast function used to send permission requests to connected clients.
   * This is typically set by the WebSocket server after initialization.
   */
  setBroadcast(fn: (sessionId: string, msg: PermissionRequestMessage) => void): void {
    this.broadcastFn = fn;
  }

  /**
   * Request permission from connected clients for a tool invocation.
   * Returns true if allowed, false if denied or timed out.
   */
  async requestPermission(opts: {
    sessionId: string;
    tool: string;
    input: Record<string, unknown>;
    safetyAnalysis?: { level: string; details: string };
  }): Promise<boolean> {
    if (!this.broadcastFn) {
      log.warn("permission-bridge", "No broadcast function set — denying by default");
      return false;
    }

    const requestId = randomUUID();

    const msg = createMessage<PermissionRequestMessage>("permission.request", {
      sessionId: opts.sessionId,
      requestId,
      tool: opts.tool,
      input: opts.input,
      safetyAnalysis: opts.safetyAnalysis ?? { level: "unknown", details: "No analysis available" },
    });

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        log.warn("permission-bridge", `Permission request ${requestId} timed out after ${this.timeoutMs}ms — denying`);
        this.pending.delete(requestId);
        resolve(false);
      }, this.timeoutMs);

      // Unref the timer so it doesn't keep the process alive
      if (timer && typeof timer === "object" && "unref" in timer) {
        (timer as NodeJS.Timeout).unref();
      }

      this.pending.set(requestId, {
        requestId,
        sessionId: opts.sessionId,
        resolve,
        timer,
      });

      // Send the request to clients
      try {
        this.broadcastFn!(opts.sessionId, msg);
      } catch (err) {
        log.error("permission-bridge", `Failed to broadcast permission request: ${err}`);
        this.pending.delete(requestId);
        clearTimeout(timer);
        resolve(false);
      }
    });
  }

  /**
   * Handle a permission response from a client.
   * Returns true if the response was matched to a pending request.
   */
  handleResponse(msg: PermissionResponseMessage): boolean {
    const pending = this.pending.get(msg.requestId);
    if (!pending) {
      log.warn("permission-bridge", `Received response for unknown request: ${msg.requestId}`);
      return false;
    }

    // Verify session matches
    if (pending.sessionId !== msg.sessionId) {
      log.warn("permission-bridge", `Session mismatch for request ${msg.requestId}: expected ${pending.sessionId}, got ${msg.sessionId}`);
      return false;
    }

    clearTimeout(pending.timer);
    this.pending.delete(msg.requestId);

    log.info("permission-bridge", `Permission ${msg.allowed ? "granted" : "denied"} for request ${msg.requestId}`);
    pending.resolve(msg.allowed);
    return true;
  }

  /**
   * Get the number of pending permission requests.
   */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Cancel all pending permission requests (e.g., on shutdown).
   */
  cancelAll(): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve(false);
    }
    this.pending.clear();
  }
}
