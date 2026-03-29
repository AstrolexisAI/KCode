// KCode - Prompt Policy & Truncation Path Tests
// Validates: no-tools policy, language matching, and truncation on tool_use stopReason

import { describe, test, expect } from "bun:test";
import { SystemPromptBuilder } from "./system-prompt";
import { looksIncomplete, looksTheoretical, looksCheckpointed, dedupContinuation, detectLanguage } from "./conversation";
import { LoopGuardState } from "./agent-loop-guards";
import { classifyToolCoherence } from "../tools/plan";
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

  test("detects short post-tool truncation ending with 'en'", () => {
    expect(looksIncomplete("Para ver los cambios, abre ese URL en")).toBe(true);
  });

  test("detects short truncation ending mid-word", () => {
    expect(looksIncomplete("Ahora voy a verificar que todo funcione co")).toBe(true);
  });

  test("does not trigger on intentionally short complete sentence", () => {
    expect(looksIncomplete("Done.")).toBe(false);
  });

  test("does not trigger on very short text below 10 chars", () => {
    expect(looksIncomplete("OK")).toBe(false);
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

// ─── looksCheckpointed — scope checkpoint detection ─────────────

describe("looksCheckpointed", () => {
  test("detects 'primer paso' (Spanish)", () => {
    expect(looksCheckpointed("Crea el proyecto y muéstrame el primer paso")).toBe(true);
  });

  test("detects 'first step' (English)", () => {
    expect(looksCheckpointed("Create the project and show me the first step")).toBe(true);
  });

  test("detects 'estructura inicial'", () => {
    expect(looksCheckpointed("Solo la estructura inicial por ahora")).toBe(true);
  });

  test("detects 'show me when done'", () => {
    expect(looksCheckpointed("Build the base and show me when done")).toBe(true);
  });

  test("detects 'haz primero'", () => {
    expect(looksCheckpointed("Haz primero la base del proyecto")).toBe(true);
  });

  test("detects 'empieza con...muéstrame'", () => {
    expect(looksCheckpointed("Empieza con la estructura y muéstrame el resultado")).toBe(true);
  });

  test("does not trigger on normal request", () => {
    expect(looksCheckpointed("Create a complete website with all pages")).toBe(false);
  });

  test("does not trigger on simple question", () => {
    expect(looksCheckpointed("How do I install Next.js?")).toBe(false);
  });
});

// ─── Error fingerprinting — retry discipline ────────────────────

describe("LoopGuardState error fingerprinting", () => {
  test("first error is not burned", () => {
    const g = new LoopGuardState();
    const burned = g.recordToolError("Write", "embedding HTML inside TypeScript");
    expect(burned).toBe(false);
  });

  test("second identical error is burned", () => {
    const g = new LoopGuardState();
    g.recordToolError("Write", "embedding HTML inside TypeScript");
    const burned = g.recordToolError("Write", "embedding HTML inside TypeScript");
    expect(burned).toBe(true);
  });

  test("burned fingerprint is detected via isErrorBurned", () => {
    const g = new LoopGuardState();
    g.recordToolError("Write", "embedding HTML inside TypeScript");
    g.recordToolError("Write", "embedding HTML inside TypeScript");
    expect(g.isErrorBurned("Write", "embedding HTML inside TypeScript")).toBe(true);
  });

  test("different errors are tracked independently", () => {
    const g = new LoopGuardState();
    g.recordToolError("Write", "embedding HTML inside TypeScript");
    const burned = g.recordToolError("Write", "Permission denied: /etc/shadow");
    expect(burned).toBe(false);
  });

  test("normalizes paths in fingerprints", () => {
    const g = new LoopGuardState();
    g.recordToolError("Write", "cannot write to /home/curly/project/file.tsx");
    const burned = g.recordToolError("Write", "cannot write to /home/other/different/file.tsx");
    expect(burned).toBe(true); // Both normalize to "cannot write to <path>"
  });
});

// ─── classifyToolCoherence — plan vs execution ──────────────────

describe("classifyToolCoherence", () => {
  test("setup step + scaffold command = ok", () => {
    expect(classifyToolCoherence("Bash", { command: "bun create next-app my-project" }, "Initialize project setup")).toBe("ok");
  });

  test("setup step + npm install = ok", () => {
    expect(classifyToolCoherence("Bash", { command: "npm install tailwindcss" }, "Set up project structure")).toBe("ok");
  });

  test("setup step + writing config = ok", () => {
    expect(classifyToolCoherence("Write", { file_path: "/project/tailwind.config.ts" }, "Configure project setup")).toBe("ok");
  });

  test("setup step + writing page component = warn", () => {
    expect(classifyToolCoherence("Write", { file_path: "/project/app/about/page.tsx" }, "Initialize project setup")).toBe("warn");
  });

  test("git step + git command = ok", () => {
    expect(classifyToolCoherence("Bash", { command: "git add -A && git commit -m 'init'" }, "Git commit and push")).toBe("ok");
  });

  test("git step + writing new files = block", () => {
    expect(classifyToolCoherence("Write", { file_path: "/project/components/Hero.tsx" }, "Final git commit")).toBe("block");
  });

  test("build page step + Write component = ok", () => {
    expect(classifyToolCoherence("Write", { file_path: "/project/components/Hero.tsx" }, "Build Home/Landing page with hero")).toBe("ok");
  });

  test("test/verify step + Bash = ok", () => {
    expect(classifyToolCoherence("Bash", { command: "bun test" }, "Verify and test the project")).toBe("ok");
  });

  test("test/verify step + Write = warn", () => {
    expect(classifyToolCoherence("Write", { file_path: "/project/app/page.tsx" }, "Test and validate")).toBe("warn");
  });

  test("docs step + Write .md = ok", () => {
    expect(classifyToolCoherence("Write", { file_path: "/project/README.md" }, "Create documentation and README")).toBe("ok");
  });

  test("docs step + Write .tsx = warn", () => {
    expect(classifyToolCoherence("Write", { file_path: "/project/app/page.tsx" }, "Update documentation")).toBe("warn");
  });

  test("finalize step + Edit code = block", () => {
    expect(classifyToolCoherence("Edit", { file_path: "/project/app/page.tsx" }, "Finalize and polish")).toBe("block");
  });

  test("unclassified step = ok (default)", () => {
    expect(classifyToolCoherence("Bash", { command: "echo test" }, "Something custom")).toBe("ok");
  });
});

// ─── dedupContinuation — line and char level dedup ──────────────

describe("dedupContinuation", () => {
  test("strips repeated paragraph from continuation", () => {
    const tail = "Line one of the conclusion.\nLine two of the conclusion.\nFinal sentence of the section.";
    const continuation = "Line two of the conclusion.\nFinal sentence of the section.\nNew content that follows.";
    const result = dedupContinuation(tail, continuation);
    expect(result).toBe("New content that follows.");
  });

  test("strips exact char overlap at boundary", () => {
    const tail = "x".repeat(50) + "The answer is 42. This is the final result.";
    const continuation = "This is the final result. And here is more content.";
    const result = dedupContinuation(tail, continuation);
    expect(result).toBe(" And here is more content.");
  });

  test("returns original if no overlap", () => {
    const tail = "Something completely different.";
    const continuation = "Brand new content starts here.";
    const result = dedupContinuation(tail, continuation);
    expect(result).toBe("Brand new content starts here.");
  });

  test("handles empty inputs", () => {
    expect(dedupContinuation("", "new text")).toBe("new text");
    expect(dedupContinuation("old text", "")).toBe("");
  });

  test("strips repeated conclusion section", () => {
    const tail = [
      "## Paso 4: Verificación",
      "Los cálculos son consistentes.",
      "",
      "## Conclusión",
      "La demanda acumulada refleja correctamente la estructura.",
    ].join("\n");

    const continuation = [
      "## Conclusión",
      "La demanda acumulada refleja correctamente la estructura.",
      "Este resultado confirma la hipótesis inicial.",
    ].join("\n");

    const result = dedupContinuation(tail, continuation);
    expect(result).toBe("Este resultado confirma la hipótesis inicial.");
  });

  test("strips repeated final lines of a proof", () => {
    const tail = [
      "Por lo tanto, SUBSEQ-OPT ≤ₚ MAX-FLOW.",
      "Como MAX-FLOW ∈ P, se deduce que SUBSEQ-OPT ∈ P.",
      "QED.",
    ].join("\n");

    const continuation = [
      "Como MAX-FLOW ∈ P, se deduce que SUBSEQ-OPT ∈ P.",
      "QED.",
      "Nota adicional sobre la complejidad.",
    ].join("\n");

    const result = dedupContinuation(tail, continuation);
    expect(result).toBe("Nota adicional sobre la complejidad.");
  });
});
