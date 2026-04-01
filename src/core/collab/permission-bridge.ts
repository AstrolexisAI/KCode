// KCode - Collaborative Permission Bridge
// Routes permission requests through multi-user approval flow.

import { log } from "../logger";
import type { CollabEvent } from "./types";
import type { SessionShare } from "./session-share";

interface PendingRequest {
  resolve: (allowed: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
  escalated: boolean;
}

type EventListener = (event: CollabEvent) => void;

export class CollabPermissionBridge {
  private pending = new Map<string, PendingRequest>();
  private listeners: Set<EventListener> = new Set();
  private sessionShare: SessionShare;

  constructor(sessionShare: SessionShare) {
    this.sessionShare = sessionShare;
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Request permission through the collab flow. */
  async requestPermission(toolName: string, input: unknown): Promise<boolean> {
    const requestId = crypto.randomUUID();

    // Broadcast to all participants
    this.broadcast({
      type: "permission.request",
      data: { id: requestId, tool: toolName, input, ownerOnly: true },
      timestamp: Date.now(),
    });

    return new Promise<boolean>((resolve) => {
      // 30s timeout for owner
      const timer = setTimeout(() => {
        const pending = this.pending.get(requestId);
        if (!pending) return;

        // Escalate to collaborators
        pending.escalated = true;
        this.broadcast({
          type: "permission.escalated",
          data: { id: requestId, reason: "Owner did not respond" },
          timestamp: Date.now(),
        });

        // 30s timeout for collaborators
        const collabTimer = setTimeout(() => {
          this.pending.delete(requestId);
          log.debug("collab/permission", `Permission ${requestId} denied: no response`);
          resolve(false);
        }, 30_000);

        pending.timer = collabTimer;
      }, 30_000);

      this.pending.set(requestId, { resolve, timer, escalated: false });
    });
  }

  /** Respond to a pending permission request. */
  respondToPermission(requestId: string, participantId: string, allowed: boolean): void {
    const pending = this.pending.get(requestId);
    if (!pending) {
      log.debug("collab/permission", `No pending request: ${requestId}`);
      return;
    }

    const participants = this.sessionShare.getParticipants();
    const responder = participants.find((p) => p.id === participantId);
    if (!responder) return;

    // Only owner can respond initially; collaborators after escalation
    if (!pending.escalated && responder.role !== "owner") {
      log.debug("collab/permission", `Non-owner response rejected before escalation`);
      return;
    }
    if (pending.escalated && responder.role === "viewer") {
      log.debug("collab/permission", `Viewer response rejected`);
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(requestId);

    this.broadcast({
      type: "permission.resolved",
      data: { id: requestId, allowed, responderId: participantId },
      timestamp: Date.now(),
    });

    pending.resolve(allowed);
  }

  /** Cancel all pending requests. */
  cancelAll(): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve(false);
    }
    this.pending.clear();
  }

  hasPending(): boolean {
    return this.pending.size > 0;
  }

  private broadcast(event: CollabEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        log.debug("collab/permission", `Event listener error: ${err}`);
      }
    }
  }
}
