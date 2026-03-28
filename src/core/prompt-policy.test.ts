// KCode - Prompt Policy & Truncation Path Tests
// Validates: no-tools policy, language matching, and truncation on tool_use stopReason

import { describe, test, expect } from "bun:test";
import { SystemPromptBuilder } from "./system-prompt";
import { looksIncomplete, looksTheoretical, detectLanguage } from "./conversation";
import type { KCodeConfig } from "./types";

// ─── Minimal config for prompt generation ───────────────────────

function minConfig(overrides?: Partial<KCodeConfig>): KCodeConfig {
  return {
    model: "test-model",
    maxTokens: 4096,
    systemPrompt: "",
    workingDirectory: "/tmp/test-project",
    permissionMode: "ask",
    version: "1.4.0",
    ...overrides,
  };
}

// ─── System Prompt Policy Sections ──────────────────────────────

describe("System prompt policy sections", () => {
  test("contains 'When NOT to use tools' section", async () => {
    const prompt = await SystemPromptBuilder.build(minConfig());
    expect(prompt).toContain("When NOT to use tools");
    expect(prompt).toContain("theoretical");
    expect(prompt).toContain("respond directly with text");
  });

  test("contains 'Respond in the user's language' section", async () => {
    const prompt = await SystemPromptBuilder.build(minConfig());
    expect(prompt).toContain("user's language");
    expect(prompt).toContain("Spanish");
  });

  test("contains workspace-scoped Glob guidance", async () => {
    const prompt = await SystemPromptBuilder.build(minConfig());
    expect(prompt).toContain("within the project workspace only");
    expect(prompt).toContain("Start with specific subdirectories");
  });

  test("contains math/formula policy for terminal", async () => {
    const prompt = await SystemPromptBuilder.build(minConfig());
    expect(prompt).toContain("Math and formulas in terminal");
    expect(prompt).toContain("Unicode first");
    expect(prompt).toContain("Do NOT write raw LaTeX");
  });
});

// ─── Truncation Detection on tool_use Path ──────────────────────

describe("looksIncomplete — tool_use path coverage", () => {
  // These simulate text that would appear before tool calls
  // where stopReason is "tool_use" but text is truncated
  const pad = (s: string) => "x".repeat(60) + " " + s;

  test("detects 'with' at end (common tool_use truncation)", () => {
    expect(looksIncomplete(pad("The algorithm works best with"))).toBe(true);
  });

  test("detects 'the' at end before tool calls", () => {
    expect(looksIncomplete(pad("I need to read the"))).toBe(true);
  });

  test("detects hyphen at end before tool calls", () => {
    expect(looksIncomplete(pad("Let me check the configura-"))).toBe(true);
  });

  test("detects open paren before tool calls", () => {
    expect(looksIncomplete(pad("The complexity is O("))).toBe(true);
  });

  test("does not trigger on clean text before tools", () => {
    expect(looksIncomplete(pad("Let me check the file."))).toBe(false);
  });

  test("does not trigger on text ending with colon (valid before tools)", () => {
    expect(looksIncomplete(pad("Here is what I found:"))).toBe(false);
  });

  test("detects 'sino' at end (Spanish continuation connector)", () => {
    expect(looksIncomplete(pad("La clave no es solo igualar stock, sino"))).toBe(true);
  });

  test("detects 'aunque' at end (Spanish concessive)", () => {
    expect(looksIncomplete(pad("El resultado es correcto, aunque"))).toBe(true);
  });

  test("detects 'porque' at end (Spanish causal)", () => {
    expect(looksIncomplete(pad("Esto funciona mejor porque"))).toBe(true);
  });

  test("detects 'not only' at end (English continuation)", () => {
    expect(looksIncomplete(pad("The strategy should consider not only"))).toBe(true);
  });

  test("detects 'however' at end (English contrast)", () => {
    expect(looksIncomplete(pad("The first approach works. However"))).toBe(true);
  });

  test("detects 'means' at end (English verb continuation)", () => {
    expect(looksIncomplete(pad("This result means"))).toBe(true);
  });
});

// ─── looksTheoretical — auto-detect formal prompts ──────────────

describe("looksTheoretical", () => {
  test("detects Spanish formal proof request", () => {
    expect(looksTheoretical("Demuestra formalmente que no existe un algoritmo")).toBe(true);
  });

  test("detects English formal proof request", () => {
    expect(looksTheoretical("Prove that the problem is reducible to reachability")).toBe(true);
  });

  test("detects transition system language", () => {
    expect(looksTheoretical("sistema de transición de estados con variables infinitas")).toBe(true);
  });

  test("detects multiple formal keywords", () => {
    expect(looksTheoretical("decidability of compaction with idempotent tool calls and equivalence")).toBe(true);
  });

  test("does not trigger on normal coding request", () => {
    expect(looksTheoretical("fix the bug in src/index.ts")).toBe(false);
  });

  test("does not trigger on simple questions", () => {
    expect(looksTheoretical("what does this function do?")).toBe(false);
  });

  test("detects the exact KCode test prompt", () => {
    const prompt = "Dado un programa arbitrario P que recibe como entrada una secuencia de tool calls con efectos secundarios sobre un filesystem, demuestra que el problema de determinar si existe una subsecuencia de compaction que preserve la equivalencia observacional del estado final del filesystem es reducible al problema de alcanzabilidad";
    expect(looksTheoretical(prompt)).toBe(true);
  });

  test("detects structured reasoning prompt with sections and tables", () => {
    const prompt = `### CONTEXTO GENERAL
Una empresa de retail opera con las siguientes condiciones:
| Producto | A | B | C |
| P1 | 10 | 0 | 5 |
#### PARTE 1 — Diagnóstico
* Identificá qué productos van a tener quiebres de stock
* Explicá el razonamiento paso a paso
#### PARTE 2 — Optimización
* Diseñá un plan de transferencias para maximizar ganancia`;
    expect(looksTheoretical(prompt)).toBe(true);
  });

  test("detects long prompt with structured sections and reasoning keywords", () => {
    const prompt = "Sos un sistema de razonamiento avanzado. " + "x ".repeat(250) + `
### TAREAS
Explicá la consistencia lógica del modelo y mostrá el diagnóstico paso a paso.`;
    expect(looksTheoretical(prompt)).toBe(true);
  });

  test("detects prompt with data tables and multiple reasoning keywords", () => {
    const prompt = `| Stock | A | B | C |
| P1 | 10 | 0 | 5 |
Analizá el trade-off entre maximizar ganancia y minimizar pérdidas.
Mostrá el razonamiento paso a paso.`;
    expect(looksTheoretical(prompt)).toBe(true);
  });

  test("does not trigger on short request mentioning tables", () => {
    expect(looksTheoretical("create a table with user data")).toBe(false);
  });

  test("does not trigger on code task with markdown headers", () => {
    expect(looksTheoretical("### TODO\nfix the login bug")).toBe(false);
  });
});

// ─── detectLanguage ─────────────────────────────────────────────

describe("detectLanguage", () => {
  test("detects Spanish", () => {
    expect(detectLanguage("Dado un programa que recibe una secuencia de tool calls sobre un filesystem")).toBe("es");
  });

  test("detects English", () => {
    expect(detectLanguage("Prove that the problem of determining reachability is undecidable")).toBe("en");
  });

  test("defaults to English for short/ambiguous text", () => {
    expect(detectLanguage("fix the bug")).toBe("en");
  });

  test("detects Spanish in the KCode test prompt", () => {
    const prompt = "Dado un programa arbitrario P que recibe como entrada una secuencia de tool calls con efectos secundarios sobre un filesystem, demuestra que el problema";
    expect(detectLanguage(prompt)).toBe("es");
  });
});
