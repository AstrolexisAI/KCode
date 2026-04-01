// KCode - Hardware Optimizer
// Generates model recommendations and inference configuration based on detected hardware.

import { log } from "../logger";
import { getEffectiveMemoryForModels, getTotalVram } from "./profiles";
import type { HardwareProfile, LlamaCppConfig, ModelRecommendation } from "./types";

export class HardwareOptimizer {
  /**
   * Generate ranked model recommendations based on the detected hardware profile.
   * Returns recommendations sorted from best (highest quality) to most conservative.
   */
  recommend(profile: HardwareProfile): ModelRecommendation[] {
    const totalVram = getTotalVram(profile);
    const hasApple = profile.gpus.some((g) => g.vendor === "apple");
    const recommendations: ModelRecommendation[] = [];

    // === Apple Silicon (unified memory) ===
    if (hasApple) {
      const unifiedMem = profile.memory.totalGb; // Apple Silicon shares RAM with GPU
      if (unifiedMem >= 32) {
        recommendations.push({
          model: "qwen2.5-coder:32b-instruct-q4_K_M",
          quantization: "Q4_K_M",
          contextWindow: 16384,
          batchSize: 512,
          threads: profile.cpu.cores,
          gpuLayers: -1,
          estimatedTps: 20,
          vramRequired: 0,
          ramRequired: 22,
          reason: "Apple Silicon with MLX, unified memory — 32B model",
        });
      }
      if (unifiedMem >= 16) {
        recommendations.push({
          model: "qwen2.5-coder:14b-instruct-q4_K_M",
          quantization: "Q4_K_M",
          contextWindow: 16384,
          batchSize: 512,
          threads: profile.cpu.cores,
          gpuLayers: -1,
          estimatedTps: 30,
          vramRequired: 0,
          ramRequired: 10,
          reason: "Apple Silicon — 14B model fits comfortably in unified memory",
        });
      } else {
        recommendations.push({
          model: "qwen2.5-coder:7b-instruct-q4_K_M",
          quantization: "Q4_K_M",
          contextWindow: 8192,
          batchSize: 256,
          threads: profile.cpu.cores,
          gpuLayers: -1,
          estimatedTps: 40,
          vramRequired: 0,
          ramRequired: 5,
          reason: "Apple Silicon — 7B model for limited memory",
        });
      }
      return recommendations;
    }

    // === Tier 1: GPU with lots of VRAM (>= 24GB) ===
    if (totalVram >= 24) {
      recommendations.push({
        model: "qwen2.5-coder:32b-instruct-q4_K_M",
        quantization: "Q4_K_M",
        contextWindow: 16384,
        batchSize: 1024,
        threads: Math.min(profile.cpu.threads, 16),
        gpuLayers: -1,
        estimatedTps: 25,
        vramRequired: 20,
        ramRequired: 4,
        reason: "32B model on GPU, excellent code quality",
      });
    }

    // === Tier 2: Medium GPU (12-23GB) ===
    if (totalVram >= 12 && totalVram < 24) {
      recommendations.push({
        model: "qwen2.5-coder:14b-instruct-q4_K_M",
        quantization: "Q4_K_M",
        contextWindow: 16384,
        batchSize: 512,
        threads: Math.min(profile.cpu.threads, 12),
        gpuLayers: -1,
        estimatedTps: 35,
        vramRequired: 10,
        ramRequired: 4,
        reason: "14B model fully on GPU, good quality/speed balance",
      });
    }

    // === Tier 3: Small GPU (6-11GB) ===
    if (totalVram >= 6 && totalVram < 12) {
      recommendations.push({
        model: "qwen2.5-coder:7b-instruct-q5_K_M",
        quantization: "Q5_K_M",
        contextWindow: 8192,
        batchSize: 256,
        threads: Math.min(profile.cpu.threads, 8),
        gpuLayers: -1,
        estimatedTps: 50,
        vramRequired: 6,
        ramRequired: 2,
        reason: "7B model with high quantization for limited GPU",
      });
    }

    // === Tier 4: CPU-only (no usable GPU) ===
    if (totalVram < 6) {
      const availableRam = profile.memory.availableGb - 4; // Reserve 4GB for OS

      if (availableRam >= 16) {
        recommendations.push({
          model: "qwen2.5-coder:7b-instruct-q4_K_M",
          quantization: "Q4_K_M",
          contextWindow: 4096,
          batchSize: 128,
          threads: Math.min(profile.cpu.threads, 8),
          gpuLayers: 0,
          estimatedTps: 8,
          vramRequired: 0,
          ramRequired: 6,
          reason: "CPU-only, 7B model with reduced context",
        });
      } else {
        recommendations.push({
          model: "qwen2.5-coder:3b-instruct-q4_K_M",
          quantization: "Q4_K_M",
          contextWindow: 2048,
          batchSize: 64,
          threads: Math.min(profile.cpu.threads, 4),
          gpuLayers: 0,
          estimatedTps: 15,
          vramRequired: 0,
          ramRequired: 3,
          reason: "Compact model for limited hardware",
        });
      }
    }

    // Always add a smaller fallback option if we have a large recommendation
    if (recommendations.length > 0 && totalVram >= 12) {
      const existing = recommendations[recommendations.length - 1];
      if (existing.model.includes("32b") || existing.model.includes("14b")) {
        recommendations.push({
          model: "qwen2.5-coder:7b-instruct-q5_K_M",
          quantization: "Q5_K_M",
          contextWindow: 8192,
          batchSize: 256,
          threads: Math.min(profile.cpu.threads, 8),
          gpuLayers: -1,
          estimatedTps: totalVram >= 24 ? 80 : 50,
          vramRequired: 6,
          ramRequired: 2,
          reason: "Faster 7B alternative — higher speed, smaller model",
        });
      }
    }

    return recommendations;
  }

  /**
   * Generate an optimized llama.cpp server configuration from a recommendation.
   */
  generateLlamaCppConfig(
    recommendation: ModelRecommendation,
    profile: HardwareProfile,
  ): LlamaCppConfig {
    return {
      model: recommendation.model,
      contextSize: recommendation.contextWindow,
      batchSize: recommendation.batchSize,
      threads: recommendation.threads,
      gpuLayers: recommendation.gpuLayers,
      flashAttention: profile.gpus.some(
        (g) => g.vendor === "nvidia" && parseFloat(g.computeCapability || "0") >= 8.0,
      ),
      mmap: true,
      mlock: recommendation.ramRequired < profile.memory.availableGb * 0.5,
      numa: profile.cpu.threads > 16 ? "distribute" : "disable",
    };
  }

  /**
   * Generate optimized Ollama environment variables from a recommendation.
   */
  generateOllamaConfig(recommendation: ModelRecommendation): Record<string, string> {
    return {
      OLLAMA_NUM_PARALLEL: "2",
      OLLAMA_MAX_LOADED_MODELS: "1",
      OLLAMA_NUM_GPU: String(recommendation.gpuLayers),
      OLLAMA_FLASH_ATTENTION: "1",
    };
  }

  /**
   * Validate that a recommendation is feasible for the given hardware.
   * Returns an error string if infeasible, null if OK.
   */
  validateRecommendation(rec: ModelRecommendation, profile: HardwareProfile): string | null {
    const totalVram = getTotalVram(profile);
    const effectiveMem = getEffectiveMemoryForModels(profile);

    if (
      rec.gpuLayers !== 0 &&
      rec.vramRequired > totalVram &&
      !profile.gpus.some((g) => g.vendor === "apple")
    ) {
      return `Model requires ${rec.vramRequired}GB VRAM but only ${totalVram}GB available`;
    }

    if (rec.gpuLayers === 0 && rec.ramRequired > effectiveMem.cpuGb) {
      return `Model requires ${rec.ramRequired}GB RAM but only ${effectiveMem.cpuGb}GB available for models`;
    }

    if (rec.threads > profile.cpu.threads) {
      return `Configuration requests ${rec.threads} threads but only ${profile.cpu.threads} available`;
    }

    return null;
  }
}

// Singleton
let _optimizer: HardwareOptimizer | null = null;

export function getHardwareOptimizer(): HardwareOptimizer {
  if (!_optimizer) _optimizer = new HardwareOptimizer();
  return _optimizer;
}
