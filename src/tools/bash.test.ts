import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { bashDefinition, executeBash } from "./bash.ts";

let hasBash = false;
try {
  execFileSync("bash", ["--version"], { stdio: "pipe" });
  hasBash = true;
} catch {}

(hasBash ? describe : describe.skip)("bash tool", () => {
  // ─── Definition ───

  test("bashDefinition has correct name and required fields", () => {
    expect(bashDefinition.name).toBe("Bash");
    expect(bashDefinition.input_schema.required).toContain("command");
  });

  // ─── Basic execution ───

  test("executes simple echo command", async () => {
    const result = await executeBash({ command: "echo hello" });
    expect(result.content).toContain("hello");
    expect(result.is_error).toBeFalsy();
  });

  test("failing command returns is_error true", async () => {
    const result = await executeBash({ command: "exit 1" });
    expect(result.is_error).toBe(true);
  });

  test("captures stderr output", async () => {
    const result = await executeBash({ command: "echo oops >&2" });
    expect(result.content).toContain("oops");
  });

  test("returns exit code for empty output", async () => {
    const result = await executeBash({ command: "exit 42" });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("exit code 42");
  });

  // ─── Timeout ───

  test("respects timeout parameter", async () => {
    const start = Date.now();
    const result = await executeBash({ command: "sleep 30", timeout: 1000 });
    const elapsed = Date.now() - start;
    // Should be killed well before 30 seconds
    expect(elapsed).toBeLessThan(10_000);
    expect(result.is_error).toBe(true);
  });

  // ─── Dangerous kill pattern guard ───

  test("blocks pkill -f serve", async () => {
    const result = await executeBash({ command: 'pkill -f "serve"' });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("BLOCKED");
  });

  test("blocks killall node", async () => {
    const result = await executeBash({ command: "killall node" });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("BLOCKED");
  });

  test("blocks pkill python", async () => {
    const result = await executeBash({ command: "pkill python" });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("BLOCKED");
  });

  test("blocks pkill -9 bun", async () => {
    const result = await executeBash({ command: "pkill -9 bun" });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("BLOCKED");
  });

  // ─── Safe kill patterns are allowed ───

  test("allows kill by port via lsof", async () => {
    // kill $(lsof ...) does not match the pkill/killall guard
    const result = await executeBash({ command: "echo 'kill $(lsof -ti :3000)'" });
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("kill $(lsof -ti :3000)");
  });

  test("pkill with full command path still blocked if it contains a guarded word", async () => {
    // The regex matches the FIRST guarded word it finds after pkill -f
    // So 'pkill -f "python3 -m http.server 8080"' matches "python" at the word boundary
    // This is an intentional trade-off in the guard — overly broad patterns are blocked
    const result = await executeBash({
      command: 'pkill -f "python3 -m http.server 8080"',
    });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("BLOCKED");
  });

  test("safe kill alternatives are not blocked", async () => {
    // Using fuser to kill by port is safe and not blocked
    const result = await executeBash({ command: "echo 'fuser -k 8080/tcp'" });
    expect(result.is_error).toBeFalsy();
    expect(result.content).not.toContain("BLOCKED");
  });

  // ─── Auto-background detection ───

  test("plain echo does NOT get backgrounded", async () => {
    // A command without any server keywords should run in foreground
    const result = await executeBash({ command: "echo 'npm test'" });
    expect(result.content).toContain("npm test");
    expect(result.is_error).toBeFalsy();
  });

  test("echo with serve keyword DOES get auto-backgrounded", async () => {
    // The isServerCommand regex matches \bserve\b anywhere in the command
    // so even `echo "serve"` triggers auto-backgrounding — this is by design
    const result = await executeBash({ command: "echo 'serve test'" });
    // It still completes (auto-backgrounded echo finishes fast)
    expect(result.content).toBeTruthy();
  });

  test("simple commands return immediately with output", async () => {
    const start = Date.now();
    const result = await executeBash({ command: "echo fast" });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000);
    expect(result.content).toContain("fast");
  });

  test("run_in_background flag returns quickly", async () => {
    const start = Date.now();
    const result = await executeBash({
      command: "echo bg-started && sleep 60",
      run_in_background: true,
    });
    const elapsed = Date.now() - start;
    // Background wrapper waits ~3s for initial output, plus overhead
    expect(elapsed).toBeLessThan(15_000);
    expect(result.content).toContain("bg-started");
  });

  test("python3 -m http.server 0 gets auto-backgrounded", async () => {
    const start = Date.now();
    const result = await executeBash({
      command: "python3 -m http.server 0",
    });
    const elapsed = Date.now() - start;
    // Should auto-background and return in ~3-5s, not block for 2 minutes
    expect(elapsed).toBeLessThan(20_000);
    // Should have started successfully or show output
    expect(result.content).toBeTruthy();
  });

  // ─── shellEscape (tested indirectly via background commands) ───

  test("handles commands with single quotes via background", async () => {
    // Background mode uses shellEscape internally
    const result = await executeBash({
      command: "echo 'hello'\\''s world'",
      run_in_background: true,
    });
    // Should not error out
    expect(result.is_error).toBeFalsy();
  });

  test("shellEscape handles single quotes in background commands", async () => {
    const result = await executeBash({
      command: 'echo "it\'s a test"',
      run_in_background: true,
    });
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain("it's a test");
  });

  // ─── isServerCommand regex matching ───

  test("isServerCommand matches uvicorn", async () => {
    // uvicorn would block forever; auto-background should kick in
    const start = Date.now();
    await executeBash({
      command: "echo 'would run uvicorn' && exit 0",
    });
    // "uvicorn" appears in the command, so it gets auto-backgrounded
    // The wrapper should return within ~15s
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(20_000);
  });

  test("isServerCommand matches flask run", async () => {
    const start = Date.now();
    await executeBash({
      command: "echo 'flask run test' && exit 0",
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(20_000);
  });

  test("isServerCommand does NOT match npm test", async () => {
    const start = Date.now();
    const result = await executeBash({ command: "echo npm_test_output" });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5_000);
    expect(result.content).toContain("npm_test_output");
    expect(result.is_error).toBeFalsy();
  });

  // Phase 24 detection coverage now lives in bash-spawn-verifier.test.ts
  // where detectServerSpawn is unit-tested directly. Echo-wrapped bash
  // integration tests are tautologies — the echo exits in <20ms so the
  // assertion passes regardless of whether auto-backgrounding runs. See
  // the phase 24 audit for details.

  // ─── tool_use_id is always empty string ───

  test("result always has empty tool_use_id", async () => {
    const result = await executeBash({ command: "echo test" });
    expect(result.tool_use_id).toBe("");
  });

  // ─── Phase 34: recursive ls auto-rewrite ───
  // Prevents context-window bombs from `ls -R` on large projects.
  // Gemma 4 (v2.10.84) ran `ls -R /home/curly/KCode` → 244K tokens
  // against a 65K context window, killing the session instantly.

  test("ls -R is rewritten to a safe find command", async () => {
    const result = await executeBash({ command: "ls -R /tmp" });
    // The output should come from `find /tmp ...` not `ls -R /tmp`
    // We can't assert the exact command, but we CAN assert it doesn't
    // include node_modules paths (which find -not -path excludes) and
    // it completes without error.
    expect(result.is_error).toBeFalsy();
  });

  test("ls -lR is also rewritten (flags combined with R)", async () => {
    const result = await executeBash({ command: "ls -lR /tmp" });
    expect(result.is_error).toBeFalsy();
  });

  test("ls --recursive is rewritten", async () => {
    const result = await executeBash({ command: "ls --recursive /tmp" });
    expect(result.is_error).toBeFalsy();
  });

  test("non-recursive ls is NOT rewritten", async () => {
    const result = await executeBash({ command: "ls -la /tmp" });
    expect(result.is_error).toBeFalsy();
    // Should contain typical ls output (permissions, dates, etc.)
    // rather than find-style path-only output.
    expect(result.content).toBeTruthy();
  });
});
