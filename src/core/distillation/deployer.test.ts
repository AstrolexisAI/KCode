import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setModelsPathForTest, loadModelsConfig } from "../models";
import { ModelDeployer } from "./deployer";
import type { DeployConfig } from "./types";

// ─── Test Helpers ──────────────────────────────────────────────

let tempDir: string;
let deployer: ModelDeployer;
let modelFile: string;

function makeConfig(overrides?: Partial<DeployConfig>): DeployConfig {
  return {
    modelPath: modelFile,
    name: "kcode-distilled-7b",
    description: "Fine-tuned on KCode sessions",
    setAsDefault: false,
    ...overrides,
  };
}

// ─── Setup / Teardown ──────────────────────────────────────────

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "kcode-deployer-test-"));
  deployer = new ModelDeployer();

  // Create a mock GGUF model file
  modelFile = join(tempDir, "model-q4_k_m.gguf");
  await Bun.write(modelFile, "GGUF mock content");

  // Point models.json to temp directory
  _setModelsPathForTest(join(tempDir, "models.json"));
});

afterEach(async () => {
  _setModelsPathForTest(undefined); // Reset
  await rm(tempDir, { recursive: true, force: true });
});

// ─── Tests ─────────────────────────────────────────────────────

describe("ModelDeployer", () => {
  // ─── validateConfig() ──────────────────────────────────────

  describe("validateConfig", () => {
    test("passes for valid config", () => {
      const errors = deployer.validateConfig(makeConfig());
      expect(errors).toEqual([]);
    });

    test("fails for empty modelPath", () => {
      const errors = deployer.validateConfig(makeConfig({ modelPath: "" }));
      expect(errors).toContain("modelPath is required");
    });

    test("fails for non-existent model file", () => {
      const errors = deployer.validateConfig(makeConfig({ modelPath: "/nonexistent/model.gguf" }));
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain("Model file not found");
    });

    test("fails for invalid model name characters", () => {
      const errors = deployer.validateConfig(makeConfig({ name: "my model with spaces!" }));
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain("Invalid model name");
    });

    test("passes for valid model name with dots and hyphens", () => {
      const errors = deployer.validateConfig(makeConfig({ name: "my-model.v2_q4" }));
      expect(errors).toEqual([]);
    });
  });

  // ─── inferModelName() ─────────────────────────────────────

  describe("inferModelName", () => {
    test("strips .gguf extension", () => {
      expect(deployer.inferModelName("/path/to/model-q4_k_m.gguf")).toBe("model-q4_k_m");
    });

    test("strips .ggml extension", () => {
      expect(deployer.inferModelName("/path/to/model.ggml")).toBe("model");
    });

    test("strips .bin extension", () => {
      expect(deployer.inferModelName("/path/to/model.bin")).toBe("model");
    });

    test("strips .safetensors extension", () => {
      expect(deployer.inferModelName("/path/to/model.safetensors")).toBe("model");
    });

    test("strips .pt extension", () => {
      expect(deployer.inferModelName("/path/to/model.pt")).toBe("model");
    });

    test("handles files without known extensions", () => {
      expect(deployer.inferModelName("/path/to/model.txt")).toBe("model.txt");
    });

    test("handles just a filename", () => {
      expect(deployer.inferModelName("my-model.gguf")).toBe("my-model");
    });
  });

  // ─── deploy() ─────────────────────────────────────────────

  describe("deploy", () => {
    test("registers model in models.json", async () => {
      const report = await deployer.deploy(makeConfig());

      expect(report.modelName).toBe("kcode-distilled-7b");
      expect(report.setAsDefault).toBe(false);
      expect(report.modelPath).toBe(modelFile);
      expect(report.registeredAt).toBeTruthy();

      // Verify models.json was written
      const modelsConfig = await loadModelsConfig();
      const registered = modelsConfig.models.find((m) => m.name === "kcode-distilled-7b");
      expect(registered).toBeTruthy();
      expect(registered!.description).toBe("Fine-tuned on KCode sessions");
    });

    test("sets model as default when requested", async () => {
      const report = await deployer.deploy(makeConfig({ setAsDefault: true }));

      expect(report.setAsDefault).toBe(true);

      const modelsConfig = await loadModelsConfig();
      expect(modelsConfig.defaultModel).toBe("kcode-distilled-7b");
    });

    test("infers model name from path when name is empty", async () => {
      const report = await deployer.deploy(makeConfig({ name: "" }));

      expect(report.modelName).toBe("model-q4_k_m");
    });

    test("rejects invalid config", async () => {
      try {
        await deployer.deploy(makeConfig({ modelPath: "" }));
        expect(true).toBe(false); // Should not reach
      } catch (err) {
        expect(String(err)).toContain("Invalid deploy config");
      }
    });

    test("updates existing model if deployed again", async () => {
      // Deploy once
      await deployer.deploy(makeConfig());

      // Deploy again with different description
      await deployer.deploy(makeConfig({ description: "Updated description" }));

      const modelsConfig = await loadModelsConfig();
      const models = modelsConfig.models.filter((m) => m.name === "kcode-distilled-7b");
      // Should have exactly one entry (updated, not duplicated)
      expect(models.length).toBe(1);
      expect(models[0]!.description).toBe("Updated description");
    });
  });
});
