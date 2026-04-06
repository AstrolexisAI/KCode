import { describe, test, expect } from "bun:test";
import { createPyProject } from "./python-engine";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("python-engine", () => {
  function withTmp(fn: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), "kcode-py-"));
    try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  test("creates FastAPI project", () => {
    withTmp((dir) => {
      const r = createPyProject("REST API with FastAPI called myapi", dir);
      expect(r.config.type).toBe("api");
      expect(r.config.name).toBe("myapi");
      expect(existsSync(join(dir, "myapi", "pyproject.toml"))).toBe(true);
    });
  });

  test("creates CLI project", () => {
    withTmp((dir) => {
      const r = createPyProject("CLI tool", dir);
      expect(r.config.type).toBe("cli");
    });
  });

  test("creates ML project", () => {
    withTmp((dir) => {
      const r = createPyProject("ML model training with PyTorch", dir);
      expect(r.config.type).toBe("ml");
    });
  });

  test("creates scraper project", () => {
    withTmp((dir) => {
      const r = createPyProject("web scraper with BeautifulSoup", dir);
      expect(r.config.type).toBe("scraper");
    });
  });

  test("creates bot project", () => {
    withTmp((dir) => {
      const r = createPyProject("Discord bot", dir);
      expect(r.config.type).toBe("bot");
    });
  });

  test("creates library project", () => {
    withTmp((dir) => {
      const r = createPyProject("Python library package", dir);
      expect(r.config.type).toBe("library");
    });
  });

  test("creates data pipeline", () => {
    withTmp((dir) => {
      const r = createPyProject("data pipeline with pandas", dir);
      expect(r.config.type).toBe("data");
    });
  });

  test("has Makefile and Dockerfile", () => {
    withTmp((dir) => {
      const r = createPyProject("API", dir);
      expect(existsSync(join(r.projectPath, "Makefile"))).toBe(true);
      expect(existsSync(join(r.projectPath, "Dockerfile"))).toBe(true);
    });
  });
});
