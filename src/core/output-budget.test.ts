import { describe, test, expect } from "bun:test";
import { evaluateOutputBudget } from "./output-budget";

describe("evaluateOutputBudget", () => {
  test("short prompt returns normal strategy", () => {
    const r = evaluateOutputBudget("What is 2+2?", 4096);
    expect(r.strategy).toBe("normal");
  });

  test("explicit word count triggers non-normal strategy when exceeds budget", () => {
    // 2000 words ≈ 2800 tokens, but max is only 2048 → should trigger
    const r = evaluateOutputBudget("Escribí un ensayo de 2000 palabras sobre la historia de la IA", 2048);
    expect(r.strategy).not.toBe("normal");
    expect(r.systemHint).toBeDefined();
  });

  test("exhaustive keyword triggers non-normal strategy", () => {
    const r = evaluateOutputBudget("Explicá exhaustivamente cada aspecto del problema con todos los detalles posibles", 2048);
    expect(r.strategy).not.toBe("normal");
  });

  test("many sections + bullets triggers budget warning", () => {
    const prompt = `### Sección 1
* punto 1
* punto 2
### Sección 2
* punto 3
* punto 4
### Sección 3
* punto 5
* punto 6
### Sección 4
* punto 7
* punto 8
* punto 9`;
    const r = evaluateOutputBudget(prompt, 2048);
    expect(["summarize", "sectioned", "warn"]).toContain(r.strategy);
  });

  test("normal prompt with high max tokens stays normal", () => {
    const r = evaluateOutputBudget("Explain how a hash table works", 8192);
    expect(r.strategy).toBe("normal");
  });

  test("high context usage tightens the budget", () => {
    const r = evaluateOutputBudget(
      "Escribí un ensayo extenso de 2000 palabras mostrando todos los detalles",
      4096,
      90,
    );
    expect(r.strategy).not.toBe("normal");
  });

  test("complete history keyword triggers non-normal", () => {
    const r = evaluateOutputBudget("Write the complete history of computing from 1940 to 2024", 2048);
    expect(r.strategy).not.toBe("normal");
  });

  test("non-normal strategy includes systemHint", () => {
    const r = evaluateOutputBudget("Escribí 3000 palabras sobre Bitcoin", 2048);
    expect(r.strategy).not.toBe("normal");
    expect(r.systemHint).toBeDefined();
    expect(r.systemHint!.length).toBeGreaterThan(20);
  });
});
