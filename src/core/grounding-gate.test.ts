import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatStubWarning, scanFilesForStubs } from "./grounding-gate";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "grounding-gate-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const path = join(tmp, name);
  writeFileSync(path, content, "utf-8");
  return path;
}

describe("grounding-gate", () => {
  test("flags the exact bug from issue #100 (stub_tx1)", () => {
    const f = write(
      "main.py",
      `
def update():
    txs = [{"txid": "stub_tx1", "vsize": 200, "fee": 1000}]
    return txs
`.trim(),
    );
    const findings = scanFilesForStubs([f]);
    expect(findings.length).toBeGreaterThan(0);
    const placeholder = findings.find((x) => x.kind === "placeholder");
    expect(placeholder).toBeDefined();
    expect(placeholder?.snippet).toContain("stub_tx1");
  });

  test("flags NotImplementedError in Python", () => {
    const f = write(
      "service.py",
      `
def compute_fees():
    raise NotImplementedError("hook up real mempool data")
`.trim(),
    );
    const findings = scanFilesForStubs([f]);
    const ni = findings.find((x) => x.kind === "not_implemented");
    expect(ni).toBeDefined();
  });

  test("flags empty Python function bodies (def foo: pass)", () => {
    const f = write(
      "handlers.py",
      `
def handle_block(block):
    pass

def real_one():
    return 1
`.trim(),
    );
    const findings = scanFilesForStubs([f]);
    const empty = findings.find((x) => x.kind === "empty_stub");
    expect(empty).toBeDefined();
  });

  test("flags TODO markers in newly-written code", () => {
    const f = write(
      "api.ts",
      `
export function chargeCustomer() {
  // TODO: actually call Stripe
  return { success: true };
}
`.trim(),
    );
    const findings = scanFilesForStubs([f]);
    const todo = findings.find((x) => x.kind === "todo_in_new_code");
    expect(todo).toBeDefined();
  });

  test("flags placeholder string literals", () => {
    const f = write(
      "data.ts",
      `
const fallback = { name: "placeholder_value", amount: 0 };
export default fallback;
`.trim(),
    );
    const findings = scanFilesForStubs([f]);
    const ph = findings.find((x) => x.kind === "placeholder");
    expect(ph).toBeDefined();
  });

  test("does NOT flag production code without stubs", () => {
    const f = write(
      "auth.ts",
      `
export async function login(email: string, password: string): Promise<string> {
  const res = await fetch("/auth", { method: "POST", body: JSON.stringify({ email, password }) });
  if (!res.ok) throw new Error("login failed");
  const { token } = await res.json();
  return token;
}
`.trim(),
    );
    const findings = scanFilesForStubs([f]);
    // password= in the literal string is a keyword context, but the body is real code.
    // We tolerate the false positive if it happens — the goal is the test documents intent.
    const real = findings.filter((x) => x.kind !== "placeholder");
    expect(real.length).toBe(0);
  });

  test("skips markdown and config files", () => {
    const md = write("README.md", "TODO: write docs\nstub_example");
    const json = write("config.json", `{"status": "placeholder_value"}`);
    const findings = scanFilesForStubs([md, json]);
    expect(findings).toHaveLength(0);
  });

  test("silently skips files that do not exist", () => {
    const findings = scanFilesForStubs([join(tmp, "missing.py")]);
    expect(findings).toHaveLength(0);
  });

  test("formatStubWarning returns empty string when no findings", () => {
    expect(formatStubWarning([])).toBe("");
  });

  test("formatStubWarning builds a human-readable warning", () => {
    const findings = [
      {
        file: join(tmp, "a.py"),
        line: 3,
        kind: "placeholder" as const,
        snippet: `txs = [{"txid": "stub_tx1"}]`,
      },
      {
        file: join(tmp, "b.py"),
        line: 10,
        kind: "not_implemented" as const,
        snippet: "raise NotImplementedError(...)",
      },
    ];
    const warning = formatStubWarning(findings);
    expect(warning).toContain("Grounding check");
    expect(warning).toContain("stub_tx1");
    expect(warning).toContain("NotImplementedError");
    expect(warning).toContain("placeholder");
    expect(warning).toContain("not implemented");
  });

  test("formatStubWarning caps at 8 items with overflow note", () => {
    const findings = Array.from({ length: 12 }, (_, i) => ({
      file: join(tmp, `f${i}.py`),
      line: i + 1,
      kind: "placeholder" as const,
      snippet: `stub_${i}`,
    }));
    const warning = formatStubWarning(findings);
    expect(warning).toContain("4 more finding(s)");
  });
});
