import { beforeEach, describe, expect, test } from "bun:test";
import { type Prediction, WorldModel } from "./world-model";

describe("WorldModel", () => {
  let wm: WorldModel;

  beforeEach(() => {
    wm = new WorldModel();
  });

  // ─── predict ───────────────────────────────────────────────────

  test("predict returns prediction with confidence", () => {
    const prediction = wm.predict("Read", { file_path: "/tmp/test.ts" });
    expect(prediction).toHaveProperty("action");
    expect(prediction).toHaveProperty("expected");
    expect(prediction).toHaveProperty("confidence");
    expect(typeof prediction.action).toBe("string");
    expect(typeof prediction.expected).toBe("string");
    expect(typeof prediction.confidence).toBe("number");
    expect(prediction.confidence).toBeGreaterThan(0);
    expect(prediction.confidence).toBeLessThanOrEqual(1);
  });

  test("predict returns higher confidence for Read than Bash", () => {
    const readPrediction = wm.predict("Read", { file_path: "/tmp/test.ts" });
    const bashPrediction = wm.predict("Bash", { command: "echo hello" });
    // Base confidence: Read=0.9, Bash=0.6 (may be adjusted by history, but generally higher)
    expect(readPrediction.confidence).toBeGreaterThanOrEqual(bashPrediction.confidence);
  });

  test("predict generates correct action description for Read", () => {
    const prediction = wm.predict("Read", { file_path: "/tmp/foo.ts" });
    expect(prediction.action).toBe("Read: /tmp/foo.ts");
  });

  test("predict generates correct action description for Bash", () => {
    const prediction = wm.predict("Bash", { command: "ls -la" });
    expect(prediction.action).toContain("Bash:");
    expect(prediction.action).toContain("ls -la");
  });

  test("predict generates correct expectation for Read", () => {
    const prediction = wm.predict("Read", { file_path: "/tmp/foo.ts" });
    expect(prediction.expected).toContain("exists and is readable");
  });

  test("predict generates correct expectation for Write", () => {
    const prediction = wm.predict("Write", { file_path: "/tmp/out.ts" });
    expect(prediction.expected).toContain("created/overwritten successfully");
  });

  test("predict generates correct expectation for Bash mkdir", () => {
    const prediction = wm.predict("Bash", { command: "mkdir -p /tmp/newdir" });
    expect(prediction.expected).toBe("Directory created");
  });

  // ─── compare ───────────────────────────────────────────────────

  test("compare records correct prediction", () => {
    const prediction = wm.predict("Read", { file_path: "/tmp/test-correct.ts" });
    // Should not throw
    wm.compare(prediction, "file contents here", false);
    // Verify via getAccuracy — total should increase
    const accuracy = wm.getAccuracy();
    expect(accuracy.total).toBeGreaterThanOrEqual(1);
  });

  test("compare records incorrect prediction (error result)", () => {
    const prediction = wm.predict("Read", { file_path: "/tmp/nonexistent.ts" });
    wm.compare(prediction, "Error: not found", true);
    // Should be recorded as incorrect
    const discrepancies = wm.loadRecentDiscrepancies(100);
    const found = discrepancies.some((d) => d.action.includes("nonexistent.ts"));
    expect(found).toBe(true);
  });

  test("compare records incorrect prediction when result contains error indicator", () => {
    const prediction = wm.predict("Bash", { command: "cat /missing" });
    wm.compare(prediction, "No such file or directory", false);
    // Result contains "no such file" error indicator, so should be marked incorrect
    const discrepancies = wm.loadRecentDiscrepancies(100);
    const found = discrepancies.some((d) => d.action.includes("cat /missing"));
    expect(found).toBe(true);
  });

  // ─── loadRecentDiscrepancies ───────────────────────────────────

  test("loadRecentDiscrepancies returns recent wrong predictions", () => {
    const prediction = wm.predict("Bash", { command: "failing-command-test" });
    wm.compare(prediction, "Error: permission denied", false);
    const discrepancies = wm.loadRecentDiscrepancies(5);
    expect(Array.isArray(discrepancies)).toBe(true);
    // Should have at least the one we just inserted
    expect(discrepancies.length).toBeGreaterThanOrEqual(1);
    const entry = discrepancies.find((d) => d.action.includes("failing-command-test"));
    if (entry) {
      expect(entry).toHaveProperty("action");
      expect(entry).toHaveProperty("expected");
      expect(entry).toHaveProperty("actual");
      expect(entry).toHaveProperty("created_at");
    }
  });

  // ─── getAccuracy ───────────────────────────────────────────────

  test("getAccuracy returns ratio of correct predictions", () => {
    const accuracy = wm.getAccuracy();
    expect(accuracy).toHaveProperty("total");
    expect(accuracy).toHaveProperty("correct");
    expect(accuracy).toHaveProperty("rate");
    expect(typeof accuracy.total).toBe("number");
    expect(typeof accuracy.correct).toBe("number");
    expect(typeof accuracy.rate).toBe("number");
    if (accuracy.total > 0) {
      expect(accuracy.rate).toBeGreaterThanOrEqual(0);
      expect(accuracy.rate).toBeLessThanOrEqual(1);
    }
  });

  test("getAccuracy can filter by tool name", () => {
    // Record a prediction for a unique tool pattern
    const prediction = wm.predict("Glob", { pattern: "**/*.test-accuracy" });
    wm.compare(prediction, "some results", false);
    const accuracy = wm.getAccuracy("Glob");
    expect(accuracy.total).toBeGreaterThanOrEqual(1);
  });
});
