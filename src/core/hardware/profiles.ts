// KCode - Hardware Profiles
// Predefined hardware profiles for testing, benchmarking, and fallback recommendations.

import type { HardwareProfile, ModelRecommendation } from "./types";

/**
 * Named hardware profiles representing common user configurations.
 * Used for testing recommendations and as fallbacks when detection fails.
 */
export const HARDWARE_PROFILES = {
  // High-end desktop: dual GPU workstation
  "high-end-nvidia": {
    cpu: {
      model: "AMD Ryzen 9 7950X",
      cores: 16,
      threads: 32,
      architecture: "x86_64",
      features: ["avx2", "avx512f", "fma"],
    },
    memory: { totalGb: 64, availableGb: 48 },
    gpus: [
      {
        vendor: "nvidia",
        model: "NVIDIA GeForce RTX 4090",
        vramGb: 24,
        computeCapability: "8.9",
        driver: "535.129.03",
      },
    ],
    storage: { availableGb: 500, type: "ssd" },
    os: { platform: "linux", release: "6.5.0", isWSL: false },
  },

  // Mid-range desktop: single GPU
  "mid-range-nvidia": {
    cpu: {
      model: "Intel Core i7-13700K",
      cores: 8,
      threads: 16,
      architecture: "x86_64",
      features: ["avx2", "fma", "sse4_2"],
    },
    memory: { totalGb: 32, availableGb: 24 },
    gpus: [
      {
        vendor: "nvidia",
        model: "NVIDIA GeForce RTX 3060",
        vramGb: 12,
        computeCapability: "8.6",
        driver: "535.129.03",
      },
    ],
    storage: { availableGb: 200, type: "ssd" },
    os: { platform: "linux", release: "6.2.0", isWSL: false },
  },

  // Budget desktop: small GPU
  "budget-nvidia": {
    cpu: {
      model: "AMD Ryzen 5 5600X",
      cores: 6,
      threads: 12,
      architecture: "x86_64",
      features: ["avx2", "fma"],
    },
    memory: { totalGb: 16, availableGb: 12 },
    gpus: [
      {
        vendor: "nvidia",
        model: "NVIDIA GeForce RTX 3060",
        vramGb: 8,
        computeCapability: "8.6",
        driver: "535.129.03",
      },
    ],
    storage: { availableGb: 100, type: "ssd" },
    os: { platform: "linux", release: "6.1.0", isWSL: false },
  },

  // CPU-only machine with decent RAM
  "cpu-only-high-ram": {
    cpu: {
      model: "Intel Xeon E5-2690 v4",
      cores: 14,
      threads: 28,
      architecture: "x86_64",
      features: ["avx2", "fma", "sse4_2"],
    },
    memory: { totalGb: 64, availableGb: 48 },
    gpus: [],
    storage: { availableGb: 300, type: "ssd" },
    os: { platform: "linux", release: "5.15.0", isWSL: false },
  },

  // CPU-only with limited RAM
  "cpu-only-low-ram": {
    cpu: {
      model: "Intel Core i5-8400",
      cores: 6,
      threads: 6,
      architecture: "x86_64",
      features: ["avx2", "sse4_2"],
    },
    memory: { totalGb: 8, availableGb: 5 },
    gpus: [],
    storage: { availableGb: 50, type: "hdd" },
    os: { platform: "linux", release: "5.10.0", isWSL: false },
  },

  // Apple Silicon Mac
  "apple-m2-pro": {
    cpu: {
      model: "Apple M2 Pro",
      cores: 12,
      threads: 12,
      architecture: "aarch64",
      features: [],
    },
    memory: { totalGb: 32, availableGb: 24 },
    gpus: [
      {
        vendor: "apple",
        model: "Apple M2 Pro",
        vramGb: 0, // Unified memory
      },
    ],
    storage: { availableGb: 200, type: "ssd" },
    os: { platform: "darwin", release: "23.0.0", isWSL: false },
  },

  // Apple Silicon Mac with more memory
  "apple-m3-max": {
    cpu: {
      model: "Apple M3 Max",
      cores: 16,
      threads: 16,
      architecture: "aarch64",
      features: [],
    },
    memory: { totalGb: 64, availableGb: 48 },
    gpus: [
      {
        vendor: "apple",
        model: "Apple M3 Max",
        vramGb: 0, // Unified memory
      },
    ],
    storage: { availableGb: 500, type: "ssd" },
    os: { platform: "darwin", release: "24.0.0", isWSL: false },
  },

  // WSL setup
  "wsl-mid-range": {
    cpu: {
      model: "Intel Core i7-12700K",
      cores: 8,
      threads: 16,
      architecture: "x86_64",
      features: ["avx2", "fma", "sse4_2"],
    },
    memory: { totalGb: 16, availableGb: 10 },
    gpus: [
      {
        vendor: "nvidia",
        model: "NVIDIA GeForce RTX 3070",
        vramGb: 8,
        computeCapability: "8.6",
        driver: "535.129.03",
      },
    ],
    storage: { availableGb: 100, type: "ssd" },
    os: { platform: "linux", release: "5.15.90.1-microsoft-standard-WSL2", isWSL: true },
  },

  // Dual GPU setup
  "dual-gpu": {
    cpu: {
      model: "AMD Ryzen 9 9950X",
      cores: 16,
      threads: 32,
      architecture: "x86_64",
      features: ["avx2", "avx512f", "fma"],
    },
    memory: { totalGb: 128, availableGb: 96 },
    gpus: [
      {
        vendor: "nvidia",
        model: "NVIDIA GeForce RTX 4090",
        vramGb: 24,
        computeCapability: "8.9",
        driver: "550.54.14",
      },
      {
        vendor: "nvidia",
        model: "NVIDIA GeForce RTX 5090",
        vramGb: 32,
        computeCapability: "10.0",
        driver: "550.54.14",
      },
    ],
    storage: { availableGb: 1000, type: "ssd" },
    os: { platform: "linux", release: "6.8.0", isWSL: false },
  },
} satisfies Record<string, HardwareProfile>;

/**
 * Get a named hardware profile by key.
 */
export function getHardwareProfile(name: string): HardwareProfile | undefined {
  return HARDWARE_PROFILES[name];
}

/**
 * List all available profile names.
 */
export function listHardwareProfiles(): string[] {
  return Object.keys(HARDWARE_PROFILES);
}

/**
 * Compute the total VRAM across all GPUs in a profile.
 * For Apple Silicon, returns 0 (unified memory is tracked separately).
 */
export function getTotalVram(profile: HardwareProfile): number {
  return profile.gpus.filter((g) => g.vendor !== "apple").reduce((sum, g) => sum + g.vramGb, 0);
}

/**
 * Determine the effective available memory for model loading.
 * Apple Silicon uses unified memory (RAM), others use VRAM + RAM overflow.
 */
export function getEffectiveMemoryForModels(profile: HardwareProfile): {
  gpuGb: number;
  cpuGb: number;
} {
  const hasApple = profile.gpus.some((g) => g.vendor === "apple");
  if (hasApple) {
    // Apple Silicon: unified memory, reserve 4GB for OS
    const available = Math.max(0, profile.memory.availableGb - 4);
    return { gpuGb: available, cpuGb: 0 };
  }

  const totalVram = getTotalVram(profile);
  // Reserve 4GB of RAM for OS
  const availableRam = Math.max(0, profile.memory.availableGb - 4);
  return { gpuGb: totalVram, cpuGb: availableRam };
}
