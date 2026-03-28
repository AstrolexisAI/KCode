// KCode - Execution Profiles Tests

import { describe, test, expect } from "bun:test";
import { getProfile, listProfiles, applyProfile, getCurrentProfileName } from "./profiles";
import type { KCodeConfig } from "./types";

function makeConfig(overrides: Partial<KCodeConfig> = {}): KCodeConfig {
  return {
    model: "test-model",
    maxTokens: 16384,
    systemPrompt: "",
    workingDirectory: "/tmp",
    permissionMode: "ask",
    ...overrides,
  };
}

describe("getProfile", () => {
  test("returns safe profile", () => {
    const p = getProfile("safe");
    expect(p).toBeDefined();
    expect(p!.name).toBe("safe");
    expect(p!.settings.permissionMode).toBe("ask");
    expect(p!.settings.disallowedTools).toContain("Write");
  });

  test("returns fast profile", () => {
    const p = getProfile("fast");
    expect(p).toBeDefined();
    expect(p!.name).toBe("fast");
    expect(p!.settings.effortLevel).toBe("low");
    expect(p!.settings.maxTokens).toBe(4096);
  });

  test("returns review profile", () => {
    const p = getProfile("review");
    expect(p).toBeDefined();
    expect(p!.settings.thinking).toBe(true);
    expect(p!.settings.effortLevel).toBe("high");
    expect(p!.settings.disallowedTools).toContain("Bash");
  });

  test("returns implement profile", () => {
    const p = getProfile("implement");
    expect(p).toBeDefined();
    expect(p!.settings.permissionMode).toBe("auto");
    expect(p!.settings.thinking).toBe(true);
  });

  test("returns ops profile", () => {
    const p = getProfile("ops");
    expect(p).toBeDefined();
    expect(p!.settings.allowedTools).toContain("Bash");
    expect(p!.settings.allowedTools).toContain("Read");
    expect(p!.settings.allowedTools).not.toContain("Edit");
  });

  test("is case-insensitive", () => {
    expect(getProfile("SAFE")).toBeDefined();
    expect(getProfile("Fast")).toBeDefined();
    expect(getProfile("REVIEW")).toBeDefined();
  });

  test("returns undefined for unknown profile", () => {
    expect(getProfile("nonexistent")).toBeUndefined();
    expect(getProfile("")).toBeUndefined();
  });
});

describe("listProfiles", () => {
  test("returns all 5 built-in profiles", () => {
    const profiles = listProfiles();
    expect(profiles).toHaveLength(5);
    const names = profiles.map(p => p.name);
    expect(names).toContain("safe");
    expect(names).toContain("fast");
    expect(names).toContain("review");
    expect(names).toContain("implement");
    expect(names).toContain("ops");
  });

  test("returns copies (not references to internal array)", () => {
    const a = listProfiles();
    const b = listProfiles();
    expect(a).not.toBe(b);
  });
});

describe("applyProfile", () => {
  test("sets permission mode and effort level", () => {
    const config = makeConfig();
    const profile = getProfile("implement")!;
    applyProfile(config, profile);
    expect(config.permissionMode).toBe("auto");
    expect(config.effortLevel).toBe("high");
    expect(config.thinking).toBe(true);
    expect(config.activeProfile).toBe("implement");
  });

  test("sets maxTokens when profile specifies it", () => {
    const config = makeConfig();
    applyProfile(config, getProfile("fast")!);
    expect(config.maxTokens).toBe(4096);
  });

  test("does not change maxTokens when profile does not specify it", () => {
    const config = makeConfig({ maxTokens: 8192 });
    applyProfile(config, getProfile("safe")!);
    expect(config.maxTokens).toBe(8192);
  });

  test("sets disallowedTools", () => {
    const config = makeConfig();
    applyProfile(config, getProfile("safe")!);
    expect(config.disallowedTools).toContain("Write");
    expect(config.disallowedTools).toContain("Edit");
    expect(config.disallowedTools).toContain("Bash");
  });

  test("sets allowedTools for ops profile", () => {
    const config = makeConfig();
    applyProfile(config, getProfile("ops")!);
    expect(config.allowedTools).toEqual(["Read", "Bash", "Glob", "Grep", "LS"]);
  });

  test("appends to existing systemPromptAppend", () => {
    const config = makeConfig();
    (config as any).systemPromptAppend = "Existing instruction.";
    applyProfile(config, getProfile("safe")!);
    expect(config.systemPromptAppend).toContain("Existing instruction.");
    expect(config.systemPromptAppend).toContain("SAFE mode");
  });

  test("sets systemPromptAppend when none exists", () => {
    const config = makeConfig();
    applyProfile(config, getProfile("review")!);
    expect(config.systemPromptAppend).toContain("REVIEW mode");
  });
});

describe("getCurrentProfileName", () => {
  test("returns profile name when activeProfile is set", () => {
    const config = makeConfig({ activeProfile: "fast" });
    expect(getCurrentProfileName(config)).toBe("fast");
  });

  test("detects matching profile by settings", () => {
    const config = makeConfig();
    applyProfile(config, getProfile("ops")!);
    // Clear the tracked name to force heuristic detection
    config.activeProfile = undefined;
    expect(getCurrentProfileName(config)).toBe("ops");
  });

  test("returns null when no profile matches", () => {
    const config = makeConfig({
      permissionMode: "deny",
      effortLevel: "max",
    });
    expect(getCurrentProfileName(config)).toBeNull();
  });
});
