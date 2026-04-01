import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { NarrativeManager, type SessionData } from "./narrative";

describe("NarrativeManager", () => {
  let manager: NarrativeManager;
  const testProject = `test-project-${Date.now()}`;

  // Isolated in-memory DB for tests
  const testDb = new Database(":memory:");
  testDb.exec(`CREATE TABLE IF NOT EXISTS narrative (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    summary TEXT NOT NULL,
    project TEXT NOT NULL DEFAULT '',
    tools_used TEXT DEFAULT '',
    actions_taken INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  function makeSessionData(overrides: Partial<SessionData> = {}): SessionData {
    return {
      project: testProject,
      messagesCount: 10,
      toolsUsed: ["Read", "Write", "Bash"],
      actionsCount: 5,
      topicsDiscussed: ["testing", "refactoring"],
      errorsEncountered: 0,
      filesModified: ["/src/app.ts", "/src/utils.ts"],
      ...overrides,
    };
  }

  afterAll(() => {
    testDb.close();
  });

  beforeEach(() => {
    // Clear narrative table between tests for isolation
    testDb.exec("DELETE FROM narrative");
    manager = new NarrativeManager(testDb);
  });

  // ─── updateNarrative ──────────────────────────────────────────

  test("updateNarrative stores session summary", () => {
    const data = makeSessionData();
    // Should not throw
    manager.updateNarrative(data);

    // Verify it was stored
    const all = manager.getAllNarratives(50);
    const found = all.find((n) => n.project === testProject);
    expect(found).toBeDefined();
    expect(found!.summary.length).toBeGreaterThan(0);
    expect(found!.actions_taken).toBe(5);
  });

  // ─── loadNarrative ────────────────────────────────────────────

  test("loadNarrative returns recent narratives", () => {
    const data = makeSessionData();
    manager.updateNarrative(data);

    const result = manager.loadNarrative(10);
    expect(result).not.toBeNull();
    expect(result!).toContain("# Recent Sessions");
    expect(result!).toContain("Summaries of recent sessions");
  });

  test("loadNarrative returns null when no narratives exist for empty DB", () => {
    const result = manager.loadNarrative(3);
    expect(result).toBeNull();
  });

  // ─── getAllNarratives ──────────────────────────────────────────

  test("getAllNarratives returns all entries", () => {
    // Insert a couple of entries
    manager.updateNarrative(makeSessionData({ actionsCount: 1 }));
    manager.updateNarrative(makeSessionData({ actionsCount: 2 }));

    const all = manager.getAllNarratives(50);
    expect(Array.isArray(all)).toBe(true);
    expect(all.length).toBeGreaterThanOrEqual(2);

    // Verify entry structure
    const entry = all[0]!;
    expect(entry).toHaveProperty("summary");
    expect(entry).toHaveProperty("project");
    expect(entry).toHaveProperty("tools_used");
    expect(entry).toHaveProperty("actions_taken");
    expect(entry).toHaveProperty("created_at");
  });

  // ─── narrative content ─────────────────────────────────────────

  test("narrative includes session data details", () => {
    const data = makeSessionData({
      filesModified: ["/src/main.ts", "/src/config.ts"],
      toolsUsed: ["Read", "Edit", "Bash"],
      topicsDiscussed: ["database", "migrations"],
      errorsEncountered: 2,
      actionsCount: 8,
    });
    manager.updateNarrative(data);

    const all = manager.getAllNarratives(50);
    const found = all.find((n) => n.project === testProject && n.actions_taken === 8);
    expect(found).toBeDefined();

    const summary = found!.summary;
    // Should mention files worked on
    expect(summary).toContain("2 file");
    // Should mention the project
    expect(summary).toContain(testProject.split("/").pop()!);
    // Should mention tools used
    expect(summary).toContain("Read");
    // Should mention errors
    expect(summary).toContain("2 error");
    // Should mention topics
    expect(summary).toContain("database");
  });

  test("narrative mentions actions count when no files modified", () => {
    const data = makeSessionData({
      filesModified: [],
      actionsCount: 12,
    });
    manager.updateNarrative(data);

    const all = manager.getAllNarratives(50);
    const found = all.find((n) => n.project === testProject && n.actions_taken === 12);
    expect(found).toBeDefined();
    expect(found!.summary).toContain("12 actions");
  });

  test("narrative says 'had a conversation' when no actions", () => {
    const data = makeSessionData({
      filesModified: [],
      actionsCount: 0,
      toolsUsed: [],
      topicsDiscussed: [],
    });
    manager.updateNarrative(data);

    const all = manager.getAllNarratives(50);
    const found = all.find((n) => n.project === testProject && n.actions_taken === 0);
    expect(found).toBeDefined();
    expect(found!.summary).toContain("had a conversation");
  });

  test("narrative tools_used field contains comma-separated tools", () => {
    const data = makeSessionData({
      toolsUsed: ["Grep", "Read", "Write"],
    });
    manager.updateNarrative(data);

    const all = manager.getAllNarratives(50);
    const found = all.find((n) => n.tools_used.includes("Grep"));
    expect(found).toBeDefined();
    expect(found!.tools_used).toContain("Read");
    expect(found!.tools_used).toContain("Write");
  });
});
