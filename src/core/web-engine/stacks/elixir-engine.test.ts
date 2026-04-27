import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElixirProject } from "./elixir-engine";

describe("elixir-engine", () => {
  function withTmp(fn: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), "kcode-ex-"));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("creates Plug API project", () => {
    withTmp((dir) => {
      const r = createElixirProject("REST API called myapi", dir);
      expect(r.config.type).toBe("api");
      expect(r.config.framework).toBe("plug");
      expect(r.config.name).toBe("myapi");
      expect(existsSync(join(dir, "myapi", "mix.exs"))).toBe(true);
      expect(existsSync(join(dir, "myapi", "lib/myapi/router.ex"))).toBe(true);
    });
  });

  test("creates CLI escript", () => {
    withTmp((dir) => {
      const r = createElixirProject("CLI escript tool", dir);
      expect(r.config.type).toBe("cli");
    });
  });

  test("creates library", () => {
    withTmp((dir) => {
      const r = createElixirProject("hex library package", dir);
      expect(r.config.type).toBe("library");
      expect(r.config.name).toBe("mylib");
    });
  });

  test("creates GenServer worker", () => {
    withTmp((dir) => {
      const r = createElixirProject("GenServer OTP worker", dir);
      expect(r.config.type).toBe("worker");
      expect(existsSync(join(dir, "myapp", "lib/myapp/worker.ex"))).toBe(true);
    });
  });

  test("detects Phoenix/LiveView", () => {
    withTmp((dir) => {
      const r = createElixirProject("Phoenix LiveView app", dir);
      expect(r.config.type).toBe("liveview");
      expect(r.config.framework).toBe("phoenix");
    });
  });

  test("adds Ecto for database keyword", () => {
    withTmp((dir) => {
      const r = createElixirProject("API with Postgres database", dir);
      expect(r.config.deps.some((d) => d.name === "ecto_sql")).toBe(true);
    });
  });

  test("includes test setup", () => {
    withTmp((dir) => {
      const r = createElixirProject("API", dir);
      expect(existsSync(join(dir, "myapp", "test/test_helper.exs"))).toBe(true);
      expect(existsSync(join(dir, "myapp", "config/config.exs"))).toBe(true);
    });
  });
});
