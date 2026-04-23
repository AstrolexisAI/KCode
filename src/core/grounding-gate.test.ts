import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  countFilesOnDisk,
  detectAuthClaim,
  detectCreationClaimMismatch,
  detectPatchWithoutRerun,
  detectReadinessAfterErrors,
  detectStrongCompletionClaim,
  formatAuthClaimWarning,
  formatClaimMismatchWarning,
  formatPatchWithoutRerunWarning,
  formatReadinessContradictionWarning,
  formatStrongCompletionWarning,
  formatStubWarning,
  scanFilesForStubs,
  type ToolEvent,
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

  // ─── Readiness claim contradicting errors (issue #103) ────────

  test("detects the EXACT 2026-04-23 phrase 'app.py is ready' after errors", () => {
    const finalText = "The main application script (app.py) is ready. Run it with python3 app.py.";
    const finding = detectReadinessAfterErrors(finalText, 1, false);
    expect(finding).not.toBeNull();
    expect(finding?.snippet).toMatch(/ready/i);
    expect(finding?.errorCount).toBe(1);
  });

  test("detects readiness claim when only repair was blocked", () => {
    const finalText = "The dashboard displays real-time stats.";
    const finding = detectReadinessAfterErrors(finalText, 0, true);
    expect(finding).not.toBeNull();
    expect(finding?.repairBlocked).toBe(true);
  });

  test("detects 'muestra en tiempo real' with errors", () => {
    expect(
      detectReadinessAfterErrors("La app muestra en tiempo real las transacciones.", 2, false),
    ).not.toBeNull();
  });

  test("detects 'Run it with python3 app.py'", () => {
    expect(
      detectReadinessAfterErrors("Run it with: python3 /tmp/app.py", 1, false),
    ).not.toBeNull();
  });

  test("detects 'el dashboard muestra'", () => {
    expect(
      detectReadinessAfterErrors("El dashboard muestra bloques en vivo.", 1, false),
    ).not.toBeNull();
  });

  test("does NOT fire when no errors and nothing blocked", () => {
    expect(
      detectReadinessAfterErrors("The app is ready to use.", 0, false),
    ).toBeNull();
  });

  test("does NOT fire on honest partial wording", () => {
    expect(
      detectReadinessAfterErrors(
        "Created the initial skeleton, but the app is not ready — runtime validation failed.",
        1,
        true,
      ),
    ).toBeNull();
  });

  test("formatReadinessContradictionWarning mentions error count and block", () => {
    const finding = { snippet: "app is ready", errorCount: 2, repairBlocked: true };
    const warning = formatReadinessContradictionWarning(finding);
    expect(warning).toContain("Grounding check");
    expect(warning).toContain("2 tool error");
    expect(warning).toContain("repair attempt");
    expect(warning).toContain("blocked");
  });

  test("formatReadinessContradictionWarning omits unused fields", () => {
    const errorsOnly = { snippet: "ready", errorCount: 1, repairBlocked: false };
    expect(formatReadinessContradictionWarning(errorsOnly)).not.toContain("repair attempt");
    const blockOnly = { snippet: "ready", errorCount: 0, repairBlocked: true };
    expect(formatReadinessContradictionWarning(blockOnly)).not.toContain("tool error");
  });

  // ─── Patch-without-rerun detection (issue #104) ───────────────

  test("detects the EXACT 2026-04-23 sequence: python fail → GrepReplace → no rerun → success claim", () => {
    const events: ToolEvent[] = [
      { name: "Bash", isError: false, summary: "mkdir -p /tmp/app" },
      { name: "Bash", isError: false, summary: "pip install rich" },
      { name: "Write", isError: false, summary: "/tmp/app/app.py" },
      { name: "Bash", isError: true, summary: "python3 app.py" }, // ran_failed
      { name: "Edit", isError: true, summary: "/tmp/app/app.py" },   // blocked
      {
        name: "GrepReplace",
        isError: false,
        summary: "pattern=except JSONRPCException → except Exception",
      }, // patched
      // No subsequent python3 call
    ];
    const finalText =
      "He creado el proyecto del dashboard TUI para Bitcoin. Incluye un script que conecta al nodo y mostrará los datos en vivo.";
    const finding = detectPatchWithoutRerun(events, finalText);
    expect(finding).not.toBeNull();
    expect(finding?.failingCommand).toContain("python3");
    expect(finding?.patchAction).toContain("GrepReplace");
    expect(finding?.claimSnippet).toMatch(/conecta|mostrará|creado/i);
  });

  test("does NOT fire if rerun succeeded after patch", () => {
    const events: ToolEvent[] = [
      { name: "Bash", isError: true, summary: "python3 app.py" },
      { name: "Edit", isError: false, summary: "app.py" },
      { name: "Bash", isError: false, summary: "python3 app.py" }, // rerun passed
    ];
    expect(detectPatchWithoutRerun(events, "works great")).toBeNull();
  });

  test("does NOT fire without a runtime failure in the chain", () => {
    const events: ToolEvent[] = [
      { name: "Write", isError: false, summary: "app.py" },
      { name: "Edit", isError: false, summary: "app.py" },
    ];
    expect(detectPatchWithoutRerun(events, "created the app, ready to use")).toBeNull();
  });

  test("counts bash sed -i as a patch (not just Edit/Write)", () => {
    const events: ToolEvent[] = [
      { name: "Bash", isError: true, summary: "node server.js" },
      { name: "Bash", isError: false, summary: "sed -i 's/foo/bar/' server.js" },
    ];
    const finding = detectPatchWithoutRerun(events, "El servidor corre y muestra logs.");
    expect(finding).not.toBeNull();
    expect(finding?.patchAction).toContain("Bash");
  });

  test("ignores non-mutation bash after failure", () => {
    const events: ToolEvent[] = [
      { name: "Bash", isError: true, summary: "python3 app.py" },
      { name: "Bash", isError: false, summary: "ls -la" }, // not a mutation
    ];
    // Even if final text claims success, without a real patch the check doesn't fire.
    expect(detectPatchWithoutRerun(events, "app is ready")).toBeNull();
  });

  test("does NOT fire on neutral response wording", () => {
    const events: ToolEvent[] = [
      { name: "Bash", isError: true, summary: "python3 app.py" },
      { name: "GrepReplace", isError: false, summary: "pattern" },
    ];
    const neutralText =
      "Applied a patch to exception handling. I did not rerun the app, so functionality is not yet verified.";
    expect(detectPatchWithoutRerun(events, neutralText)).toBeNull();
  });

  test("formatPatchWithoutRerunWarning explains the chain", () => {
    const finding = {
      failingCommand: "python3 app.py",
      patchAction: "GrepReplace: pattern=except X → except Y",
      claimSnippet: "mostrará los datos en vivo",
    };
    const w = formatPatchWithoutRerunWarning(finding);
    expect(w).toContain("runtime failed");
    expect(w).toContain("patch was applied");
    expect(w).toContain("rerun");
    expect(w).toContain("python3 app.py");
    expect(w).toContain("GrepReplace");
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
