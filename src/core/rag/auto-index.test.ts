import { test, expect, describe, beforeEach } from "bun:test";
import { RagAutoIndexer, _resetRagAutoIndexer, getRagAutoIndexer } from "./auto-index";
import type { FileChangeEvent } from "../file-watcher";

function makeChange(path: string, type: "create" | "modify" | "delete" = "modify"): FileChangeEvent {
  return { type, path, timestamp: Date.now(), relativePath: path };
}

describe("RagAutoIndexer", () => {
  beforeEach(() => _resetRagAutoIndexer());

  test("starts with no pending files", () => {
    const indexer = new RagAutoIndexer("/tmp/test");
    const stats = indexer.getStats();
    expect(stats.pendingFiles).toBe(0);
    expect(stats.totalReindexed).toBe(0);
    expect(stats.isIndexing).toBe(false);
  });

  test("accumulates pending files from changes", () => {
    const indexer = new RagAutoIndexer("/tmp/test", { enabled: true, debounceMs: 999999 });
    indexer.onFileChanges([
      makeChange("/tmp/test/a.ts"),
      makeChange("/tmp/test/b.ts"),
    ]);
    expect(indexer.getStats().pendingFiles).toBe(2);
  });

  test("deduplicates same file", () => {
    const indexer = new RagAutoIndexer("/tmp/test", { enabled: true, debounceMs: 999999 });
    indexer.onFileChanges([
      makeChange("/tmp/test/a.ts"),
      makeChange("/tmp/test/a.ts"),
    ]);
    expect(indexer.getStats().pendingFiles).toBe(1);
  });

  test("does not accumulate when disabled", () => {
    const indexer = new RagAutoIndexer("/tmp/test", { enabled: false });
    indexer.onFileChanges([makeChange("/tmp/test/a.ts")]);
    expect(indexer.getStats().pendingFiles).toBe(0);
  });

  test("stop clears pending and disables", () => {
    const indexer = new RagAutoIndexer("/tmp/test", { enabled: true, debounceMs: 999999 });
    indexer.onFileChanges([makeChange("/tmp/test/a.ts")]);
    indexer.stop();
    expect(indexer.getStats().pendingFiles).toBe(0);
  });

  test("enable re-enables after stop", () => {
    const indexer = new RagAutoIndexer("/tmp/test", { enabled: true, debounceMs: 999999 });
    indexer.stop();
    indexer.enable();
    indexer.onFileChanges([makeChange("/tmp/test/a.ts")]);
    expect(indexer.getStats().pendingFiles).toBe(1);
  });

  test("singleton returns same instance for same dir", () => {
    const a = getRagAutoIndexer("/tmp/test");
    const b = getRagAutoIndexer("/tmp/test");
    expect(a).toBe(b);
  });

  test("singleton resets correctly", () => {
    const a = getRagAutoIndexer("/tmp/test");
    _resetRagAutoIndexer();
    const b = getRagAutoIndexer("/tmp/test");
    expect(a).not.toBe(b);
  });
});
