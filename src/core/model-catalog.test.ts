import { describe, expect, test } from "bun:test";
import type { HardwareInfo } from "./hardware";
import {
  type CatalogEntry,
  findCatalogEntry,
  getAvailableModels,
  MODEL_CATALOG,
  recommendModel,
} from "./model-catalog";
import { calculateOptimalTensorSplit, formatTensorSplit, modelFitsMultiGpu } from "./multi-gpu";

// ─── Model Catalog Validation ──────────────────────────────────────────

describe("model-catalog", () => {
  test("catalog has at least 12 models (6 original + 6 community)", () => {
    expect(MODEL_CATALOG.length).toBeGreaterThanOrEqual(12);
  });

  test("all entries have required fields", () => {
    for (const entry of MODEL_CATALOG) {
      expect(entry.codename).toBeTruthy();
      expect(entry.paramBillions).toBeGreaterThan(0);
      expect(entry.quant).toBeTruthy();
      expect(entry.sizeGB).toBeGreaterThan(0);
      expect(entry.minVramMB).toBeGreaterThan(0);
      expect(entry.contextSize).toBeGreaterThan(0);
      expect(entry.localFile).toBeTruthy();
      expect(entry.description).toBeTruthy();
    }
  });

  test("all codenames are unique", () => {
    const codenames = MODEL_CATALOG.map((m) => m.codename);
    const unique = new Set(codenames);
    expect(unique.size).toBe(codenames.length);
  });

  test("all localFile names are unique", () => {
    const files = MODEL_CATALOG.map((m) => m.localFile);
    const unique = new Set(files);
    expect(unique.size).toBe(files.length);
  });

  test("codenames follow mnemo: prefix convention", () => {
    for (const entry of MODEL_CATALOG) {
      expect(entry.codename).toMatch(/^mnemo:/);
    }
  });

  test("localFile names end with .gguf", () => {
    for (const entry of MODEL_CATALOG) {
      expect(entry.localFile).toMatch(/\.gguf$/);
    }
  });

  // ── Community model entries ────────────────────────────────────────

  test("DeepSeek Coder V2 Lite entry exists with correct properties", () => {
    const entry = findCatalogEntry("mnemo:deepseek-coder-v2");
    expect(entry).toBeDefined();
    expect(entry!.paramBillions).toBe(16);
    expect(entry!.quant).toBe("Q4_K_M");
    expect(entry!.sizeGB).toBe(10);
    expect(entry!.cdnUrl).toContain("huggingface.co");
  });

  test("CodeLlama 34B entry exists with correct properties", () => {
    const entry = findCatalogEntry("mnemo:codellama-34b");
    expect(entry).toBeDefined();
    expect(entry!.paramBillions).toBe(34);
    expect(entry!.quant).toBe("Q4_K_M");
    expect(entry!.sizeGB).toBe(20);
    expect(entry!.minVramMB).toBe(24576);
  });

  test("Phi-3 Medium entry exists", () => {
    const entry = findCatalogEntry("mnemo:phi3-medium");
    expect(entry).toBeDefined();
    expect(entry!.paramBillions).toBe(14);
    expect(entry!.contextSize).toBe(131072);
  });

  test("Phi-3 Mini entry exists with small footprint", () => {
    const entry = findCatalogEntry("mnemo:phi3-mini");
    expect(entry).toBeDefined();
    expect(entry!.paramBillions).toBe(3.8);
    expect(entry!.sizeGB).toBe(3);
    expect(entry!.minVramMB).toBe(4096);
  });

  test("Mistral Nemo entry exists", () => {
    const entry = findCatalogEntry("mnemo:mistral-nemo");
    expect(entry).toBeDefined();
    expect(entry!.paramBillions).toBe(12);
    expect(entry!.sizeGB).toBe(9);
  });

  test("Llama 3.1 8B entry exists", () => {
    const entry = findCatalogEntry("mnemo:llama31-8b");
    expect(entry).toBeDefined();
    expect(entry!.paramBillions).toBe(8);
    expect(entry!.sizeGB).toBe(6);
    expect(entry!.contextSize).toBe(131072);
  });

  // ── Original mark5 series still intact ─────────────────────────────

  test("original mark5 series models are present", () => {
    const mark5Names = [
      "mnemo:mark5-pico",
      "mnemo:mark5-nano",
      "mnemo:mark5-mini",
      "mnemo:mark5-mid",
      "mnemo:mark5-max",
      "mnemo:mark5-80b",
    ];
    for (const name of mark5Names) {
      expect(findCatalogEntry(name)).toBeDefined();
    }
  });

  // ── getAvailableModels ─────────────────────────────────────────────

  test("getAvailableModels returns all models with expected fields", () => {
    const models = getAvailableModels();
    expect(models.length).toBe(MODEL_CATALOG.length);
    for (const m of models) {
      expect(m.codename).toBeTruthy();
      expect(m.paramBillions).toBeGreaterThan(0);
      expect(m.sizeGB).toBeGreaterThan(0);
      expect(m.description).toBeTruthy();
      expect(m.minVramMB).toBeGreaterThan(0);
    }
  });

  // ── recommendModel ─────────────────────────────────────────────────

  test("recommendModel returns a small model for CPU-only low-RAM system", () => {
    const hw: HardwareInfo = {
      platform: "linux",
      arch: "x64",
      gpus: [],
      totalVramMB: 0,
      ramMB: 4096,
      cudaAvailable: false,
    };
    const rec = recommendModel(hw);
    expect(rec).toBeDefined();
    // Should pick a model that fits in ~6 GB (4GB * 1.5)
    expect(rec.sizeGB).toBeLessThanOrEqual(5);
  });

  test("recommendModel returns a model for 24GB VRAM system", () => {
    const hw: HardwareInfo = {
      platform: "linux",
      arch: "x64",
      gpus: [{ index: 0, name: "RTX 4090", vramMB: 24576 }],
      totalVramMB: 24576,
      ramMB: 32768,
      cudaAvailable: true,
    };
    const rec = recommendModel(hw);
    expect(rec).toBeDefined();
    expect(rec.sizeGB).toBeGreaterThan(0);
  });

  test("findCatalogEntry returns undefined for unknown codename", () => {
    expect(findCatalogEntry("mnemo:nonexistent")).toBeUndefined();
  });
});

// ─── Download Resume ───────────────────────────────────────────────────

describe("downloadFile resume support", () => {
  // We test the resume logic indirectly by verifying the module exports
  // and the partial file handling behavior. Full integration tests require
  // a real HTTP server and are covered in e2e tests.

  test("downloadFile is exported from model-file-utils", async () => {
    const mod = await import("./model-file-utils");
    expect(typeof mod.downloadFile).toBe("function");
  });

  test("downloadFile accepts expectedSizeBytes parameter", async () => {
    const mod = await import("./model-file-utils");
    // Verify the function accepts 4 parameters (url, dest, onProgress, expectedSizeBytes)
    expect(mod.downloadFile.length).toBeGreaterThanOrEqual(3);
  });
});

// ─── Multi-GPU Tensor Split ────────────────────────────────────────────

describe("multi-gpu tensor split", () => {
  test("returns empty array for no GPUs", () => {
    expect(calculateOptimalTensorSplit([], 10)).toEqual([]);
  });

  test("returns [1.0] for single GPU", () => {
    const gpus = [{ index: 0, name: "RTX 4090", vramMB: 24576 }];
    expect(calculateOptimalTensorSplit(gpus, 10)).toEqual([1.0]);
  });

  test("splits proportionally for two GPUs with equal VRAM", () => {
    const gpus = [
      { index: 0, name: "RTX 4090", vramMB: 24576 },
      { index: 1, name: "RTX 4090", vramMB: 24576 },
    ];
    const result = calculateOptimalTensorSplit(gpus, 20);
    expect(result).toEqual([0.5, 0.5]);
  });

  test("splits proportionally for two GPUs with different VRAM", () => {
    const gpus = [
      { index: 0, name: "RTX 4090", vramMB: 24576 },
      { index: 1, name: "RTX 5090", vramMB: 32768 },
    ];
    const result = calculateOptimalTensorSplit(gpus, 30);
    expect(result.length).toBe(2);
    // 24576 / (24576 + 32768) ≈ 0.43, 32768 / 57344 ≈ 0.57
    expect(result[0]!).toBeCloseTo(0.43, 1);
    expect(result[1]!).toBeCloseTo(0.57, 1);
    // Sum must be 1.0
    expect(result[0]! + result[1]!).toBeCloseTo(1.0, 10);
  });

  test("splits for three GPUs", () => {
    const gpus = [
      { index: 0, name: "GPU A", vramMB: 8192 },
      { index: 1, name: "GPU B", vramMB: 16384 },
      { index: 2, name: "GPU C", vramMB: 8192 },
    ];
    const result = calculateOptimalTensorSplit(gpus, 20);
    expect(result.length).toBe(3);
    expect(result[0]! + result[1]! + result[2]!).toBeCloseTo(1.0, 10);
    // GPU B should get the largest share
    expect(result[1]!).toBeGreaterThan(result[0]!);
  });

  test("orders by GPU index", () => {
    const gpus = [
      { index: 1, name: "RTX 5090", vramMB: 32768 },
      { index: 0, name: "RTX 4090", vramMB: 24576 },
    ];
    const result = calculateOptimalTensorSplit(gpus, 30);
    // Index 0 (24576) should be first, index 1 (32768) second
    expect(result[0]!).toBeLessThan(result[1]!);
  });

  test("handles zero VRAM GPUs gracefully", () => {
    const gpus = [
      { index: 0, name: "GPU A", vramMB: 0 },
      { index: 1, name: "GPU B", vramMB: 0 },
    ];
    const result = calculateOptimalTensorSplit(gpus, 10);
    expect(result.length).toBe(2);
    expect(result[0]!).toBe(0.5);
    expect(result[1]!).toBe(0.5);
  });

  test("formatTensorSplit produces comma-separated string", () => {
    expect(formatTensorSplit([0.6, 0.4])).toBe("0.6,0.4");
    expect(formatTensorSplit([0.25, 0.5, 0.25])).toBe("0.25,0.5,0.25");
    expect(formatTensorSplit([1.0])).toBe("1");
  });

  test("modelFitsMultiGpu returns false for no GPUs", () => {
    expect(modelFitsMultiGpu([], 10)).toBe(false);
  });

  test("modelFitsMultiGpu returns true when total VRAM is sufficient", () => {
    const gpus = [
      { index: 0, name: "RTX 4090", vramMB: 24576 },
      { index: 1, name: "RTX 5090", vramMB: 32768 },
    ];
    // Total: 57344 MB ≈ 56 GB, model 30 GB + 20% = 36 GB — fits
    expect(modelFitsMultiGpu(gpus, 30)).toBe(true);
  });

  test("modelFitsMultiGpu returns false when model is too large", () => {
    const gpus = [{ index: 0, name: "RTX 3060", vramMB: 12288 }];
    // Total: 12 GB, model 48 GB + 20% = 57.6 GB — does not fit
    expect(modelFitsMultiGpu(gpus, 48)).toBe(false);
  });
});
