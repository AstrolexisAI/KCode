import { describe, expect, test } from "bun:test";
import { classifyBenchmarkTask, isMonolithicCreation } from "./router";

// Regression coverage for issue #101: scaffold prompts with "analizar"
// keyword were being routed to analysis instead of implementation.
describe("classifyBenchmarkTask — scaffold routing (issue #101)", () => {
  test("exact 2026-04-23 Bitcoin TUI prompt routes to complex-edit, not analysis", () => {
    const prompt =
      "Necesito crear un proyecto nuevo, quiero un dashboard de TUI de bitcoin, " +
      "tengo un nodo bitcoin conectado en este servidor, quiero ver bloques, " +
      "transacciones, y mucho mas en vivo, o sea, analizar completamente la " +
      "blockchain de bitcoin";

    // Sanity: the scaffold pattern matches the prompt
    expect(isMonolithicCreation(prompt)).toBe(true);

    // Routing: scaffold wins over "analizar"
    const task = classifyBenchmarkTask(prompt);
    expect(task).toBe("complex-edit");
    expect(task).not.toBe("analysis");
  });

  test("pure scaffold prompt routes to complex-edit", () => {
    expect(classifyBenchmarkTask("Crea un proyecto nuevo de Python con FastAPI")).toBe(
      "complex-edit",
    );
    expect(classifyBenchmarkTask("Build a new Rust CLI from scratch")).toBe("complex-edit");
    expect(classifyBenchmarkTask("Implementá un servidor HTTP en Go")).toBe("complex-edit");
  });

  test("pure analysis prompt still routes to analysis", () => {
    expect(classifyBenchmarkTask("analiza el código de /tmp/foo.py para bugs")).toBe("analysis");
    expect(classifyBenchmarkTask("audit this codebase")).toBe("analysis");
  });

  test("multi-step structural wins over scaffold", () => {
    // "Hacé 3 cosas: 1. creá un proyecto 2. ..." → multi-step, not complex-edit
    expect(
      classifyBenchmarkTask("Hacé 3 cosas: 1. creá un proyecto nuevo 2. analizá el código"),
    ).toBe("multi-step");
  });

  // Note: `detectImageContent` keys off actual image attachments / data
  // URIs, not the literal word "captura" in plain text — so we don't
  // include a vision test here. The "captura" keyword under the analysis
  // patterns only fires after the new scaffold check, which is the
  // intended behavior for issue #101.
});
