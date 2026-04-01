import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FineTuner, type FineTuneConfig } from "./fine-tuner";

const TEST_DIR = join(import.meta.dir, ".test-fine-tuner");

function makeConfig(overrides?: Partial<FineTuneConfig>): FineTuneConfig {
  return {
    baseModel: "unsloth/llama-3-8b-bnb-4bit",
    trainingDataPath: join(TEST_DIR, "train.jsonl"),
    outputDir: join(TEST_DIR, "output"),
    method: "lora",
    epochs: 3,
    learningRate: 2e-4,
    loraRank: 16,
    ...overrides,
  };
}

function createTrainingData(count: number): void {
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    lines.push(
      JSON.stringify({
        messages: [
          { role: "user", content: `Question ${i}` },
          { role: "assistant", content: `Answer ${i}` },
        ],
      }),
    );
  }
  writeFileSync(join(TEST_DIR, "train.jsonl"), lines.join("\n") + "\n", "utf-8");
}

describe("FineTuner", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ─── validate ───────────────────────────────────────────────

  describe("validate", () => {
    it("reports missing training data", async () => {
      const tuner = new FineTuner();
      const config = makeConfig({ trainingDataPath: "/nonexistent/data.jsonl" });
      const result = await tuner.validate(config);

      expect(result.ready).toBe(false);
      expect(result.issues.some((i) => i.includes("Training data not found"))).toBe(true);
    });

    it("reports insufficient training pairs", async () => {
      createTrainingData(10); // way below the 100 minimum
      const tuner = new FineTuner();
      const config = makeConfig();
      const result = await tuner.validate(config);

      expect(result.ready).toBe(false);
      expect(result.issues.some((i) => i.includes("Insufficient training data"))).toBe(true);
      expect(result.issues.some((i) => i.includes("10 pairs"))).toBe(true);
    });

    it("reports invalid epochs", async () => {
      createTrainingData(150);
      const tuner = new FineTuner();
      const config = makeConfig({ epochs: 0 });
      const result = await tuner.validate(config);

      expect(result.issues.some((i) => i.includes("Epochs must be"))).toBe(true);
    });

    it("reports invalid learning rate", async () => {
      createTrainingData(150);
      const tuner = new FineTuner();
      const config = makeConfig({ learningRate: -0.1 });
      const result = await tuner.validate(config);

      expect(result.issues.some((i) => i.includes("Learning rate must be"))).toBe(true);
    });

    it("reports invalid LoRA rank", async () => {
      createTrainingData(150);
      const tuner = new FineTuner();
      const config = makeConfig({ loraRank: 2 });
      const result = await tuner.validate(config);

      expect(result.issues.some((i) => i.includes("LoRA rank must be"))).toBe(true);
    });

    it("reports missing base model path (local)", async () => {
      createTrainingData(150);
      const tuner = new FineTuner();
      const config = makeConfig({ baseModel: "/nonexistent/model/path" });
      const result = await tuner.validate(config);

      expect(result.issues.some((i) => i.includes("Base model not found"))).toBe(true);
    });

    it("does not check local path for HuggingFace model names", async () => {
      createTrainingData(150);
      const tuner = new FineTuner();
      // HuggingFace-style model name contains / but no leading /
      const config = makeConfig({ baseModel: "unsloth/llama-3-8b" });
      const result = await tuner.validate(config);

      // Should NOT report "Base model not found" for HF names
      expect(result.issues.some((i) => i.includes("Base model not found"))).toBe(false);
    });
  });

  // ─── generateTrainingScript ─────────────────────────────────

  describe("generateTrainingScript", () => {
    it("generates Unsloth script for LoRA method", () => {
      const tuner = new FineTuner();
      const config = makeConfig({ method: "lora" });
      const script = tuner.generateTrainingScript(config);

      expect(script).toContain("#!/usr/bin/env python3");
      expect(script).toContain("unsloth");
      expect(script).toContain("FastLanguageModel");
      expect(script).toContain("LoRA");
      expect(script).toContain(`EPOCHS = ${config.epochs}`);
      expect(script).toContain(`LEARNING_RATE = ${config.learningRate}`);
      expect(script).toContain(`LORA_RANK = ${config.loraRank}`);
      expect(script).toContain(config.baseModel);
      expect(script).toContain(config.trainingDataPath);
    });

    it("generates Unsloth script for QLoRA method with 4bit", () => {
      const tuner = new FineTuner();
      const config = makeConfig({ method: "qlora" });
      const script = tuner.generateTrainingScript(config);

      expect(script).toContain("unsloth");
      expect(script).toContain('"4bit"');
      expect(script).toContain("QLORA");
    });

    it("generates llama.cpp script for full method", () => {
      const tuner = new FineTuner();
      const config = makeConfig({ method: "full", baseModel: "meta-llama/Llama-3-8B" });
      const script = tuner.generateTrainingScript(config);

      expect(script).toContain("#!/usr/bin/env python3");
      expect(script).toContain("llama-finetune");
      expect(script).toContain("llama.cpp");
      expect(script).toContain(`EPOCHS = ${config.epochs}`);
      expect(script).toContain(`LEARNING_RATE = ${config.learningRate}`);
      expect(script).not.toContain("from unsloth");
    });

    it("includes config values in generated script", () => {
      const tuner = new FineTuner();
      const config = makeConfig({
        baseModel: "meta-llama/Llama-3-8B",
        epochs: 5,
        learningRate: 1e-5,
        loraRank: 32,
      });
      const script = tuner.generateTrainingScript(config);

      expect(script).toContain("meta-llama/Llama-3-8B");
      expect(script).toContain("EPOCHS = 5");
      expect(script).toContain("LORA_RANK = 32");
    });
  });
});
