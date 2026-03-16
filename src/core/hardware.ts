// KCode - Hardware Detection
// Detects GPUs, VRAM, RAM, platform, and CUDA availability

import { log } from "./logger";

export interface GpuInfo {
  name: string;
  vramMB: number;
  index: number;
}

export interface HardwareInfo {
  platform: "linux" | "darwin" | "win32";
  arch: "x64" | "arm64";
  gpus: GpuInfo[];
  totalVramMB: number;
  ramMB: number;
  cudaAvailable: boolean;
  cudaVersion?: string;
}

/** Detect hardware capabilities (GPUs, VRAM, RAM, platform) */
export async function detectHardware(): Promise<HardwareInfo> {
  const platform = process.platform as "linux" | "darwin" | "win32";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const ramMB = Math.round(require("node:os").totalmem() / (1024 * 1024));

  let gpus: GpuInfo[] = [];
  let cudaAvailable = false;
  let cudaVersion: string | undefined;

  if (platform === "darwin") {
    gpus = await detectMacGpu(ramMB);
  } else {
    const nvidiaResult = await detectNvidiaGpus();
    gpus = nvidiaResult.gpus;
    cudaAvailable = nvidiaResult.cudaAvailable;
    cudaVersion = nvidiaResult.cudaVersion;
  }

  const totalVramMB = gpus.reduce((sum, g) => sum + g.vramMB, 0);

  const info: HardwareInfo = {
    platform,
    arch,
    gpus,
    totalVramMB,
    ramMB,
    cudaAvailable,
    cudaVersion,
  };

  log.debug("hardware", `Detected: ${gpus.length} GPU(s), ${totalVramMB}MB VRAM, ${ramMB}MB RAM, CUDA: ${cudaAvailable}`);
  return info;
}

/** Detect NVIDIA GPUs via nvidia-smi */
async function detectNvidiaGpus(): Promise<{ gpus: GpuInfo[]; cudaAvailable: boolean; cudaVersion?: string }> {
  try {
    // Try common nvidia-smi paths per platform (not always in PATH, especially via SSH)
    const nvidiaSmiPaths: string[] = process.platform === "win32"
      ? [
          "nvidia-smi",
          "C:\\Windows\\System32\\nvidia-smi.exe",
          "C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe",
        ]
      : [
          "nvidia-smi",
          "/usr/bin/nvidia-smi",
          "/usr/local/bin/nvidia-smi",
          "/usr/local/cuda/bin/nvidia-smi",
          "/opt/cuda/bin/nvidia-smi",
        ];

    let proc: ReturnType<typeof Bun.spawnSync> | null = null;
    const env = { ...process.env, PATH: `/usr/bin:/usr/local/bin:/usr/local/cuda/bin:${process.env.PATH ?? ""}` };
    for (const smiPath of nvidiaSmiPaths) {
      const attempt = Bun.spawnSync(
        [smiPath, "--query-gpu=index,name,memory.total", "--format=csv,noheader,nounits"],
        { stdout: "pipe", stderr: "pipe", env },
      );
      if (attempt.exitCode === 0) {
        proc = attempt;
        break;
      }
    }

    if (!proc || proc.exitCode !== 0) {
      return { gpus: [], cudaAvailable: false };
    }

    const output = proc.stdout.toString().trim();
    const gpus: GpuInfo[] = [];

    for (const line of output.split("\n")) {
      const parts = line.split(",").map((s) => s.trim());
      if (parts.length >= 3) {
        gpus.push({
          index: parseInt(parts[0], 10),
          name: parts[1],
          vramMB: parseInt(parts[2], 10),
        });
      }
    }

    // Get CUDA version
    let cudaVersion: string | undefined;
    const cudaProc = Bun.spawnSync(
      ["nvidia-smi", "--query-gpu=driver_version", "--format=csv,noheader"],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (cudaProc.exitCode === 0) {
      // Also check nvcc for CUDA toolkit version
      const nvccProc = Bun.spawnSync(["nvcc", "--version"], { stdout: "pipe", stderr: "pipe" });
      if (nvccProc.exitCode === 0) {
        const nvccOut = nvccProc.stdout.toString();
        const vMatch = nvccOut.match(/release (\d+\.\d+)/);
        if (vMatch) cudaVersion = vMatch[1];
      }
    }

    return { gpus, cudaAvailable: gpus.length > 0, cudaVersion };
  } catch {
    return { gpus: [], cudaAvailable: false };
  }
}

/** Detect macOS GPU (Metal - unified memory) */
async function detectMacGpu(ramMB: number): Promise<GpuInfo[]> {
  try {
    const proc = Bun.spawnSync(
      ["system_profiler", "SPDisplaysDataType", "-json"],
      { stdout: "pipe", stderr: "pipe" },
    );

    if (proc.exitCode !== 0) {
      // Fallback: assume Apple Silicon with shared memory
      return [{ index: 0, name: "Apple Silicon (Metal)", vramMB: Math.round(ramMB * 0.75) }];
    }

    const data = JSON.parse(proc.stdout.toString());
    const displays = data?.SPDisplaysDataType;
    if (!Array.isArray(displays) || displays.length === 0) {
      return [{ index: 0, name: "Apple Silicon (Metal)", vramMB: Math.round(ramMB * 0.75) }];
    }

    const gpu = displays[0];
    const name = gpu.sppci_model ?? "Apple GPU";
    // On Apple Silicon, GPU uses unified memory — ~75% available for ML
    const vramMB = Math.round(ramMB * 0.75);

    return [{ index: 0, name, vramMB }];
  } catch {
    return [{ index: 0, name: "Apple Silicon (Metal)", vramMB: Math.round(ramMB * 0.75) }];
  }
}

/** Format hardware info for display */
export function formatHardware(hw: HardwareInfo): string {
  const lines: string[] = [];
  lines.push(`Platform: ${hw.platform} ${hw.arch}`);
  lines.push(`RAM: ${(hw.ramMB / 1024).toFixed(0)} GB`);

  if (hw.gpus.length === 0) {
    lines.push("GPU: None detected (CPU mode)");
  } else {
    for (const gpu of hw.gpus) {
      lines.push(`GPU ${gpu.index}: ${gpu.name} (${(gpu.vramMB / 1024).toFixed(0)} GB VRAM)`);
    }
    lines.push(`Total VRAM: ${(hw.totalVramMB / 1024).toFixed(0)} GB`);
  }

  if (hw.cudaAvailable) {
    lines.push(`CUDA: ${hw.cudaVersion ?? "available"}`);
  }

  return lines.join("\n");
}
