import { describe, it, expect } from "bun:test";
import {
  parseNvidiaSmiOutput,
  formatGpuStatusTable,
  checkGpuAlerts,
  type GpuStatus,
} from "./gpu-orchestrator";

// ─── parseNvidiaSmiOutput ───────────────────────────────────────

describe("parseNvidiaSmiOutput", () => {
  it("parses single GPU output", () => {
    const output = "0, NVIDIA GeForce RTX 4090, 24564, 20000, 4564, 52, 35, 120.50, 550.54.14";
    const result = parseNvidiaSmiOutput(output);

    expect(result).toHaveLength(1);
    expect(result[0]!.index).toBe(0);
    expect(result[0]!.name).toBe("NVIDIA GeForce RTX 4090");
    expect(result[0]!.vramTotal).toBe(24564);
    expect(result[0]!.vramFree).toBe(20000);
    expect(result[0]!.vramUsed).toBe(4564);
    expect(result[0]!.temperature).toBe(52);
    expect(result[0]!.utilization).toBe(35);
    expect(result[0]!.powerDraw).toBe(120.5);
    expect(result[0]!.driverVersion).toBe("550.54.14");
  });

  it("parses multi-GPU output", () => {
    const output = [
      "0, NVIDIA GeForce RTX 4090, 24564, 20000, 4564, 52, 35, 120.50, 550.54.14",
      "1, NVIDIA GeForce RTX 5090, 32768, 28000, 4768, 45, 20, 95.30, 550.54.14",
    ].join("\n");

    const result = parseNvidiaSmiOutput(output);
    expect(result).toHaveLength(2);
    expect(result[0]!.name).toBe("NVIDIA GeForce RTX 4090");
    expect(result[1]!.name).toBe("NVIDIA GeForce RTX 5090");
    expect(result[1]!.vramTotal).toBe(32768);
    expect(result[1]!.index).toBe(1);
  });

  it("returns empty array for empty input", () => {
    expect(parseNvidiaSmiOutput("")).toEqual([]);
    expect(parseNvidiaSmiOutput("  ")).toEqual([]);
  });

  it("skips lines with too few columns", () => {
    const output = "0, GPU, 24564, 20000";
    const result = parseNvidiaSmiOutput(output);
    expect(result).toEqual([]);
  });

  it("handles [N/A] values as 0", () => {
    const output = "0, Tesla T4, 15360, 14000, 1360, [N/A], 0, [N/A], 460.32.03";
    const result = parseNvidiaSmiOutput(output);
    expect(result).toHaveLength(1);
    expect(result[0]!.temperature).toBe(0); // NaN → 0
    expect(result[0]!.powerDraw).toBe(0); // NaN → 0
  });
});

// ─── formatGpuStatusTable ───────────────────────────────────────

describe("formatGpuStatusTable", () => {
  it("returns 'No GPUs detected.' for empty array", () => {
    expect(formatGpuStatusTable([])).toBe("No GPUs detected.");
  });

  it("formats a single GPU", () => {
    const statuses: GpuStatus[] = [
      {
        index: 0,
        name: "NVIDIA GeForce RTX 4090",
        vramTotal: 24576,
        vramFree: 20000,
        vramUsed: 4576,
        temperature: 52,
        utilization: 35,
        powerDraw: 120,
        driverVersion: "550.54.14",
      },
    ];

    const table = formatGpuStatusTable(statuses);
    expect(table).toContain("NVIDIA GeForce RTX 4090");
    expect(table).toContain("4.5"); // vramUsed ~4.5 GB
    expect(table).toContain("24.0"); // vramTotal 24.0 GB
    expect(table).toContain("52C");
    expect(table).toContain("35%");
    expect(table).toContain("120W");
  });

  it("formats multiple GPUs with header", () => {
    const statuses: GpuStatus[] = [
      {
        index: 0,
        name: "RTX 4090",
        vramTotal: 24576,
        vramFree: 20000,
        vramUsed: 4576,
        temperature: 50,
        utilization: 30,
        powerDraw: 100,
        driverVersion: "550.54.14",
      },
      {
        index: 1,
        name: "RTX 5090",
        vramTotal: 32768,
        vramFree: 30000,
        vramUsed: 2768,
        temperature: 42,
        utilization: 10,
        powerDraw: 80,
        driverVersion: "550.54.14",
      },
    ];

    const table = formatGpuStatusTable(statuses);
    expect(table).toContain("GPU");
    expect(table).toContain("Name");
    expect(table).toContain("VRAM");
    expect(table).toContain("RTX 4090");
    expect(table).toContain("RTX 5090");
  });

  it("truncates long GPU names", () => {
    const statuses: GpuStatus[] = [
      {
        index: 0,
        name: "NVIDIA GeForce RTX 4090 Founders Edition Super Ultra",
        vramTotal: 24576,
        vramFree: 20000,
        vramUsed: 4576,
        temperature: 50,
        utilization: 30,
        powerDraw: 100,
        driverVersion: "550.54.14",
      },
    ];

    const table = formatGpuStatusTable(statuses);
    expect(table).toContain("...");
  });

  it("shows N/A for zero temperature and power", () => {
    const statuses: GpuStatus[] = [
      {
        index: 0,
        name: "Apple M2 Pro",
        vramTotal: 12288,
        vramFree: 10000,
        vramUsed: 2288,
        temperature: 0,
        utilization: 15,
        powerDraw: 0,
        driverVersion: "Metal",
      },
    ];

    const table = formatGpuStatusTable(statuses);
    expect(table).toContain("N/A");
  });
});

// ─── checkGpuAlerts ─────────────────────────────────────────────

describe("checkGpuAlerts", () => {
  it("returns no alerts for normal operation", () => {
    const statuses: GpuStatus[] = [
      {
        index: 0,
        name: "RTX 4090",
        vramTotal: 24576,
        vramFree: 20000,
        vramUsed: 4576,
        temperature: 60,
        utilization: 40,
        powerDraw: 120,
        driverVersion: "550.54.14",
      },
    ];

    const alerts = checkGpuAlerts(statuses);
    expect(alerts).toEqual([]);
  });

  it("warns on temperature >= 85C", () => {
    const statuses: GpuStatus[] = [
      {
        index: 0,
        name: "RTX 4090",
        vramTotal: 24576,
        vramFree: 20000,
        vramUsed: 4576,
        temperature: 87,
        utilization: 95,
        powerDraw: 350,
        driverVersion: "550.54.14",
      },
    ];

    const alerts = checkGpuAlerts(statuses);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.type).toBe("temperature");
    expect(alerts[0]!.severity).toBe("warn");
    expect(alerts[0]!.gpuIndex).toBe(0);
    expect(alerts[0]!.message).toContain("87C");
  });

  it("critical on temperature >= 95C", () => {
    const statuses: GpuStatus[] = [
      {
        index: 0,
        name: "RTX 4090",
        vramTotal: 24576,
        vramFree: 20000,
        vramUsed: 4576,
        temperature: 97,
        utilization: 100,
        powerDraw: 400,
        driverVersion: "550.54.14",
      },
    ];

    const alerts = checkGpuAlerts(statuses);
    const tempAlerts = alerts.filter((a) => a.type === "temperature");
    expect(tempAlerts).toHaveLength(1);
    expect(tempAlerts[0]!.severity).toBe("critical");
  });

  it("warns on VRAM >= 95%", () => {
    const statuses: GpuStatus[] = [
      {
        index: 0,
        name: "RTX 4090",
        vramTotal: 24576,
        vramFree: 1000, // ~4% free = 96% used
        vramUsed: 23576,
        temperature: 60,
        utilization: 90,
        powerDraw: 300,
        driverVersion: "550.54.14",
      },
    ];

    const alerts = checkGpuAlerts(statuses);
    const vramAlerts = alerts.filter((a) => a.type === "vram");
    expect(vramAlerts).toHaveLength(1);
    expect(vramAlerts[0]!.severity).toBe("warn");
  });

  it("critical on VRAM >= 99%", () => {
    const statuses: GpuStatus[] = [
      {
        index: 0,
        name: "RTX 4090",
        vramTotal: 24576,
        vramFree: 100, // ~0.4% free = 99.6% used
        vramUsed: 24476,
        temperature: 60,
        utilization: 100,
        powerDraw: 350,
        driverVersion: "550.54.14",
      },
    ];

    const alerts = checkGpuAlerts(statuses);
    const vramAlerts = alerts.filter((a) => a.type === "vram");
    expect(vramAlerts).toHaveLength(1);
    expect(vramAlerts[0]!.severity).toBe("critical");
  });

  it("returns multiple alerts for multiple GPUs", () => {
    const statuses: GpuStatus[] = [
      {
        index: 0,
        name: "RTX 4090",
        vramTotal: 24576,
        vramFree: 200,
        vramUsed: 24376,
        temperature: 90,
        utilization: 99,
        powerDraw: 350,
        driverVersion: "550.54.14",
      },
      {
        index: 1,
        name: "RTX 5090",
        vramTotal: 32768,
        vramFree: 100,
        vramUsed: 32668,
        temperature: 96,
        utilization: 100,
        powerDraw: 400,
        driverVersion: "550.54.14",
      },
    ];

    const alerts = checkGpuAlerts(statuses);
    // GPU 0: temp warn + vram warn = 2
    // GPU 1: temp critical + vram critical = 2
    expect(alerts.length).toBeGreaterThanOrEqual(4);
    expect(alerts.some((a) => a.gpuIndex === 0)).toBe(true);
    expect(alerts.some((a) => a.gpuIndex === 1)).toBe(true);
  });

  it("returns empty array for empty input", () => {
    expect(checkGpuAlerts([])).toEqual([]);
  });

  it("skips VRAM alert when vramTotal is 0", () => {
    const statuses: GpuStatus[] = [
      {
        index: 0,
        name: "Unknown GPU",
        vramTotal: 0,
        vramFree: 0,
        vramUsed: 0,
        temperature: 50,
        utilization: 0,
        powerDraw: 0,
        driverVersion: "N/A",
      },
    ];

    const alerts = checkGpuAlerts(statuses);
    expect(alerts.filter((a) => a.type === "vram")).toHaveLength(0);
  });
});
