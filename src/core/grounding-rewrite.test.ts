// Tests for grounding-rewrite (issue #111 v305, overclaim prevention).

import { describe, expect, it } from "bun:test";
import { enforceEvidenceFloor, rewriteFinalTextForGrounding } from "./grounding-rewrite";
import type { TaskScope } from "./task-scope";

function scopePartial(): TaskScope {
  return {
    phase: "partial",
    sessionPrompt: "",
    userInstructions: [],
    goals: [],
    subgoals: [],
    projectRoot: { path: "", status: "unknown" },
    verification: {
      filesWritten: [],
      filesEdited: [],
      runtimeCommands: [],
      packageManagerOps: [],
      rerunAttempts: 0,
    },
    completion: {
      mayClaimReady: false,
      mayClaimImplemented: false,
      mustUsePartialLanguage: true,
    },
    reasons: [],
    commitments: [],
    // biome-ignore lint/suspicious/noExplicitAny: TaskScope has more fields but tests only set what's needed
  } as any;
}

function scopeHealthy(): TaskScope {
  return {
    phase: "done",
    sessionPrompt: "",
    userInstructions: [],
    goals: [],
    subgoals: [],
    projectRoot: { path: "", status: "verified" },
    verification: {
      filesWritten: [],
      filesEdited: [],
      runtimeCommands: [],
      packageManagerOps: [],
      rerunAttempts: 0,
    },
    completion: {
      mayClaimReady: true,
      mayClaimImplemented: true,
      mustUsePartialLanguage: false,
    },
    reasons: [],
    commitments: [],
    // biome-ignore lint/suspicious/noExplicitAny: TaskScope has more fields but tests only set what's needed
  } as any;
}

describe("rewriteFinalTextForGrounding — partial scope", () => {
  it("softens 'visión profunda' → 'lectura inicial'", () => {
    const draft = "Ahora tengo una visión profunda del proyecto ogma-core.";
    const rw = rewriteFinalTextForGrounding(draft, scopePartial());
    expect(rw.replacements).toBeGreaterThan(0);
    expect(rw.text).not.toContain("visión profunda");
    expect(rw.text).toContain("lectura inicial");
  });

  it("softens 'listo.' → 'revisión inicial.'", () => {
    const draft = "Escaneé los archivos. Listo. Aquí está el análisis.";
    const rw = rewriteFinalTextForGrounding(draft, scopePartial());
    expect(rw.text.toLowerCase()).not.toMatch(/\blisto\b/);
  });

  it("softens 'deep understanding' → 'initial reading'", () => {
    const draft = "I now have a deep understanding of the architecture.";
    const rw = rewriteFinalTextForGrounding(draft, scopePartial());
    expect(rw.text).not.toContain("deep understanding");
    expect(rw.text.toLowerCase()).toContain("initial reading");
  });

  it("softens 'is ready' → 'has a partial scaffold'", () => {
    const draft = "The project is ready to use.";
    const rw = rewriteFinalTextForGrounding(draft, scopePartial());
    expect(rw.text).not.toContain("is ready");
    expect(rw.text).toContain("has a partial scaffold");
  });

  it("softens 'está funcional' → 'fue revisado parcialmente'", () => {
    const draft = "El módulo está funcional.";
    const rw = rewriteFinalTextForGrounding(draft, scopePartial());
    expect(rw.text).not.toContain("está funcional");
  });

  it("reports replacement reasons for telemetry", () => {
    const draft = "Ahora tengo una visión profunda. El proyecto está completo. Listo.";
    const rw = rewriteFinalTextForGrounding(draft, scopePartial());
    expect(rw.replacements).toBeGreaterThanOrEqual(2);
    expect(rw.reasons.length).toBeGreaterThanOrEqual(2);
  });
});

describe("rewriteFinalTextForGrounding — healthy scope", () => {
  it("is a no-op on phase=done + mayClaimReady=true", () => {
    const draft = "Ahora tengo una visión profunda del módulo.";
    const rw = rewriteFinalTextForGrounding(draft, scopeHealthy());
    expect(rw.replacements).toBe(0);
    expect(rw.text).toBe(draft);
  });
});

describe("enforceEvidenceFloor", () => {
  it("prepends a disclaimer when architectural claims are made with <5 source reads", () => {
    const draft =
      "La arquitectura del sistema se basa en 3 módulos principales con responsabilidades bien definidas.";
    const result = enforceEvidenceFloor(draft, 2, 5);
    expect(result.underfloor).toBe(true);
    expect(result.text).toContain("Initial reading");
    expect(result.text).toContain("2 source file");
  });

  it("does not annotate when reads meet or exceed the floor", () => {
    const draft = "La arquitectura es clara: 3 módulos principales.";
    const result = enforceEvidenceFloor(draft, 7, 5);
    expect(result.underfloor).toBe(false);
    expect(result.text).toBe(draft);
  });

  it("does not annotate non-architectural text even with low reads", () => {
    const draft = "Hola, ¿cómo estás?";
    const result = enforceEvidenceFloor(draft, 0, 5);
    expect(result.underfloor).toBe(false);
    expect(result.text).toBe(draft);
  });

  it("recognizes English architectural markers", () => {
    const draft =
      "The module architecture is split into 3 responsibilities with clear design decisions.";
    const result = enforceEvidenceFloor(draft, 1, 5);
    expect(result.underfloor).toBe(true);
  });
});

describe("idempotence", () => {
  it("running rewrite twice does not further change output", () => {
    const draft = "Ahora tengo una visión profunda del sistema.";
    const first = rewriteFinalTextForGrounding(draft, scopePartial());
    const second = rewriteFinalTextForGrounding(first.text, scopePartial());
    expect(second.text).toBe(first.text);
    expect(second.replacements).toBe(0);
  });
});
