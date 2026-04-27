import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCSharpProject } from "./csharp-engine";

describe("csharp-engine", () => {
  function withTmp(fn: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), "kcode-cs-"));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("creates API project with controllers", () => {
    withTmp((dir) => {
      const r = createCSharpProject("REST API called MyApi", dir);
      expect(r.config.type).toBe("api");
      expect(r.config.name).toBe("MyApi");
      expect(existsSync(join(dir, "MyApi", "MyApi.csproj"))).toBe(true);
      expect(existsSync(join(dir, "MyApi", "Program.cs"))).toBe(true);
      expect(existsSync(join(dir, "MyApi", "Controllers/HealthController.cs"))).toBe(true);
    });
  });

  test("creates minimal API", () => {
    withTmp((dir) => {
      const r = createCSharpProject("minimal API", dir);
      expect(r.config.framework).toBe("minimal");
    });
  });

  test("creates Blazor project", () => {
    withTmp((dir) => {
      const r = createCSharpProject("Blazor SPA app", dir);
      expect(r.config.type).toBe("blazor");
      expect(existsSync(join(dir, "MyApp", "App.razor"))).toBe(true);
    });
  });

  test("creates CLI project", () => {
    withTmp((dir) => {
      const r = createCSharpProject("console CLI tool", dir);
      expect(r.config.type).toBe("cli");
      expect(r.config.deps).toContain("System.CommandLine");
    });
  });

  test("creates worker service", () => {
    withTmp((dir) => {
      const r = createCSharpProject("background worker service", dir);
      expect(r.config.type).toBe("worker");
      expect(existsSync(join(dir, "MyApp", "Worker.cs"))).toBe(true);
    });
  });

  test("adds EF Core for database keyword", () => {
    withTmp((dir) => {
      const r = createCSharpProject("API with database", dir);
      expect(r.config.deps).toContain("Microsoft.EntityFrameworkCore");
    });
  });

  test("includes test project", () => {
    withTmp((dir) => {
      const r = createCSharpProject("library", dir);
      expect(existsSync(join(dir, "MyLib", "Tests/MyLib.Tests.csproj"))).toBe(true);
    });
  });
});
