// Tests for phase 26 — write content scanner (secrets + debug).

import { describe, expect, test } from "bun:test";
import {
  buildDebugWarning,
  buildSecretReport,
  detectDebugStatements,
  detectSecrets,
} from "./write-content-scanner";

// ─── Secret detection ────────────────────────────────────────────

describe("detectSecrets — known key shapes", () => {
  test("catches OpenAI sk- key", () => {
    const code = `const client = new OpenAI({ apiKey: "sk-proj1234567890abcdefABCDEF1234567890XYZ" });`;
    const v = detectSecrets("/tmp/app.ts", code);
    expect(v.hasSecret).toBe(true);
    expect(v.hits[0]!.name).toBe("openai-api-key");
    expect(v.hits[0]!.line).toBe(1);
  });

  test("catches Anthropic sk-ant- key", () => {
    const key = "sk-ant-" + "A".repeat(96);
    const code = `const k = "${key}";`;
    const v = detectSecrets("/tmp/app.ts", code);
    expect(v.hasSecret).toBe(true);
    expect(v.hits[0]!.name).toBe("anthropic-api-key");
  });

  test("catches xAI/Grok key (the real user key shape from the session logs)", () => {
    // Shape from user's earlier logs: xai-EPv6hHa45Cqb... (80 alnum chars)
    const key = "xai-" + "A".repeat(80);
    const code = `const GROK_KEY = "${key}";`;
    const v = detectSecrets("/tmp/config.js", code);
    expect(v.hasSecret).toBe(true);
    expect(v.hits[0]!.name).toBe("xai-api-key");
  });

  test("catches Google API key (AIza...)", () => {
    const code = `export const GOOGLE_API_KEY = "AIza${"B".repeat(35)}";`;
    const v = detectSecrets("/tmp/maps.ts", code);
    expect(v.hasSecret).toBe(true);
    expect(v.hits[0]!.name).toBe("google-api-key");
  });

  test("catches AWS access key ID (AKIA...)", () => {
    const code = `const AWS_ACCESS = "AKIAIOSFODNN7EXAMPLE";`;
    const v = detectSecrets("/tmp/aws.ts", code);
    // "EXAMPLE" is a placeholder substring — should be ignored
    expect(v.hasSecret).toBe(false);
  });

  test("catches real-looking AWS access key", () => {
    const code = `const AWS_ACCESS = "AKIA" + "ABCDEFGHIJKLMNOP";`;
    // The key literal itself must be one string; split expressions don't count
    const realKey = `AKIA${"X".repeat(16)}`;
    const realCode = `const AWS_ACCESS = "${realKey}";`;
    const v = detectSecrets("/tmp/aws.ts", realCode);
    // Note: the regex uses [0-9A-Z], and "X" fits but looksLikePlaceholder
    // catches all-X patterns. Use a realistic mix:
    const realMix = "AKIAIOSFODNN7AB1CD23";
    expect(detectSecrets("/tmp/aws.ts", `const k = "${realMix}";`).hasSecret).toBe(true);
  });

  test("catches GitHub PAT (ghp_...)", () => {
    // String is split at runtime so GitHub's own secret scanner
    // doesn't flag this test file as containing a real PAT.
    const fakeKey = "gh" + "p_" + "a".repeat(36);
    const code = `const TOKEN = "${fakeKey}";`;
    const v = detectSecrets("/tmp/app.ts", code);
    expect(v.hasSecret).toBe(true);
    expect(v.hits[0]!.name).toBe("github-pat");
  });

  test("catches Slack bot token (xoxb-...)", () => {
    const fakeKey = "xo" + "xb-" + "1234567890-0987654321-abcdefghijklmnopqrst";
    const code = `const SLACK = "${fakeKey}";`;
    const v = detectSecrets("/tmp/slack.ts", code);
    expect(v.hasSecret).toBe(true);
    expect(v.hits[0]!.name).toBe("slack-bot-token");
  });

  test("catches Stripe live secret (sk_live_...)", () => {
    // Split to avoid GitHub secret scanner false positive on test file.
    const fakeKey = "sk" + "_live_" + "51abcdefghijklmnopqrstuvwx";
    const code = `stripe = new Stripe("${fakeKey}");`;
    const v = detectSecrets("/tmp/payment.ts", code);
    expect(v.hasSecret).toBe(true);
    expect(v.hits[0]!.name).toBe("stripe-secret");
  });

  test("catches generic api_key assignment", () => {
    const code = `const config = { api_key: "9kZ3xP2mN4qR6tL1vW8aB5cD7eF0hJ9k" };`;
    const v = detectSecrets("/tmp/config.js", code);
    expect(v.hasSecret).toBe(true);
    expect(v.hits[0]!.name).toBe("generic-api-key-assignment");
  });

  test("catches Bearer token literal", () => {
    const code = `headers: { Authorization: "Bearer 1234567890abcdefghijABCDEFGHIJ" }`;
    const v = detectSecrets("/tmp/api.ts", code);
    expect(v.hasSecret).toBe(true);
    expect(v.hits[0]!.name).toBe("bearer-token");
  });
});

describe("detectSecrets — placeholder handling", () => {
  test("skips YOUR_KEY_HERE placeholders", () => {
    // These look like secrets structurally but contain placeholder substrings
    const code = `
      const OPENAI_KEY = "sk-YOUR_OPENAI_KEY_HERE_1234567890xxxxx";
      const ANTHROPIC = "sk-ant-YOUR_ANTHROPIC_KEY_HERE${"_".repeat(80)}";
      const API_KEY = "REPLACE_WITH_YOUR_ACTUAL_KEY_HERE_12345";
    `;
    const v = detectSecrets("/tmp/config.ts", code);
    expect(v.hasSecret).toBe(false);
  });

  test("skips all-x placeholder shapes", () => {
    const code = `const KEY = "sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";`;
    const v = detectSecrets("/tmp/demo.ts", code);
    expect(v.hasSecret).toBe(false);
  });

  test("skips EXAMPLE-suffixed AWS keys (documentation standard)", () => {
    const code = `const AWS = "AKIAIOSFODNN7EXAMPLE";`;
    const v = detectSecrets("/tmp/iam.ts", code);
    expect(v.hasSecret).toBe(false);
  });
});

describe("detectSecrets — path exemptions", () => {
  test("allows .env.example with literal examples", () => {
    const content = `OPENAI_API_KEY=sk-proj1234567890abcdefABCDEF1234567890XYZ`;
    expect(detectSecrets("/tmp/.env.example", content).hasSecret).toBe(false);
  });

  test("allows .env.sample", () => {
    const content = `GROK_KEY=xai-${"A".repeat(80)}`;
    expect(detectSecrets("/tmp/.env.sample", content).hasSecret).toBe(false);
  });

  test("allows README.md to contain example keys", () => {
    const content = `
      # Setup
      export OPENAI_API_KEY="sk-abc1234567890defABCDEF1234567890XYZ"
    `;
    expect(detectSecrets("/tmp/README.md", content).hasSecret).toBe(false);
  });

  test("does NOT allow secrets in .env (non-example)", () => {
    const content = `OPENAI_API_KEY=sk-proj1234567890abcdefABCDEF1234567890XYZ`;
    // Note: .env is already blocked by the older sensitive-file
    // pattern in write.ts, but the scanner should still flag it
    expect(detectSecrets("/tmp/.env", content).hasSecret).toBe(true);
  });
});

describe("buildSecretReport", () => {
  test("names the file, lists hits, offers three resolutions", () => {
    const verdict = {
      hasSecret: true,
      hits: [
        { name: "openai-api-key", line: 12, snippet: "sk-proj1234…XYZ" },
        { name: "stripe-secret", line: 45, snippet: "sk_live_51abcd…" },
      ],
    };
    const report = buildSecretReport("/tmp/app.ts", verdict);
    expect(report).toContain("BLOCKED");
    expect(report).toContain("app.ts");
    expect(report).toContain("2 plausible credential");
    expect(report).toContain("openai-api-key");
    expect(report).toContain("line 12");
    expect(report).toMatch(/a\)/);
    expect(report).toMatch(/b\)/);
    expect(report).toMatch(/c\)/);
    expect(report).toContain("env-var");
  });
});

// ─── Debug statement detection ────────────────────────────────────

describe("detectDebugStatements", () => {
  test("flags console.log in a .ts file", () => {
    const code = `
      function main() {
        console.log("hello");
        return 42;
      }
    `;
    const v = detectDebugStatements("/tmp/app.ts", code);
    expect(v.hasDebug).toBe(true);
    expect(v.hits[0]!.name).toBe("console.log");
  });

  test("flags debugger statement", () => {
    const code = `
      function fn() {
        debugger;
      }
    `;
    const v = detectDebugStatements("/tmp/app.ts", code);
    expect(v.hasDebug).toBe(true);
    expect(v.hits.some((h) => h.name === "debugger")).toBe(true);
  });

  test("flags console.log inside an HTML file", () => {
    const code = `<html><script>console.log('x');</script></html>`;
    const v = detectDebugStatements("/tmp/orbital.html", code);
    expect(v.hasDebug).toBe(true);
  });

  test("flags Python print() statements", () => {
    const code = `
      def main():
          print("debug")
          return 42
    `;
    const v = detectDebugStatements("/tmp/app.py", code);
    expect(v.hasDebug).toBe(true);
    expect(v.hits[0]!.name).toBe("print()");
  });

  test("flags Rust dbg! and println!", () => {
    const code = `fn main() { dbg!(x); println!("y"); }`;
    const v = detectDebugStatements("/tmp/main.rs", code);
    expect(v.hasDebug).toBe(true);
    expect(v.hits.length).toBeGreaterThanOrEqual(2);
  });

  test("exempts test files (.test.ts)", () => {
    const code = `
      test("foo", () => {
        console.log("debug");
        expect(1).toBe(1);
      });
    `;
    const v = detectDebugStatements("/tmp/app.test.ts", code);
    expect(v.hasDebug).toBe(false);
  });

  test("exempts __tests__ directory", () => {
    const code = `console.log('in tests')`;
    const v = detectDebugStatements("/tmp/__tests__/foo.ts", code);
    expect(v.hasDebug).toBe(false);
  });

  test("exempts scripts/bin/ folder", () => {
    const code = `console.log('running');`;
    const v = detectDebugStatements("/tmp/scripts/deploy.ts", code);
    expect(v.hasDebug).toBe(false);
  });

  test("exempts examples/ folder", () => {
    const code = `print("example output")`;
    const v = detectDebugStatements("/tmp/examples/hello.py", code);
    expect(v.hasDebug).toBe(false);
  });

  test("does NOT flag Python code in a .ts file (wrong extension)", () => {
    const code = `print("this is actually a JS-style string")`;
    // print() only triggers for .py
    const v = detectDebugStatements("/tmp/app.ts", code);
    expect(v.hasDebug).toBe(false);
  });

  test("caps hits per pattern at 10", () => {
    const code = Array.from({ length: 25 }, () => `console.log("x");`).join("\n");
    const v = detectDebugStatements("/tmp/app.ts", code);
    // Each pattern caps at 10
    const consoleHits = v.hits.filter((h) => h.name === "console.log");
    expect(consoleHits.length).toBe(10);
  });
});

describe("buildDebugWarning", () => {
  test("lists hits with line numbers and names the exemption note", () => {
    const verdict = {
      hasDebug: true,
      hits: [
        { name: "console.log", line: 5, snippet: "console.log('hi')" },
        { name: "debugger", line: 12, snippet: "debugger;" },
      ],
    };
    const warning = buildDebugWarning(verdict);
    expect(warning).toContain("2 debug statement");
    expect(warning).toContain("console.log");
    expect(warning).toContain("line 5");
    expect(warning).toContain("debugger");
    expect(warning).toContain("non-blocking");
    expect(warning).toMatch(/tests,\s*examples/i);
  });
});
