// KCode - GPU Health Check

import { log } from "../../logger";
import type { HealthCheck } from "../health-score";

async function run(cmd: string[]): Promise<{ ok: boolean; stdout: string }> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    return { ok: code === 0, stdout: stdout.trim() };
  } catch {
    return { ok: false, stdout: "" };
  }
}

export async function checkGpu(): Promise<HealthCheck> {
  // Check NVIDIA GPU
  const nvResult = await run([
    "nvidia-smi",
    "--query-gpu=name,memory.total",
    "--format=csv,noheader,nounits",
  ]);
  if (nvResult.ok && nvResult.stdout) {
    const lines = nvResult.stdout.split("\n").filter(Boolean);
    const gpus = lines.map((line) => {
      const [name, vram] = line.split(", ");
      return `${name?.trim()} — ${Math.round(parseInt(vram ?? "0") / 1024)}GB VRAM`;
    });
    return {
      name: "GPU",
      category: "gpu",
      status: "pass",
      message: gpus.join("; "),
      weight: 7,
    };
  }

  // Check AMD GPU (ROCm)
  const rocmResult = await run(["rocm-smi", "--showproductname"]);
  if (rocmResult.ok && rocmResult.stdout) {
    return {
      name: "GPU",
      category: "gpu",
      status: "pass",
      message: `AMD GPU detected (ROCm)`,
      weight: 7,
    };
  }

  // Check macOS Apple Silicon
  if (process.platform === "darwin") {
    const sysResult = await run(["sysctl", "-n", "machdep.cpu.brand_string"]);
    if (sysResult.ok && sysResult.stdout.includes("Apple")) {
      return {
        name: "GPU",
        category: "gpu",
        status: "pass",
        message: `Apple Silicon (Metal acceleration available)`,
        weight: 7,
      };
    }
  }

  return {
    name: "GPU",
    category: "gpu",
    status: "skip",
    message: "No GPU detected — local models will use CPU only",
    fix: "Install NVIDIA drivers or use cloud APIs for best performance",
    weight: 7,
  };
}
