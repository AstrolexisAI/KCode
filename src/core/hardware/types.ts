// KCode - Hardware Auto-Optimizer Types
// Shared type definitions for hardware detection, optimization, and monitoring.

export interface CpuInfo {
  model: string;         // "AMD Ryzen 9 7950X"
  cores: number;         // 16
  threads: number;       // 32
  architecture: string;  // "x86_64" | "aarch64"
  features: string[];    // ["avx2", "avx512", "amx"]
}

export interface MemoryInfo {
  totalGb: number;       // 64
  availableGb: number;   // 48
}

export interface GpuInfo {
  vendor: "nvidia" | "amd" | "intel" | "apple";
  model: string;         // "RTX 4090"
  vramGb: number;        // 24
  computeCapability?: string; // "8.9" (CUDA)
  driver?: string;       // "535.129.03"
}

export interface StorageInfo {
  availableGb: number;
  type: "ssd" | "hdd" | "unknown";
}

export interface OsInfo {
  platform: string;      // "linux" | "darwin" | "win32"
  release: string;
  isWSL: boolean;
}

export interface HardwareProfile {
  cpu: CpuInfo;
  memory: MemoryInfo;
  gpus: GpuInfo[];
  storage: StorageInfo;
  os: OsInfo;
}

export interface ModelRecommendation {
  model: string;           // "qwen2.5-coder:32b-instruct-q4_K_M"
  quantization: string;    // "Q4_K_M"
  contextWindow: number;   // 8192
  batchSize: number;       // 512
  threads: number;         // 8
  gpuLayers: number;       // -1 (all)
  estimatedTps: number;    // tokens/second estimated
  vramRequired: number;    // GB
  ramRequired: number;     // GB
  reason: string;          // "Best balance for 24GB VRAM + 32GB RAM"
}

export interface LlamaCppConfig {
  model: string;
  contextSize: number;
  batchSize: number;
  threads: number;
  gpuLayers: number;
  flashAttention: boolean;
  mmap: boolean;
  mlock: boolean;
  numa: "distribute" | "disable";
}

export interface PerformanceMetrics {
  tokensPerSecond: number;
  timeToFirstToken: number;  // ms
  gpuUtilization?: number;   // 0-100%
  gpuMemoryUsed?: number;    // GB
  ramUsed: number;           // GB
  cpuUtilization: number;    // 0-100%
  timestamp?: number;        // epoch ms
}

export interface DegradationAlert {
  type: "tps_drop" | "ttft_increase" | "gpu_memory_high";
  message: string;
  severity: "warning" | "critical";
  currentValue: number;
  baselineValue: number;
}
