import { describe, expect, test } from "bun:test";
import { redact, redactSilently } from "./secret-redactor";

describe("secret-redactor", () => {
  test("masks rpcpassword from bitcoin.conf output", () => {
    const input = "rpcuser=curly\nrpcpassword=tronco\nrpcport=8332";
    const { redacted, rulesFired } = redact(input);
    expect(redacted).not.toContain("tronco");
    expect(redacted).toContain("rpcpassword=***REDACTED***");
    expect(redacted).toContain("rpcport=8332"); // untouched
    expect(rulesFired).toContain("rpcpassword");
    expect(rulesFired).toContain("rpcuser");
  });

  test("masks Anthropic API keys", () => {
    const input =
      "ANTHROPIC_API_KEY=sk-ant-api03-abcd1234efgh5678ijkl9012mnop3456qrst7890uvwxyz";
    const { redacted, rulesFired } = redact(input);
    expect(redacted).not.toContain("sk-ant-api03");
    expect(rulesFired).toContain("anthropic_key");
  });

  test("masks xAI keys", () => {
    const input = "export XAI_API_KEY=xai-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
    const { redacted } = redact(input);
    expect(redacted).not.toContain("xai-abcdefghijklmnop");
    expect(redacted).toContain("***REDACTED***");
  });

  test("masks Stripe webhook secrets", () => {
    // Synthetic fixture — NEVER paste real whsec_ values into tests.
    const input =
      "STRIPE_WEBHOOK_SECRET=whsec_FAKE" + "0".repeat(28);
    const { redacted } = redact(input);
    expect(redacted).not.toContain("whsec_FAKE");
    expect(redacted).toContain("***REDACTED***");
  });

  test("masks PEM-encoded private keys", () => {
    const input =
      "here is the key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n...\n-----END RSA PRIVATE KEY-----\nDone.";
    const { redacted, rulesFired } = redact(input);
    expect(redacted).not.toContain("MIIEpAIBAAKCAQEA");
    expect(redacted).toContain("Done.");
    expect(rulesFired).toContain("pem_private_key");
  });

  test("masks URL basic auth", () => {
    const input = "Connecting to https://admin:supersecret@db.internal:5432/kulvex";
    const { redacted } = redact(input);
    expect(redacted).not.toContain("supersecret");
    expect(redacted).toContain("admin:");
    expect(redacted).toContain("@db.internal");
  });

  test("masks JWT tokens", () => {
    const input =
      "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjMifQ.abcdef123456";
    const { redacted, rulesFired } = redact(input);
    expect(redacted).not.toContain("eyJzdWIiOiIxMjMifQ");
    expect(rulesFired).toContain("jwt");
  });

  test("does not redact short non-secret values", () => {
    const input = "password=''\ntoken=abc\nsecret=x";
    const { redacted } = redact(input);
    // All too short to trigger: password="" (empty), token=abc (<16), secret=x (<8)
    expect(redacted).toContain("password=");
    expect(redacted).toContain("token=abc");
  });

  test("redactSilently returns only the string", () => {
    const out = redactSilently("rpcpassword=hunter2");
    expect(typeof out).toBe("string");
    expect(out).not.toContain("hunter2");
  });

  test("masks the EXACT 2026-04-23 #107 assistant-prose leak", () => {
    // Real model output: "(user: curly, password: tronco, port: 8332)"
    const input =
      "Configured with your RPC credentials (user: curly, password: tronco, port: 8332)";
    const { redacted, rulesFired } = redact(input);
    expect(redacted).not.toContain("tronco");
    expect(redacted).toContain("***REDACTED***");
    expect(rulesFired).toContain("password_assign");
  });

  test("returns input unchanged when no secrets present", () => {
    const input = "ls -la /tmp\ntotal 0\ndrwxrwxrwt 15 root root 340 Apr 23 09:00 .";
    const { redacted, rulesFired } = redact(input);
    expect(redacted).toBe(input);
    expect(rulesFired).toHaveLength(0);
  });

  test("handles empty and nullish input", () => {
    expect(redact("").redacted).toBe("");
    expect(redact("" as string).rulesFired).toHaveLength(0);
  });

  test("masks multiple distinct secrets in one text", () => {
    const input =
      "ANTHROPIC_API_KEY=sk-ant-api03-abcd1234efgh5678ijkl9012mnop3456qrst7890uvwxyz\nrpcpassword=hunter2\nSTRIPE_SECRET=sk_live_" +
      "a".repeat(30);
    const { redacted, rulesFired } = redact(input);
    expect(redacted).not.toContain("sk-ant-api03-abcd");
    expect(redacted).not.toContain("hunter2");
    expect(redacted).not.toContain("sk_live_aaaa");
    expect(rulesFired.length).toBeGreaterThanOrEqual(3);
  });
});
