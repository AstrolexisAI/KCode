import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { SessionBrowser } from "./browser";

function createBrowser(): SessionBrowser {
  const db = new Database(":memory:");
  return new SessionBrowser(db);
}

function seedSessions(browser: SessionBrowser): void {
  const now = Date.now();

  browser.addSession({
    sessionId: "s1",
    startedAt: now - 3000,
    model: "llama-3",
    project: "/home/user/project-a",
  });
  browser.addTurn("s1", 0, "user", "Fix the login bug", now - 3000);
  browser.addTurn("s1", 1, "assistant", "Looking at the code now.", now - 2500);
  browser.addTurn("s1", 2, "user", "Thanks, that worked!", now - 2000);

  browser.addSession({
    sessionId: "s2",
    startedAt: now - 1000,
    model: "claude-3",
    project: "/home/user/project-b",
  });
  browser.addTurn("s2", 0, "user", "Add pagination to the API", now - 1000);
  browser.addTurn("s2", 1, "assistant", "I will add pagination.", now - 500);
}

describe("SessionBrowser", () => {
  test("listSessions returns sorted results by date", () => {
    const browser = createBrowser();
    seedSessions(browser);

    const sessions = browser.listSessions({ sortBy: "date" });
    expect(sessions).toHaveLength(2);
    // Most recent first
    expect(sessions[0].sessionId).toBe("s2");
    expect(sessions[1].sessionId).toBe("s1");
  });

  test("listSessions returns sorted results by turns", () => {
    const browser = createBrowser();
    seedSessions(browser);

    const sessions = browser.listSessions({ sortBy: "turns" });
    expect(sessions).toHaveLength(2);
    // s1 has 3 turns, s2 has 2
    expect(sessions[0].sessionId).toBe("s1");
    expect(sessions[0].turnCount).toBe(3);
    expect(sessions[1].sessionId).toBe("s2");
    expect(sessions[1].turnCount).toBe(2);
  });

  test("listSessions supports limit", () => {
    const browser = createBrowser();
    seedSessions(browser);

    const sessions = browser.listSessions({ limit: 1 });
    expect(sessions).toHaveLength(1);
  });

  test("listSessions supports offset", () => {
    const browser = createBrowser();
    seedSessions(browser);

    const sessions = browser.listSessions({ limit: 1, offset: 1 });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe("s1");
  });

  test("listSessions includes metadata", () => {
    const browser = createBrowser();
    seedSessions(browser);

    const sessions = browser.listSessions();
    const s2 = sessions.find((s) => s.sessionId === "s2")!;
    expect(s2.model).toBe("claude-3");
    expect(s2.project).toBe("/home/user/project-b");
    expect(s2.summary).toBe("Add pagination to the API");
  });

  test("getSession returns detail with turns", () => {
    const browser = createBrowser();
    seedSessions(browser);

    const detail = browser.getSession("s1");
    expect(detail).not.toBeNull();
    expect(detail!.sessionId).toBe("s1");
    expect(detail!.model).toBe("llama-3");
    expect(detail!.turns).toHaveLength(3);
    expect(detail!.turns[0].role).toBe("user");
    expect(detail!.turns[0].content).toBe("Fix the login bug");
    expect(detail!.turns[1].role).toBe("assistant");
    expect(detail!.turns[2].turnIndex).toBe(2);
  });

  test("getSession returns null for unknown session", () => {
    const browser = createBrowser();
    const detail = browser.getSession("nonexistent");
    expect(detail).toBeNull();
  });

  test("deleteSession removes session and turns", () => {
    const browser = createBrowser();
    seedSessions(browser);

    browser.deleteSession("s1");
    expect(browser.getSession("s1")).toBeNull();
    // s2 still exists
    expect(browser.getSession("s2")).not.toBeNull();
  });

  test("getStats returns correct counts", () => {
    const browser = createBrowser();
    seedSessions(browser);

    const stats = browser.getStats();
    expect(stats.totalSessions).toBe(2);
    expect(stats.totalTurns).toBe(5); // 3 + 2
    expect(stats.oldestSession).toBe("s1");
    expect(stats.newestSession).toBe("s2");
  });

  test("empty DB returns empty results", () => {
    const browser = createBrowser();

    const sessions = browser.listSessions();
    expect(sessions).toHaveLength(0);

    const stats = browser.getStats();
    expect(stats.totalSessions).toBe(0);
    expect(stats.totalTurns).toBe(0);
    expect(stats.oldestSession).toBe("");
    expect(stats.newestSession).toBe("");
  });

  test("summary is first user message truncated to 80 chars", () => {
    const browser = createBrowser();
    const longMessage = "A".repeat(120);

    browser.addSession({ sessionId: "s-long", startedAt: Date.now() });
    browser.addTurn("s-long", 0, "user", longMessage, Date.now());

    const session = browser.getSession("s-long");
    expect(session).not.toBeNull();
    expect(session!.summary).toHaveLength(80);
  });

  test("deleteSession on nonexistent session does not throw", () => {
    const browser = createBrowser();
    expect(() => browser.deleteSession("nonexistent")).not.toThrow();
  });
});
