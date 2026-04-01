import { describe, expect, test } from "bun:test";
import {
  homeDir,
  isLinux,
  isMacOS,
  isWindows,
  kcodeConfigDir,
  lineEnding,
  nullDevice,
  pathSeparator,
  shellName,
} from "./platform";

describe("platform utilities", () => {
  // ─── Platform detection ───

  test("exactly one platform function returns true", () => {
    const platforms = [isWindows(), isMacOS(), isLinux()];
    const trueCount = platforms.filter(Boolean).length;
    // On any given host, exactly one should be true (or zero on exotic platforms)
    expect(trueCount).toBeLessThanOrEqual(1);
    // On CI (Linux/macOS) at least one should match
    if (process.platform === "linux" || process.platform === "darwin" || process.platform === "win32") {
      expect(trueCount).toBe(1);
    }
  });

  test("isWindows matches process.platform", () => {
    expect(isWindows()).toBe(process.platform === "win32");
  });

  test("isMacOS matches process.platform", () => {
    expect(isMacOS()).toBe(process.platform === "darwin");
  });

  test("isLinux matches process.platform", () => {
    expect(isLinux()).toBe(process.platform === "linux");
  });

  // ─── homeDir ───

  test("homeDir returns a non-empty string", () => {
    const dir = homeDir();
    expect(typeof dir).toBe("string");
    expect(dir.length).toBeGreaterThan(0);
  });

  test("homeDir returns absolute path", () => {
    const dir = homeDir();
    if (isWindows()) {
      // Windows absolute paths start with drive letter (e.g., C:\)
      expect(dir).toMatch(/^[A-Za-z]:\\/);
    } else {
      expect(dir.startsWith("/")).toBe(true);
    }
  });

  // ─── nullDevice ───

  test("nullDevice returns platform-appropriate value", () => {
    const dev = nullDevice();
    if (isWindows()) {
      expect(dev).toBe("NUL");
    } else {
      expect(dev).toBe("/dev/null");
    }
  });

  // ─── pathSeparator ───

  test("pathSeparator returns platform-appropriate value", () => {
    const sep = pathSeparator();
    if (isWindows()) {
      expect(sep).toBe(";");
    } else {
      expect(sep).toBe(":");
    }
  });

  // ─── shellName ───

  test("shellName returns a non-empty string", () => {
    const name = shellName();
    expect(typeof name).toBe("string");
    expect(name.length).toBeGreaterThan(0);
  });

  test("shellName returns powershell on Windows, shell basename elsewhere", () => {
    const name = shellName();
    if (isWindows()) {
      expect(name).toBe("powershell");
    } else {
      // Should be a simple name like bash, zsh, fish — no slashes
      expect(name).not.toContain("/");
    }
  });

  // ─── lineEnding ───

  test("lineEnding returns platform-appropriate value", () => {
    const ending = lineEnding();
    if (isWindows()) {
      expect(ending).toBe("\r\n");
    } else {
      expect(ending).toBe("\n");
    }
  });

  // ─── kcodeConfigDir ───

  test("kcodeConfigDir ends with .kcode", () => {
    const dir = kcodeConfigDir();
    expect(dir.endsWith(".kcode")).toBe(true);
  });

  test("kcodeConfigDir is under homeDir", () => {
    const dir = kcodeConfigDir();
    expect(dir.startsWith(homeDir())).toBe(true);
  });
});
