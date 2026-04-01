// KCode - Hardware Detector
// Detects CPU, RAM, GPU, storage, and OS information for auto-optimization.

import { log } from "../logger";
import type { CpuInfo, GpuInfo, HardwareProfile, MemoryInfo, OsInfo, StorageInfo } from "./types";

export class HardwareDetector {
  /**
   * Detect all hardware components in parallel and return a unified profile.
   */
  async detect(): Promise<HardwareProfile> {
    const [cpu, memory, gpus, storage, os] = await Promise.all([
      this.detectCPU(),
      this.detectMemory(),
      this.detectGPUs(),
      this.detectStorage(),
      this.detectOS(),
    ]);
    return { cpu, memory, gpus, storage, os };
  }

  /**
   * Detect CPU model, core/thread count, architecture, and instruction set features.
   */
  async detectCPU(): Promise<CpuInfo> {
    const arch =
      process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
    let model = "Unknown CPU";
    let cores = 1;
    let threads = 1;
    let features: string[] = [];

    if (process.platform === "linux") {
      try {
        const cpuinfo = await Bun.file("/proc/cpuinfo").text();
        const modelMatch = cpuinfo.match(/model name\s*:\s*(.+)/);
        if (modelMatch) model = modelMatch[1].trim();

        // Count physical cores (unique core ids per physical id)
        const coreIds = new Set<string>();
        let processorCount = 0;
        for (const line of cpuinfo.split("\n")) {
          if (line.startsWith("processor")) processorCount++;
          const coreIdMatch = line.match(/core id\s*:\s*(\d+)/);
          if (coreIdMatch) coreIds.add(coreIdMatch[1]);
        }
        threads = processorCount || 1;
        cores = coreIds.size || Math.ceil(threads / 2);

        // Extract CPU features/flags
        const flagsMatch = cpuinfo.match(/flags\s*:\s*(.+)/);
        if (flagsMatch) {
          const allFlags = flagsMatch[1].trim().split(/\s+/);
          const interesting = [
            "avx",
            "avx2",
            "avx512f",
            "avx512_vnni",
            "amx_tile",
            "amx_int8",
            "amx_bf16",
            "sse4_2",
            "fma",
            "f16c",
          ];
          features = allFlags.filter((f) => interesting.includes(f));
        }
      } catch (err) {
        log.debug("hardware", `Failed to read /proc/cpuinfo: ${err}`);
      }
    } else if (process.platform === "darwin") {
      try {
        const brandResult = Bun.spawnSync(["sysctl", "-n", "machdep.cpu.brand_string"]);
        if (brandResult.exitCode === 0) {
          model = brandResult.stdout.toString().trim();
        }

        const coreResult = Bun.spawnSync(["sysctl", "-n", "hw.physicalcpu"]);
        if (coreResult.exitCode === 0) {
          cores = parseInt(coreResult.stdout.toString().trim(), 10) || 1;
        }

        const threadResult = Bun.spawnSync(["sysctl", "-n", "hw.logicalcpu"]);
        if (threadResult.exitCode === 0) {
          threads = parseInt(threadResult.stdout.toString().trim(), 10) || cores;
        }

        const featResult = Bun.spawnSync(["sysctl", "-n", "machdep.cpu.features"]);
        if (featResult.exitCode === 0) {
          const raw = featResult.stdout.toString().trim().toLowerCase();
          features = raw.split(/\s+/).filter((f) => f.length > 0);
        }
      } catch (err) {
        log.debug("hardware", `Failed to detect macOS CPU: ${err}`);
      }
    } else {
      // Fallback for other platforms
      const os = await import("node:os");
      const cpus = os.cpus();
      if (cpus.length > 0) {
        model = cpus[0].model;
        threads = cpus.length;
        cores = Math.ceil(threads / 2);
      }
    }

    return { model, cores, threads, architecture: arch, features };
  }

  /**
   * Detect total and available system memory.
   */
  async detectMemory(): Promise<MemoryInfo> {
    let totalGb = 0;
    let availableGb = 0;

    if (process.platform === "linux") {
      try {
        const meminfo = await Bun.file("/proc/meminfo").text();
        const totalMatch = meminfo.match(/MemTotal:\s+(\d+)\s+kB/);
        const availMatch = meminfo.match(/MemAvailable:\s+(\d+)\s+kB/);
        if (totalMatch) totalGb = Math.round(parseInt(totalMatch[1], 10) / 1024 / 1024);
        if (availMatch) availableGb = Math.round(parseInt(availMatch[1], 10) / 1024 / 1024);
      } catch (err) {
        log.debug("hardware", `Failed to read /proc/meminfo: ${err}`);
      }
    } else if (process.platform === "darwin") {
      try {
        const memResult = Bun.spawnSync(["sysctl", "-n", "hw.memsize"]);
        if (memResult.exitCode === 0) {
          totalGb = Math.round(
            parseInt(memResult.stdout.toString().trim(), 10) / 1024 / 1024 / 1024,
          );
        }
        // Approximate available memory on macOS via vm_stat
        const vmResult = Bun.spawnSync(["vm_stat"]);
        if (vmResult.exitCode === 0) {
          const output = vmResult.stdout.toString();
          const pageSize = 16384; // typical on Apple Silicon
          const freeMatch = output.match(/Pages free:\s+(\d+)/);
          const inactiveMatch = output.match(/Pages inactive:\s+(\d+)/);
          const freePages = parseInt(freeMatch?.[1] ?? "0", 10);
          const inactivePages = parseInt(inactiveMatch?.[1] ?? "0", 10);
          availableGb = Math.round(((freePages + inactivePages) * pageSize) / 1024 / 1024 / 1024);
        }
      } catch (err) {
        log.debug("hardware", `Failed to detect macOS memory: ${err}`);
      }
    } else {
      const os = await import("node:os");
      totalGb = Math.round(os.totalmem() / 1024 / 1024 / 1024);
      availableGb = Math.round(os.freemem() / 1024 / 1024 / 1024);
    }

    // Fallback: if we got total but not available, estimate 60% available
    if (totalGb > 0 && availableGb <= 0) {
      availableGb = Math.round(totalGb * 0.6);
    }

    return { totalGb, availableGb };
  }

  /**
   * Detect GPUs: NVIDIA via nvidia-smi, AMD via rocm-smi, Apple via system_profiler.
   */
  async detectGPUs(): Promise<GpuInfo[]> {
    const gpus: GpuInfo[] = [];

    // NVIDIA detection
    try {
      const result = Bun.spawnSync([
        "nvidia-smi",
        "--query-gpu=name,memory.total,driver_version,compute_cap",
        "--format=csv,noheader,nounits",
      ]);
      if (result.exitCode === 0) {
        const lines = result.stdout.toString().trim().split("\n");
        for (const line of lines) {
          if (!line.trim()) continue;
          const parts = line.split(",").map((s) => s.trim());
          if (parts.length >= 2) {
            gpus.push({
              vendor: "nvidia",
              model: parts[0],
              vramGb: Math.round(parseInt(parts[1], 10) / 1024),
              driver: parts[2] || undefined,
              computeCapability: parts[3] || undefined,
            });
          }
        }
      }
    } catch {
      // No NVIDIA GPU or nvidia-smi not installed
    }

    // AMD detection
    try {
      const result = Bun.spawnSync(["rocm-smi", "--showproductname"]);
      if (result.exitCode === 0) {
        const output = result.stdout.toString();
        const nameMatch = output.match(/Card Series:\s+(.+)/);
        if (nameMatch) {
          let vramGb = 0;
          try {
            const memResult = Bun.spawnSync(["rocm-smi", "--showmeminfo", "vram"]);
            if (memResult.exitCode === 0) {
              const memMatch = memResult.stdout.toString().match(/Total Memory \(B\):\s+(\d+)/);
              if (memMatch) {
                vramGb = Math.round(parseInt(memMatch[1], 10) / 1024 / 1024 / 1024);
              }
            }
          } catch {
            /* ignore */
          }
          gpus.push({
            vendor: "amd",
            model: nameMatch[1].trim(),
            vramGb,
          });
        }
      }
    } catch {
      // No AMD GPU or rocm-smi not installed
    }

    // Apple Silicon detection
    if (process.platform === "darwin") {
      try {
        const result = Bun.spawnSync(["system_profiler", "SPDisplaysDataType", "-json"]);
        if (result.exitCode === 0) {
          const data = JSON.parse(result.stdout.toString());
          const displays = data?.SPDisplaysDataType;
          if (Array.isArray(displays)) {
            for (const display of displays) {
              const chipModel = display.sppci_model ?? "Apple GPU";
              // Apple Silicon uses unified memory — VRAM is shared with system RAM
              gpus.push({
                vendor: "apple",
                model: chipModel,
                vramGb: 0, // Unified memory — handled at optimization level
              });
            }
          }
        }
      } catch {
        // No Apple GPU info available
      }
    }

    return gpus;
  }

  /**
   * Detect available storage space and type (SSD vs HDD).
   */
  async detectStorage(): Promise<StorageInfo> {
    let availableGb = 0;
    let type: StorageInfo["type"] = "unknown";

    try {
      const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
      const result = Bun.spawnSync(["df", "-B1", home]);
      if (result.exitCode === 0) {
        const lines = result.stdout.toString().trim().split("\n");
        if (lines.length >= 2) {
          const parts = lines[1].split(/\s+/);
          // df -B1 output: Filesystem 1B-blocks Used Available Use% Mounted-on
          if (parts.length >= 4) {
            availableGb = Math.round(parseInt(parts[3], 10) / 1024 / 1024 / 1024);
          }
        }
      }
    } catch {
      // df not available
    }

    // Detect SSD vs HDD on Linux
    if (process.platform === "linux") {
      try {
        const result = Bun.spawnSync(["lsblk", "-d", "-o", "name,rota", "-n"]);
        if (result.exitCode === 0) {
          const lines = result.stdout.toString().trim().split("\n");
          // rota=0 means SSD, rota=1 means HDD
          const hasSsd = lines.some((l) => l.trim().endsWith("0"));
          const hasHdd = lines.some((l) => l.trim().endsWith("1"));
          if (hasSsd && !hasHdd) type = "ssd";
          else if (hasHdd && !hasSsd) type = "hdd";
          else if (hasSsd) type = "ssd"; // mixed, assume SSD for primary
        }
      } catch {
        // lsblk not available
      }
    } else if (process.platform === "darwin") {
      // macOS typically uses SSD (NVMe/Flash storage)
      type = "ssd";
    }

    return { availableGb, type };
  }

  /**
   * Detect OS platform, release version, and whether running under WSL.
   */
  async detectOS(): Promise<OsInfo> {
    const platform = process.platform;
    let release = "";
    let isWSL = false;

    try {
      const os = await import("node:os");
      release = os.release();
    } catch {
      /* ignore */
    }

    // WSL detection
    if (platform === "linux") {
      try {
        const proc = await Bun.file("/proc/version").text();
        isWSL = /microsoft|wsl/i.test(proc);
      } catch {
        // Not WSL or /proc/version not readable
      }
    }

    return { platform, release, isWSL };
  }
}

// Singleton for convenience
let _detector: HardwareDetector | null = null;

export function getHardwareDetector(): HardwareDetector {
  if (!_detector) _detector = new HardwareDetector();
  return _detector;
}
