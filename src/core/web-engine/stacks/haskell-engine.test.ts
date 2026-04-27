import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHaskellProject } from "./haskell-engine";

describe("haskell-engine", () => {
  function withTmp(fn: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), "kcode-hs-"));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("creates Scotty API project", () => {
    withTmp((dir) => {
      const r = createHaskellProject("REST API called myapi", dir);
      expect(r.config.type).toBe("api");
      expect(r.config.framework).toBe("scotty");
      expect(r.config.name).toBe("myapi");
      expect(existsSync(join(dir, "myapi", "package.yaml"))).toBe(true);
      expect(existsSync(join(dir, "myapi", "stack.yaml"))).toBe(true);
      expect(existsSync(join(dir, "myapi", "app/Main.hs"))).toBe(true);
      expect(existsSync(join(dir, "myapi", "src/Lib.hs"))).toBe(true);
      expect(existsSync(join(dir, "myapi", "test/Spec.hs"))).toBe(true);
    });
  });

  test("creates CLI project with optparse", () => {
    withTmp((dir) => {
      const r = createHaskellProject("CLI command tool called mytool", dir);
      expect(r.config.type).toBe("cli");
      expect(r.config.name).toBe("mytool");
      expect(r.config.deps.some((d) => d.name === "optparse-applicative")).toBe(true);
      expect(existsSync(join(dir, "mytool", "app/Main.hs"))).toBe(true);
    });
  });

  test("creates library", () => {
    withTmp((dir) => {
      const r = createHaskellProject("hackage library package", dir);
      expect(r.config.type).toBe("library");
      expect(r.config.name).toBe("mylib");
      expect(existsSync(join(dir, "mylib", "src/Mylib.hs"))).toBe(true);
    });
  });

  test("detects dependencies", () => {
    withTmp((dir) => {
      const r = createHaskellProject("API with postgresql and mtl and lens", dir);
      expect(r.config.deps.some((d) => d.name === "postgresql-simple")).toBe(true);
      expect(r.config.deps.some((d) => d.name === "mtl")).toBe(true);
      expect(r.config.deps.some((d) => d.name === "lens")).toBe(true);
    });
  });

  test("default name is myapp", () => {
    withTmp((dir) => {
      const r = createHaskellProject("API server", dir);
      expect(r.config.name).toBe("myapp");
    });
  });

  test("creates Servant API", () => {
    withTmp((dir) => {
      const r = createHaskellProject("servant API", dir);
      expect(r.config.type).toBe("api");
      expect(r.config.framework).toBe("servant");
      expect(r.config.deps.some((d) => d.name === "servant")).toBe(true);
    });
  });

  test("creates Yesod web project", () => {
    withTmp((dir) => {
      const r = createHaskellProject("yesod web app", dir);
      expect(r.config.type).toBe("web");
      expect(r.config.framework).toBe("yesod");
    });
  });

  test("includes CI and gitignore", () => {
    withTmp((dir) => {
      const r = createHaskellProject("API", dir);
      expect(existsSync(join(dir, "myapp", ".github/workflows/ci.yml"))).toBe(true);
      expect(existsSync(join(dir, "myapp", ".gitignore"))).toBe(true);
    });
  });
});
