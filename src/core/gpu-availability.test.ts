// Tests for live GPU availability detection + effectiveUsableVramMB
// fallback math.

import { describe, expect, test } from "bun:test";
import {
  detectGpuAvailability,
  effectiveUsableVramMB,
  type GpuAvailability,
} from "./gpu-availability";

describe("effectiveUsableVramMB", () => {
  test("uses free VRAM with 10% safety margin when live data is available", () => {
    const avail: GpuAvailability = {
      totalMB: 12288,
      freeMB: 8000,
      usedMB: 4288,
      source: "nvidia-smi",
    };
    const usable = effectiveUsableVramMB(avail, 12288);
    // 8000 * 0.9 = 7200
    expect(usable).toBe(7200);
  });

  test("falls back to 80% × 90% of total when free is null", () => {
    const avail: GpuAvailability = {
      totalMB: 12288,
      freeMB: null,
      usedMB: null,
      source: "unknown",
    };
    const usable = effectiveUsableVramMB(avail, 12288);
    // 12288 * 0.8 * 0.9 = 8847.36
    expect(usable).toBeCloseTo(8847.36, 1);
  });

  test("returns 0 when free is zero", () => {
    const avail: GpuAvailability = {
      totalMB: 12288,
      freeMB: 0,
      usedMB: 12288,
      source: "nvidia-smi",
    };
    expect(effectiveUsableVramMB(avail, 12288)).toBe(0);
  });

  test("handles negative-looking free values gracefully (clamped to 0)", () => {
    const avail: GpuAvailability = {
      totalMB: 12288,
      freeMB: -100, // bogus driver report
      usedMB: null,
      source: "nvidia-smi",
    };
    expect(effectiveUsableVramMB(avail, 12288)).toBe(0);
  });
});

describe("detectGpuAvailability — Apple Silicon short-circuit", () => {
  test("darwin platform returns null free (unified memory)", async () => {
    const r = await detectGpuAvailability("darwin", 32_000);
    expect(r.source).toBe("apple-unified");
    expect(r.freeMB).toBeNull();
    expect(r.totalMB).toBe(32_000);
  });
});

describe("detectGpuAvailability — nvidia-smi absent", () => {
  test("returns null free when nvidia-smi is not installed", async () => {
    // On a machine without an NVIDIA driver / nvidia-smi binary, the
    // module should return a clean null-free result rather than throw.
    // This test is indirect — in CI we may or may not have nvidia-smi,
    // but either way the function must return a well-formed object.
    const r = await detectGpuAvailability("linux", 0);
    expect(r).toBeDefined();
    expect(typeof r.totalMB).toBe("number");
    // freeMB could be null (no nvidia-smi) or a number (CI has it);
    // both are valid, we just don't throw.
    expect(r.freeMB === null || typeof r.freeMB === "number").toBe(true);
  });
});
