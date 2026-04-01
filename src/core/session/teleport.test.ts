import { test, expect, describe, afterAll } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  exportSession,
  importSession,
  saveToFile,
  loadFromFile,
} from "./teleport";
import type { SessionCheckpoint } from "./types";

function makeSession(overrides: Partial<SessionCheckpoint> = {}): SessionCheckpoint {
  return {
    id: "test-cp-1",
    timestamp: Date.now(),
    conversationId: "conv-test",
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ],
    toolStates: { pinned: ["file.ts"] },
    workingDirectory: "/tmp/test-project",
    gitBranch: "main",
    modelId: "test-model",
    tokensUsed: 500,
    costUsd: 0.02,
    ...overrides,
  };
}

describe("teleport", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "kcode-teleport-test-"));

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("exportSession", () => {
    test("creates package with required fields", async () => {
      const session = makeSession();
      const { package: pkg, code } = await exportSession(session);
      expect(pkg.version).toBe("1.0.0");
      expect(pkg.exportedAt).toBeGreaterThan(0);
      expect(pkg.sourceHost).toBeTruthy();
      expect(pkg.session.conversationId).toBe("conv-test");
      expect(code).toMatch(/^[0-9a-f]{12}$/);
    });

    test("serialized is valid JSON", async () => {
      const { serialized } = await exportSession(makeSession());
      expect(() => JSON.parse(serialized)).not.toThrow();
    });

    test("generates unique codes", async () => {
      const { code: a } = await exportSession(makeSession());
      const { code: b } = await exportSession(makeSession());
      expect(a).not.toBe(b);
    });
  });

  describe("importSession", () => {
    test("parses valid package", async () => {
      const { serialized } = await exportSession(makeSession());
      const pkg = importSession(serialized);
      expect(pkg.session.conversationId).toBe("conv-test");
      expect(pkg.session.messages).toHaveLength(3);
    });

    test("throws on invalid JSON", () => {
      expect(() => importSession("not json")).toThrow("malformed JSON");
    });

    test("throws on missing version", () => {
      expect(() => importSession(JSON.stringify({ session: { conversationId: "x" } }))).toThrow(
        "missing version",
      );
    });

    test("throws on missing session", () => {
      expect(() => importSession(JSON.stringify({ version: "1.0.0" }))).toThrow(
        "missing session",
      );
    });

    test("throws on missing conversationId", () => {
      expect(() =>
        importSession(JSON.stringify({ version: "1.0.0", session: {} })),
      ).toThrow("missing conversationId");
    });
  });

  describe("saveToFile / loadFromFile round-trip", () => {
    test("saves and loads compressed package", async () => {
      const session = makeSession();
      const { serialized } = await exportSession(session);
      const filePath = join(tmpDir, "test-teleport.ktp");

      await saveToFile(serialized, filePath);
      const loaded = await loadFromFile(filePath);

      expect(loaded.session.conversationId).toBe("conv-test");
      expect(loaded.session.messages).toHaveLength(3);
      expect(loaded.session.tokensUsed).toBe(500);
    });

    test("loadFromFile throws for missing file", async () => {
      await expect(loadFromFile("/nonexistent/file.ktp")).rejects.toThrow(
        "not found",
      );
    });
  });

  describe("referenced files", () => {
    test("export without files has empty array", async () => {
      const { package: pkg } = await exportSession(makeSession());
      expect(pkg.referencedFiles).toEqual([]);
    });

    test("export with nonexistent files skips them", async () => {
      const { package: pkg } = await exportSession(makeSession(), {
        includeFiles: ["/nonexistent/file.ts"],
      });
      expect(pkg.referencedFiles).toEqual([]);
    });
  });
});
