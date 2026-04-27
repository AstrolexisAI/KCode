// Regression test for the v2.10.82 forensic audit finding about
// unbounded memory growth in FileChangeSuggester.suggestions. The
// pending buffer was already capped at 500; suggestions was not.
// Under high-churn scenarios (node_modules reinstall, git checkout
// between large branches) with a slow consumer, the array could
// grow without bound.
//
// This test does NOT cover FileWatcher's fs-backed behavior because
// that requires a real filesystem and is out of scope for a unit
// test. The suggester is pure in-memory logic.

import { describe, expect, test } from "bun:test";
import type { FileChangeEvent } from "./file-watcher";
import { FileChangeSuggester } from "./file-watcher";

function makeChanges(n: number, baseName: string): FileChangeEvent[] {
  const events: FileChangeEvent[] = [];
  for (let i = 0; i < n; i++) {
    events.push({
      type: "modify",
      path: `/project/src/${baseName}-${i}.test.ts`,
      relativePath: `src/${baseName}-${i}.test.ts`,
      timestamp: Date.now(),
    });
  }
  return events;
}

describe("FileChangeSuggester memory caps", () => {
  test("suggestions buffer is capped to 200 after repeated pushes", async () => {
    const suggester = new FileChangeSuggester();

    // 300 distinct test-file changes → ~300 unique suggestions
    // (each uses the file path in the message so they dedupe per
    // batch but are distinct across batches).
    for (let batch = 0; batch < 6; batch++) {
      suggester.addChanges(makeChanges(50, `b${batch}`));
      // Wait out the debounce so the internal process() runs and
      // flushes the batch into suggestions.
      await new Promise((r) => setTimeout(r, 600));
    }

    // suggestions should be capped even though we never drained it
    const drained = suggester.getSuggestions();
    expect(drained.length).toBeLessThanOrEqual(200);
  });

  test("drained suggestions are cleared so subsequent batches start fresh", async () => {
    const suggester = new FileChangeSuggester();
    suggester.addChanges(makeChanges(10, "a"));
    await new Promise((r) => setTimeout(r, 600));
    const first = suggester.getSuggestions();
    expect(first.length).toBeGreaterThan(0);
    // After draining, hasSuggestions should be false
    expect(suggester.hasSuggestions).toBe(false);
  });

  test("clear() resets both pending and suggestions", async () => {
    const suggester = new FileChangeSuggester();
    suggester.addChanges(makeChanges(10, "a"));
    suggester.clear();
    await new Promise((r) => setTimeout(r, 600));
    expect(suggester.hasSuggestions).toBe(false);
  });
});
