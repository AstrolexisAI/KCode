import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getTaskScopeManager } from "./task-scope";
import { renderForLog, renderVisibleText } from "./visible-text-renderer";

beforeEach(() => {
  getTaskScopeManager().reset();
});

afterEach(() => {
  getTaskScopeManager().reset();
  delete process.env.KCODE_DISABLE_REDACTION;
});

describe("renderVisibleText", () => {
  test("returns input unchanged when no secrets are present", () => {
    const input = "ls -la /tmp\ntotal 0";
    expect(renderVisibleText(input, { source: "tool_output" })).toBe(input);
  });

  test("redacts rpcpassword", () => {
    const input = "rpcpassword=tronco\nserver=1";
    const out = renderVisibleText(input, { source: "tool_output" });
    expect(out).not.toContain("tronco");
    expect(out).toContain("***REDACTED***");
  });

  test("redacts the 2026-04-23 #107 assistant-prose leak shape", () => {
    const input =
      "Configured with your RPC credentials (user: curly, password: tronco, port: 8332)";
    const out = renderVisibleText(input, { source: "assistant_prose" });
    expect(out).not.toContain("tronco");
    expect(out).toContain("curly"); // username not redacted (intentional)
    expect(out).toContain("***REDACTED***");
  });

  test("records findings to scope.secrets", () => {
    const mgr = getTaskScopeManager();
    mgr.beginNewScope({ type: "configure", userPrompt: "x" });
    renderVisibleText("rpcpassword=hunter2", { source: "tool_output" });
    const detected = mgr.current()?.secrets.detected ?? [];
    expect(detected.length).toBeGreaterThan(0);
    expect(detected.some((s) => s.kind === "rpcpassword")).toBe(true);
    expect(detected.some((s) => s.source === "tool_output")).toBe(true);
  });

  test("deduplicates repeated secret findings in scope", () => {
    const mgr = getTaskScopeManager();
    mgr.beginNewScope({ type: "configure", userPrompt: "x" });
    renderVisibleText("rpcpassword=tronco", { source: "tool_output" });
    renderVisibleText("rpcpassword=tronco", { source: "tool_output" });
    renderVisibleText("rpcpassword=tronco", { source: "tool_output" });
    const detected = mgr.current()?.secrets.detected ?? [];
    // Manager dedups by kind+source
    expect(
      detected.filter((s) => s.kind === "rpcpassword" && s.source === "tool_output").length,
    ).toBe(1);
  });

  test("skipScopeRecord=true does not pollute scope", () => {
    const mgr = getTaskScopeManager();
    mgr.beginNewScope({ type: "configure", userPrompt: "x" });
    renderVisibleText("rpcpassword=tronco", { source: "log", skipScopeRecord: true });
    expect(mgr.current()?.secrets.detected ?? []).toHaveLength(0);
  });

  test("renderForLog masks but does not record", () => {
    const mgr = getTaskScopeManager();
    mgr.beginNewScope({ type: "audit", userPrompt: "x" });
    const out = renderForLog("ANTHROPIC_API_KEY=sk-ant-api03-" + "a".repeat(50));
    expect(out).not.toContain("sk-ant-api03-aaaa");
    expect(mgr.current()?.secrets.detected ?? []).toHaveLength(0);
  });

  test("works without an active scope (early startup case)", () => {
    getTaskScopeManager().reset(); // no scope active
    const out = renderVisibleText("rpcpassword=x", { source: "tool_output" });
    expect(out).not.toContain("=x");
  });

  test("KCODE_DISABLE_REDACTION=1 disables the pipeline", () => {
    process.env.KCODE_DISABLE_REDACTION = "1";
    const input = "rpcpassword=tronco";
    expect(renderVisibleText(input, { source: "tool_output" })).toBe(input);
  });

  test("handles empty / nullish input", () => {
    expect(renderVisibleText("")).toBe("");
    expect(renderVisibleText("", { source: "tool_output" })).toBe("");
  });

  test("redacts PEM keys and JWTs together", () => {
    const input = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEpAIBAAKCAQEA",
      "-----END RSA PRIVATE KEY-----",
      // Real-length JWT (signature ≥ 10 chars per redactor rule)
      "and a jwt: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjMifQ.abcdef1234567890",
    ].join("\n");
    const mgr = getTaskScopeManager();
    mgr.beginNewScope({ type: "configure", userPrompt: "x" });
    const out = renderVisibleText(input, { source: "tool_output" });
    expect(out).not.toContain("MIIEpAIBAAKCAQEA");
    expect(out).not.toContain("eyJzdWIiOiIxMjMifQ");
    const kinds = mgr.current()?.secrets.detected.map((s) => s.kind) ?? [];
    expect(kinds).toContain("pem_private_key");
    expect(kinds).toContain("jwt");
  });
});
