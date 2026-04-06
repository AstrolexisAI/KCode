import { describe, test, expect } from "bun:test";
import { createPhpProject } from "./php-engine";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("php-engine", () => {
  function withTmp(fn: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), "kcode-php-"));
    try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  test("creates Slim API project", () => {
    withTmp((dir) => {
      const r = createPhpProject("REST API with Slim called myapi", dir);
      expect(r.config.type).toBe("api");
      expect(r.config.framework).toBe("slim");
      expect(existsSync(join(dir, "myapi", "composer.json"))).toBe(true);
      expect(existsSync(join(dir, "myapi", "public/index.php"))).toBe(true);
    });
  });

  test("creates CLI project", () => {
    withTmp((dir) => {
      const r = createPhpProject("console CLI tool", dir);
      expect(r.config.type).toBe("cli");
      expect(existsSync(join(dir, "myapp", "bin/console"))).toBe(true);
    });
  });

  test("creates WordPress plugin", () => {
    withTmp((dir) => {
      const r = createPhpProject("WordPress plugin", dir);
      expect(r.config.type).toBe("wordpress");
    });
  });

  test("creates library", () => {
    withTmp((dir) => {
      const r = createPhpProject("composer library package", dir);
      expect(r.config.type).toBe("library");
    });
  });

  test("detects Laravel", () => {
    withTmp((dir) => {
      const r = createPhpProject("Laravel web app", dir);
      expect(r.config.framework).toBe("laravel");
    });
  });

  test("includes phpunit config", () => {
    withTmp((dir) => {
      const r = createPhpProject("API", dir);
      expect(existsSync(join(dir, "myapp", "phpunit.xml"))).toBe(true);
    });
  });
});
