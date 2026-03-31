import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

import { ModelTrainer } from "./trainer";
import type { TrainingConfig } from "./types";

// ─── Test Helpers ──────────────────────────────────────────────

let tempDir: string;
let trainer: ModelTrainer;
let datasetPath: string;

function makeConfig(overrides?: Partial<TrainingConfig>): TrainingConfig {
  return ModelTrainer.defaults({
    datasetPath,
    outputDir: tempDir,
    ...overrides,
  });
}

// ─── Setup / Teardown ──────────────────────────────────────────

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "kcode-trainer-test-"));
  trainer = new ModelTrainer();

  // Create a mock dataset file
  datasetPath = join(tempDir, "dataset.jsonl");
  await Bun.write(
    datasetPath,
    JSON.stringify({
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi!" },
      ],
    }) + "\n",
  );
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ─── Tests ─────────────────────────────────────────────────────

describe("ModelTrainer", () => {
  // ─── defaults() ─────────────────────────────────────────────

  test("defaults() returns valid TrainingConfig", () => {
    const config = ModelTrainer.defaults();
    expect(config.backend).toBe("unsloth");
    expect(config.epochs).toBe(3);
    expect(config.batchSize).toBe(4);
    expect(config.learningRate).toBe(2e-5);
    expect(config.loraRank).toBe(16);
    expect(config.loraAlpha).toBe(32);
    expect(config.maxSeqLength).toBe(4096);
    expect(config.quantization).toBe("4bit");
    expect(config.cudaDevices).toBe("0");
  });

  test("defaults() merges partial overrides", () => {
    const config = ModelTrainer.defaults({
      backend: "mlx-lm",
      epochs: 5,
      loraRank: 32,
    });
    expect(config.backend).toBe("mlx-lm");
    expect(config.epochs).toBe(5);
    expect(config.loraRank).toBe(32);
    expect(config.batchSize).toBe(4); // unchanged
  });

  // ─── validateConfig() ──────────────────────────────────────

  describe("validateConfig", () => {
    test("passes for valid config", () => {
      const errors = trainer.validateConfig(makeConfig());
      expect(errors).toEqual([]);
    });

    test("fails for unsupported backend", () => {
      const errors = trainer.validateConfig(
        makeConfig({ backend: "invalid" as any }),
      );
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain("Unsupported backend");
    });

    test("fails for empty baseModel", () => {
      const errors = trainer.validateConfig(makeConfig({ baseModel: "" }));
      expect(errors).toContain("baseModel is required");
    });

    test("fails for empty datasetPath", () => {
      const errors = trainer.validateConfig(makeConfig({ datasetPath: "" }));
      expect(errors).toContain("datasetPath is required");
    });

    test("fails for non-existent dataset file", () => {
      const errors = trainer.validateConfig(
        makeConfig({ datasetPath: "/nonexistent/path.jsonl" }),
      );
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain("Dataset file not found");
    });

    test("fails for invalid epochs", () => {
      const errors = trainer.validateConfig(makeConfig({ epochs: 0 }));
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain("epochs");
    });

    test("fails for invalid batchSize", () => {
      const errors = trainer.validateConfig(makeConfig({ batchSize: 0 }));
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain("batchSize");
    });

    test("fails for invalid learningRate", () => {
      const errors = trainer.validateConfig(
        makeConfig({ learningRate: -0.1 }),
      );
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain("learningRate");
    });

    test("fails for invalid loraRank", () => {
      const errors = trainer.validateConfig(makeConfig({ loraRank: 2 }));
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain("loraRank");
    });

    test("fails for invalid maxSeqLength", () => {
      const errors = trainer.validateConfig(
        makeConfig({ maxSeqLength: 100 }),
      );
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain("maxSeqLength");
    });

    test("collects multiple errors", () => {
      const errors = trainer.validateConfig(
        makeConfig({
          baseModel: "",
          datasetPath: "",
          epochs: 0,
          batchSize: -1,
        }),
      );
      expect(errors.length).toBeGreaterThanOrEqual(3);
    });
  });

  // ─── generateTrainingScript() ─────────────────────────────

  describe("generateTrainingScript", () => {
    test("generates valid Unsloth script", () => {
      const script = trainer.generateTrainingScript(makeConfig());

      expect(script).toContain("from unsloth import FastLanguageModel");
      expect(script).toContain("from trl import SFTTrainer");
      expect(script).toContain("TRAINING_COMPLETE");
      expect(script).toContain(
        "unsloth/Qwen2.5-Coder-7B-Instruct",
      );
      expect(script).toContain("load_in_4bit=True");
      expect(script).toContain(`r=16`);
      expect(script).toContain(`lora_alpha=32`);
      expect(script).toContain(`per_device_train_batch_size=4`);
      expect(script).toContain(`num_train_epochs=3`);
    });

    test("generates Unsloth script with 8bit quantization", () => {
      const script = trainer.generateTrainingScript(
        makeConfig({ quantization: "8bit" }),
      );
      expect(script).toContain("load_in_4bit=False");
    });

    test("generates valid MLX-LM script", () => {
      const script = trainer.generateTrainingScript(
        makeConfig({ backend: "mlx-lm" }),
      );

      expect(script).toContain("import mlx");
      expect(script).toContain("mlx_lm");
      expect(script).toContain("TRAINING_COMPLETE");
      expect(script).toContain("TRAINING_FAILED");
    });

    test("generates valid Axolotl script", () => {
      const script = trainer.generateTrainingScript(
        makeConfig({ backend: "axolotl" }),
      );

      expect(script).toContain("axolotl");
      expect(script).toContain("axolotl_config");
      expect(script).toContain("TRAINING_COMPLETE");
      expect(script).toContain("yaml");
    });

    test("generates valid LLaMA-Factory script", () => {
      const script = trainer.generateTrainingScript(
        makeConfig({ backend: "llamafactory" }),
      );

      expect(script).toContain("llamafactory");
      expect(script).toContain("TRAINING_COMPLETE");
      expect(script).toContain("TRAINING_FAILED");
    });

    test("embeds config values correctly in Unsloth script", () => {
      const config = makeConfig({
        baseModel: "meta-llama/Llama-3-8B",
        epochs: 5,
        batchSize: 8,
        learningRate: 1e-4,
        loraRank: 32,
        loraAlpha: 64,
        maxSeqLength: 8192,
      });

      const script = trainer.generateTrainingScript(config);

      expect(script).toContain("meta-llama/Llama-3-8B");
      expect(script).toContain("max_seq_length=8192");
      expect(script).toContain("r=32");
      expect(script).toContain("lora_alpha=64");
      expect(script).toContain("per_device_train_batch_size=8");
      expect(script).toContain("num_train_epochs=5");
      expect(script).toContain("learning_rate=0.0001");
    });

    test("throws for unknown backend", () => {
      expect(() =>
        trainer.generateTrainingScript(
          makeConfig({ backend: "unknown" as any }),
        ),
      ).toThrow(/not implemented/);
    });
  });

  // ─── train() writes script to disk ────────────────────────

  test("train() writes the training script to outputDir", async () => {
    const config = makeConfig();

    // We don't actually want to run python3, so we catch the spawn error
    try {
      await trainer.train(config);
    } catch {
      // python3 may not be available — that's fine, we just check the script was written
    }

    const scriptPath = join(tempDir, "train.py");
    expect(existsSync(scriptPath)).toBe(true);

    const content = readFileSync(scriptPath, "utf-8");
    expect(content).toContain("from unsloth import FastLanguageModel");
    expect(content).toContain("TRAINING_COMPLETE");
  });

  test("train() rejects invalid config", async () => {
    const config = makeConfig({ baseModel: "", datasetPath: "" });

    try {
      await trainer.train(config);
      expect(true).toBe(false); // Should not reach here
    } catch (err) {
      expect(String(err)).toContain("Invalid training config");
    }
  });

  // ─── checkStatus() ────────────────────────────────────────

  describe("checkStatus", () => {
    test("returns running when no log file exists", () => {
      const handle = {
        pid: 12345,
        logFile: join(tempDir, "nonexistent.log"),
        outputDir: tempDir,
        status: "running" as const,
      };

      const result = trainer.checkStatus(handle);
      expect(result.status).toBe("running");
    });

    test("returns completed when log contains TRAINING_COMPLETE", async () => {
      const logFile = join(tempDir, "train.log");
      await Bun.write(logFile, "Epoch 1/3...\nEpoch 2/3...\nTRAINING_COMPLETE\n");

      const handle = {
        pid: 12345,
        logFile,
        outputDir: tempDir,
        status: "running" as const,
      };

      const result = trainer.checkStatus(handle);
      expect(result.status).toBe("completed");
    });

    test("returns failed when log contains Traceback at end", async () => {
      const logFile = join(tempDir, "train.log");
      await Bun.write(
        logFile,
        "Loading model...\nTraceback (most recent call last):\n  File...\nRuntimeError: CUDA OOM\n",
      );

      const handle = {
        pid: 12345,
        logFile,
        outputDir: tempDir,
        status: "running" as const,
      };

      const result = trainer.checkStatus(handle);
      expect(result.status).toBe("failed");
    });

    test("returns running when log has no terminal marker", async () => {
      const logFile = join(tempDir, "train.log");
      await Bun.write(logFile, "Epoch 1/3...\nLoss: 0.45\n");

      const handle = {
        pid: 12345,
        logFile,
        outputDir: tempDir,
        status: "running" as const,
      };

      const result = trainer.checkStatus(handle);
      expect(result.status).toBe("running");
    });
  });
});
