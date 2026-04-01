// KCode - GPU Orchestrator
// Enhanced GPU monitoring, alerting, and management for multi-GPU setups

import { log } from "./logger";

// ─── Types ──────────────────────────────────────────────────────

export interface GpuStatus {
  index: number;
  name: string;
  vramTotal: number; // MB
  vramFree: number; // MB
  vramUsed: number; // MB
  temperature: number; // Celsius
  utilization: number; // 0-100%
  powerDraw: number; // Watts
  driverVersion: string;
}

export interface GpuAlert {
  gpuIndex: number;
  type: "temperature" | "vram" | "error";
  message: string;
  severity: "warn" | "critical";
}

// ─── NVIDIA GPU Status ──────────────────────────────────────────

const NVIDIA_SMI_PATHS: string[] =
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

const NVIDIA_QUERY =
  "--query-gpu=index,name,memory.total,memory.free,memory.used,temperature.gpu,utilization.gpu,power.draw,driver_version";
const NVIDIA_FORMAT = "--format=csv,noheader,nounits";

/**
 * Parse nvidia-smi CSV output into GpuStatus array.
 * Expected columns: index, name, memory.total, memory.free, memory.used,
 *                   temperature.gpu, utilization.gpu, power.draw, driver_version
 */
export function parseNvidiaSmiOutput(output: string): GpuStatus[] {
  const statuses: GpuStatus[] = [];
  if (!output || !output.trim()) return statuses;

  for (const line of output.trim().split("\n")) {
    const parts = line.split(",").map((s) => s.trim());
    if (parts.length < 9) continue;

    const parseNum = (val: string): number => {
      const n = parseFloat(val);
      return Number.isNaN(n) ? 0 : n;
    };

    statuses.push({
      index: parseInt(parts[0]!, 10),
      name: parts[1]!,
      vramTotal: parseNum(parts[2]!),
      vramFree: parseNum(parts[3]!),
      vramUsed: parseNum(parts[4]!),
      temperature: parseNum(parts[5]!),
      utilization: parseNum(parts[6]!),
      powerDraw: parseNum(parts[7]!),
      driverVersion: parts[8]!,
    });
  }

  return statuses;
}

/**
 * Query all NVIDIA GPUs via nvidia-smi with detailed metrics.
 */
export async function getGpuStatus(): Promise<GpuStatus[]> {
  // Try NVIDIA GPUs first
  const nvidiaStatuses = await queryNvidiaGpus();
  if (nvidiaStatuses.length > 0) return nvidiaStatuses;

  // Fall back to Apple Silicon
  const appleStatus = await getAppleSiliconStatus();
  if (appleStatus) return [appleStatus];

  return [];
}

async function queryNvidiaGpus(): Promise<GpuStatus[]> {
  const { execSync } = await import("node:child_process");

  for (const smiPath of NVIDIA_SMI_PATHS) {
    try {
      const output = execSync(`${smiPath} ${NVIDIA_QUERY} ${NVIDIA_FORMAT}`, {
        encoding: "utf-8",
        timeout: 10_000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();

      if (output) {
        return parseNvidiaSmiOutput(output);
      }
    } catch {
      /* try next path */
    }
  }

  // Fallback to Bun.spawnSync
  const env = {
    ...process.env,
    PATH: `/usr/bin:/usr/local/bin:/usr/local/cuda/bin:${process.env.PATH ?? ""}`,
  };
  for (const smiPath of NVIDIA_SMI_PATHS) {
    try {
      const result = Bun.spawnSync(
        [smiPath, NVIDIA_QUERY, NVIDIA_FORMAT],
        { stdout: "pipe", stderr: "pipe", env },
      );
      if (result.exitCode === 0) {
        const output = result.stdout.toString().trim();
        if (output) return parseNvidiaSmiOutput(output);
      }
    } catch {
      /* try next */
    }
  }

  return [];
}

/**
 * Get Apple Silicon unified memory status as a GpuStatus.
 * Returns null on non-macOS or if detection fails.
 */
export async function getAppleSiliconStatus(): Promise<GpuStatus | null> {
  if (process.platform !== "darwin") return null;

  try {
    const os = await import("node:os");
    const totalRamMB = Math.round(os.totalmem() / (1024 * 1024));
    // Apple Silicon shares ~75% of system RAM with GPU
    const vramTotal = Math.round(totalRamMB * 0.75);

    // Try to get GPU name from system_profiler
    let name = "Apple Silicon (Metal)";
    try {
      const proc = Bun.spawnSync(["system_profiler", "SPDisplaysDataType", "-json"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      if (proc.exitCode === 0) {
        const data = JSON.parse(proc.stdout.toString());
        const displays = data?.SPDisplaysDataType;
        if (Array.isArray(displays) && displays.length > 0) {
          name = displays[0].sppci_model ?? name;
        }
      }
    } catch {
      /* use default name */
    }

    // Try to get memory pressure for usage estimate
    let vramUsed = 0;
    try {
      const { execSync } = await import("node:child_process");
      const vmStat = execSync("vm_stat", { encoding: "utf-8", timeout: 5000 });
      const pageSize = 16384; // Apple Silicon default
      const activeMatch = vmStat.match(/Pages active:\s+(\d+)/);
      const wiredMatch = vmStat.match(/Pages wired down:\s+(\d+)/);
      if (activeMatch && wiredMatch) {
        const activePages = parseInt(activeMatch[1]!, 10);
        const wiredPages = parseInt(wiredMatch[1]!, 10);
        const usedMB = Math.round(((activePages + wiredPages) * pageSize) / (1024 * 1024));
        vramUsed = Math.min(usedMB, vramTotal);
      }
    } catch {
      /* estimate unavailable */
    }

    return {
      index: 0,
      name,
      vramTotal,
      vramFree: vramTotal - vramUsed,
      vramUsed,
      temperature: 0, // Not easily accessible on macOS without sudo
      utilization: vramUsed > 0 ? Math.round((vramUsed / vramTotal) * 100) : 0,
      powerDraw: 0, // Not reported on macOS
      driverVersion: "Metal",
    };
  } catch {
    return null;
  }
}

/**
 * Start polling GPU statuses at the given interval.
 * Returns a cleanup function to stop the monitor.
 */
export function monitorGpus(
  intervalMs: number,
  callback: (statuses: GpuStatus[]) => void,
): () => void {
  let running = true;

  const poll = async () => {
    while (running) {
      try {
        const statuses = await getGpuStatus();
        if (running) callback(statuses);
      } catch (err) {
        log.error("gpu", `Monitor poll error: ${err}`);
      }
      if (running) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }
  };

  poll();

  return () => {
    running = false;
  };
}

/**
 * Format GPU statuses as a human-readable table.
 */
export function formatGpuStatusTable(statuses: GpuStatus[]): string {
  if (statuses.length === 0) return "No GPUs detected.";

  const lines: string[] = [];
  const header = "GPU  Name                         VRAM Used/Total   Temp   Util   Power";
  const sep = "---  ---------------------------  ----------------  -----  -----  ------";
  lines.push(header);
  lines.push(sep);

  for (const s of statuses) {
    const name = s.name.length > 27 ? s.name.slice(0, 24) + "..." : s.name.padEnd(27);
    const vram = `${(s.vramUsed / 1024).toFixed(1)}/${(s.vramTotal / 1024).toFixed(1)} GB`.padEnd(16);
    const temp = s.temperature > 0 ? `${s.temperature}C`.padEnd(5) : "N/A  ";
    const util = `${s.utilization}%`.padEnd(5);
    const power = s.powerDraw > 0 ? `${s.powerDraw.toFixed(0)}W` : "N/A";
    lines.push(`${String(s.index).padEnd(4)} ${name}  ${vram}  ${temp}  ${util}  ${power}`);
  }

  return lines.join("\n");
}

/**
 * Check GPU statuses for alert conditions.
 * Alerts: temperature >85C (warn) / >95C (critical), VRAM >95% (warn) / >99% (critical).
 */
export function checkGpuAlerts(statuses: GpuStatus[]): GpuAlert[] {
  const alerts: GpuAlert[] = [];

  for (const s of statuses) {
    // Temperature alerts
    if (s.temperature >= 95) {
      alerts.push({
        gpuIndex: s.index,
        type: "temperature",
        message: `GPU ${s.index} (${s.name}) temperature critical: ${s.temperature}C`,
        severity: "critical",
      });
    } else if (s.temperature >= 85) {
      alerts.push({
        gpuIndex: s.index,
        type: "temperature",
        message: `GPU ${s.index} (${s.name}) temperature high: ${s.temperature}C`,
        severity: "warn",
      });
    }

    // VRAM alerts
    if (s.vramTotal > 0) {
      const usagePercent = (s.vramUsed / s.vramTotal) * 100;
      if (usagePercent >= 99) {
        alerts.push({
          gpuIndex: s.index,
          type: "vram",
          message: `GPU ${s.index} (${s.name}) VRAM critical: ${usagePercent.toFixed(1)}% used (${s.vramFree} MB free)`,
          severity: "critical",
        });
      } else if (usagePercent >= 95) {
        alerts.push({
          gpuIndex: s.index,
          type: "vram",
          message: `GPU ${s.index} (${s.name}) VRAM high: ${usagePercent.toFixed(1)}% used (${s.vramFree} MB free)`,
          severity: "warn",
        });
      }
    }
  }

  return alerts;
}
