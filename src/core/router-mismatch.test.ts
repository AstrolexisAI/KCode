// KCode - Tests for checkModelTaskMismatch
import { describe, expect, test } from "bun:test";
import { checkModelTaskMismatch, classifyBenchmarkTask, classifyTask } from "./router";

describe("checkModelTaskMismatch", () => {
  test("Qwen3-Coder + analysis task → mismatch", () => {
    const m = checkModelTaskMismatch(
      "mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit-DWQ",
      "analysis",
    );
    expect(m).not.toBeNull();
    expect(m?.reason).toMatch(/Qwen3-Coder is excellent at code-gen/);
    expect(m?.suggestion).toMatch(/multimodel on/);
    expect(m?.suggestion).toMatch(/mark5-mid/);
  });

  test("Qwen3-Coder + chat task → mismatch", () => {
    expect(checkModelTaskMismatch("Qwen3-Coder-30B", "chat")?.reason).toMatch(/Qwen3-Coder/);
  });

  test("Qwen3-Coder + complex-edit task → no mismatch (its strength)", () => {
    expect(checkModelTaskMismatch("Qwen3-Coder-30B", "complex-edit")).toBeNull();
  });

  test("Gemma 4 26B Q4 + complex-edit → mismatch (still chat-tuned at low quant)", () => {
    const m = checkModelTaskMismatch("mlx-community/gemma-4-26b-a4b-it-4bit", "complex-edit");
    expect(m?.reason).toMatch(/Gemma at 4-bit/);
    expect(m?.suggestion).toMatch(/mark5-mid/);
  });

  test("Gemma 4 31B Q6 + complex-edit → no mismatch (verified agentic 2026-05-09)", () => {
    expect(
      checkModelTaskMismatch("mlx-community/gemma-4-31b-it-6bit", "complex-edit"),
    ).toBeNull();
  });

  test("Gemma 4 31B Q8 + complex-edit → no mismatch (single-shot tier)", () => {
    expect(
      checkModelTaskMismatch("mlx-community/gemma-4-31b-it-8bit", "complex-edit"),
    ).toBeNull();
  });

  test("Gemma + chat → no mismatch (its strength)", () => {
    expect(checkModelTaskMismatch("Gemma-4-31B", "chat")).toBeNull();
  });

  test("Gemma + analysis → no mismatch (broadly OK)", () => {
    expect(checkModelTaskMismatch("Gemma-4-26B", "analysis")).toBeNull();
  });

  test("Llama-2 + any agentic task → mismatch", () => {
    expect(checkModelTaskMismatch("Llama-2-7B", "complex-edit")?.reason).toMatch(/Llama/);
    expect(checkModelTaskMismatch("Llama-2-7B", "analysis")?.reason).toMatch(/Llama/);
  });

  test("Phi-3 + agentic task → mismatch", () => {
    expect(checkModelTaskMismatch("microsoft/phi-3-mini", "complex-edit")?.reason).toMatch(
      /Phi-2\/3/,
    );
  });

  test("Claude Haiku → no mismatch (broadly capable)", () => {
    expect(checkModelTaskMismatch("claude-haiku-4-5-20251001", "complex-edit")).toBeNull();
    expect(checkModelTaskMismatch("claude-haiku-4-5-20251001", "analysis")).toBeNull();
  });

  test("Grok-4 → no mismatch", () => {
    expect(checkModelTaskMismatch("grok-4", "complex-edit")).toBeNull();
  });

  test("GLM-4.7-Flash + analysis → mismatch (verified 2026-05-09 weak intent)", () => {
    // Initial verification 2026-05-08 said agentic was strong, but
    // 2026-05-09 testing on Mac proved it confuses ambiguous Spanish
    // intent like "analiza la red local" (reads source files instead
    // of running ifconfig). Listed as a mismatch for analysis tasks
    // so multimodel routing is suggested.
    const m = checkModelTaskMismatch("mlx-community/GLM-4.7-Flash-4bit", "analysis");
    expect(m).not.toBeNull();
    expect(m?.reason).toMatch(/GLM-4\.7-Flash/);
    expect(m?.suggestion).toMatch(/multimodel on/);
  });

  test("GLM-4.7-Flash + complex-edit → no mismatch (its strength)", () => {
    // GLM-4.7-Flash is still good at explicit coding tasks where the
    // intent is unambiguous (file path + change is clear).
    expect(checkModelTaskMismatch("mlx-community/GLM-4.7-Flash-4bit", "complex-edit")).toBeNull();
  });

  test("Empty/unknown model → no mismatch", () => {
    expect(checkModelTaskMismatch("", "complex-edit")).toBeNull();
    expect(checkModelTaskMismatch("custom-internal-model", "complex-edit")).toBeNull();
  });
});

describe("markMismatchSeen — session dedup", () => {
  test("first call returns true, subsequent same (model,task) returns false", async () => {
    const { markMismatchSeen, _resetMismatchSeen } = await import("./router");
    _resetMismatchSeen();
    expect(markMismatchSeen("gemma-4-26b", "complex-edit")).toBe(true);
    expect(markMismatchSeen("gemma-4-26b", "complex-edit")).toBe(false);
    expect(markMismatchSeen("gemma-4-26b", "complex-edit")).toBe(false);
  });

  test("different (model,task) pairs are independent", async () => {
    const { markMismatchSeen, _resetMismatchSeen } = await import("./router");
    _resetMismatchSeen();
    expect(markMismatchSeen("gemma-4", "complex-edit")).toBe(true);
    expect(markMismatchSeen("gemma-4", "simple-edit")).toBe(true);
    expect(markMismatchSeen("qwen3-coder", "analysis")).toBe(true);
    // Re-querying any seen pair returns false
    expect(markMismatchSeen("gemma-4", "complex-edit")).toBe(false);
    expect(markMismatchSeen("qwen3-coder", "analysis")).toBe(false);
  });
});

describe("classifyBenchmarkTask gaps fixed 2026-05-08", () => {
  test("'escribí tests para X' → coding (was misclassified as chat)", () => {
    expect(classifyTask("escribí tests para el módulo de auth")).toBe("code");
  });

  test("'fix the bug in the parser' → code", () => {
    expect(classifyTask("fix the bug in the parser")).toBe("code");
  });

  test("'creá un proyecto Next.js' → code (creation)", () => {
    expect(classifyTask("creá un proyecto Next.js nuevo")).toBe("code");
  });

  test("language-only mention triggers code classification", () => {
    expect(classifyTask("ayudame con typescript")).toBe("code");
    expect(classifyTask("dale rust support")).toBe("code");
  });
});
