import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DataCollector, sanitizeForTraining } from "./data-collector";

// Use a temp directory for tests to avoid touching real user data
const TEST_DIR = join(import.meta.dir, ".test-training-data");

// Override kcodePath for tests by setting a custom data dir
function createTestCollector(sessionId?: string): DataCollector {
  // We'll create the collector and then monkey-patch the internal paths
  const collector = new (class extends DataCollector {
    constructor() {
      super(sessionId ?? "test-session");
      // Override internal paths to use test directory
      (this as any).dataDir = TEST_DIR;
      (this as any).filePath = join(TEST_DIR, "pairs.jsonl");
      mkdirSync(TEST_DIR, { recursive: true });
    }
  })();
  return collector;
}

describe("DataCollector", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("records accepted pairs", () => {
    const collector = createTestCollector();
    collector.recordAccepted("Hello", "Hi there!", "test-model");

    const stats = collector.getStats();
    expect(stats.total).toBe(1);
    expect(stats.accepted).toBe(1);
    expect(stats.rejected).toBe(0);
    expect(stats.edited).toBe(0);
  });

  it("records rejected pairs", () => {
    const collector = createTestCollector();
    collector.recordRejected("Fix this bug", "Bad response", "test-model");

    const stats = collector.getStats();
    expect(stats.total).toBe(1);
    expect(stats.accepted).toBe(0);
    expect(stats.rejected).toBe(1);
  });

  it("records edited pairs", () => {
    const collector = createTestCollector();
    collector.recordEdited(
      "Write a function",
      "function foo() {}",
      "function bar() {}",
      "test-model",
    );

    const stats = collector.getStats();
    expect(stats.total).toBe(1);
    expect(stats.edited).toBe(1);
    expect(stats.accepted).toBe(0); // edited counts separately
  });

  it("accumulates multiple records", () => {
    const collector = createTestCollector();
    collector.recordAccepted("q1", "a1", "model-a");
    collector.recordAccepted("q2", "a2", "model-a");
    collector.recordRejected("q3", "a3", "model-a");
    collector.recordEdited("q4", "a4-orig", "a4-edit", "model-a");

    const stats = collector.getStats();
    expect(stats.total).toBe(4);
    expect(stats.accepted).toBe(2);
    expect(stats.rejected).toBe(1);
    expect(stats.edited).toBe(1);
    expect(stats.sizeBytes).toBeGreaterThan(0);
  });

  it("getStats returns zeros when no data", () => {
    const collector = createTestCollector();
    const stats = collector.getStats();
    expect(stats.total).toBe(0);
    expect(stats.accepted).toBe(0);
    expect(stats.rejected).toBe(0);
    expect(stats.edited).toBe(0);
    expect(stats.sizeBytes).toBe(0);
  });

  it("clear removes all data", () => {
    const collector = createTestCollector();
    collector.recordAccepted("q", "a", "m");
    expect(collector.getStats().total).toBe(1);

    collector.clear();
    expect(collector.getStats().total).toBe(0);
  });

  it("exports JSONL in correct format", async () => {
    const collector = createTestCollector();
    collector.recordAccepted("Hello", "Hi!", "test-model");
    collector.recordRejected("Bad prompt", "Bad response", "test-model");
    collector.recordEdited("Fix this", "wrong fix", "correct fix", "test-model");

    const outputPath = join(TEST_DIR, "export.jsonl");
    const count = await collector.exportJSONL(outputPath);

    // Only accepted + edited should be exported (not rejected)
    expect(count).toBe(2);
    expect(existsSync(outputPath)).toBe(true);

    const lines = readFileSync(outputPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);

    // Check format of first entry
    const first = JSON.parse(lines[0]!);
    expect(first.messages).toHaveLength(2);
    expect(first.messages[0].role).toBe("user");
    expect(first.messages[0].content).toBe("Hello");
    expect(first.messages[1].role).toBe("assistant");
    expect(first.messages[1].content).toBe("Hi!");

    // Check edited entry uses the edited response
    const second = JSON.parse(lines[1]!);
    expect(second.messages[1].content).toBe("correct fix");
  });

  it("exportJSONL returns 0 when no data", async () => {
    const collector = createTestCollector();
    const outputPath = join(TEST_DIR, "empty-export.jsonl");
    const count = await collector.exportJSONL(outputPath);
    expect(count).toBe(0);
  });

  it("readPairs returns stored pairs", () => {
    const collector = createTestCollector();
    collector.recordAccepted("q1", "a1", "model");
    collector.recordRejected("q2", "a2", "model");

    const pairs = collector.readPairs();
    expect(pairs).toHaveLength(2);
    expect(pairs[0]!.accepted).toBe(true);
    expect(pairs[1]!.accepted).toBe(false);
  });

  it("stores session ID in pairs", () => {
    const collector = createTestCollector("my-session-42");
    collector.recordAccepted("q", "a", "model");

    const pairs = collector.readPairs();
    expect(pairs[0]!.sessionId).toBe("my-session-42");
  });

  it("stores timestamps in pairs", () => {
    const before = Date.now();
    const collector = createTestCollector();
    collector.recordAccepted("q", "a", "model");
    const after = Date.now();

    const pairs = collector.readPairs();
    expect(pairs[0]!.timestamp).toBeGreaterThanOrEqual(before);
    expect(pairs[0]!.timestamp).toBeLessThanOrEqual(after);
  });
});

// ─── sanitizeForTraining ────────────────────────────────────────

describe("sanitizeForTraining", () => {
  it("replaces home directory with ~", () => {
    const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? "/home/testuser";
    const text = `Read the file at ${homeDir}/projects/code.ts`;
    const result = sanitizeForTraining(text);
    expect(result).toContain("~/projects/code.ts");
    expect(result).not.toContain(homeDir);
  });

  it("replaces username in /home/user/ paths when home dir replacement does not cover it", () => {
    const username = process.env.USER ?? process.env.USERNAME;
    if (!username || username.length <= 2) return; // skip if no username
    // Use a different prefix that won't match the HOME dir replacement
    const text = `another user at /home/${username}/documents/file.txt`;
    const result = sanitizeForTraining(text);
    // Home dir replacement will match first (~/documents/file.txt)
    // and username replacement also fires on remaining path-like contexts
    expect(result).not.toContain(`/home/${username}/`);
  });

  it("does not modify text without paths", () => {
    const text = "Write a function that adds two numbers";
    expect(sanitizeForTraining(text)).toBe(text);
  });

  it("handles empty string", () => {
    expect(sanitizeForTraining("")).toBe("");
  });

  it("sanitizes multiple path occurrences", () => {
    const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? "/home/testuser";
    const text = `File A: ${homeDir}/a.ts and File B: ${homeDir}/b.ts`;
    const result = sanitizeForTraining(text);
    expect(result).toBe("File A: ~/a.ts and File B: ~/b.ts");
  });
});
