// KCode - Model Availability Health Check

import { log } from "../../logger";
import type { HealthCheck } from "../health-score";

export async function checkModels(): Promise<HealthCheck> {
  try {
    const { loadModelsConfig, getDefaultModel } = await import("../../models");
    const config = await loadModelsConfig();
    const defaultModel = await getDefaultModel();

    if (config.models.length === 0) {
      return {
        name: "Models",
        category: "model",
        status: "warn",
        message: "No models registered",
        fix: "Run `kcode setup` to configure a model or set KCODE_API_KEY for cloud APIs",
        weight: 10,
      };
    }

    const entry = config.models.find((m) => m.name === defaultModel);
    if (!entry) {
      return {
        name: "Models",
        category: "model",
        status: "warn",
        message: `Default model "${defaultModel}" not found in registry (${config.models.length} other models available)`,
        fix: `Run \`kcode models set-default <model>\` to choose from available models`,
        weight: 10,
      };
    }

    return {
      name: "Models",
      category: "model",
      status: "pass",
      message: `${config.models.length} model(s) — default: ${defaultModel}`,
      weight: 10,
    };
  } catch (err) {
    log.debug("doctor/model-check", `Error: ${err}`);
    return {
      name: "Models",
      category: "model",
      status: "fail",
      message: "Could not load model configuration",
      fix: "Check ~/.kcode/models.json for JSON errors",
      weight: 10,
    };
  }
}
