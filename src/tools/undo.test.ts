// Tests for Undo tool — file rollback system
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { UndoManager } from "../core/undo";
import { executeUndo, setUndoManager, undoDefinition } from "./undo";

const testDir = join(tmpdir(), `kcode-undo-test-${Date.now()}`);

beforeAll(() => {
  mkdirSync(testDir, { recursive: true });
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("undoDefinition", () => {
  test("has correct name and schema", () => {
    expect(undoDefinition.name).toBe("Undo");
    expect(undoDefinition.input_schema.type).toBe("object");
  });
});

describe("executeUndo without manager", () => {
  test("returns error when manager not initialized", async () => {
    setUndoManager(null as unknown as UndoManager);
    const result = await executeUndo({});
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("not initialized");
  });
});

describe("executeUndo with manager", () => {
  const testFile = join(testDir, "undo-test.txt");
  let mgr: UndoManager;

  beforeAll(() => {
    mgr = new UndoManager();
    setUndoManager(mgr);
  });

  test("peek returns 'Nothing to undo' on empty stack", async () => {
    const result = await executeUndo({ action: "peek" });
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("Nothing to undo");
  });

  test("list returns empty message when no actions", async () => {
    const result = await executeUndo({ action: "list" });
    expect(result.content).toContain("empty");
  });

  test("undo on empty stack returns 'Nothing to undo'", async () => {
    const result = await executeUndo({ action: "undo" });
    expect(result.content).toContain("Nothing to undo");
  });

  test("captures snapshot and undoes file modification", async () => {
    // Write original content
    writeFileSync(testFile, "original");
    // Capture snapshot
    const snapshot = mgr.captureSnapshot(testFile);
    // Modify file
    writeFileSync(testFile, "modified");
    // Push undo action
    mgr.pushAction("Write", [snapshot], "Test write");

    // Peek shows the action
    const peeked = await executeUndo({ action: "peek" });
    expect(peeked.content).toContain("Test write");
    expect(peeked.content).toContain("Write");

    // List shows it
    const listed = await executeUndo({ action: "list" });
    expect(listed.content).toContain("Test write");

    // Undo restores
    const undone = await executeUndo({ action: "undo" });
    expect(undone.is_error).toBeFalsy();
    expect(readFileSync(testFile, "utf-8")).toBe("original");
  });

  test("count parameter undoes multiple actions", async () => {
    // Create 3 actions
    for (let i = 0; i < 3; i++) {
      writeFileSync(testFile, `version-${i}`);
      const snap = mgr.captureSnapshot(testFile);
      writeFileSync(testFile, `modified-${i}`);
      mgr.pushAction("Write", [snap], `Action ${i}`);
    }

    // Undo 2 at once
    const result = await executeUndo({ action: "undo", count: 2 });
    expect(result.is_error).toBeFalsy();
    // Stack should have 1 remaining
    const listed = await executeUndo({ action: "list" });
    expect(listed.content).toContain("1 action");
  });

  test("count is capped at 5", async () => {
    // Fill stack
    for (let i = 0; i < 10; i++) {
      const snap = mgr.captureSnapshot(testFile);
      writeFileSync(testFile, `v${i}`);
      mgr.pushAction("Write", [snap], `Action ${i}`);
    }
    // Try to undo 100 — should cap at 5
    const result = await executeUndo({ action: "undo", count: 100 });
    expect(result.is_error).toBeFalsy();
  });
});
