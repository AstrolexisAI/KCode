import { describe, test, expect } from "bun:test";
import { createSwiftProject } from "./swift-engine";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("swift-engine", () => {
  function withTmp(fn: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), "kcode-swift-"));
    try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  test("creates iOS SwiftUI app", () => {
    withTmp((dir) => {
      const r = createSwiftProject("iOS app with SwiftUI called MyApp", dir);
      expect(r.config.type).toBe("ios");
      expect(r.config.name).toBe("MyApp");
      expect(existsSync(join(dir, "MyApp", "Package.swift"))).toBe(true);
      expect(existsSync(join(dir, "MyApp", "Sources/ContentView.swift"))).toBe(true);
    });
  });

  test("creates macOS app", () => {
    withTmp((dir) => {
      const r = createSwiftProject("macOS desktop app", dir);
      expect(r.config.type).toBe("macos");
    });
  });

  test("creates CLI with ArgumentParser", () => {
    withTmp((dir) => {
      const r = createSwiftProject("CLI command tool", dir);
      expect(r.config.type).toBe("cli");
      expect(r.config.dependencies.some(d => d.url.includes("argument-parser"))).toBe(true);
    });
  });

  test("creates Vapor server", () => {
    withTmp((dir) => {
      const r = createSwiftProject("Vapor API server", dir);
      expect(r.config.type).toBe("server");
      expect(r.config.framework).toBe("vapor");
    });
  });

  test("creates SPM package", () => {
    withTmp((dir) => {
      const r = createSwiftProject("Swift package library", dir);
      expect(r.config.type).toBe("package");
    });
  });

  test("has tests and CI", () => {
    withTmp((dir) => {
      const r = createSwiftProject("iOS app", dir);
      expect(r.files.some(f => f.path.includes("Tests"))).toBe(true);
      expect(r.files.some(f => f.path.includes("ci.yml"))).toBe(true);
    });
  });
});
