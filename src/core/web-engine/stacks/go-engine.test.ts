import { describe, test, expect } from "bun:test";
import { createGoProject } from "./go-engine";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("go-engine", () => {
  function withTmp(fn: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), "kcode-go-"));
    try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  test("creates Chi API project", () => {
    withTmp((dir) => {
      const r = createGoProject("REST API with Chi called myapi", dir);
      expect(r.config.type).toBe("api");
      expect(r.config.framework).toBe("chi");
      expect(r.config.name).toBe("myapi");
      expect(existsSync(join(dir, "myapi", "go.mod"))).toBe(true);
      expect(existsSync(join(dir, "myapi", "main.go"))).toBe(true);
    });
  });

  test("creates Gin API", () => {
    withTmp((dir) => {
      const r = createGoProject("API with Gin framework", dir);
      expect(r.config.framework).toBe("gin");
    });
  });

  test("creates CLI project", () => {
    withTmp((dir) => {
      const r = createGoProject("command line tool", dir);
      expect(r.config.type).toBe("cli");
    });
  });

  test("creates library", () => {
    withTmp((dir) => {
      const r = createGoProject("Go library package", dir);
      expect(r.config.type).toBe("library");
      expect(r.config.name).toBe("mylib");
    });
  });

  test("creates gRPC service", () => {
    withTmp((dir) => {
      const r = createGoProject("gRPC service with protobuf", dir);
      expect(r.config.type).toBe("grpc");
    });
  });

  test("creates worker", () => {
    withTmp((dir) => {
      const r = createGoProject("background worker job consumer", dir);
      expect(r.config.type).toBe("worker");
    });
  });

  test("adds database deps", () => {
    withTmp((dir) => {
      const r = createGoProject("API with SQLite database", dir);
      expect(r.config.dependencies.some(d => d.includes("sqlx"))).toBe(true);
    });
  });

  test("has Makefile and Dockerfile", () => {
    withTmp((dir) => {
      const r = createGoProject("API", dir);
      expect(existsSync(join(dir, "myapp", "Makefile"))).toBe(true);
      expect(existsSync(join(dir, "myapp", "Dockerfile"))).toBe(true);
    });
  });
});
