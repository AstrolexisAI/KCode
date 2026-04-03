// KCode - Hardware Detection
// Detects GPUs, VRAM, RAM, platform, and CUDA availability

import { log } from "./logger";

export interface GpuInfo {
  name: string;
  vramMB: number;
  index: number;
  /** CUDA compute capability (e.g. "8.9" for RTX 4090, "12.0" for RTX 5090) */
  computeCapability?: string;
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

  log.debug(
    "hardware",
    `Detected: ${gpus.length} GPU(s), ${totalVramMB}MB VRAM, ${ramMB}MB RAM, CUDA: ${cudaAvailable}`,
  );
  return info;
}

/** Detect NVIDIA GPUs via nvidia-smi */
async function detectNvidiaGpus(): Promise<{
  gpus: GpuInfo[];
  cudaAvailable: boolean;
  cudaVersion?: string;
}> {
  try {
    const { execSync } = require("node:child_process");

    // Try common nvidia-smi paths per platform (not always in PATH, especially via SSH)
    const nvidiaSmiPaths: string[] =
      process.platform === "win32"
        ? [
            "nvidia-smi",
            "C:\\Windows\\System32\\nvidia-smi.exe",
            "C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe",
          ]
        : [
            "/usr/bin/nvidia-smi",
            "nvidia-smi",
            "/usr/local/bin/nvidia-smi",
            "/usr/local/cuda/bin/nvidia-smi",
            "/opt/cuda/bin/nvidia-smi",
          ];

    const queryArgs =
      "--query-gpu=index,name,memory.total,compute_cap --format=csv,noheader,nounits";
    let output = "";

    // Try execSync first (more reliable in standalone binaries)
    for (const smiPath of nvidiaSmiPaths) {
      try {
        output = execSync(`${smiPath} ${queryArgs}`, {
          encoding: "utf-8",
          timeout: 10000,
          stdio: ["pipe", "pipe", "pipe"],
        }).trim();
        if (output) break;
      } catch {
        /* try next path */
      }
    }

    if (!output) {
      // Fallback to Bun.spawnSync
      const env = {
        ...process.env,
        PATH: `/usr/bin:/usr/local/bin:/usr/local/cuda/bin:${process.env.PATH ?? ""}`,
      };
      for (const smiPath of nvidiaSmiPaths) {
        const attempt = Bun.spawnSync(
          [
            smiPath,
            "--query-gpu=index,name,memory.total,compute_cap",
            "--format=csv,noheader,nounits",
          ],
          { stdout: "pipe", stderr: "pipe", env },
        );
        if (attempt.exitCode === 0) {
          output = attempt.stdout.toString().trim();
          if (output) break;
        }
      }
    }

    if (!output) {
      return { gpus: [], cudaAvailable: false };
    }

    const gpus: GpuInfo[] = [];

    for (const line of output.split("\n")) {
      const parts = line.split(",").map((s) => s.trim());
      if (parts.length >= 3) {
        gpus.push({
          index: parseInt(parts[0]!, 10),
          name: parts[1]!,
          vramMB: parseInt(parts[2]!, 10),
          computeCapability: parts[3] || undefined,
        });
      }
    }

    // Get CUDA version
    let cudaVersion: string | undefined;
    try {
      const nvccOut = execSync(
        "nvcc --version 2>/dev/null || /usr/local/cuda/bin/nvcc --version 2>/dev/null",
        {
          encoding: "utf-8",
          timeout: 5000,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const vMatch = nvccOut.match(/release (\d+\.\d+)/);
      if (vMatch) cudaVersion = vMatch[1];
    } catch {
      /* no nvcc */
    }

    return { gpus, cudaAvailable: gpus.length > 0, cudaVersion };
  } catch {
    return { gpus: [], cudaAvailable: false };
  }
}

/** Detect macOS GPU (Metal - unified memory) */
async function detectMacGpu(ramMB: number): Promise<GpuInfo[]> {
  try {
    const proc = Bun.spawnSync(["system_profiler", "SPDisplaysDataType", "-json"], {
      stdout: "pipe",
      stderr: "pipe",
    });

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
      const cc = gpu.computeCapability ? `, sm_${gpu.computeCapability.replace(".", "")}` : "";
      lines.push(`GPU ${gpu.index}: ${gpu.name} (${(gpu.vramMB / 1024).toFixed(0)} GB VRAM${cc})`);
    }
    lines.push(`Total VRAM: ${(hw.totalVramMB / 1024).toFixed(0)} GB`);
  }

  if (hw.cudaAvailable) {
    lines.push(`CUDA: ${hw.cudaVersion ?? "available"}`);
  }

  return lines.join("\n");
}
