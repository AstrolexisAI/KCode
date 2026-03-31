// Tests for Bridge Protocol - message parsing, serialization, and creation

import { describe, test, expect } from "bun:test";
import { parseMessage, serializeMessage, createMessage, isClientMessageType, isServerMessageType } from "./protocol";
import type {
  PingMessage,
  PongMessage,
  SessionCreateMessage,
  SessionMessageMessage,
  SessionCancelMessage,
  SessionDestroyMessage,
  PermissionResponseMessage,
  SessionCreatedMessage,
  SessionDoneMessage,
  ShutdownMessage,
} from "./types";

// ─── parseMessage ───────────────────────────────────────────────

describe("parseMessage", () => {
  test("parses a valid ping message", () => {
    const raw = JSON.stringify({ type: "ping", id: "abc-123", timestamp: "2026-01-01T00:00:00.000Z" });
    const msg = parseMessage(raw);
    expect(msg.type).toBe("ping");
    expect(msg.id).toBe("abc-123");
  });

  test("parses a valid session.create message", () => {
    const raw = JSON.stringify({
      type: "session.create",
      id: "id-1",
      timestamp: "2026-01-01T00:00:00.000Z",
      dir: "/home/user/project",
      spawnMode: "single-session",
    });
    const msg = parseMessage(raw) as SessionCreateMessage;
    expect(msg.type).toBe("session.create");
    expect(msg.dir).toBe("/home/user/project");
    expect(msg.spawnMode).toBe("single-session");
  });

  test("parses session.create with optional model and initialPrompt", () => {
    const raw = JSON.stringify({
      type: "session.create",
      id: "id-2",
      timestamp: "2026-01-01T00:00:00.000Z",
      dir: "/tmp",
      spawnMode: "worktree",
      model: "claude-sonnet-4-6",
      initialPrompt: "fix the bug",
    });
    const msg = parseMessage(raw) as SessionCreateMessage;
    expect(msg.model).toBe("claude-sonnet-4-6");
    expect(msg.initialPrompt).toBe("fix the bug");
  });

  test("parses a valid session.message", () => {
    const raw = JSON.stringify({
      type: "session.message",
      id: "id-3",
      timestamp: "2026-01-01T00:00:00.000Z",
      sessionId: "sess-1",
      content: "hello",
    });
    const msg = parseMessage(raw) as SessionMessageMessage;
    expect(msg.sessionId).toBe("sess-1");
    expect(msg.content).toBe("hello");
  });

  test("parses a valid session.cancel", () => {
    const raw = JSON.stringify({
      type: "session.cancel",
      id: "id-4",
      timestamp: "2026-01-01T00:00:00.000Z",
      sessionId: "sess-1",
    });
    const msg = parseMessage(raw) as SessionCancelMessage;
    expect(msg.type).toBe("session.cancel");
  });

  test("parses a valid session.destroy", () => {
    const raw = JSON.stringify({
      type: "session.destroy",
      id: "id-5",
      timestamp: "2026-01-01T00:00:00.000Z",
      sessionId: "sess-1",
    });
    const msg = parseMessage(raw) as SessionDestroyMessage;
    expect(msg.type).toBe("session.destroy");
  });

  test("parses a valid permission.response", () => {
    const raw = JSON.stringify({
      type: "permission.response",
      id: "id-6",
      timestamp: "2026-01-01T00:00:00.000Z",
      sessionId: "sess-1",
      requestId: "req-1",
      allowed: true,
      remember: false,
    });
    const msg = parseMessage(raw) as PermissionResponseMessage;
    expect(msg.allowed).toBe(true);
    expect(msg.remember).toBe(false);
  });

  test("accepts known server message types", () => {
    const raw = JSON.stringify({
      type: "session.created",
      id: "id-7",
      timestamp: "2026-01-01T00:00:00.000Z",
      sessionId: "sess-1",
      dir: "/tmp",
      model: "gpt-4",
    });
    const msg = parseMessage(raw);
    expect(msg.type).toBe("session.created");
  });

  // ─── Error cases ────────────────────────────────────────────

  test("throws on invalid JSON", () => {
    expect(() => parseMessage("not json")).toThrow("Invalid JSON");
  });

  test("throws on non-object JSON", () => {
    expect(() => parseMessage('"hello"')).toThrow("must be a JSON object");
  });

  test("throws on array JSON", () => {
    expect(() => parseMessage("[]")).toThrow("must be a JSON object");
  });

  test("throws on missing type", () => {
    const raw = JSON.stringify({ id: "x", timestamp: "t" });
    expect(() => parseMessage(raw)).toThrow("missing or invalid 'type'");
  });

  test("throws on missing id", () => {
    const raw = JSON.stringify({ type: "ping", timestamp: "t" });
    expect(() => parseMessage(raw)).toThrow("missing or invalid 'id'");
  });

  test("throws on missing timestamp", () => {
    const raw = JSON.stringify({ type: "ping", id: "x" });
    expect(() => parseMessage(raw)).toThrow("missing or invalid 'timestamp'");
  });

  test("throws on unknown message type", () => {
    const raw = JSON.stringify({ type: "unknown.type", id: "x", timestamp: "t" });
    expect(() => parseMessage(raw)).toThrow("Unknown message type");
  });

  test("throws on session.create with invalid spawnMode", () => {
    const raw = JSON.stringify({
      type: "session.create",
      id: "x",
      timestamp: "t",
      dir: "/tmp",
      spawnMode: "invalid",
    });
    expect(() => parseMessage(raw)).toThrow("invalid spawnMode");
  });

  test("throws on session.create missing dir", () => {
    const raw = JSON.stringify({
      type: "session.create",
      id: "x",
      timestamp: "t",
      spawnMode: "single-session",
    });
    expect(() => parseMessage(raw)).toThrow("missing or invalid 'dir'");
  });

  test("throws on session.message missing content", () => {
    const raw = JSON.stringify({
      type: "session.message",
      id: "x",
      timestamp: "t",
      sessionId: "s",
    });
    expect(() => parseMessage(raw)).toThrow("missing or invalid 'content'");
  });

  test("throws on permission.response missing allowed", () => {
    const raw = JSON.stringify({
      type: "permission.response",
      id: "x",
      timestamp: "t",
      sessionId: "s",
      requestId: "r",
      remember: false,
    });
    expect(() => parseMessage(raw)).toThrow("missing or invalid 'allowed'");
  });

  test("throws on permission.response missing remember", () => {
    const raw = JSON.stringify({
      type: "permission.response",
      id: "x",
      timestamp: "t",
      sessionId: "s",
      requestId: "r",
      allowed: true,
    });
    expect(() => parseMessage(raw)).toThrow("missing or invalid 'remember'");
  });
});

// ─── serializeMessage ───────────────────────────────────────────

describe("serializeMessage", () => {
  test("serializes a message to JSON", () => {
    const msg: PingMessage = { type: "ping", id: "abc", timestamp: "2026-01-01T00:00:00.000Z" };
    const json = serializeMessage(msg);
    expect(JSON.parse(json)).toEqual(msg);
  });

  test("round-trips through parse", () => {
    const msg: PingMessage = { type: "ping", id: "abc", timestamp: "2026-01-01T00:00:00.000Z" };
    const result = parseMessage(serializeMessage(msg));
    expect(result.type).toBe("ping");
    expect(result.id).toBe("abc");
  });
});

// ─── createMessage ──────────────────────────────────────────────

describe("createMessage", () => {
  test("auto-generates id and timestamp", () => {
    const msg = createMessage<PingMessage>("ping", {});
    expect(msg.type).toBe("ping");
    expect(msg.id).toBeTruthy();
    expect(msg.timestamp).toBeTruthy();
    // Timestamp should be valid ISO 8601
    expect(new Date(msg.timestamp).toISOString()).toBe(msg.timestamp);
  });

  test("allows overriding id and timestamp", () => {
    const msg = createMessage<PingMessage>("ping", { id: "custom-id", timestamp: "2026-06-01T00:00:00.000Z" });
    expect(msg.id).toBe("custom-id");
    expect(msg.timestamp).toBe("2026-06-01T00:00:00.000Z");
  });

  test("creates a session.created message with extra fields", () => {
    const msg = createMessage<SessionCreatedMessage>("session.created", {
      sessionId: "sess-1",
      dir: "/home/user",
      model: "gpt-4",
    });
    expect(msg.type).toBe("session.created");
    expect(msg.sessionId).toBe("sess-1");
    expect(msg.dir).toBe("/home/user");
    expect(msg.model).toBe("gpt-4");
  });

  test("creates a shutdown message", () => {
    const msg = createMessage<ShutdownMessage>("shutdown", { reason: "daemon stopping" });
    expect(msg.type).toBe("shutdown");
    expect(msg.reason).toBe("daemon stopping");
  });
});

// ─── Type checks ────────────────────────────────────────────────

describe("isClientMessageType / isServerMessageType", () => {
  test("identifies client message types", () => {
    expect(isClientMessageType("session.create")).toBe(true);
    expect(isClientMessageType("session.message")).toBe(true);
    expect(isClientMessageType("session.cancel")).toBe(true);
    expect(isClientMessageType("session.destroy")).toBe(true);
    expect(isClientMessageType("permission.response")).toBe(true);
    expect(isClientMessageType("ping")).toBe(true);
    expect(isClientMessageType("pong")).toBe(false);
  });

  test("identifies server message types", () => {
    expect(isServerMessageType("session.created")).toBe(true);
    expect(isServerMessageType("session.text")).toBe(true);
    expect(isServerMessageType("session.tool_use")).toBe(true);
    expect(isServerMessageType("session.thinking")).toBe(true);
    expect(isServerMessageType("permission.request")).toBe(true);
    expect(isServerMessageType("session.done")).toBe(true);
    expect(isServerMessageType("session.error")).toBe(true);
    expect(isServerMessageType("pong")).toBe(true);
    expect(isServerMessageType("shutdown")).toBe(true);
    expect(isServerMessageType("ping")).toBe(false);
  });
});
