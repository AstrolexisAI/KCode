import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// We need to test the module's internal functions.
// Since parseModelsConfig is not exported, we test it indirectly through loadModelsConfig.
// The exported API: loadModelsConfig, saveModelsConfig, getModelBaseUrl, getModelContextSize,
// getDefaultModel, findModel, listModels, addModel, removeModel, setDefaultModel, invalidateCache.

import {
  invalidateCache,
  loadModelsConfig,
  saveModelsConfig,
  getModelBaseUrl,
  getModelContextSize,
  getDefaultModel,
  findModel,
  listModels,
  addModel,
  removeModel,
  setDefaultModel,
  type ModelEntry,
  type ModelsConfig,
} from "./models.ts";

// Since models.ts reads from a hardcoded path (~/.kcode/models.json),
// we need to test parseModelsConfig behavior by writing to that path
// and using invalidateCache + loadModelsConfig.
// For isolation, we'll save/restore any existing config.

const KCODE_HOME = join(process.env.HOME ?? "/tmp", ".kcode");
const MODELS_PATH = join(KCODE_HOME, "models.json");

let originalConfig: string | null = null;

async function saveOriginal() {
  try {
    const file = Bun.file(MODELS_PATH);
    if (await file.exists()) {
      originalConfig = await file.text();
    } else {
      originalConfig = null;
    }
  } catch {
    originalConfig = null;
  }
}

async function restoreOriginal() {
  invalidateCache();
  if (originalConfig !== null) {
    await Bun.write(MODELS_PATH, originalConfig);
  } else {
    // Remove the file if it didn't exist before
    try {
      await rm(MODELS_PATH, { force: true });
    } catch {}
  }
}

async function writeModelsJson(data: unknown) {
  await mkdir(KCODE_HOME, { recursive: true });
  await Bun.write(MODELS_PATH, JSON.stringify(data));
  invalidateCache();
}

async function removeModelsJson() {
  try {
    await rm(MODELS_PATH, { force: true });
  } catch {}
  invalidateCache();
}

describe("models", () => {
  beforeEach(async () => {
    await saveOriginal();
  });

  afterEach(async () => {
    await restoreOriginal();
  });

  // ─── parseModelsConfig (tested indirectly via loadModelsConfig) ───

  describe("parseModelsConfig via loadModelsConfig", () => {
    test("valid config with multiple models", async () => {
      await writeModelsJson({
        models: [
          { name: "model-a", baseUrl: "http://a:10080", contextSize: 4096 },
          { name: "model-b", baseUrl: "http://b:10080", capabilities: ["code", "vision"] },
        ],
        defaultModel: "model-a",
      });

      const config = await loadModelsConfig();
      expect(config.models).toHaveLength(2);
      expect(config.models[0]!.name).toBe("model-a");
      expect(config.models[0]!.baseUrl).toBe("http://a:10080");
      expect(config.models[0]!.contextSize).toBe(4096);
      expect(config.models[1]!.name).toBe("model-b");
      expect(config.models[1]!.capabilities).toEqual(["code", "vision"]);
      expect(config.defaultModel).toBe("model-a");
    });

    test("invalid entries are skipped (missing name or baseUrl)", async () => {
      await writeModelsJson({
        models: [
          { baseUrl: "http://no-name:10080" }, // missing name
          { name: "no-url" }, // missing baseUrl
          { name: 123, baseUrl: "http://bad:10080" }, // name not string
          { name: "valid", baseUrl: "http://ok:10080" },
        ],
      });

      const config = await loadModelsConfig();
      expect(config.models).toHaveLength(1);
      expect(config.models[0]!.name).toBe("valid");
    });

    test("empty models array", async () => {
      await writeModelsJson({ models: [] });
      const config = await loadModelsConfig();
      expect(config.models).toHaveLength(0);
      expect(config.defaultModel).toBeUndefined();
    });

    test("missing models key returns empty array", async () => {
      await writeModelsJson({ something: "else" });
      const config = await loadModelsConfig();
      expect(config.models).toHaveLength(0);
    });

    test("non-existent file returns empty config", async () => {
      await removeModelsJson();
      const config = await loadModelsConfig();
      expect(config.models).toHaveLength(0);
      expect(config.defaultModel).toBeUndefined();
    });

    test("invalid JSON file returns empty config", async () => {
      await mkdir(KCODE_HOME, { recursive: true });
      await Bun.write(MODELS_PATH, "not valid json{{{");
      invalidateCache();
      const config = await loadModelsConfig();
      expect(config.models).toHaveLength(0);
    });

    test("optional fields: gpu, description, capabilities handled correctly", async () => {
      await writeModelsJson({
        models: [
          {
            name: "full",
            baseUrl: "http://full:10080",
            contextSize: 8192,
            capabilities: ["code"],
            gpu: "RTX 5090",
            description: "A test model",
          },
        ],
      });

      const config = await loadModelsConfig();
      const m = config.models[0]!;
      expect(m.gpu).toBe("RTX 5090");
      expect(m.description).toBe("A test model");
      expect(m.capabilities).toEqual(["code"]);
      expect(m.contextSize).toBe(8192);
    });

    test("non-number contextSize is ignored", async () => {
      await writeModelsJson({
        models: [{ name: "m", baseUrl: "http://m:10080", contextSize: "big" }],
      });
      const config = await loadModelsConfig();
      expect(config.models[0]!.contextSize).toBeUndefined();
    });

    test("non-string defaultModel is ignored", async () => {
      await writeModelsJson({
        models: [],
        defaultModel: 42,
      });
      const config = await loadModelsConfig();
      expect(config.defaultModel).toBeUndefined();
    });
  });

  // ─── addModel ───

  describe("addModel", () => {
    test("adds a new model", async () => {
      await writeModelsJson({ models: [] });
      await addModel({ name: "new-model", baseUrl: "http://new:10080" });

      invalidateCache();
      const config = await loadModelsConfig();
      expect(config.models).toHaveLength(1);
      expect(config.models[0]!.name).toBe("new-model");
    });

    test("updates existing model with same name", async () => {
      await writeModelsJson({
        models: [{ name: "existing", baseUrl: "http://old:10080" }],
      });

      await addModel({ name: "existing", baseUrl: "http://updated:9090", contextSize: 16384 });

      invalidateCache();
      const config = await loadModelsConfig();
      expect(config.models).toHaveLength(1);
      expect(config.models[0]!.baseUrl).toBe("http://updated:9090");
      expect(config.models[0]!.contextSize).toBe(16384);
    });
  });

  // ─── removeModel ───

  describe("removeModel", () => {
    test("removes existing model and returns true", async () => {
      await writeModelsJson({
        models: [
          { name: "keep", baseUrl: "http://keep:10080" },
          { name: "remove-me", baseUrl: "http://rm:10080" },
        ],
      });

      const result = await removeModel("remove-me");
      expect(result).toBe(true);

      invalidateCache();
      const config = await loadModelsConfig();
      expect(config.models).toHaveLength(1);
      expect(config.models[0]!.name).toBe("keep");
    });

    test("returns false for non-existent model", async () => {
      await writeModelsJson({ models: [] });
      const result = await removeModel("ghost");
      expect(result).toBe(false);
    });

    test("clears defaultModel if removed model was default", async () => {
      await writeModelsJson({
        models: [{ name: "default-one", baseUrl: "http://d:10080" }],
        defaultModel: "default-one",
      });

      await removeModel("default-one");

      invalidateCache();
      const config = await loadModelsConfig();
      expect(config.defaultModel).toBeUndefined();
    });
  });

  // ─── getModelBaseUrl ───

  describe("getModelBaseUrl", () => {
    test("returns baseUrl for registered model", async () => {
      await writeModelsJson({
        models: [{ name: "local-llm", baseUrl: "http://local:11434" }],
      });

      const url = await getModelBaseUrl("local-llm");
      expect(url).toBe("http://local:11434");
    });

    test("registry entry takes priority over configBase", async () => {
      await writeModelsJson({
        models: [{ name: "local-llm", baseUrl: "http://local:11434" }],
      });

      const url = await getModelBaseUrl("local-llm", "http://override:9999");
      expect(url).toBe("http://local:11434");
    });

    test("configBase used for models not in registry", async () => {
      await writeModelsJson({ models: [] });

      const url = await getModelBaseUrl("unregistered-model", "http://override:9999");
      expect(url).toBe("http://override:9999");
    });

    test("falls back to KCODE_API_BASE env var for unregistered model", async () => {
      await writeModelsJson({ models: [] });

      const original = process.env.KCODE_API_BASE;
      process.env.KCODE_API_BASE = "http://env-base:7777";
      try {
        const url = await getModelBaseUrl("unknown-model");
        expect(url).toBe("http://env-base:7777");
      } finally {
        if (original !== undefined) {
          process.env.KCODE_API_BASE = original;
        } else {
          delete process.env.KCODE_API_BASE;
        }
      }
    });

    test("falls back to localhost:10091 when no env var and unregistered", async () => {
      await writeModelsJson({ models: [] });

      const original = process.env.KCODE_API_BASE;
      delete process.env.KCODE_API_BASE;
      try {
        const url = await getModelBaseUrl("unknown-model");
        expect(url).toBe("http://localhost:10091");
      } finally {
        if (original !== undefined) {
          process.env.KCODE_API_BASE = original;
        }
      }
    });
  });

  // ─── getModelContextSize ───

  describe("getModelContextSize", () => {
    test("returns contextSize for registered model", async () => {
      await writeModelsJson({
        models: [{ name: "big-model", baseUrl: "http://b:10080", contextSize: 32768 }],
      });

      const size = await getModelContextSize("big-model");
      expect(size).toBe(32768);
    });

    test("returns undefined for unregistered model", async () => {
      await writeModelsJson({ models: [] });
      const size = await getModelContextSize("nope");
      expect(size).toBeUndefined();
    });

    test("returns undefined when model has no contextSize", async () => {
      await writeModelsJson({
        models: [{ name: "no-ctx", baseUrl: "http://n:10080" }],
      });

      const size = await getModelContextSize("no-ctx");
      expect(size).toBeUndefined();
    });
  });

  // ─── setDefaultModel / getDefaultModel ───

  describe("setDefaultModel / getDefaultModel", () => {
    test("sets and retrieves default model", async () => {
      await writeModelsJson({ models: [] });

      await setDefaultModel("my-default");
      invalidateCache();
      const def = await getDefaultModel();
      expect(def).toBe("my-default");
    });

    test("returns mnemo:code3 when no default is set", async () => {
      await writeModelsJson({ models: [] });
      const def = await getDefaultModel();
      expect(def).toBe("mnemo:code3");
    });
  });

  // ─── invalidateCache ───

  describe("invalidateCache", () => {
    test("forces re-read from disk", async () => {
      await writeModelsJson({
        models: [{ name: "first", baseUrl: "http://first:10080" }],
      });

      // Load into cache
      const config1 = await loadModelsConfig();
      expect(config1.models).toHaveLength(1);

      // Write different data directly
      await Bun.write(
        MODELS_PATH,
        JSON.stringify({
          models: [
            { name: "first", baseUrl: "http://first:10080" },
            { name: "second", baseUrl: "http://second:10080" },
          ],
        }),
      );

      // Without invalidation, cache returns old data
      const config2 = await loadModelsConfig();
      expect(config2.models).toHaveLength(1);

      // After invalidation, fresh data
      invalidateCache();
      const config3 = await loadModelsConfig();
      expect(config3.models).toHaveLength(2);
    });
  });

  // ─── findModel / listModels ───

  describe("findModel", () => {
    test("finds existing model", async () => {
      await writeModelsJson({
        models: [{ name: "target", baseUrl: "http://t:10080", description: "found" }],
      });
      const m = await findModel("target");
      expect(m).toBeDefined();
      expect(m!.description).toBe("found");
    });

    test("returns undefined for missing model", async () => {
      await writeModelsJson({ models: [] });
      const m = await findModel("nope");
      expect(m).toBeUndefined();
    });
  });

  describe("listModels", () => {
    test("returns all registered models", async () => {
      await writeModelsJson({
        models: [
          { name: "a", baseUrl: "http://a:10080" },
          { name: "b", baseUrl: "http://b:10080" },
        ],
      });
      const models = await listModels();
      expect(models).toHaveLength(2);
    });
  });
});
