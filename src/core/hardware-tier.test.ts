// Hardware tier classification tests.

import { describe, expect, test } from "bun:test";
import type { HardwareInfo } from "./hardware";
import { classifyHardware, tierLabel } from "./hardware-tier";

function hw(overrides: Partial<HardwareInfo>): HardwareInfo {
  return {
    platform: "linux",
    arch: "x64",
    ramMB: 16 * 1024,
    totalVramMB: 0,
    gpus: [],
    gpuName: null,
    gpuDriver: null,
    cpuModel: "Test CPU",
    cpuCores: 8,
    ...overrides,
  } as HardwareInfo;
}

describe("classifyHardware — discrete GPU", () => {
  test("24GB VRAM = strong", () => {
    const r = classifyHardware(hw({ totalVramMB: 24 * 1024 }));
    expect(r.tier).toBe("strong");
    expect(r.primary).toBe("local");
  });

  test("16GB VRAM = medium", () => {
    const r = classifyHardware(hw({ totalVramMB: 16 * 1024 }));
    expect(r.tier).toBe("medium");
    expect(r.primary).toBe("local");
  });

  test("6GB VRAM = weak (cloud-first)", () => {
    const r = classifyHardware(hw({ totalVramMB: 6 * 1024 }));
    expect(r.tier).toBe("weak");
    expect(r.primary).toBe("cloud");
  });

  test("dual GPU (8+16=24GB) = strong", () => {
    const r = classifyHardware(hw({ totalVramMB: 24 * 1024 }));
    expect(r.tier).toBe("strong");
  });
});

describe("classifyHardware — Apple Silicon", () => {
  test("M3 Max 64GB = strong", () => {
    const r = classifyHardware(hw({ platform: "darwin", arch: "arm64", ramMB: 64 * 1024 }));
    expect(r.tier).toBe("strong");
    expect(r.primary).toBe("local");
    expect(r.reason).toContain("Apple Silicon");
  });

  test("M3 Pro 18GB = medium", () => {
    const r = classifyHardware(hw({ platform: "darwin", arch: "arm64", ramMB: 18 * 1024 }));
    expect(r.tier).toBe("medium");
    expect(r.primary).toBe("local");
  });

  test("M3 8GB = weak (cloud-first)", () => {
    const r = classifyHardware(hw({ platform: "darwin", arch: "arm64", ramMB: 8 * 1024 }));
    expect(r.tier).toBe("weak");
    expect(r.primary).toBe("cloud");
  });
});

describe("classifyHardware — CPU only", () => {
  test("No GPU, 16GB RAM (canonical Fedora case) = weak cloud-first", () => {
    const r = classifyHardware(hw({ totalVramMB: 0, ramMB: 16 * 1024 }));
    expect(r.tier).toBe("weak");
    expect(r.primary).toBe("cloud");
    expect(r.offerAlternative).toBe(true);
    expect(r.reason).toContain("16GB RAM");
  });

  test("No GPU, 8GB RAM = unusable", () => {
    const r = classifyHardware(hw({ totalVramMB: 0, ramMB: 8 * 1024 }));
    expect(r.tier).toBe("unusable");
    expect(r.primary).toBe("cloud");
    expect(r.offerAlternative).toBe(false);
  });

  test("No GPU, 64GB RAM = weak but viable", () => {
    const r = classifyHardware(hw({ totalVramMB: 0, ramMB: 64 * 1024 }));
    expect(r.tier).toBe("weak");
    expect(r.primary).toBe("cloud");
    expect(r.offerAlternative).toBe(true);
  });
});

describe("classifyHardware with live VRAM override", () => {
  test("12GB card with 1GB free → unusable (no model fits)", () => {
    const r = classifyHardware(hw({ totalVramMB: 12 * 1024 }), { liveUsableVramMB: 1024 });
    expect(r.tier).toBe("unusable");
    expect(r.primary).toBe("cloud");
    expect(r.offerAlternative).toBe(false);
    expect(r.reason).toContain("1.0GB free");
  });

  test("12GB card with 2GB free → weak (can still force local)", () => {
    const r = classifyHardware(hw({ totalVramMB: 12 * 1024 }), { liveUsableVramMB: 2 * 1024 });
    expect(r.tier).toBe("weak");
    expect(r.primary).toBe("cloud");
    expect(r.offerAlternative).toBe(true);
  });

  test("24GB card with only 6GB free → weak (downgraded from strong)", () => {
    const r = classifyHardware(hw({ totalVramMB: 24 * 1024 }), { liveUsableVramMB: 6 * 1024 });
    expect(r.tier).toBe("weak");
    expect(r.primary).toBe("cloud");
    expect(r.reason).toContain("6GB free of 24GB");
  });

  test("12GB card with 9.5GB free → medium (healthy local)", () => {
    const r = classifyHardware(hw({ totalVramMB: 12 * 1024 }), { liveUsableVramMB: 9.5 * 1024 });
    expect(r.tier).toBe("medium");
    expect(r.primary).toBe("local");
  });

  test("24GB card with 22GB free → strong (confirmed by live)", () => {
    const r = classifyHardware(hw({ totalVramMB: 24 * 1024 }), { liveUsableVramMB: 22 * 1024 });
    expect(r.tier).toBe("strong");
    expect(r.primary).toBe("local");
  });

  test("no liveUsableVramMB → falls back to total VRAM logic (backwards compat)", () => {
    const r = classifyHardware(hw({ totalVramMB: 12 * 1024 }));
    // Without live override, 12GB total = medium
    expect(r.tier).toBe("medium");
  });
});

describe("tierLabel", () => {
  test("returns human-readable labels", () => {
    expect(tierLabel("strong")).toContain("local-first");
    expect(tierLabel("medium")).toContain("balanced");
    expect(tierLabel("weak")).toContain("cloud-first");
    expect(tierLabel("unusable")).toContain("cloud-only");
  });
});
