// Tests for Stash tool — save/restore conversation state
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Message } from "../core/types";
import { clearStashes, executeStash, setStashCallbacks, stashDefinition } from "./stash";

let mockMessages: Message[] = [];
let restoredMessages: Message[] | null = null;

beforeEach(() => {
  clearStashes();
  mockMessages = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi there" },
  ];
  restoredMessages = null;
  setStashCallbacks(
    () => mockMessages,
    (msgs: Message[]) => {
      restoredMessages = msgs;
    },
  );
});

afterEach(() => {
  clearStashes();
});

describe("stashDefinition", () => {
  test("has correct name", () => {
    expect(stashDefinition.name).toBe("Stash");
  });
});

describe("executeStash — list", () => {
  test("reports empty state", async () => {
    const result = await executeStash({ action: "list" });
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("No stashes");
  });

  test("lists saved stashes with metadata", async () => {
    await executeStash({ action: "save", name: "wip", description: "work in progress" });
    const result = await executeStash({ action: "list" });
    expect(result.content).toContain("wip");
    expect(result.content).toContain("2 messages");
    expect(result.content).toContain("work in progress");
  });
});

describe("executeStash — save", () => {
  test("requires name", async () => {
    const result = await executeStash({ action: "save" });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("name is required");
  });

  test("rejects invalid name characters", async () => {
    const result = await executeStash({ action: "save", name: "invalid name with spaces!" });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("alphanumeric");
  });

  test("accepts valid alphanumeric/dash/underscore name", async () => {
    const result = await executeStash({ action: "save", name: "my-stash_1" });
    expect(result.is_error).toBeFalsy();
  });

  test("name limited to 30 chars", async () => {
    const longName = "a".repeat(31);
    const result = await executeStash({ action: "save", name: longName });
    expect(result.is_error).toBe(true);
  });

  test("saves conversation state", async () => {
    const result = await executeStash({ action: "save", name: "test" });
    expect(result.is_error).toBeFalsy();
    const list = await executeStash({ action: "list" });
    expect(list.content).toContain("test");
  });
});

describe("executeStash — restore", () => {
  test("requires name", async () => {
    const result = await executeStash({ action: "restore" });
    expect(result.is_error).toBe(true);
  });

  test("errors when stash doesn't exist", async () => {
    const result = await executeStash({ action: "restore", name: "nonexistent" });
    expect(result.is_error).toBe(true);
  });

  test("restores saved stash", async () => {
    await executeStash({ action: "save", name: "snap1" });
    // Change current messages
    mockMessages = [{ role: "user", content: "different" }];
    // Restore
    const result = await executeStash({ action: "restore", name: "snap1" });
    expect(result.is_error).toBeFalsy();
    expect(restoredMessages).not.toBeNull();
    expect(restoredMessages!.length).toBe(2);
  });
});

describe("executeStash — drop", () => {
  test("drops a stash", async () => {
    await executeStash({ action: "save", name: "droptest" });
    const result = await executeStash({ action: "drop", name: "droptest" });
    expect(result.is_error).toBeFalsy();
    const list = await executeStash({ action: "list" });
    expect(list.content).not.toContain("droptest");
  });

  test("errors when dropping non-existent stash", async () => {
    const result = await executeStash({ action: "drop", name: "nope" });
    expect(result.is_error).toBe(true);
  });
});
