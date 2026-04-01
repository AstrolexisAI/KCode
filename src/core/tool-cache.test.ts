import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToolCache } from "./tool-cache.ts";

let tempDir: string;
let cache: ToolCache;

async function createTempFile(name: string, content: string): Promise<string> {
  const filePath = join(tempDir, name);
  await Bun.write(filePath, content);
  return filePath;
}

describe("tool-cache", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kcode-tool-cache-test-"));
    cache = new ToolCache();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ─── Basic set/get ───

  test("set and get returns cached result", async () => {
    const filePath = await createTempFile("test.txt", "hello");
    const key = cache.makeKey("Read", filePath);

    cache.set(key, filePath, "cached content");
    const result = cache.get(key, filePath);

    expect(result).toBe("cached content");
    expect(cache.hits).toBe(1);
    expect(cache.size).toBe(1);
  });

  // ─── Cache miss for missing key ───

  test("returns null for uncached file", async () => {
    const filePath = await createTempFile("test.txt", "hello");
    const key = cache.makeKey("Read", filePath);

    const result = cache.get(key, filePath);

    expect(result).toBeNull();
    expect(cache.misses).toBe(1);
  });

  // ─── TTL expiry ───

  test("returns null after TTL expires", async () => {
    const filePath = await createTempFile("test.txt", "hello");
    const key = cache.makeKey("Read", filePath);

    cache.set(key, filePath, "cached content");

    // Manually expire the entry by patching the cachedAt timestamp
    // Access the internal cache map via the size check and re-set with old timestamp
    const entry = (cache as any).cache.get(key);
    entry.cachedAt = Date.now() - 120_000; // 120 seconds ago, well past 60s TTL

    const result = cache.get(key, filePath);

    expect(result).toBeNull();
    expect(cache.misses).toBe(1);
  });

  // ─── Invalidation on file change ───

  test("returns null when file mtime changes", async () => {
    const filePath = await createTempFile("test.txt", "hello");
    const key = cache.makeKey("Read", filePath);

    cache.set(key, filePath, "cached content");

    // Patch the stored mtime to a stale value so the real mtime no longer matches
    const entry = (cache as any).cache.get(key);
    entry.mtime = entry.mtime - 10_000; // Pretend file was cached 10s earlier

    const result = cache.get(key, filePath);

    expect(result).toBeNull();
  });

  // ─── clear() empties cache ───

  test("clear empties all entries and resets stats", async () => {
    const fileA = await createTempFile("a.txt", "aaa");
    const fileB = await createTempFile("b.txt", "bbb");

    cache.set(cache.makeKey("Read", fileA), fileA, "content A");
    cache.set(cache.makeKey("Read", fileB), fileB, "content B");

    expect(cache.size).toBe(2);

    cache.clear();

    expect(cache.size).toBe(0);
    expect(cache.hits).toBe(0);
    expect(cache.misses).toBe(0);
  });

  // ─── Max entries eviction ───

  test("evicts oldest entry when capacity is reached", async () => {
    // ToolCache has MAX_ENTRIES = 200, so we fill it and check eviction
    const files: string[] = [];
    for (let i = 0; i < 201; i++) {
      const filePath = await createTempFile(`file-${i}.txt`, `content-${i}`);
      files.push(filePath);
      const key = cache.makeKey("Read", filePath);
      cache.set(key, filePath, `result-${i}`);
    }

    // Cache should have exactly 200 entries (one evicted)
    expect(cache.size).toBe(200);

    // The first entry (oldest, never accessed again) should have been evicted
    const firstKey = cache.makeKey("Read", files[0]!);
    const firstResult = cache.get(firstKey, files[0]!);
    expect(firstResult).toBeNull();

    // The last entry should still be present
    const lastKey = cache.makeKey("Read", files[200]!);
    const lastResult = cache.get(lastKey, files[200]!);
    expect(lastResult).toBe("result-200");
  });

  // ─── invalidate() removes entries for a specific file ───

  test("invalidate removes entries for a specific file path", async () => {
    const fileA = await createTempFile("a.txt", "aaa");
    const fileB = await createTempFile("b.txt", "bbb");

    const keyA = cache.makeKey("Read", fileA);
    const keyB = cache.makeKey("Read", fileB);

    cache.set(keyA, fileA, "content A");
    cache.set(keyB, fileB, "content B");

    cache.invalidate(fileA);

    expect(cache.size).toBe(1);
    expect(cache.get(keyA, fileA)).toBeNull();
    expect(cache.get(keyB, fileB)).toBe("content B");
  });
});
