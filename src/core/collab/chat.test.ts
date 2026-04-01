// KCode - Collaboration Chat Tests

import { beforeEach, describe, expect, test } from "bun:test";
import { CollabChat } from "./chat";
import type { CollabEvent } from "./types";

describe("CollabChat", () => {
  let chat: CollabChat;
  let events: CollabEvent[];

  beforeEach(() => {
    chat = new CollabChat();
    events = [];
    chat.onEvent((e) => events.push(e));
  });

  test("sendMessage adds to history", () => {
    chat.sendMessage("p1", "Alice", "hello world");
    const history = chat.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0]!.message).toBe("hello world");
    expect(history[0]!.participantName).toBe("Alice");
  });

  test("sendMessage broadcasts collab.chat event", () => {
    chat.sendMessage("p1", "Alice", "hi");
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("collab.chat");
    expect(events[0]!.data.from).toBe("Alice");
    expect(events[0]!.data.message).toBe("hi");
  });

  test("message has correct structure", () => {
    const msg = chat.sendMessage("p1", "Alice", "test");
    expect(msg.id).toBeDefined();
    expect(msg.participantId).toBe("p1");
    expect(msg.participantName).toBe("Alice");
    expect(msg.message).toBe("test");
    expect(msg.timestamp).toBeGreaterThan(0);
  });

  test("getHistory returns copies", () => {
    chat.sendMessage("p1", "Alice", "msg1");
    const h1 = chat.getHistory();
    chat.sendMessage("p2", "Bob", "msg2");
    const h2 = chat.getHistory();
    expect(h1).toHaveLength(1);
    expect(h2).toHaveLength(2);
  });

  test("history is trimmed at 100 messages", () => {
    for (let i = 0; i < 110; i++) {
      chat.sendMessage("p1", "Alice", `msg-${i}`);
    }
    const history = chat.getHistory();
    expect(history).toHaveLength(100);
    expect(history[0]!.message).toBe("msg-10"); // first 10 trimmed
  });

  test("clear removes all history", () => {
    chat.sendMessage("p1", "Alice", "hello");
    chat.sendMessage("p2", "Bob", "world");
    chat.clear();
    expect(chat.getHistory()).toHaveLength(0);
  });

  test("multiple messages maintain order", () => {
    chat.sendMessage("p1", "Alice", "first");
    chat.sendMessage("p2", "Bob", "second");
    chat.sendMessage("p1", "Alice", "third");
    const history = chat.getHistory();
    expect(history.map((m) => m.message)).toEqual(["first", "second", "third"]);
  });
});
