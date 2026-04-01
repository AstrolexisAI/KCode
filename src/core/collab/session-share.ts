// KCode - Session Sharing for Real-time Collaboration

import { log } from "../logger";
import type {
  CollabSession,
  CollabEvent,
  Participant,
  ShareInfo,
  JoinResult,
} from "./types";
import { PARTICIPANT_COLORS } from "./types";

type EventListener = (event: CollabEvent) => void;

export class SessionShare {
  private session: CollabSession | null = null;
  private listeners: Set<EventListener> = new Set();
  private port: number = 19300;

  /** Subscribe to collaboration events. */
  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Set the web server port (for URL generation). */
  setPort(port: number): void {
    this.port = port;
  }

  /** Start sharing the current session. */
  startSharing(
    sessionId: string,
    ownerId: string,
    ownerName: string,
    mode: "view" | "interact" = "interact",
  ): ShareInfo {
    const shareToken = this.generateToken(16);

    this.session = {
      sessionId,
      ownerId,
      shareToken,
      participants: [
        {
          id: ownerId,
          name: ownerName,
          role: "owner",
          connectedAt: Date.now(),
          lastActivity: Date.now(),
          color: PARTICIPANT_COLORS[0]!,
        },
      ],
      mode,
      maxParticipants: 5,
      createdAt: Date.now(),
    };

    log.debug("collab", `Session sharing started: ${shareToken}`);

    const shareUrl = `http://localhost:${this.port}?share=${shareToken}`;
    return { shareUrl, shareToken };
  }

  /** A participant joins the session. */
  join(token: string, name: string): JoinResult {
    if (!this.session) throw new Error("No active sharing session");
    if (token !== this.session.shareToken) throw new Error("Invalid share token");
    if (this.session.participants.length >= this.session.maxParticipants) {
      throw new Error("Session is full");
    }

    const participant: Participant = {
      id: this.generateToken(8),
      name,
      role: this.session.mode === "interact" ? "collaborator" : "viewer",
      connectedAt: Date.now(),
      lastActivity: Date.now(),
      color: this.assignColor(),
    };

    this.session.participants.push(participant);
    this.broadcast({ type: "collab.joined", data: { participant }, timestamp: Date.now() });

    return {
      participant,
      history: [],
      currentState: { model: "", tokens: 0, isResponding: false },
    };
  }

  /** Remove a participant. */
  leave(participantId: string): void {
    if (!this.session) return;
    const idx = this.session.participants.findIndex((p) => p.id === participantId);
    if (idx === -1) return;
    const removed = this.session.participants.splice(idx, 1)[0]!;
    this.broadcast({ type: "collab.left", data: { participant: removed }, timestamp: Date.now() });
  }

  /** Kick a participant (owner only). */
  kick(participantId: string, requesterId: string): void {
    if (!this.session) throw new Error("No active sharing session");
    const requester = this.session.participants.find((p) => p.id === requesterId);
    if (!requester || requester.role !== "owner") {
      throw new Error("Only the owner can kick participants");
    }
    const target = this.session.participants.find((p) => p.id === participantId);
    if (!target) throw new Error("Participant not found");
    if (target.role === "owner") throw new Error("Cannot kick the owner");
    this.leave(participantId);
    this.broadcast({ type: "collab.kicked", data: { participantId }, timestamp: Date.now() });
  }

  /** Send a message as a participant. */
  sendAsParticipant(participantId: string, content: string): string {
    if (!this.session) throw new Error("No active sharing session");
    const participant = this.session.participants.find((p) => p.id === participantId);
    if (!participant) throw new Error("Not a participant");
    if (participant.role === "viewer") throw new Error("Viewers cannot send messages");
    participant.lastActivity = Date.now();
    return `[${participant.name}] ${content}`;
  }

  /** Stop sharing. */
  stopSharing(): void {
    if (!this.session) return;
    this.broadcast({ type: "collab.ended", data: {}, timestamp: Date.now() });
    this.session = null;
  }

  /** Get current participants. */
  getParticipants(): Participant[] {
    return this.session?.participants ?? [];
  }

  /** Get the active session. */
  getSession(): CollabSession | null {
    return this.session;
  }

  isActive(): boolean {
    return this.session !== null;
  }

  // ─── Private helpers ─────────────────────────────────────────

  private broadcast(event: CollabEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        log.debug("collab", `Event listener error: ${err}`);
      }
    }
  }

  private assignColor(): string {
    const usedColors = new Set(this.session?.participants.map((p) => p.color));
    for (const color of PARTICIPANT_COLORS) {
      if (!usedColors.has(color)) return color;
    }
    return PARTICIPANT_COLORS[0]!;
  }

  private generateToken(length: number): string {
    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => chars[b % chars.length]).join("");
  }
}
