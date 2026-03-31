import { test, expect, describe } from "bun:test";
import { HardwareOptimizer, getHardwareOptimizer } from "./optimizer";
import { HARDWARE_PROFILES } from "./profiles";
import type { HardwareProfile, ModelRecommendation } from "./types";

describe("HardwareOptimizer", () => {
  const optimizer = new HardwareOptimizer();

  // ─── recommend() ──────────────────────────────────────────────

  describe("recommend()", () => {
    test("high-end NVIDIA recommends 32B model first", () => {
      const recs = optimizer.recommend(HARDWARE_PROFILES["high-end-nvidia"]);
      expect(recs.length).toBeGreaterThan(0);
      expect(recs[0].model).toContain("32b");
      expect(recs[0].gpuLayers).toBe(-1);
      expect(recs[0].contextWindow).toBe(16384);
    });

    test("mid-range NVIDIA recommends 14B model", () => {
      const recs = optimizer.recommend(HARDWARE_PROFILES["mid-range-nvidia"]);
      expect(recs.length).toBeGreaterThan(0);
      expect(recs[0].model).toContain("14b");
      expect(recs[0].gpuLayers).toBe(-1);
    });

    test("budget NVIDIA recommends 7B model", () => {
      const recs = optimizer.recommend(HARDWARE_PROFILES["budget-nvidia"]);
      expect(recs.length).toBeGreaterThan(0);
      expect(recs[0].model).toContain("7b");
    });

    test("CPU-only high RAM recommends 7B CPU model", () => {
      const recs = optimizer.recommend(HARDWARE_PROFILES["cpu-only-high-ram"]);
      expect(recs.length).toBeGreaterThan(0);
      expect(recs[0].model).toContain("7b");
      expect(recs[0].gpuLayers).toBe(0);
      expect(recs[0].contextWindow).toBe(4096);
    });

    test("CPU-only low RAM recommends 3B model", () => {
      const recs = optimizer.recommend(HARDWARE_PROFILES["cpu-only-low-ram"]);
      expect(recs.length).toBeGreaterThan(0);
      expect(recs[0].model).toContain("3b");
      expect(recs[0].gpuLayers).toBe(0);
      expect(recs[0].contextWindow).toBe(2048);
    });

    test("Apple Silicon M2 Pro (32GB) recommends 32B model", () => {
      const recs = optimizer.recommend(HARDWARE_PROFILES["apple-m2-pro"]);
      expect(recs.length).toBeGreaterThan(0);
      // M2 Pro with 32GB -> should get 32B and 14B recommendations
      expect(recs[0].model).toContain("32b");
      expect(recs[0].reason).toContain("Apple Silicon");
    });

    test("Apple Silicon M3 Max (64GB) recommends 32B model first", () => {
      const recs = optimizer.recommend(HARDWARE_PROFILES["apple-m3-max"]);
      expect(recs.length).toBeGreaterThan(0);
      expect(recs[0].model).toContain("32b");
    });

    test("dual GPU recommends 32B model", () => {
      const recs = optimizer.recommend(HARDWARE_PROFILES["dual-gpu"]);
      expect(recs.length).toBeGreaterThan(0);
      expect(recs[0].model).toContain("32b");
      // 24+32=56GB total VRAM, easily fits 32B
      expect(recs[0].vramRequired).toBeLessThanOrEqual(56);
    });

    test("WSL mid-range recommends 7B model", () => {
      const recs = optimizer.recommend(HARDWARE_PROFILES["wsl-mid-range"]);
      expect(recs.length).toBeGreaterThan(0);
      expect(recs[0].model).toContain("7b");
    });

    test("all profiles produce at least one recommendation", () => {
      for (const [name, profile] of Object.entries(HARDWARE_PROFILES)) {
        const recs = optimizer.recommend(profile);
        expect(recs.length).toBeGreaterThan(0);
      }
    });

    test("recommendations have valid fields", () => {
      for (const [name, profile] of Object.entries(HARDWARE_PROFILES)) {
        const recs = optimizer.recommend(profile);
        for (const rec of recs) {
          expect(typeof rec.model).toBe("string");
          expect(rec.model.length).toBeGreaterThan(0);
          expect(typeof rec.quantization).toBe("string");
          expect(rec.contextWindow).toBeGreaterThan(0);
          expect(rec.batchSize).toBeGreaterThan(0);
          expect(rec.threads).toBeGreaterThan(0);
          expect(typeof rec.gpuLayers).toBe("number");
          expect(rec.estimatedTps).toBeGreaterThan(0);
          expect(rec.vramRequired).toBeGreaterThanOrEqual(0);
          expect(rec.ramRequired).toBeGreaterThanOrEqual(0);
          expect(typeof rec.reason).toBe("string");
          expect(rec.reason.length).toBeGreaterThan(0);
        }
      }
    });

    test("CPU-only models always set gpuLayers to 0", () => {
      const cpuProfiles = [
        HARDWARE_PROFILES["cpu-only-high-ram"],
        HARDWARE_PROFILES["cpu-only-low-ram"],
      ];
      for (const profile of cpuProfiles) {
        const recs = optimizer.recommend(profile);
        for (const rec of recs) {
          expect(rec.gpuLayers).toBe(0);
        }
      }
    });

    test("threads never exceed available threads", () => {
      for (const [name, profile] of Object.entries(HARDWARE_PROFILES)) {
        const recs = optimizer.recommend(profile);
        for (const rec of recs) {
          expect(rec.threads).toBeLessThanOrEqual(profile.cpu.threads);
        }
      }
    });

    test("high-end profiles include a faster fallback option", () => {
      const recs = optimizer.recommend(HARDWARE_PROFILES["high-end-nvidia"]);
      // Should have at least 2 recommendations: 32B + 7B fallback
      expect(recs.length).toBeGreaterThanOrEqual(2);
      const last = recs[recs.length - 1];
      expect(last.model).toContain("7b");
    });

    test("Apple Silicon with 16GB recommends 14B", () => {
      const appleProfile: HardwareProfile = {
        cpu: { model: "Apple M1", cores: 8, threads: 8, architecture: "aarch64", features: [] },
        memory: { totalGb: 16, availableGb: 12 },
        gpus: [{ vendor: "apple", model: "Apple M1", vramGb: 0 }],
        storage: { availableGb: 100, type: "ssd" },
        os: { platform: "darwin", release: "22.0.0", isWSL: false },
      };
      const recs = optimizer.recommend(appleProfile);
      expect(recs.length).toBeGreaterThan(0);
      expect(recs[0].model).toContain("14b");
    });

    test("Apple Silicon with 8GB recommends 7B", () => {
      const appleProfile: HardwareProfile = {
        cpu: { model: "Apple M1", cores: 8, threads: 8, architecture: "aarch64", features: [] },
        memory: { totalGb: 8, availableGb: 5 },
        gpus: [{ vendor: "apple", model: "Apple M1", vramGb: 0 }],
        storage: { availableGb: 50, type: "ssd" },
        os: { platform: "darwin", release: "22.0.0", isWSL: false },
      };
      const recs = optimizer.recommend(appleProfile);
      expect(recs.length).toBeGreaterThan(0);
      expect(recs[0].model).toContain("7b");
    });
  });

  // ─── generateLlamaCppConfig() ─────────────────────────────────

  describe("generateLlamaCppConfig()", () => {
    test("generates valid config for high-end NVIDIA", () => {
      const profile = HARDWARE_PROFILES["high-end-nvidia"];
      const recs = optimizer.recommend(profile);
      const config = optimizer.generateLlamaCppConfig(recs[0], profile);

      expect(config.model).toBe(recs[0].model);
      expect(config.contextSize).toBe(recs[0].contextWindow);
      expect(config.batchSize).toBe(recs[0].batchSize);
      expect(config.threads).toBe(recs[0].threads);
      expect(config.gpuLayers).toBe(recs[0].gpuLayers);
      expect(config.mmap).toBe(true);
    });

    test("enables flash attention for NVIDIA with CC >= 8.0", () => {
      const profile = HARDWARE_PROFILES["high-end-nvidia"];
      const recs = optimizer.recommend(profile);
      const config = optimizer.generateLlamaCppConfig(recs[0], profile);

      expect(config.flashAttention).toBe(true);
    });

    test("disables flash attention when no NVIDIA GPU", () => {
      const profile = HARDWARE_PROFILES["cpu-only-high-ram"];
      const recs = optimizer.recommend(profile);
      const config = optimizer.generateLlamaCppConfig(recs[0], profile);

      expect(config.flashAttention).toBe(false);
    });

    test("enables NUMA distribute for high-thread-count CPUs", () => {
      const profile = HARDWARE_PROFILES["high-end-nvidia"]; // 32 threads
      const recs = optimizer.recommend(profile);
      const config = optimizer.generateLlamaCppConfig(recs[0], profile);

      expect(config.numa).toBe("distribute");
    });

    test("disables NUMA for low-thread-count CPUs", () => {
      const profile = HARDWARE_PROFILES["budget-nvidia"]; // 12 threads
      const recs = optimizer.recommend(profile);
      const config = optimizer.generateLlamaCppConfig(recs[0], profile);

      expect(config.numa).toBe("disable");
    });

    test("mlock is true when RAM requirement is under half of available", () => {
      const profile = HARDWARE_PROFILES["high-end-nvidia"]; // 48GB available
      const recs = optimizer.recommend(profile);
      // rec needs 4GB RAM, 4 < 48*0.5=24, so mlock=true
      const config = optimizer.generateLlamaCppConfig(recs[0], profile);
      expect(config.mlock).toBe(true);
    });
  });

  // ─── generateOllamaConfig() ───────────────────────────────────

  describe("generateOllamaConfig()", () => {
    test("returns expected env vars", () => {
      const recs = optimizer.recommend(HARDWARE_PROFILES["high-end-nvidia"]);
      const config = optimizer.generateOllamaConfig(recs[0]);

      expect(config.OLLAMA_NUM_PARALLEL).toBe("2");
      expect(config.OLLAMA_MAX_LOADED_MODELS).toBe("1");
      expect(config.OLLAMA_NUM_GPU).toBe(String(recs[0].gpuLayers));
      expect(config.OLLAMA_FLASH_ATTENTION).toBe("1");
    });

    test("CPU-only sets OLLAMA_NUM_GPU to 0", () => {
      const recs = optimizer.recommend(HARDWARE_PROFILES["cpu-only-high-ram"]);
      const config = optimizer.generateOllamaConfig(recs[0]);
      expect(config.OLLAMA_NUM_GPU).toBe("0");
    });
  });

  // ─── validateRecommendation() ─────────────────────────────────

  describe("validateRecommendation()", () => {
    test("valid recommendation returns null", () => {
      const profile = HARDWARE_PROFILES["high-end-nvidia"];
      const recs = optimizer.recommend(profile);
      const error = optimizer.validateRecommendation(recs[0], profile);
      expect(error).toBeNull();
    });

    test("detects VRAM shortage", () => {
      const profile = HARDWARE_PROFILES["budget-nvidia"]; // 8GB VRAM
      const bigRec: ModelRecommendation = {
        model: "qwen2.5-coder:32b-instruct-q4_K_M",
        quantization: "Q4_K_M",
        contextWindow: 16384,
        batchSize: 1024,
        threads: 8,
        gpuLayers: -1,
        estimatedTps: 25,
        vramRequired: 20,
        ramRequired: 4,
        reason: "Too big for this GPU",
      };
      const error = optimizer.validateRecommendation(bigRec, profile);
      expect(error).not.toBeNull();
      expect(error).toContain("VRAM");
    });

    test("detects thread count too high", () => {
      const profile = HARDWARE_PROFILES["cpu-only-high-ram"]; // 28 threads, plenty of RAM
      const rec: ModelRecommendation = {
        model: "test:model",
        quantization: "Q4_K_M",
        contextWindow: 4096,
        batchSize: 128,
        threads: 64, // way too many
        gpuLayers: 0,
        estimatedTps: 8,
        vramRequired: 0,
        ramRequired: 3,
        reason: "Test",
      };
      const error = optimizer.validateRecommendation(rec, profile);
      expect(error).not.toBeNull();
      expect(error).toContain("threads");
    });

    test("detects RAM shortage for CPU-only models", () => {
      const profile = HARDWARE_PROFILES["cpu-only-low-ram"]; // 5GB available, 4GB reserved = 1GB
      const rec: ModelRecommendation = {
        model: "test:model",
        quantization: "Q4_K_M",
        contextWindow: 4096,
        batchSize: 128,
        threads: 4,
        gpuLayers: 0,
        estimatedTps: 8,
        vramRequired: 0,
        ramRequired: 10, // needs 10GB RAM
        reason: "Test",
      };
      const error = optimizer.validateRecommendation(rec, profile);
      expect(error).not.toBeNull();
      expect(error).toContain("RAM");
    });
  });

  // ─── Singleton ────────────────────────────────────────────────

  describe("getHardwareOptimizer()", () => {
    test("returns same instance", () => {
      const o1 = getHardwareOptimizer();
      const o2 = getHardwareOptimizer();
      expect(o1).toBe(o2);
    });
  });
});
