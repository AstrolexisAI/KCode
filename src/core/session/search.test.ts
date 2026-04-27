import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { SessionSearch } from "./search";

function createSearch(): SessionSearch {
  const db = new Database(":memory:");
  return new SessionSearch(db);
}

describe("SessionSearch", () => {
  test("initFTS creates table without error", () => {
    expect(() => createSearch()).not.toThrow();
  });

  test("indexTurn inserts data", () => {
    const search = createSearch();
    search.indexTurn("s1", 0, "user", "Hello world");
    const turns = search.getSessionTurns("s1");
    expect(turns).toHaveLength(1);
    expect(turns[0]!.content).toBe("Hello world");
    expect(turns[0]!.role).toBe("user");
    expect(turns[0]!.turnIndex).toBe(0);
  });

  test("search returns matching results with snippets", () => {
    const search = createSearch();
    search.indexTurn("s1", 0, "user", "Fix the authentication bug in login");
    search.indexTurn("s1", 1, "assistant", "I will fix the authentication issue");

    const results = search.search("authentication");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.sessionId).toBe("s1");
    expect(results[0]!.matchSnippet).toContain("authentication");
    expect(results[0]!.score).toBeGreaterThan(0);
  });

  test("search returns empty for no matches", () => {
    const search = createSearch();
    search.indexTurn("s1", 0, "user", "Hello world");
    const results = search.search("xyznonexistent");
    expect(results).toHaveLength(0);
  });

  test("search respects limit parameter", () => {
    const search = createSearch();
    for (let i = 0; i < 10; i++) {
      search.indexTurn("s1", i, "user", `Message about typescript feature ${i}`);
    }
    const results = search.search("typescript", 3);
    expect(results).toHaveLength(3);
  });

  test("getSessionTurns returns all turns for a session", () => {
    const search = createSearch();
    search.indexTurn("s1", 0, "user", "First message");
    search.indexTurn("s1", 1, "assistant", "Second message");
    search.indexTurn("s1", 2, "user", "Third message");
    search.indexTurn("s2", 0, "user", "Other session");

    const turns = search.getSessionTurns("s1");
    expect(turns).toHaveLength(3);
    expect(turns[0]!.turnIndex).toBe(0);
    expect(turns[1]!.turnIndex).toBe(1);
    expect(turns[2]!.turnIndex).toBe(2);
  });

  test("getSessionTurns returns turns in order", () => {
    const search = createSearch();
    search.indexTurn("s1", 2, "user", "Third");
    search.indexTurn("s1", 0, "user", "First");
    search.indexTurn("s1", 1, "assistant", "Second");

    const turns = search.getSessionTurns("s1");
    expect(turns[0]!.turnIndex).toBe(0);
    expect(turns[1]!.turnIndex).toBe(1);
    expect(turns[2]!.turnIndex).toBe(2);
  });

  test("deleteSession removes entries", () => {
    const search = createSearch();
    search.indexTurn("s1", 0, "user", "Keep this");
    search.indexTurn("s2", 0, "user", "Delete this");

    search.deleteSession("s2");
    expect(search.getSessionTurns("s2")).toHaveLength(0);
    expect(search.getSessionTurns("s1")).toHaveLength(1);
  });

  test("getSessionCount returns correct count", () => {
    const search = createSearch();
    expect(search.getSessionCount()).toBe(0);

    search.indexTurn("s1", 0, "user", "Session 1");
    expect(search.getSessionCount()).toBe(1);

    search.indexTurn("s2", 0, "user", "Session 2");
    expect(search.getSessionCount()).toBe(2);

    search.indexTurn("s1", 1, "assistant", "Still session 1");
    expect(search.getSessionCount()).toBe(2);
  });

  test("multiple sessions can be indexed and searched", () => {
    const search = createSearch();
    search.indexTurn("s1", 0, "user", "Implement the database migration");
    search.indexTurn("s2", 0, "user", "Fix the database connection pool");
    search.indexTurn("s3", 0, "user", "Write unit tests for auth");

    const dbResults = search.search("database");
    expect(dbResults).toHaveLength(2);

    const authResults = search.search("auth");
    expect(authResults).toHaveLength(1);
    expect(authResults[0]!.sessionId).toBe("s3");
  });
});
