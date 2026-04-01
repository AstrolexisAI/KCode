// KCode - Session Share Tests

import { describe, test, expect, beforeEach } from "bun:test";
import { SessionShare } from "./session-share";
import type { CollabEvent } from "./types";

describe("SessionShare", () => {
  let share: SessionShare;
  let events: CollabEvent[];

  beforeEach(() => {
    share = new SessionShare();
    events = [];
    share.onEvent((e) => events.push(e));
  });

  // ─── startSharing ────────────────────────────────────────────

  test("startSharing generates valid share info", () => {
    const info = share.startSharing("sess-1", "owner-1", "Alice");
    expect(info.shareToken).toHaveLength(16);
    expect(info.shareUrl).toContain("share=");
    expect(info.shareUrl).toContain("localhost");
  });

  test("startSharing creates session with owner", () => {
    share.startSharing("sess-1", "owner-1", "Alice");
    const participants = share.getParticipants();
    expect(participants).toHaveLength(1);
    expect(participants[0]!.name).toBe("Alice");
    expect(participants[0]!.role).toBe("owner");
  });

  test("isActive returns true after sharing starts", () => {
    expect(share.isActive()).toBe(false);
    share.startSharing("sess-1", "owner-1", "Alice");
    expect(share.isActive()).toBe(true);
  });

  // ─── join ────────────────────────────────────────────────────

  test("join adds participant with correct role", () => {
    const info = share.startSharing("sess-1", "owner-1", "Alice", "interact");
    const result = share.join(info.shareToken, "Bob");
    expect(result.participant.name).toBe("Bob");
    expect(result.participant.role).toBe("collaborator");
    expect(share.getParticipants()).toHaveLength(2);
  });

  test("join in view mode creates viewer", () => {
    const info = share.startSharing("sess-1", "owner-1", "Alice", "view");
    const result = share.join(info.shareToken, "Bob");
    expect(result.participant.role).toBe("viewer");
  });

  test("join broadcasts collab.joined event", () => {
    const info = share.startSharing("sess-1", "owner-1", "Alice");
    share.join(info.shareToken, "Bob");
    expect(events.some((e) => e.type === "collab.joined")).toBe(true);
  });

  test("join rejects invalid token", () => {
    share.startSharing("sess-1", "owner-1", "Alice");
    expect(() => share.join("wrong-token", "Bob")).toThrow("Invalid share token");
  });

  test("join rejects when session is full", () => {
    const info = share.startSharing("sess-1", "owner-1", "Alice");
    // Add 4 more to reach limit of 5
    for (let i = 0; i < 4; i++) {
      share.join(info.shareToken, `User${i}`);
    }
    expect(share.getParticipants()).toHaveLength(5);
    expect(() => share.join(info.shareToken, "OneMore")).toThrow("Session is full");
  });

  test("join assigns unique colors", () => {
    const info = share.startSharing("sess-1", "owner-1", "Alice");
    share.join(info.shareToken, "Bob");
    share.join(info.shareToken, "Charlie");
    const colors = share.getParticipants().map((p) => p.color);
    const unique = new Set(colors);
    expect(unique.size).toBe(colors.length);
  });

  // ─── leave ───────────────────────────────────────────────────

  test("leave removes participant", () => {
    const info = share.startSharing("sess-1", "owner-1", "Alice");
    const { participant } = share.join(info.shareToken, "Bob");
    expect(share.getParticipants()).toHaveLength(2);
    share.leave(participant.id);
    expect(share.getParticipants()).toHaveLength(1);
  });

  test("leave broadcasts collab.left event", () => {
    const info = share.startSharing("sess-1", "owner-1", "Alice");
    const { participant } = share.join(info.shareToken, "Bob");
    share.leave(participant.id);
    expect(events.some((e) => e.type === "collab.left")).toBe(true);
  });

  test("leave with unknown id is a no-op", () => {
    share.startSharing("sess-1", "owner-1", "Alice");
    share.leave("nonexistent");
    expect(share.getParticipants()).toHaveLength(1);
  });

  // ─── kick ────────────────────────────────────────────────────

  test("kick removes participant when requester is owner", () => {
    const info = share.startSharing("sess-1", "owner-1", "Alice");
    const { participant } = share.join(info.shareToken, "Bob");
    share.kick(participant.id, "owner-1");
    expect(share.getParticipants()).toHaveLength(1);
  });

  test("kick rejects non-owner requester", () => {
    const info = share.startSharing("sess-1", "owner-1", "Alice");
    const { participant: bob } = share.join(info.shareToken, "Bob");
    const { participant: charlie } = share.join(info.shareToken, "Charlie");
    expect(() => share.kick(charlie.id, bob.id)).toThrow("Only the owner");
  });

  test("kick rejects kicking the owner", () => {
    const info = share.startSharing("sess-1", "owner-1", "Alice");
    share.join(info.shareToken, "Bob");
    expect(() => share.kick("owner-1", "owner-1")).toThrow("Cannot kick the owner");
  });

  // ─── sendAsParticipant ───────────────────────────────────────

  test("sendAsParticipant prefixes message with name", () => {
    const info = share.startSharing("sess-1", "owner-1", "Alice");
    const { participant } = share.join(info.shareToken, "Bob");
    const msg = share.sendAsParticipant(participant.id, "hello");
    expect(msg).toBe("[Bob] hello");
  });

  test("sendAsParticipant rejects viewers", () => {
    const info = share.startSharing("sess-1", "owner-1", "Alice", "view");
    const { participant } = share.join(info.shareToken, "Bob");
    expect(() => share.sendAsParticipant(participant.id, "hello")).toThrow("Viewers cannot send");
  });

  test("sendAsParticipant rejects unknown participant", () => {
    share.startSharing("sess-1", "owner-1", "Alice");
    expect(() => share.sendAsParticipant("unknown", "hello")).toThrow("Not a participant");
  });

  // ─── stopSharing ─────────────────────────────────────────────

  test("stopSharing clears session", () => {
    share.startSharing("sess-1", "owner-1", "Alice");
    share.stopSharing();
    expect(share.isActive()).toBe(false);
    expect(share.getParticipants()).toHaveLength(0);
  });

  test("stopSharing broadcasts collab.ended", () => {
    share.startSharing("sess-1", "owner-1", "Alice");
    share.stopSharing();
    expect(events.some((e) => e.type === "collab.ended")).toBe(true);
  });
});
