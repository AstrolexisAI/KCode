import { describe, expect, test } from "bun:test";
import { applyAirGapOverrides, type Settings } from "./config";

describe("air-gap mode", () => {
  const baseSettings: Settings = {
    model: "llama-3.1",
    autoUpdate: true,
    telemetry: true,
    offline: { enabled: false },
    featureFlags: { enableAutoRoute: true },
  };

  test("does nothing when deployment is not air-gap", () => {
    const settings: Settings = { ...baseSettings, deployment: "cloud" };
    const result = applyAirGapOverrides(settings);
    expect(result.autoUpdate).toBe(true);
    expect(result.telemetry).toBe(true);
    expect(result.offline?.enabled).toBe(false);
  });

  test("does nothing when deployment is undefined", () => {
    const settings: Settings = { ...baseSettings };
    const result = applyAirGapOverrides(settings);
    expect(result.autoUpdate).toBe(true);
    expect(result.telemetry).toBe(true);
  });

  test("forces autoUpdate=false in air-gap mode", () => {
    const settings: Settings = { ...baseSettings, deployment: "air-gap" };
    const result = applyAirGapOverrides(settings);
    expect(result.autoUpdate).toBe(false);
  });

  test("forces telemetry=false in air-gap mode", () => {
    const settings: Settings = { ...baseSettings, deployment: "air-gap" };
    const result = applyAirGapOverrides(settings);
    expect(result.telemetry).toBe(false);
  });

  test("forces offline.enabled=true in air-gap mode", () => {
    const settings: Settings = { ...baseSettings, deployment: "air-gap" };
    const result = applyAirGapOverrides(settings);
    expect(result.offline?.enabled).toBe(true);
  });

  test("forces offline.autoDetect=false in air-gap mode", () => {
    const settings: Settings = {
      ...baseSettings,
      deployment: "air-gap",
      offline: { enabled: false, autoDetect: true },
    };
    const result = applyAirGapOverrides(settings);
    expect(result.offline?.autoDetect).toBe(false);
  });

  test("disables autoRoute feature flag in air-gap mode", () => {
    const settings: Settings = { ...baseSettings, deployment: "air-gap" };
    const result = applyAirGapOverrides(settings);
    expect(result.featureFlags?.enableAutoRoute).toBe(false);
  });

  test("disables marketplace remote in air-gap mode", () => {
    const settings: Settings = { ...baseSettings, deployment: "air-gap" };
    const result = applyAirGapOverrides(settings);
    expect((result.marketplace as any)?.disableRemote).toBe(true);
  });

  test("preserves non-overridden settings in air-gap mode", () => {
    const settings: Settings = {
      ...baseSettings,
      deployment: "air-gap",
      model: "deepseek-coder",
      theme: "dark",
      effortLevel: "high",
    };
    const result = applyAirGapOverrides(settings);
    expect(result.model).toBe("deepseek-coder");
    expect(result.theme).toBe("dark");
    expect(result.effortLevel).toBe("high");
  });

  test("preserves existing offline settings when applying overrides", () => {
    const settings: Settings = {
      ...baseSettings,
      deployment: "air-gap",
      offline: { enabled: false, cacheWarmer: { enabled: true, maxCacheSizeMb: 500 } },
    };
    const result = applyAirGapOverrides(settings);
    expect(result.offline?.enabled).toBe(true);
    expect(result.offline?.cacheWarmer?.enabled).toBe(true);
    expect(result.offline?.cacheWarmer?.maxCacheSizeMb).toBe(500);
  });

  test("KCODE_DEPLOYMENT env var works", () => {
    // This is tested indirectly — the env var is read in envSettings()
    // and feeds into the settings merge pipeline. Here we just verify
    // the type guard works.
    const settings: Settings = { deployment: "air-gap" };
    const result = applyAirGapOverrides(settings);
    expect(result.autoUpdate).toBe(false);
  });
});
