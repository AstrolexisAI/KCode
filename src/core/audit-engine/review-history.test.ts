// Tests for the F5.4 review-history learning loop.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("review-history pathGlob heuristics", () => {
  test("classifies test paths as test:*", async () => {
    const { pathGlob } = await import("./review-history");
    expect(pathGlob("/proj/src/foo.test.ts", "/proj")).toBe("test:*");
    expect(pathGlob("/proj/test/foo.ts", "/proj")).toBe("test:*");
    expect(pathGlob("/proj/__tests__/foo.ts", "/proj")).toBe("test:*");
    expect(pathGlob("/proj/src/foo.spec.js", "/proj")).toBe("test:*");
  });

  test("classifies fixture paths as fixture:*", async () => {
    const { pathGlob } = await import("./review-history");
    expect(pathGlob("/proj/fixtures/data.json", "/proj")).toBe("fixture:*");
    expect(pathGlob("/proj/__mocks__/db.ts", "/proj")).toBe("fixture:*");
    expect(pathGlob("/proj/data.fixture.ts", "/proj")).toBe("fixture:*");
  });

  test("classifies generated paths as generated:*", async () => {
    const { pathGlob } = await import("./review-history");
    expect(pathGlob("/proj/generated/types.ts", "/proj")).toBe("generated:*");
    expect(pathGlob("/proj/autocoder/out.cpp", "/proj")).toBe("generated:*");
  });

  test("classifies vendor / build paths", async () => {
    const { pathGlob } = await import("./review-history");
    expect(pathGlob("/proj/node_modules/foo/index.js", "/proj")).toBe("vendor:*");
    expect(pathGlob("/proj/vendor/lib.go", "/proj")).toBe("vendor:*");
    expect(pathGlob("/proj/dist/bundle.js", "/proj")).toBe("build:*");
    expect(pathGlob("/proj/build/out.js", "/proj")).toBe("build:*");
  });

  test("falls back to top-level dir for everything else", async () => {
    const { pathGlob } = await import("./review-history");
    expect(pathGlob("/proj/src/foo.ts", "/proj")).toBe("src:*");
    expect(pathGlob("/proj/lib/x.go", "/proj")).toBe("lib:*");
  });
});

describe("review-history persistence", () => {
  let originalHome: string | undefined;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kcode-review-history-test-"));
    originalHome = process.env.KCODE_HOME;
    process.env.KCODE_HOME = tempDir;
  });

  afterEach(async () => {
    if (originalHome !== undefined) {
      process.env.KCODE_HOME = originalHome;
    } else {
      delete process.env.KCODE_HOME;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  test("recordDemotion creates a fresh entry", async () => {
    const { recordDemotion, getDemotionCount } = await import("./review-history");
    recordDemotion({
      projectRoot: "/some/proj",
      patternId: "js-009-redos",
      file: "/some/proj/src/test/foo.test.js",
    });
    const count = getDemotionCount({
      projectRoot: "/some/proj",
      patternId: "js-009-redos",
      file: "/some/proj/src/test/foo.test.js",
    });
    expect(count).toBe(1);
  });

  test("multiple demotions in same path glob accumulate", async () => {
    const { recordDemotion, getDemotionCount } = await import("./review-history");
    for (let i = 0; i < 5; i++) {
      recordDemotion({
        projectRoot: "/some/proj",
        patternId: "js-009-redos",
        file: `/some/proj/test/foo${i}.test.js`,
      });
    }
    const count = getDemotionCount({
      projectRoot: "/some/proj",
      patternId: "js-009-redos",
      file: "/some/proj/test/anything.test.js",
    });
    expect(count).toBe(5);
  });

  test("different path globs accumulate independently", async () => {
    const { recordDemotion, getDemotionCount } = await import("./review-history");
    recordDemotion({
      projectRoot: "/proj",
      patternId: "x",
      file: "/proj/test/a.test.js",
    });
    recordDemotion({
      projectRoot: "/proj",
      patternId: "x",
      file: "/proj/src/main.js",
    });
    expect(
      getDemotionCount({ projectRoot: "/proj", patternId: "x", file: "/proj/test/b.test.js" }),
    ).toBe(1);
    expect(
      getDemotionCount({ projectRoot: "/proj", patternId: "x", file: "/proj/src/util.js" }),
    ).toBe(1);
  });

  test("isHighNoise returns false below threshold", async () => {
    const { recordDemotion, isHighNoise, HIGH_NOISE_THRESHOLD } = await import("./review-history");
    for (let i = 0; i < HIGH_NOISE_THRESHOLD - 1; i++) {
      recordDemotion({ projectRoot: "/p", patternId: "x", file: "/p/test/a.test.js" });
    }
    expect(isHighNoise({ projectRoot: "/p", patternId: "x", file: "/p/test/foo.test.js" })).toBe(
      false,
    );
  });

  test("isHighNoise flips to true at threshold", async () => {
    const { recordDemotion, isHighNoise, HIGH_NOISE_THRESHOLD } = await import("./review-history");
    for (let i = 0; i < HIGH_NOISE_THRESHOLD; i++) {
      recordDemotion({ projectRoot: "/p", patternId: "x", file: "/p/test/a.test.js" });
    }
    expect(isHighNoise({ projectRoot: "/p", patternId: "x", file: "/p/test/foo.test.js" })).toBe(
      true,
    );
  });

  test("forgetProjectHistory clears the project entry", async () => {
    const { recordDemotion, getDemotionCount, forgetProjectHistory } = await import(
      "./review-history"
    );
    recordDemotion({ projectRoot: "/p", patternId: "x", file: "/p/test/a.test.js" });
    expect(getDemotionCount({ projectRoot: "/p", patternId: "x", file: "/p/test/a.test.js" })).toBe(
      1,
    );
    forgetProjectHistory("/p");
    expect(getDemotionCount({ projectRoot: "/p", patternId: "x", file: "/p/test/a.test.js" })).toBe(
      0,
    );
  });

  test("two projects keep separate histories", async () => {
    const { recordDemotion, getDemotionCount } = await import("./review-history");
    recordDemotion({ projectRoot: "/p1", patternId: "x", file: "/p1/src/a.js" });
    recordDemotion({ projectRoot: "/p2", patternId: "x", file: "/p2/src/a.js" });
    expect(getDemotionCount({ projectRoot: "/p1", patternId: "x", file: "/p1/src/a.js" })).toBe(1);
    expect(getDemotionCount({ projectRoot: "/p2", patternId: "x", file: "/p2/src/a.js" })).toBe(1);
  });

  test("getProjectHistory returns sorted entries", async () => {
    const { recordDemotion, getProjectHistory } = await import("./review-history");
    recordDemotion({ projectRoot: "/p", patternId: "x", file: "/p/src/a.js" });
    recordDemotion({ projectRoot: "/p", patternId: "y", file: "/p/src/a.js" });
    recordDemotion({ projectRoot: "/p", patternId: "y", file: "/p/src/b.js" });
    recordDemotion({ projectRoot: "/p", patternId: "y", file: "/p/src/c.js" });
    const entries = getProjectHistory("/p");
    expect(entries[0]!.pattern_id).toBe("y");
    expect(entries[0]!.demoted_count).toBe(3);
    expect(entries[1]!.pattern_id).toBe("x");
  });
});
