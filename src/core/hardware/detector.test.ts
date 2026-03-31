import { test, expect, describe, beforeEach, mock } from "bun:test";
import { HardwareDetector } from "./detector";

describe("HardwareDetector", () => {
  let detector: HardwareDetector;

  beforeEach(() => {
    detector = new HardwareDetector();
  });

  // ─── detect() ─────────────────────────────────────────────────

  describe("detect()", () => {
    test("returns a complete HardwareProfile with all fields", async () => {
      const profile = await detector.detect();

      expect(profile).toBeDefined();
      expect(profile.cpu).toBeDefined();
      expect(profile.memory).toBeDefined();
      expect(profile.gpus).toBeDefined();
      expect(profile.storage).toBeDefined();
      expect(profile.os).toBeDefined();
    });

    test("cpu has correct structure", async () => {
      const profile = await detector.detect();
      expect(typeof profile.cpu.model).toBe("string");
      expect(profile.cpu.model.length).toBeGreaterThan(0);
      expect(typeof profile.cpu.cores).toBe("number");
      expect(profile.cpu.cores).toBeGreaterThan(0);
      expect(typeof profile.cpu.threads).toBe("number");
      expect(profile.cpu.threads).toBeGreaterThan(0);
      expect(typeof profile.cpu.architecture).toBe("string");
      expect(Array.isArray(profile.cpu.features)).toBe(true);
    });

    test("memory has correct structure", async () => {
      const profile = await detector.detect();
      expect(typeof profile.memory.totalGb).toBe("number");
      expect(profile.memory.totalGb).toBeGreaterThan(0);
      expect(typeof profile.memory.availableGb).toBe("number");
      expect(profile.memory.availableGb).toBeGreaterThanOrEqual(0);
    });

    test("gpus is an array", async () => {
      const profile = await detector.detect();
      expect(Array.isArray(profile.gpus)).toBe(true);
      // Each GPU should have the right structure
      for (const gpu of profile.gpus) {
        expect(["nvidia", "amd", "intel", "apple"]).toContain(gpu.vendor);
        expect(typeof gpu.model).toBe("string");
        expect(typeof gpu.vramGb).toBe("number");
      }
    });

    test("storage has correct structure", async () => {
      const profile = await detector.detect();
      expect(typeof profile.storage.availableGb).toBe("number");
      expect(["ssd", "hdd", "unknown"]).toContain(profile.storage.type);
    });

    test("os has correct structure", async () => {
      const profile = await detector.detect();
      expect(typeof profile.os.platform).toBe("string");
      expect(typeof profile.os.release).toBe("string");
      expect(typeof profile.os.isWSL).toBe("boolean");
      expect(profile.os.platform).toBe(process.platform);
    });
  });

  // ─── detectCPU() ──────────────────────────────────────────────

  describe("detectCPU()", () => {
    test("returns a valid CPU model string", async () => {
      const cpu = await detector.detectCPU();
      expect(cpu.model).not.toBe("");
      expect(cpu.model).not.toBe("Unknown CPU");
    });

    test("cores <= threads", async () => {
      const cpu = await detector.detectCPU();
      expect(cpu.cores).toBeLessThanOrEqual(cpu.threads);
    });

    test("architecture is x86_64 or aarch64", async () => {
      const cpu = await detector.detectCPU();
      expect(["x86_64", "aarch64", "arm", "arm64", "ia32", "x64"]).toContain(cpu.architecture);
    });

    test("features is an array of strings", async () => {
      const cpu = await detector.detectCPU();
      expect(Array.isArray(cpu.features)).toBe(true);
      for (const f of cpu.features) {
        expect(typeof f).toBe("string");
      }
    });
  });

  // ─── detectMemory() ───────────────────────────────────────────

  describe("detectMemory()", () => {
    test("totalGb is positive", async () => {
      const memory = await detector.detectMemory();
      expect(memory.totalGb).toBeGreaterThan(0);
    });

    test("availableGb does not exceed totalGb", async () => {
      const memory = await detector.detectMemory();
      expect(memory.availableGb).toBeLessThanOrEqual(memory.totalGb);
    });

    test("values are in reasonable range (>0, <4096 GB)", async () => {
      const memory = await detector.detectMemory();
      expect(memory.totalGb).toBeLessThan(4096);
      expect(memory.availableGb).toBeGreaterThanOrEqual(0);
    });
  });

  // ─── detectGPUs() ─────────────────────────────────────────────

  describe("detectGPUs()", () => {
    test("returns an array", async () => {
      const gpus = await detector.detectGPUs();
      expect(Array.isArray(gpus)).toBe(true);
    });

    test("each GPU has a vendor and model", async () => {
      const gpus = await detector.detectGPUs();
      for (const gpu of gpus) {
        expect(["nvidia", "amd", "intel", "apple"]).toContain(gpu.vendor);
        expect(typeof gpu.model).toBe("string");
        expect(gpu.model.length).toBeGreaterThan(0);
      }
    });

    test("NVIDIA GPUs have vramGb > 0 if present", async () => {
      const gpus = await detector.detectGPUs();
      for (const gpu of gpus) {
        if (gpu.vendor === "nvidia") {
          expect(gpu.vramGb).toBeGreaterThan(0);
        }
      }
    });
  });

  // ─── detectStorage() ──────────────────────────────────────────

  describe("detectStorage()", () => {
    test("returns valid storage info", async () => {
      const storage = await detector.detectStorage();
      expect(typeof storage.availableGb).toBe("number");
      expect(["ssd", "hdd", "unknown"]).toContain(storage.type);
    });
  });

  // ─── detectOS() ───────────────────────────────────────────────

  describe("detectOS()", () => {
    test("returns correct platform", async () => {
      const os = await detector.detectOS();
      expect(os.platform).toBe(process.platform);
    });

    test("release is a non-empty string", async () => {
      const os = await detector.detectOS();
      expect(os.release.length).toBeGreaterThan(0);
    });

    test("isWSL is a boolean", async () => {
      const os = await detector.detectOS();
      expect(typeof os.isWSL).toBe("boolean");
    });
  });

  // ─── Singleton ────────────────────────────────────────────────

  describe("getHardwareDetector()", () => {
    test("returns same instance", async () => {
      const { getHardwareDetector } = await import("./detector");
      const d1 = getHardwareDetector();
      const d2 = getHardwareDetector();
      expect(d1).toBe(d2);
    });
  });
});
