// KCode - Tests for tool-fitness heuristic
import { describe, expect, test } from "bun:test";
import { assessToolFitness, fitnessBadge } from "./tool-fitness";

describe("assessToolFitness", () => {
  test("frontier cloud APIs are all 'good'", () => {
    const cases = [
      "claude-haiku-4-5-20251001",
      "claude-opus-4-7",
      "claude-sonnet-4-6",
      "gpt-4o",
      "gpt-5",
      "o1",
      "o3-mini",
      "grok-4",
      "grok-3",
      "gemini-2-pro",
      "gemini-1.5-flash",
    ];
    for (const name of cases) {
      expect({ name, tier: assessToolFitness(name).tier }).toEqual({ name, tier: "good" });
    }
  });

  test("coder-tuned open models — Qwen3-Coder is 'weak' (verified 2026-05-08), others 'good'", () => {
    expect(assessToolFitness("mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit-DWQ").tier).toBe(
      "weak",
    );
    expect(assessToolFitness("Qwen3-Coder-30B").tier).toBe("weak");
    const goodCases = [
      "qwen2.5-coder-32b-instruct",
      "deepseek-coder-v2",
      "deepseek-v3",
      "codestral-22b",
    ];
    for (const name of goodCases) {
      expect({ name, tier: assessToolFitness(name).tier }).toEqual({ name, tier: "good" });
    }
  });

  test("Gemma family is flagged 'weak'", () => {
    const result = assessToolFitness("mlx-community/gemma-4-26b-a4b-it-4bit");
    expect(result.tier).toBe("weak");
    expect(result.reason).toMatch(/Gemma family/);
  });

  test("Llama-2 small is flagged 'weak'", () => {
    const result = assessToolFitness("meta-llama/Llama-2-7b-chat-hf");
    expect(result.tier).toBe("weak");
  });

  test("Phi small is flagged 'weak'", () => {
    expect(assessToolFitness("microsoft/phi-2").tier).toBe("weak");
    expect(assessToolFitness("microsoft/phi-3-mini").tier).toBe("weak");
  });

  test("sub-7B models with explicit param suffix are flagged 'weak'", () => {
    expect(assessToolFitness("some-org/llama-3.2-1b-instruct").tier).toBe("weak");
    expect(assessToolFitness("some-org/qwen-0.5b").tier).toBe("weak");
    expect(assessToolFitness("some-org/foo-3b-it").tier).toBe("weak");
  });

  test("unknown providers fall through to 'unknown'", () => {
    expect(assessToolFitness("custom-internal-model-v7").tier).toBe("unknown");
    expect(assessToolFitness("").tier).toBe("unknown");
  });

  test("Llama-3.1-70b is 'good' even though 'llama' could match weak rules", () => {
    expect(assessToolFitness("llama-3.1-70b-instruct").tier).toBe("good");
    expect(assessToolFitness("llama-3.3-70b").tier).toBe("good");
  });

  test("case-insensitive matching", () => {
    expect(assessToolFitness("CLAUDE-OPUS-4-7").tier).toBe("good");
    expect(assessToolFitness("Gemma-3-27B").tier).toBe("weak");
  });
});

describe("fitnessBadge", () => {
  test("returns short label for 'weak', empty for 'good' and 'unknown'", () => {
    expect(fitnessBadge("weak")).toBe("weak tools");
    expect(fitnessBadge("good")).toBe("");
    expect(fitnessBadge("unknown")).toBe("");
  });
});
