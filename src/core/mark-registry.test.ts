// KCode - mark-registry tests

import { describe, expect, test } from "bun:test";
import { lookupMarkByGgufBasename } from "./mark-registry";

describe("lookupMarkByGgufBasename", () => {
  test("maps Qwen3.6-35B-A3B-Abliterated-Heretic-Q4_K_M to mark7", () => {
    expect(lookupMarkByGgufBasename("Qwen3.6-35B-A3B-Abliterated-Heretic-Q4_K_M")).toBe("mark7");
  });

  test("maps a bare Qwen3.6 checkpoint to mark7", () => {
    expect(lookupMarkByGgufBasename("Qwen3.6-35B-A3B")).toBe("mark7");
  });

  test("does not shadow mark7 with the mark5 Qwen3 pattern", () => {
    // Qwen3.6 contains "Qwen3" as a substring; the registry must hit
    // the mark7 pattern first so the minor version isn't thrown away.
    expect(lookupMarkByGgufBasename("Qwen3.6-Coder-30B")).toBe("mark7");
  });

  test("maps a Qwen3 (no minor) build to mark5", () => {
    expect(lookupMarkByGgufBasename("Qwen3-Coder-30B-A3B-Instruct-Q4_K_M")).toBe("mark5");
  });

  test("maps Qwen3.5 to mark6", () => {
    expect(lookupMarkByGgufBasename("Qwen3.5-72B-Instruct-Q4_K_M")).toBe("mark6");
  });

  test("maps Gemma-3-31B variants to mark6", () => {
    expect(lookupMarkByGgufBasename("Gemma-3-31B-it-abliterated")).toBe("mark6");
    expect(lookupMarkByGgufBasename("gemma3_31b_instruct")).toBe("mark6");
  });

  test("is case-insensitive", () => {
    expect(lookupMarkByGgufBasename("qwen3.6-35b-a3b")).toBe("mark7");
  });

  test("returns null for unrelated families", () => {
    expect(lookupMarkByGgufBasename("Llama-3.1-8B-Instruct")).toBeNull();
    expect(lookupMarkByGgufBasename("DeepSeek-Coder-V2-Lite")).toBeNull();
    expect(lookupMarkByGgufBasename("Phi-3-medium-128k")).toBeNull();
  });

  test("returns null for an empty string", () => {
    expect(lookupMarkByGgufBasename("")).toBeNull();
  });
});
