import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderSecureReport, runSecureChecks } from "./secure-checks";

describe("runSecureChecks", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Wipe any cloud-key env vars so the no-cloud-keys check is deterministic
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.TOGETHER_API_KEY;
    delete process.env.XAI_API_KEY;
    delete process.env.GROK_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.KCODE_OFFLINE;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("KCODE_OFFLINE=1 makes offline-mode pass", async () => {
    process.env.KCODE_OFFLINE = "1";
    const results = await runSecureChecks();
    const offline = results.find((r) => r.id === "offline-mode");
    expect(offline?.status).toBe("pass");
    expect(offline?.message).toContain("KCODE_OFFLINE=1");
  });

  test("no offline mode → warn", async () => {
    const results = await runSecureChecks();
    const offline = results.find((r) => r.id === "offline-mode");
    expect(offline?.status).toBe("warn");
    expect(offline?.fix).toBeDefined();
  });

  test("OPENAI_API_KEY env var triggers no-cloud-keys warn", async () => {
    process.env.OPENAI_API_KEY = "sk-test-fake";
    const results = await runSecureChecks();
    const cloud = results.find((r) => r.id === "no-cloud-keys");
    expect(cloud?.status).toBe("warn");
  });

  test("pinned-deps reports caret/tilde range usage", async () => {
    const root = mkdtempSync(join(tmpdir(), "kcode-secure-test-"));
    const pkgPath = join(root, "package.json");
    writeFileSync(
      pkgPath,
      JSON.stringify({
        name: "demo",
        version: "1.0.0",
        dependencies: {
          ranged: "^1.0.0",
          tilded: "~2.0.0",
          pinned: "3.0.0",
        },
      }),
    );
    const results = await runSecureChecks({ packageJsonPath: pkgPath });
    const pinned = results.find((r) => r.id === "pinned-deps");
    expect(pinned?.status).toBe("warn");
    expect(pinned?.message).toContain("2");
  });

  test("all-pinned production deps → pass", async () => {
    const root = mkdtempSync(join(tmpdir(), "kcode-secure-test-"));
    const pkgPath = join(root, "package.json");
    writeFileSync(
      pkgPath,
      JSON.stringify({
        name: "demo",
        version: "1.0.0",
        dependencies: { a: "1.0.0", b: "2.0.0" },
      }),
    );
    const results = await runSecureChecks({ packageJsonPath: pkgPath });
    const pinned = results.find((r) => r.id === "pinned-deps");
    expect(pinned?.status).toBe("pass");
  });

  test("includes all expected check IDs", async () => {
    const results = await runSecureChecks();
    const ids = results.map((r) => r.id);
    expect(ids).toContain("offline-mode");
    expect(ids).toContain("no-cloud-keys");
    expect(ids).toContain("auto-update");
    expect(ids).toContain("telemetry-off");
    expect(ids).toContain("settings-perms");
    expect(ids).toContain("pinned-deps");
    expect(ids).toContain("binary-signature");
    expect(ids).toContain("egress-attestation");
  });
});

describe("renderSecureReport", () => {
  test("renders pass/warn/fail counts and headline", () => {
    const out = renderSecureReport([
      { id: "a", name: "A", status: "pass", message: "ok" },
      { id: "b", name: "B", status: "warn", message: "meh", fix: "do x" },
      { id: "c", name: "C", status: "fail", message: "bad" },
    ]);
    expect(out).toContain("1/3 pass");
    expect(out).toContain("1 warn");
    expect(out).toContain("1 fail");
    expect(out).toContain("Failures present");
  });

  test("includes fix line for warn/fail items", () => {
    const out = renderSecureReport([
      { id: "a", name: "A", status: "warn", message: "meh", fix: "set X" },
    ]);
    expect(out).toContain("fix:");
    expect(out).toContain("set X");
  });

  test("does not show fix line for pass/info", () => {
    const out = renderSecureReport([
      { id: "a", name: "A", status: "pass", message: "ok", fix: "should not show" },
      { id: "b", name: "B", status: "info", message: "fyi", fix: "should not show" },
    ]);
    expect(out).not.toContain("should not show");
  });

  test("all-pass headline says all checks passed", () => {
    const out = renderSecureReport([{ id: "a", name: "A", status: "pass", message: "ok" }]);
    expect(out).toContain("All secure-mode checks passed");
  });
});
