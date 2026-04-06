import { describe, test, expect } from "bun:test";
import { createKotlinProject } from "./kotlin-engine";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("kotlin-engine", () => {
  function withTmp(fn: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), "kcode-kt-"));
    try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  test("creates Ktor API project", () => {
    withTmp((dir) => {
      const r = createKotlinProject("API with Ktor called myapi", dir);
      expect(r.config.type).toBe("api");
      expect(r.config.framework).toBe("ktor");
      expect(r.config.name).toBe("myapi");
      expect(existsSync(join(dir, "myapi", "build.gradle.kts"))).toBe(true);
      expect(existsSync(join(dir, "myapi", "src/main/kotlin/com/myapi/Main.kt"))).toBe(true);
    });
  });

  test("creates CLI project", () => {
    withTmp((dir) => {
      const r = createKotlinProject("command line tool", dir);
      expect(r.config.type).toBe("cli");
    });
  });

  test("creates library project", () => {
    withTmp((dir) => {
      const r = createKotlinProject("library package", dir);
      expect(r.config.type).toBe("library");
      expect(r.config.name).toBe("mylib");
    });
  });

  test("detects Android/Compose", () => {
    withTmp((dir) => {
      const r = createKotlinProject("Android app with Compose", dir);
      expect(r.config.type).toBe("android");
    });
  });

  test("adds Exposed for database keyword", () => {
    withTmp((dir) => {
      const r = createKotlinProject("API with database", dir);
      expect(r.config.deps.some(d => d.includes("exposed"))).toBe(true);
    });
  });
});
