import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createZigProject } from "./zig-engine";

describe("zig-engine", () => {
  function withTmp(fn: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), "kcode-zig-"));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("creates CLI project", () => {
    withTmp((dir) => {
      const r = createZigProject("CLI tool called mytool", dir);
      expect(r.config.type).toBe("cli");
      expect(r.config.name).toBe("mytool");
      expect(existsSync(join(dir, "mytool", "build.zig"))).toBe(true);
      expect(existsSync(join(dir, "mytool", "build.zig.zon"))).toBe(true);
      expect(existsSync(join(dir, "mytool", "src/main.zig"))).toBe(true);
    });
  });

  test("creates library", () => {
    withTmp((dir) => {
      const r = createZigProject("library package", dir);
      expect(r.config.type).toBe("library");
      expect(r.config.name).toBe("mylib");
      expect(existsSync(join(dir, "mylib", "src/mylib.zig"))).toBe(true);
    });
  });

  test("creates HTTP server", () => {
    withTmp((dir) => {
      const r = createZigProject("HTTP server", dir);
      expect(r.config.type).toBe("server");
    });
  });

  test("creates embedded project", () => {
    withTmp((dir) => {
      const r = createZigProject("embedded firmware for STM32", dir);
      expect(r.config.type).toBe("embedded");
    });
  });

  test("creates WASM module", () => {
    withTmp((dir) => {
      const r = createZigProject("WASM module", dir);
      expect(r.config.type).toBe("wasm");
    });
  });

  test("creates game project", () => {
    withTmp((dir) => {
      const r = createZigProject("game with raylib", dir);
      expect(r.config.type).toBe("game");
    });
  });
});
