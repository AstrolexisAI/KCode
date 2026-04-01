// Tests for permission audit log

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { type AuditEntry, AuditLog, computeEntryHmac, verifyEntryHmac } from "./audit-log";

function createTestDb(): Database {
  return new Database(":memory:");
}

function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    timestamp: Date.now(),
    toolName: "Bash",
    action: "allowed",
    inputSummary: "echo hello",
    sessionId: "session-1",
    ...overrides,
  };
}

describe("AuditLog", () => {
  let db: Database;
  let audit: AuditLog;

  beforeEach(() => {
    db = createTestDb();
    audit = new AuditLog(db);
  });

  test("log inserts entry", () => {
    audit.log(makeEntry());
    const history = audit.getHistory();
    expect(history.length).toBe(1);
    expect(history[0].toolName).toBe("Bash");
    expect(history[0].action).toBe("allowed");
    expect(history[0].inputSummary).toBe("echo hello");
  });

  test("log truncates long inputSummary", () => {
    const longSummary = "x".repeat(500);
    audit.log(makeEntry({ inputSummary: longSummary }));
    const history = audit.getHistory();
    expect(history[0].inputSummary.length).toBe(200);
    expect(history[0].inputSummary.endsWith("...")).toBe(true);
  });

  test("getHistory returns entries in reverse chronological order", () => {
    audit.log(makeEntry({ timestamp: 1000, toolName: "First" }));
    audit.log(makeEntry({ timestamp: 2000, toolName: "Second" }));
    audit.log(makeEntry({ timestamp: 3000, toolName: "Third" }));
    const history = audit.getHistory();
    expect(history.length).toBe(3);
    expect(history[0].toolName).toBe("Third");
    expect(history[2].toolName).toBe("First");
  });

  test("getHistory filters by toolName", () => {
    audit.log(makeEntry({ toolName: "Bash" }));
    audit.log(makeEntry({ toolName: "Write" }));
    audit.log(makeEntry({ toolName: "Bash" }));
    const history = audit.getHistory({ toolName: "Bash" });
    expect(history.length).toBe(2);
    expect(history.every((e) => e.toolName === "Bash")).toBe(true);
  });

  test("getHistory filters by sessionId", () => {
    audit.log(makeEntry({ sessionId: "s1" }));
    audit.log(makeEntry({ sessionId: "s2" }));
    audit.log(makeEntry({ sessionId: "s1" }));
    const history = audit.getHistory({ sessionId: "s1" });
    expect(history.length).toBe(2);
    expect(history.every((e) => e.sessionId === "s1")).toBe(true);
  });

  test("getHistory respects limit", () => {
    for (let i = 0; i < 10; i++) {
      audit.log(makeEntry({ timestamp: i }));
    }
    const history = audit.getHistory({ limit: 3 });
    expect(history.length).toBe(3);
  });

  test("getHistory combines filters", () => {
    audit.log(makeEntry({ toolName: "Bash", sessionId: "s1" }));
    audit.log(makeEntry({ toolName: "Write", sessionId: "s1" }));
    audit.log(makeEntry({ toolName: "Bash", sessionId: "s2" }));
    const history = audit.getHistory({ toolName: "Bash", sessionId: "s1" });
    expect(history.length).toBe(1);
  });

  test("getSummary aggregates correctly", () => {
    audit.log(makeEntry({ toolName: "Bash", action: "allowed" }));
    audit.log(makeEntry({ toolName: "Bash", action: "allowed" }));
    audit.log(makeEntry({ toolName: "Bash", action: "denied" }));
    audit.log(makeEntry({ toolName: "Bash", action: "asked" }));
    audit.log(makeEntry({ toolName: "Write", action: "denied" }));
    audit.log(makeEntry({ toolName: "Write", action: "user_approved" }));
    audit.log(makeEntry({ toolName: "Write", action: "user_denied" }));

    const summary = audit.getSummary();
    expect(summary.length).toBe(2);

    const bash = summary.find((s) => s.toolName === "Bash")!;
    expect(bash.allowed).toBe(2);
    expect(bash.denied).toBe(1);
    expect(bash.asked).toBe(1);

    const write = summary.find((s) => s.toolName === "Write")!;
    expect(write.allowed).toBe(1); // user_approved counts as allowed
    expect(write.denied).toBe(2); // denied + user_denied
    expect(write.asked).toBe(0);
  });

  test("getRecentDenials only returns denials", () => {
    audit.log(makeEntry({ action: "allowed" }));
    audit.log(makeEntry({ action: "denied", reason: "blocked" }));
    audit.log(makeEntry({ action: "asked" }));
    audit.log(makeEntry({ action: "user_denied", reason: "user said no" }));
    audit.log(makeEntry({ action: "user_approved" }));

    const denials = audit.getRecentDenials();
    expect(denials.length).toBe(2);
    expect(denials.every((d) => d.action === "denied" || d.action === "user_denied")).toBe(true);
  });

  test("getRecentDenials respects limit", () => {
    for (let i = 0; i < 20; i++) {
      audit.log(makeEntry({ action: "denied", timestamp: i }));
    }
    const denials = audit.getRecentDenials(5);
    expect(denials.length).toBe(5);
  });

  test("clear removes old entries", () => {
    audit.log(makeEntry({ timestamp: 1000 }));
    audit.log(makeEntry({ timestamp: 2000 }));
    audit.log(makeEntry({ timestamp: 3000 }));
    audit.clear(2500);
    const history = audit.getHistory();
    expect(history.length).toBe(1);
    expect(history[0].timestamp).toBe(3000);
  });

  test("clear returns correct count", () => {
    audit.log(makeEntry({ timestamp: 1000 }));
    audit.log(makeEntry({ timestamp: 2000 }));
    audit.log(makeEntry({ timestamp: 3000 }));
    const deleted = audit.clear(2500);
    expect(deleted).toBe(2);
  });

  test("clear without timestamp removes all entries", () => {
    audit.log(makeEntry());
    audit.log(makeEntry());
    audit.log(makeEntry());
    audit.clear();
    const history = audit.getHistory();
    expect(history.length).toBe(0);
  });

  test("reason is preserved", () => {
    audit.log(makeEntry({ reason: "dangerous command detected" }));
    const history = audit.getHistory();
    expect(history[0].reason).toBe("dangerous command detected");
  });

  test("reason is undefined when not provided", () => {
    audit.log(makeEntry({ reason: undefined }));
    const history = audit.getHistory();
    expect(history[0].reason).toBeUndefined();
  });

  test("formatSummary produces readable output", () => {
    const summary = [
      { toolName: "Bash", allowed: 10, denied: 3, asked: 5 },
      { toolName: "Write", allowed: 7, denied: 1, asked: 2 },
    ];
    const output = audit.formatSummary(summary);
    expect(output).toContain("Tool");
    expect(output).toContain("Allowed");
    expect(output).toContain("Denied");
    expect(output).toContain("Asked");
    expect(output).toContain("Bash");
    expect(output).toContain("Write");
    expect(output).toContain("10");
    expect(output).toContain("3");
    // Should have header, separator, and 2 data rows
    const lines = output.split("\n");
    expect(lines.length).toBe(4);
  });

  test("formatSummary handles empty data", () => {
    const output = audit.formatSummary([]);
    expect(output).toBe("No permission audit data recorded.");
  });

  // ─── New: HMAC integrity ─────────────────────────────────────

  test("getHistory entries include HMAC", () => {
    audit.log(makeEntry());
    const history = audit.getHistory();
    expect(history[0].hmac).toBeDefined();
    expect(typeof history[0].hmac).toBe("string");
    expect(history[0].hmac!.length).toBe(16);
  });

  test("HMAC is deterministic for same entry", () => {
    const hmac1 = computeEntryHmac(1000, "Bash", "allowed", "s1");
    const hmac2 = computeEntryHmac(1000, "Bash", "allowed", "s1");
    expect(hmac1).toBe(hmac2);
  });

  test("HMAC differs for different entries", () => {
    const hmac1 = computeEntryHmac(1000, "Bash", "allowed", "s1");
    const hmac2 = computeEntryHmac(1000, "Bash", "denied", "s1");
    expect(hmac1).not.toBe(hmac2);
  });

  test("verifyEntryHmac validates correct entries", () => {
    audit.log(makeEntry({ timestamp: 5000, sessionId: "s1" }));
    const entry = audit.getHistory()[0];
    expect(verifyEntryHmac(entry)).toBe(true);
  });

  test("verifyEntryHmac rejects tampered entries", () => {
    audit.log(makeEntry({ timestamp: 5000, sessionId: "s1" }));
    const entry = audit.getHistory()[0];
    entry.action = "denied"; // tamper
    expect(verifyEntryHmac(entry)).toBe(false);
  });

  // ─── New: JSON export ────────────────────────────────────────

  test("exportJSON returns NDJSON format", () => {
    audit.log(makeEntry({ timestamp: 1000, toolName: "Bash" }));
    audit.log(makeEntry({ timestamp: 2000, toolName: "Write" }));
    const json = audit.exportJSON();
    const lines = json.split("\n");
    expect(lines).toHaveLength(2);
    const parsed = JSON.parse(lines[0]);
    expect(parsed["@timestamp"]).toBeDefined();
    expect(parsed.event.action).toBeDefined();
    expect(parsed.tool.name).toBeDefined();
  });

  test("exportJSON SIEM format has correct structure", () => {
    audit.log(makeEntry({ timestamp: 1000, action: "denied", reason: "blocked" }));
    const json = audit.exportJSON();
    const parsed = JSON.parse(json);
    expect(parsed.event.kind).toBe("event");
    expect(parsed.event.category).toBe("process");
    expect(parsed.event.type).toBe("access");
    expect(parsed.event.outcome).toBe("failure");
    expect(parsed.reason).toBe("blocked");
  });

  test("exportJSON filters by sessionId", () => {
    audit.log(makeEntry({ sessionId: "s1" }));
    audit.log(makeEntry({ sessionId: "s2" }));
    const json = audit.exportJSON({ sessionId: "s1" });
    const lines = json.split("\n");
    expect(lines).toHaveLength(1);
  });

  // ─── New: File export ────────────────────────────────────────

  test("exportToFile writes entries and returns count", () => {
    audit.log(makeEntry());
    audit.log(makeEntry());
    const tmpPath = `/tmp/kcode-audit-test-${Date.now()}.ndjson`;
    const count = audit.exportToFile(tmpPath);
    expect(count).toBe(2);
    // Verify file exists and has content
    const file = Bun.file(tmpPath);
    expect(file.size).toBeGreaterThan(0);
    // Cleanup
    require("node:fs").unlinkSync(tmpPath);
  });
});
