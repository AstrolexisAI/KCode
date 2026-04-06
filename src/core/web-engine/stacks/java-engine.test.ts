import { describe, test, expect } from "bun:test";
import { createJavaProject } from "./java-engine";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("java-engine", () => {
  function withTmp(fn: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), "kcode-java-"));
    try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  test("creates Spring Boot API project", () => {
    withTmp((dir) => {
      const r = createJavaProject("REST API with Spring called myapi", dir);
      expect(r.config.type).toBe("api");
      expect(r.config.framework).toBe("spring");
      expect(r.config.name).toBe("myapi");
      expect(existsSync(join(dir, "myapi", "build.gradle.kts"))).toBe(true);
      expect(existsSync(join(dir, "myapi", "src/main/java/com/myapi/Application.java"))).toBe(true);
      expect(existsSync(join(dir, "myapi", "Dockerfile"))).toBe(true);
      expect(r.files.length).toBeGreaterThan(5);
    });
  });

  test("detects CLI type", () => {
    withTmp((dir) => {
      const r = createJavaProject("command line tool", dir);
      expect(r.config.type).toBe("cli");
    });
  });

  test("adds JPA deps for database keyword", () => {
    withTmp((dir) => {
      const r = createJavaProject("API with database", dir);
      expect(r.config.deps).toContain("spring-boot-starter-data-jpa");
    });
  });

  test("default name is myapp", () => {
    withTmp((dir) => {
      const r = createJavaProject("simple api", dir);
      expect(r.config.name).toBe("myapp");
    });
  });
});
