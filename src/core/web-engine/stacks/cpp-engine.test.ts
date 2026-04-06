import { describe, test, expect } from "bun:test";
import { createCppProject } from "./cpp-engine";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("cpp-engine", () => {
  function withTmp(fn: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), "kcode-cpp-"));
    try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  test("creates library project", () => {
    withTmp((dir) => {
      const r = createCppProject("C++ library called mylib", dir);
      expect(r.config.type).toBe("library");
      expect(r.config.name).toBe("mylib");
      expect(existsSync(join(dir, "mylib", "CMakeLists.txt"))).toBe(true);
    });
  });

  test("creates server project", () => {
    withTmp((dir) => {
      const r = createCppProject("HTTP server", dir);
      expect(r.config.type).toBe("server");
    });
  });

  test("creates CLI project", () => {
    withTmp((dir) => {
      const r = createCppProject("command line tool", dir);
      expect(r.config.type).toBe("cli");
    });
  });

  test("creates game project", () => {
    withTmp((dir) => {
      const r = createCppProject("game with OpenGL", dir);
      expect(r.config.type).toBe("game");
    });
  });

  test("creates embedded project", () => {
    withTmp((dir) => {
      const r = createCppProject("embedded firmware", dir);
      expect(r.config.type).toBe("embedded");
    });
  });

  test("detects C standard", () => {
    withTmp((dir) => {
      const r = createCppProject("C library for compression", dir);
      expect(["c17", "c11"]).toContain(r.config.standard);
    });
  });

  test("has CI and Dockerfile", () => {
    withTmp((dir) => {
      const r = createCppProject("server app", dir);
      expect(r.files.some(f => f.path.includes("ci.yml"))).toBe(true);
    });
  });
});
