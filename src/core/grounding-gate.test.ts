import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  countFilesOnDisk,
  detectAuthClaim,
  detectCreationClaimMismatch,
  detectStrongCompletionClaim,
  formatAuthClaimWarning,
  formatClaimMismatchWarning,
  formatStrongCompletionWarning,
  formatStubWarning,
  scanFilesForStubs,
} from "./grounding-gate";

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

  // ─── Creation claim mismatch (2026-04-23 Bitcoin TUI pattern) ──

  test("detects the EXACT 2026-04-23 phrase 'Proyecto X creado en /path'", () => {
    const finalText =
      "Proyecto Bitcoin TUI Dashboard creado en /home/curly/proyectos/bitcoin-tui-dashboard. Incluye venv con Textual.";
    const mismatch = detectCreationClaimMismatch(finalText, 0);
    expect(mismatch).not.toBeNull();
    expect(mismatch?.snippet).toMatch(/creado/i);
  });

  test("detects 'ha sido creado' when 0 files written", () => {
    const finalText = "El proyecto Bitcoin TUI Dashboard ha sido creado en /home/curly/proyectos/…";
    const mismatch = detectCreationClaimMismatch(finalText, 0);
    expect(mismatch).not.toBeNull();
    expect(mismatch?.snippet).toContain("ha sido creado");
    expect(mismatch?.filesWritten).toBe(0);
  });

  test("detects English 'has been created'", () => {
    const mismatch = detectCreationClaimMismatch("The project has been created successfully", 0);
    expect(mismatch).not.toBeNull();
  });

  test("detects 'proyecto creado'", () => {
    const mismatch = detectCreationClaimMismatch("Proyecto creado. Corré el comando…", 0);
    expect(mismatch).not.toBeNull();
  });

  test("detects 'successfully created'", () => {
    const mismatch = detectCreationClaimMismatch("I've successfully created the dashboard", 0);
    expect(mismatch).not.toBeNull();
  });

  test("does NOT trigger when files were actually written", () => {
    const finalText = "El proyecto ha sido creado en /tmp/foo";
    expect(detectCreationClaimMismatch(finalText, 1)).toBeNull();
    expect(detectCreationClaimMismatch(finalText, 5)).toBeNull();
  });

  test("does NOT trigger on analysis-only responses", () => {
    const finalText = "I analyzed the codebase and found no bugs in critical paths";
    expect(detectCreationClaimMismatch(finalText, 0)).toBeNull();
  });

  test("does NOT trigger on empty text", () => {
    expect(detectCreationClaimMismatch("", 0)).toBeNull();
    expect(detectCreationClaimMismatch("   \n  \n", 0)).toBeNull();
  });

  test("countFilesOnDisk ignores paths that don't exist (blocked writes)", () => {
    const existing = write("real.py", "print('hi')");
    const blocked = join(tmp, "blocked-README.md"); // never created
    expect(countFilesOnDisk([existing, blocked])).toBe(1);
    expect(countFilesOnDisk([blocked])).toBe(0);
    expect(countFilesOnDisk([])).toBe(0);
  });

  test("creation claim fires when all writes were blocked (none exist on disk)", () => {
    // Simulate the 2026-04-23 Bitcoin TUI turn:
    // Write README.md → blocked. No real files landed.
    const blockedPath = join(tmp, "bitcoin-tui", "README.md");
    const actualCount = countFilesOnDisk([blockedPath]);
    expect(actualCount).toBe(0);
    const finalText =
      "Proyecto Bitcoin TUI Dashboard creado en /home/curly/proyectos/bitcoin-tui-dashboard.";
    expect(detectCreationClaimMismatch(finalText, actualCount)).not.toBeNull();
  });

  test("creation claim does NOT fire when real file landed on disk", () => {
    const real = write("main.py", "def main(): pass");
    const count = countFilesOnDisk([real]);
    expect(count).toBe(1);
    const finalText = "Proyecto creado en /tmp/foo";
    expect(detectCreationClaimMismatch(finalText, count)).toBeNull();
  });

  test("formatClaimMismatchWarning produces readable message", () => {
    const mismatch = {
      snippet: "ha sido creado en /home/curly/proyectos/bitcoin-tui",
      filesWritten: 0,
    };
    const warning = formatClaimMismatchWarning(mismatch);
    expect(warning).toContain("Grounding check");
    expect(warning).toContain("zero files were written");
    expect(warning).toContain("ha sido creado");
    expect(warning).toContain("Do not present this turn as complete");
  });

  // ─── Auth claim detection (issue #101) ────────────────────────

  test("detects the EXACT 2026-04-23 phrase '(sin auth, como funciona)'", () => {
    const finalText =
      "Conecta al RPC de tu nodo en localhost:8332 (sin auth, como funciona).";
    const finding = detectAuthClaim(finalText);
    expect(finding).not.toBeNull();
    expect(finding?.snippet).toMatch(/sin auth/i);
  });

  test("detects 'no authentication required' in English", () => {
    const finalText = "The RPC is reachable (no auth required) from this host.";
    expect(detectAuthClaim(finalText)).not.toBeNull();
  });

  test("detects 'RPC abierto'", () => {
    const finalText = "El nodo tiene RPC abierto en el puerto 8332.";
    expect(detectAuthClaim(finalText)).not.toBeNull();
  });

  test("detects 'sin credenciales'", () => {
    const finalText = "Se puede llamar al nodo sin credenciales directamente.";
    expect(detectAuthClaim(finalText)).not.toBeNull();
  });

  test("detects 'without a password'", () => {
    const finalText = "Connects without a password since it's localhost-only";
    expect(detectAuthClaim(finalText)).not.toBeNull();
  });

  test("does NOT trigger on neutral wording 'accesible desde este host'", () => {
    const finalText = "RPC accesible desde este host. Authentication mode not yet confirmed.";
    expect(detectAuthClaim(finalText)).toBeNull();
  });

  test("does NOT trigger on empty text", () => {
    expect(detectAuthClaim("")).toBeNull();
  });

  test("formatAuthClaimWarning mentions the risk explicitly", () => {
    const finding = { snippet: "(sin auth, como funciona)", rule: "..." };
    const warning = formatAuthClaimWarning(finding);
    expect(warning).toContain("Grounding check");
    expect(warning).toContain("sin auth");
    expect(warning).toMatch(/does not prove|Successful local/i);
  });

  // ─── Strong completion claims (issue #102) ────────────────────

  test("detects the EXACT 2026-04-23 phrase 'Proyecto X completado'", () => {
    const finalText =
      "Proyecto Bitcoin TUI Dashboard completado — listo para analizar la blockchain de Bitcoin en tiempo real.";
    const broadUserPrompt =
      "quiero ver bloques, transacciones, y mucho mas en vivo, o sea, analizar completamente la blockchain";
    const finding = detectStrongCompletionClaim(finalText, broadUserPrompt);
    expect(finding).not.toBeNull();
    expect(finding?.snippet).toMatch(/completado|listo para/i);
    expect(finding?.broadRequest).toBe(true);
  });

  test("detects 'listo para producción'", () => {
    const finding = detectStrongCompletionClaim(
      "Implementación lista para producción.",
      "hazlo",
    );
    expect(finding).not.toBeNull();
    expect(finding?.broadRequest).toBe(false);
  });

  test("detects English 'production-ready'", () => {
    expect(detectStrongCompletionClaim("The app is production-ready.", "hi")).not.toBeNull();
  });

  test("detects 'works perfectly'", () => {
    expect(detectStrongCompletionClaim("Everything works perfectly end-to-end.", "fix")).not.toBeNull();
  });

  test("detects 'fully functional'", () => {
    expect(detectStrongCompletionClaim("The dashboard is fully functional now.", "")).not.toBeNull();
  });

  test("does NOT trigger on MVP/scope-honest wording", () => {
    expect(
      detectStrongCompletionClaim("Created an initial MVP of the dashboard.", "build me X"),
    ).toBeNull();
    expect(
      detectStrongCompletionClaim("First pass implementation of block viewer.", "build me X"),
    ).toBeNull();
  });

  test("does NOT trigger on empty text", () => {
    expect(detectStrongCompletionClaim("", "anything")).toBeNull();
  });

  test("broadRequest flag fires on 'analizar completamente'", () => {
    const f = detectStrongCompletionClaim("proyecto completado", "quiero analizar completamente");
    expect(f?.broadRequest).toBe(true);
  });

  test("broadRequest flag fires on 'end-to-end'", () => {
    const f = detectStrongCompletionClaim(
      "production-ready",
      "build an end-to-end monitoring solution",
    );
    expect(f?.broadRequest).toBe(true);
  });

  test("formatStrongCompletionWarning escalates on broad-scope request", () => {
    const broadFinding = { snippet: "proyecto completado", broadRequest: true };
    const narrowFinding = { snippet: "proyecto completado", broadRequest: false };
    expect(formatStrongCompletionWarning(broadFinding)).toContain("broad-scope");
    expect(formatStrongCompletionWarning(narrowFinding)).not.toContain("broad-scope");
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
