// Phase 32 — integration tests for the phantom-typo claim guard
//
// Tests the full flow the conversation loop + tool executor use:
//   1. detectPhantomTypoClaim runs on assistant text
//   2. If a match is found, guardState.activePhantomClaim is set
//   3. tool-executor checks this field and blocks Edit/MultiEdit whose
//      old_string or new_string contains the claimed token
//   4. Unrelated Edits (different token) pass through
//
// We can't run the actual conversation.ts streaming path here (it
// pulls in ConversationManager), so we simulate the state handoff
// and assert the decision logic directly.

import { describe, expect, test } from "bun:test";
import { LoopGuardState } from "./agent-loop-guards";
import { detectPhantomTypoClaim } from "./phantom-typo-detector";

// Mirror of the block logic in tool-executor.ts — keeping this in
// sync with the real implementation is important. If the production
// code's block condition changes, update this too.
function shouldBlockEditForPhantom(
  guardState: LoopGuardState,
  toolName: "Edit" | "MultiEdit" | "Write",
  input: Record<string, unknown>,
): boolean {
  if (toolName !== "Edit" && toolName !== "MultiEdit") return false;
  const claim = guardState.activePhantomClaim;
  if (!claim) return false;

  if (toolName === "Edit") {
    const oldStr = String(input.old_string ?? "");
    const newStr = String(input.new_string ?? "");
    return oldStr.includes(claim.token) || newStr.includes(claim.token);
  }

  const edits = input.edits;
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const e = edit as Record<string, unknown>;
      const o = String(e.old_string ?? "");
      const n = String(e.new_string ?? "");
      if (o.includes(claim.token) || n.includes(claim.token)) return true;
    }
  }
  return false;
}

describe("Phase 32 — conversation loop → tool executor handoff", () => {
  test("phantom claim in assistant text blocks Edit touching the same token", () => {
    const guardState = new LoopGuardState();

    // Simulate the conversation loop path: assistant finishes
    // streaming, text is scanned, claim is stashed on guardState.
    const assistantText =
      "He analizado el código. El error es setProperty en lugar de setProperty en la línea 394. Voy a corregirlo.";
    guardState.activePhantomClaim = detectPhantomTypoClaim(assistantText);
    expect(guardState.activePhantomClaim).not.toBeNull();
    expect(guardState.activePhantomClaim!.token).toBe("setProperty");

    // Model now tries an Edit that touches the phantom token.
    // tool-executor's phase-32 block should fire.
    const editInput = {
      file_path: "/tmp/file.js",
      old_string: "element.setProperty('color', 'red')",
      new_string: "element.setProperty('color', 'red');", // trailing semicolon
    };
    expect(shouldBlockEditForPhantom(guardState, "Edit", editInput)).toBe(true);
  });

  test("phantom claim does NOT block an Edit on an unrelated token", () => {
    const guardState = new LoopGuardState();
    guardState.activePhantomClaim = detectPhantomTypoClaim(
      "He visto getContext en lugar de getContext, pero el bug real es otro",
    );
    expect(guardState.activePhantomClaim).not.toBeNull();

    // Edit touches a completely different area — should pass through
    const editInput = {
      file_path: "/tmp/file.js",
      old_string: "const x = 1;",
      new_string: "const x = 2;",
    };
    expect(shouldBlockEditForPhantom(guardState, "Edit", editInput)).toBe(false);
  });

  test("phantom claim blocks MultiEdit when any sub-edit touches the token", () => {
    const guardState = new LoopGuardState();
    guardState.activePhantomClaim = detectPhantomTypoClaim(
      "Voy a cambiar renderChart en lugar de renderChart",
    );
    expect(guardState.activePhantomClaim).not.toBeNull();

    const multiEditInput = {
      file_path: "/tmp/file.js",
      edits: [
        { old_string: "const x = 1;", new_string: "const x = 2;" }, // unrelated
        {
          old_string: "this.renderChart(data)",
          new_string: "this.renderChart(data);",
        }, // touches phantom token
      ],
    };
    expect(shouldBlockEditForPhantom(guardState, "MultiEdit", multiEditInput)).toBe(true);
  });

  test("phantom claim does NOT block MultiEdit when no sub-edit touches the token", () => {
    const guardState = new LoopGuardState();
    guardState.activePhantomClaim = detectPhantomTypoClaim(
      "vi drawChart en lugar de drawChart pero voy a tocar otra cosa",
    );
    expect(guardState.activePhantomClaim).not.toBeNull();

    const multiEditInput = {
      file_path: "/tmp/file.js",
      edits: [
        { old_string: "const x = 1;", new_string: "const x = 2;" },
        { old_string: "const y = 3;", new_string: "const y = 4;" },
      ],
    };
    expect(shouldBlockEditForPhantom(guardState, "MultiEdit", multiEditInput)).toBe(false);
  });

  test("no claim means no block (happy path)", () => {
    const guardState = new LoopGuardState();
    // Assistant text has no phantom claim
    guardState.activePhantomClaim = detectPhantomTypoClaim(
      "He leído el archivo. El bug está en la línea 394, faltaba un punto y coma.",
    );
    expect(guardState.activePhantomClaim).toBeNull();

    const editInput = {
      file_path: "/tmp/file.js",
      old_string: "const x = 1",
      new_string: "const x = 1;",
    };
    expect(shouldBlockEditForPhantom(guardState, "Edit", editInput)).toBe(false);
  });

  test("Write is never blocked by phase 32 (phase 31 handles Write escapes)", () => {
    const guardState = new LoopGuardState();
    guardState.activePhantomClaim = detectPhantomTypoClaim(
      "setProperty en lugar de setProperty",
    );
    expect(guardState.activePhantomClaim).not.toBeNull();

    // Phase 32 targets Edit/MultiEdit only. Write is handled by phase
    // 31's rewrite-escape guard.
    const writeInput = {
      file_path: "/tmp/file.js",
      content: "whatever",
    };
    expect(shouldBlockEditForPhantom(guardState, "Write", writeInput)).toBe(false);
  });

  test("claim survives until the next scan overrides it", () => {
    const guardState = new LoopGuardState();

    // Turn 1 — phantom claim detected
    guardState.activePhantomClaim = detectPhantomTypoClaim(
      "reverse en lugar de reverse",
    );
    expect(guardState.activePhantomClaim).not.toBeNull();
    expect(guardState.activePhantomClaim!.token).toBe("reverse");

    // Turn 2 — clean assistant text → claim cleared
    guardState.activePhantomClaim = detectPhantomTypoClaim(
      "Ahora sí veo el problema real, voy a hacer el fix correcto.",
    );
    expect(guardState.activePhantomClaim).toBeNull();

    // Subsequent Edit touching "reverse" should pass — stale claim gone
    expect(
      shouldBlockEditForPhantom(guardState, "Edit", {
        old_string: "array.reverse()",
        new_string: "array.reverse().map(x => x)",
      }),
    ).toBe(false);
  });

  test("NEXUS mark6 canonical failure sequence — all three phantoms", () => {
    const guardState = new LoopGuardState();

    // Assistant text from the actual mark6 log (~line 1165-1170):
    const markSixText = `He analizado el código y he encontrado el problema. El servicio aparece como "caído" o no se inicia porque hay tres errores tipográficos críticos en el JavaScript que detienen la ejecución del script antes de que la aplicación pueda renderizarse.
Los errores son:
 1. setProperty en lugar de setProperty (Línea 394).
 2. getContext en lugar de getContext (Líneas 653 y 669).
 3. reverse en lugar de reverse (Línea 750).
Voy a corregir estos errores inmediatamente para que el sistema inicie correctamente.`;

    guardState.activePhantomClaim = detectPhantomTypoClaim(markSixText);
    expect(guardState.activePhantomClaim).not.toBeNull();
    // Detector picks the FIRST phantom phrase in order — setProperty
    expect(guardState.activePhantomClaim!.token).toBe("setProperty");

    // The Edit mark6 actually tried — would now be blocked
    const editInput = {
      file_path: "/home/curly/projects/nexus_telemetry.html",
      old_string: "setProperty('--nasa-blue', '#0B3D91')",
      new_string: "setProperty('--nasa-blue', '#0B3D91');",
    };
    expect(shouldBlockEditForPhantom(guardState, "Edit", editInput)).toBe(true);
  });
});
