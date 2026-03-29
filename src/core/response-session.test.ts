import { describe, test, expect, beforeEach } from "bun:test";
import {
  beginResponseSession,
  getActiveResponseSession,
  appendSessionText,
  recordSessionToolUse,
  recordSessionContinuation,
  isSessionContinuationExhausted,
  closeResponseSession,
  getLastSession,
  hasPendingIncompleteSession,
  resetSessionState,
} from "./response-session";

beforeEach(() => {
  resetSessionState();
});

describe("ResponseSession lifecycle", () => {
  test("beginResponseSession creates active session", () => {
    const s = beginResponseSession(1);
    expect(s.status).toBe("streaming");
    expect(s.turnId).toBe(1);
    expect(getActiveResponseSession()).toBe(s);
  });

  test("appendSessionText accumulates text", () => {
    beginResponseSession(1);
    appendSessionText("Hello ");
    appendSessionText("World");
    const s = getActiveResponseSession()!;
    expect(s.text).toBe("Hello World");
    expect(s.chunks.length).toBe(2);
  });

  test("closeResponseSession moves to history", () => {
    beginResponseSession(1);
    appendSessionText("Some text");
    closeResponseSession("completed", "end_turn");
    expect(getActiveResponseSession()).toBeNull();
    const last = getLastSession()!;
    expect(last.status).toBe("completed");
    expect(last.text).toBe("Some text");
  });

  test("beginning new session closes previous as incomplete", () => {
    beginResponseSession(1);
    appendSessionText("First");
    beginResponseSession(2);
    const last = getLastSession()!;
    expect(last.status).toBe("incomplete");
    expect(last.turnId).toBe(1);
  });

  test("recordSessionToolUse tracks tool usage", () => {
    beginResponseSession(1);
    recordSessionToolUse(3);
    const s = getActiveResponseSession()!;
    expect(s.hadTools).toBe(true);
    expect(s.toolCount).toBe(3);
  });

  test("continuation counting and exhaustion", () => {
    beginResponseSession(1);
    expect(isSessionContinuationExhausted()).toBe(false);
    recordSessionContinuation();
    expect(isSessionContinuationExhausted()).toBe(false);
    recordSessionContinuation();
    expect(isSessionContinuationExhausted()).toBe(true);
  });

  test("hasPendingIncompleteSession detects incomplete", () => {
    beginResponseSession(1);
    closeResponseSession("incomplete", "max_tokens");
    expect(hasPendingIncompleteSession()).toBe(true);
  });

  test("hasPendingIncompleteSession false for completed", () => {
    beginResponseSession(1);
    closeResponseSession("completed", "end_turn");
    expect(hasPendingIncompleteSession()).toBe(false);
  });

  test("closeResponseSession stores lastError", () => {
    beginResponseSession(1);
    closeResponseSession("failed", "error", "Connection refused");
    expect(getLastSession()!.lastError).toBe("Connection refused");
  });
});
