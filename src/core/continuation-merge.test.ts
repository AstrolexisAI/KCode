import { describe, expect, test } from "bun:test";
import { isTruncatedQuestion, mergeContinuation } from "./continuation-merge";

describe("mergeContinuation", () => {
  test("no overlap returns continuation unchanged", () => {
    const r = mergeContinuation("Previous text ends here.", "Brand new content.");
    expect(r.merged).toBe("Brand new content.");
    expect(r.strippedChars).toBe(0);
  });

  test("strips repeated paragraph from continuation", () => {
    const prev = "Paragraph one.\n\nParagraph two is the conclusion.\n\nFinal line.";
    const cont = "Final line.\nNew content after.";
    const r = mergeContinuation(prev, cont);
    expect(r.merged).toBe("New content after.");
  });

  test("strips repeated conclusion section", () => {
    const prev = [
      "## Paso 4: Verificación",
      "Los cálculos son consistentes.",
      "",
      "## Conclusión",
      "La demanda acumulada refleja correctamente la estructura.",
    ].join("\n");
    const cont = [
      "## Conclusión",
      "La demanda acumulada refleja correctamente la estructura.",
      "Este resultado confirma la hipótesis inicial.",
    ].join("\n");
    const r = mergeContinuation(prev, cont);
    expect(r.merged).toBe("Este resultado confirma la hipótesis inicial.");
    expect(r.repeatedPrefixDetected).toBe(true);
  });

  test("strips heading restart", () => {
    const prev = [
      "## Introducción",
      "Este es el contexto del problema.",
      "",
      "## Análisis",
      "Paso 1: calcular demanda.",
      "Paso 2: verificar stock.",
    ].join("\n");
    const cont = [
      "## Análisis",
      "Paso 1: calcular demanda.",
      "Paso 2: verificar stock.",
      "Paso 3: proponer transferencias.",
    ].join("\n");
    const r = mergeContinuation(prev, cont);
    expect(r.merged).toBe("Paso 3: proponer transferencias.");
    expect(r.repeatedPrefixDetected).toBe(true);
  });

  test("char-level overlap at boundary", () => {
    const prev = "x".repeat(50) + "The answer is 42. This is the final result.";
    const cont = "This is the final result. And here is more content.";
    const r = mergeContinuation(prev, cont);
    expect(r.merged).toBe(" And here is more content.");
  });

  test("handles empty inputs", () => {
    expect(mergeContinuation("", "new text").merged).toBe("new text");
    expect(mergeContinuation("old text", "").merged).toBe("");
  });

  test("strips repeated proof ending", () => {
    const prev = [
      "Por lo tanto, SUBSEQ-OPT ≤ₚ MAX-FLOW.",
      "Como MAX-FLOW ∈ P, se deduce que SUBSEQ-OPT ∈ P.",
      "QED.",
    ].join("\n");
    const cont = [
      "Como MAX-FLOW ∈ P, se deduce que SUBSEQ-OPT ∈ P.",
      "QED.",
      "Nota adicional sobre la complejidad.",
    ].join("\n");
    const r = mergeContinuation(prev, cont);
    expect(r.merged).toBe("Nota adicional sobre la complejidad.");
  });

  test("strips paragraph that was repeated entirely", () => {
    const prev =
      "First paragraph.\n\nThis is the important paragraph that matters a lot and has enough text to be significant.\n\nEnd.";
    const cont =
      "This is the important paragraph that matters a lot and has enough text to be significant.\n\nNew paragraph after.";
    const r = mergeContinuation(prev, cont);
    expect(r.merged).toBe("New paragraph after.");
  });

  test("cleans truncated word at junction", () => {
    const prev = "The algorithm works by compu";
    const cont = "ting the optimal solution efficiently.";
    const r = mergeContinuation(prev, cont);
    // Should strip the partial word fragment
    expect(r.merged).toBe("the optimal solution efficiently.");
  });

  test("handles large text with minimal overlap", () => {
    const prev = "A".repeat(1000) + "\nFinal unique sentence here.";
    const cont = "Completely different continuation text.";
    const r = mergeContinuation(prev, cont);
    expect(r.merged).toBe("Completely different continuation text.");
    expect(r.strippedChars).toBe(0);
  });
});

describe("isTruncatedQuestion", () => {
  test("detects truncated Spanish question", () => {
    expect(isTruncatedQuestion("¿Deseas proceder con est")).toBe(true);
  });

  test("detects truncated confirmation prompt", () => {
    expect(isTruncatedQuestion("Would you like to proceed with th")).toBe(true);
  });

  test("does not trigger on complete question", () => {
    expect(isTruncatedQuestion("¿Deseas proceder?")).toBe(false);
  });

  test("does not trigger on regular statement", () => {
    expect(isTruncatedQuestion("The project was created successfully.")).toBe(false);
  });

  test("detects 'shall' truncated", () => {
    expect(isTruncatedQuestion("Shall I continue with the ne")).toBe(true);
  });
});
