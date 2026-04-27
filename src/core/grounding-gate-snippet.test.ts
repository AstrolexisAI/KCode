// Tests for extractSentenceLikeSnippet (v2.10.306, issue #111 snippet-corruption).

import { describe, expect, it } from "bun:test";
import { extractSentenceLikeSnippet } from "./grounding-gate";

describe("extractSentenceLikeSnippet", () => {
  it("expands to sentence boundaries instead of raw character offsets", () => {
    const text =
      "Primera oración normal. Aquí está el claim fuerte: está completo y listo para producción. Siguiente oración.";
    const idx = text.indexOf("listo para producción");
    const snippet = extractSentenceLikeSnippet(text, idx, "listo para producción".length);
    expect(snippet).toContain("listo para producción");
    // Should not leak into next sentence
    expect(snippet).not.toContain("Siguiente oración");
    // Should start at a sentence boundary, not mid-word
    expect(snippet[0]).not.toBe(" ");
    expect(/^\w/.test(snippet)).toBe(true);
  });

  it("expands within a bullet, stopping at the newline", () => {
    const text = `Texto arriba.

- nasa/openmct — Open Mission Control Telemetry, listo para usar en producción
- nasa/fprime — flight software

Más texto.`;
    const idx = text.indexOf("listo para usar");
    const snippet = extractSentenceLikeSnippet(text, idx, "listo para usar".length);
    expect(snippet).toContain("listo para usar");
    expect(snippet).not.toContain("nasa/fprime");
    expect(snippet).not.toContain("Más texto");
  });

  it("never starts or ends mid-word", () => {
    const text = "Aquí está el bullet con **nasa/deep-space-navigation** — herramientas listas";
    const idx = text.indexOf("listas");
    const snippet = extractSentenceLikeSnippet(text, idx, "listas".length);
    // The snippet must not start with a partial word like "rk de observación"
    // which v305 produced. Start or end on whitespace / word boundary only.
    expect(snippet.length).toBeGreaterThan(0);
    // First char is a word char or a clean start delimiter
    const first = snippet[0]!;
    expect(/[A-Za-z0-9*`•\-(]/.test(first)).toBe(true);
  });

  it("strips dangling markdown markers at edges", () => {
    const text = "Some text **strong claim** that continues";
    const idx = text.indexOf("strong claim");
    const snippet = extractSentenceLikeSnippet(text, idx, "strong claim".length, 40);
    // Should not start with "**" alone
    expect(snippet.startsWith("**")).toBe(false);
  });

  it("truncates with ellipsis when over maxLen", () => {
    const text = "A".repeat(500);
    const snippet = extractSentenceLikeSnippet(text, 10, 5, 100);
    expect(snippet.length).toBeLessThanOrEqual(100);
    expect(snippet.endsWith("…")).toBe(true);
  });

  it("does not reproduce the v305 corruption 'rk de observación...'", () => {
    // This is the exact failure shape reported by the user.
    const text = `**nasa/openmct** — framework de observación de misiones en tiempo real
 • **nasa/deep-space-navigation** — herramientas para navegación

More text.`;
    const idx = text.indexOf("en tiempo real");
    const snippet = extractSentenceLikeSnippet(text, idx, "en tiempo real".length);
    // Must not start mid-word with "rk de observación"
    expect(snippet.startsWith("rk")).toBe(false);
    expect(snippet).toContain("en tiempo real");
  });

  it("handles match at start of text", () => {
    const text = "listo para producción. Resto.";
    const snippet = extractSentenceLikeSnippet(text, 0, "listo para producción".length);
    expect(snippet).toContain("listo para producción");
    expect(snippet).not.toContain("Resto");
  });

  it("handles match at end of text", () => {
    const text = "Preludio. Final: está listo";
    const idx = text.indexOf("está listo");
    const snippet = extractSentenceLikeSnippet(text, idx, "está listo".length);
    expect(snippet).toContain("está listo");
  });
});
