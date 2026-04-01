// KCode - Model Deployer for Model Distillation
// Registers a distilled (fine-tuned) model in the KCode model registry
// so it can be used as the active model.

import { existsSync } from "node:fs";
import { basename } from "node:path";
import { log } from "../logger";
import { addModel, setDefaultModel } from "../models";
import type { DeployConfig, DeployReport } from "./types";

// ─── ModelDeployer ─────────────────────────────────────────────

export class ModelDeployer {
  /**
   * Deploy a distilled model: register it in ~/.kcode/models.json.
   */
  async deploy(config: DeployConfig): Promise<DeployReport> {
    // Validate
    const errors = this.validateConfig(config);
    if (errors.length > 0) {
      throw new Error(`Invalid deploy config:\n  - ${errors.join("\n  - ")}`);
    }

    const modelName = config.name || this.inferModelName(config.modelPath);

    // Register in models.json
    await addModel({
      name: modelName,
      baseUrl: "http://localhost:10091",
      description: config.description ?? `Fine-tuned model distilled from KCode sessions`,
      capabilities: ["code"],
    });

    // Optionally set as default
    if (config.setAsDefault) {
      await setDefaultModel(modelName);
    }

    log.info(
      "distill",
      `Deployed model "${modelName}" from ${config.modelPath}` +
        (config.setAsDefault ? " (set as default)" : ""),
    );

    return {
      modelName,
      registeredAt: new Date().toISOString(),
      setAsDefault: config.setAsDefault,
      modelPath: config.modelPath,
    };
  }

  /**
   * Validate the deploy configuration.
   */
  validateConfig(config: DeployConfig): string[] {
    const errors: string[] = [];

    if (!config.modelPath) {
      errors.push("modelPath is required");
    } else if (!existsSync(config.modelPath)) {
      errors.push(`Model file not found: ${config.modelPath}`);
    }

    if (config.name && !/^[a-zA-Z0-9._-]+$/.test(config.name)) {
      errors.push(
        `Invalid model name "${config.name}": use only alphanumeric, dots, hyphens, underscores`,
      );
    }

    return errors;
  }

  /**
   * Infer a model name from the file path.
   * E.g. "/path/to/my-model-q4_k_m.gguf" -> "my-model-q4_k_m"
   */
  inferModelName(modelPath: string): string {
    const base = basename(modelPath);
    // Remove common extensions
    return base.replace(/\.(gguf|ggml|bin|safetensors|pt)$/i, "");
  }
}
