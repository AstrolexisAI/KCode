import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import {
  getDefaultSandboxConfig,
  getSandboxCapabilities,
  getSandboxMode,
  isSandboxAvailable,
  type SandboxMode,
  type SandboxOptions,
  wrapWithSandbox,
} from "./sandbox.ts";

// ─── getDefaultSandboxConfig ───────────────────────────────────

describe("getDefaultSandboxConfig", () => {
  const cwd = "/home/user/project";

  test("allowWritePaths includes cwd", () => {
    const config = getDefaultSandboxConfig("light", cwd);
    expect(config.allowWritePaths).toContain(cwd);
  });

  test("allowWritePaths includes /tmp", () => {
    const config = getDefaultSandboxConfig("light", cwd);
    expect(config.allowWritePaths).toContain("/tmp");
  });

  test("readOnlyPaths includes /etc/resolv.conf", () => {
    const config = getDefaultSandboxConfig("light", cwd);
    expect(config.readOnlyPaths).toContain("/etc/resolv.conf");
  });

  test("readOnlyPaths includes /etc/ssl", () => {
    const config = getDefaultSandboxConfig("light", cwd);
    expect(config.readOnlyPaths).toContain("/etc/ssl");
  });

  test("readOnlyPaths includes /etc/ca-certificates", () => {
    const config = getDefaultSandboxConfig("light", cwd);
    expect(config.readOnlyPaths).toContain("/etc/ca-certificates");
  });

  test("allowNetwork defaults to true when no opts provided", () => {
    const config = getDefaultSandboxConfig("strict", cwd);
    expect(config.allowNetwork).toBe(true);
  });

  test("allowNetwork defaults to true when opts omit allowNetwork", () => {
    const config = getDefaultSandboxConfig("strict", cwd, {});
    expect(config.allowNetwork).toBe(true);
  });

  test("allowNetwork can be set to false via opts", () => {
    const config = getDefaultSandboxConfig("strict", cwd, { allowNetwork: false });
    expect(config.allowNetwork).toBe(false);
  });

  test("extra writablePaths from opts are included", () => {
    const extra = ["/home/user/extra", "/data/shared"];
    const config = getDefaultSandboxConfig("light", cwd, { writablePaths: extra });
    expect(config.allowWritePaths).toContain("/home/user/extra");
    expect(config.allowWritePaths).toContain("/data/shared");
    // Original paths are still present
    expect(config.allowWritePaths).toContain(cwd);
    expect(config.allowWritePaths).toContain("/tmp");
  });

  test("extra readOnlyPaths from opts are included", () => {
    const extra = ["/opt/data", "/mnt/archive"];
    const config = getDefaultSandboxConfig("light", cwd, { readOnlyPaths: extra });
    expect(config.readOnlyPaths).toContain("/opt/data");
    expect(config.readOnlyPaths).toContain("/mnt/archive");
    // Original read-only paths are still present
    expect(config.readOnlyPaths).toContain("/etc/resolv.conf");
  });

  test("tmpDir is /tmp", () => {
    const config = getDefaultSandboxConfig("light", cwd);
    expect(config.tmpDir).toBe("/tmp");
  });

  test("mode is set to the requested value", () => {
    expect(getDefaultSandboxConfig("off", cwd).mode).toBe("off");
    expect(getDefaultSandboxConfig("light", cwd).mode).toBe("light");
    expect(getDefaultSandboxConfig("strict", cwd).mode).toBe("strict");
  });
});

// ─── wrapWithSandbox ───────────────────────────────────────────

describe("wrapWithSandbox", () => {
  const cwd = "/home/user/project";

  test('mode "off" returns command unchanged', () => {
    const config = getDefaultSandboxConfig("off", cwd);
    const result = wrapWithSandbox("echo hello", config);
    expect(result.command).toBe("echo hello");
  });

  test('mode "off" returns no env', () => {
    const config = getDefaultSandboxConfig("off", cwd);
    const result = wrapWithSandbox("echo hello", config);
    expect(result.env).toBeUndefined();
  });

  test('mode "light" wraps with bash', () => {
    const config = getDefaultSandboxConfig("light", cwd);
    const result = wrapWithSandbox("ls -la", config);
    expect(result.command).toContain("bash");
  });

  test('mode "light" env includes SANDBOX: "1"', () => {
    const config = getDefaultSandboxConfig("light", cwd);
    const result = wrapWithSandbox("ls -la", config);
    expect(result.env).toBeDefined();
    expect(result.env!.SANDBOX).toBe("1");
  });

  test('mode "light" env includes TMPDIR', () => {
    const config = getDefaultSandboxConfig("light", cwd);
    const result = wrapWithSandbox("ls -la", config);
    expect(result.env).toBeDefined();
    expect(result.env!.TMPDIR).toBe("/tmp");
  });

  test('mode "light" command includes safety guard', () => {
    const config = getDefaultSandboxConfig("light", cwd);
    const result = wrapWithSandbox("echo safe", config);
    expect(result.command).toContain("__kcode_guard");
  });

  test('mode "strict" without bwrap falls back to light mode behavior', () => {
    // If bwrap is not available, strict should produce light-mode output
    // We test this by checking that the output has the same structure as light mode
    const configStrict = getDefaultSandboxConfig("strict", cwd);
    const resultStrict = wrapWithSandbox("echo test", configStrict);

    // Whether bwrap is available or not, the result should have env and a wrapped command
    expect(resultStrict.command).toContain("bash");
    expect(resultStrict.env).toBeDefined();
  });

  test('mode "strict" with bwrap includes bwrap flags when available', () => {
    // This test verifies the bwrap path if bwrap is installed on this system
    const bwrapAvailable = isSandboxAvailable();
    const config = getDefaultSandboxConfig("strict", cwd);
    const result = wrapWithSandbox("echo test", config);

    if (bwrapAvailable) {
      expect(result.command).toContain("bwrap");
      expect(result.command).toContain("--unshare-pid");
      expect(result.command).toContain("--ro-bind");
      expect(result.env?.SANDBOX).toBe("strict");
    } else {
      // Falls back to light mode
      expect(result.env?.SANDBOX).toBe("1");
    }
  });
});

// ─── getSandboxCapabilities ────────────────────────────────────

describe("getSandboxCapabilities", () => {
  test("returns an object with bwrap field", () => {
    const caps = getSandboxCapabilities();
    expect(typeof caps.bwrap).toBe("boolean");
  });

  test("returns an object with unshare field", () => {
    const caps = getSandboxCapabilities();
    expect(typeof caps.unshare).toBe("boolean");
  });

  test("returns an object with available field", () => {
    const caps = getSandboxCapabilities();
    expect(typeof caps.available).toBe("boolean");
  });

  test("available is true if either bwrap or unshare is true", () => {
    const caps = getSandboxCapabilities();
    expect(caps.available).toBe(caps.bwrap || caps.unshare);
  });
});

// ─── isSandboxAvailable / getSandboxMode ───────────────────────

describe("isSandboxAvailable", () => {
  test("returns a boolean", () => {
    expect(typeof isSandboxAvailable()).toBe("boolean");
  });
});

describe("getSandboxMode", () => {
  test('returns "bwrap" or "none"', () => {
    const mode = getSandboxMode();
    expect(["bwrap", "none"]).toContain(mode);
  });

  test("is consistent with isSandboxAvailable", () => {
    const available = isSandboxAvailable();
    const mode = getSandboxMode();
    if (available) {
      expect(mode).toBe("bwrap");
    } else {
      expect(mode).toBe("none");
    }
  });
});
