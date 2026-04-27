import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRustProject } from "./rust-engine";

describe("rust-engine", () => {
  function withTmp(fn: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), "kcode-rs-"));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("creates CLI project", () => {
    withTmp((dir) => {
      const r = createRustProject("CLI tool called mytool", dir);
      expect(r.config.type).toBe("cli");
      expect(r.config.name).toBe("mytool");
      expect(existsSync(join(dir, "mytool", "Cargo.toml"))).toBe(true);
      expect(existsSync(join(dir, "mytool", "src/main.rs"))).toBe(true);
    });
  });

  test("creates Axum API", () => {
    withTmp((dir) => {
      const r = createRustProject("REST API server with Axum", dir);
      expect(r.config.type).toBe("api");
    });
  });

  test("creates library", () => {
    withTmp((dir) => {
      const r = createRustProject("library crate", dir);
      expect(r.config.type).toBe("library");
    });
  });

  test("creates WASM project", () => {
    withTmp((dir) => {
      const r = createRustProject("WebAssembly module", dir);
      expect(r.config.type).toBe("wasm");
    });
  });

  test("creates game with Bevy", () => {
    withTmp((dir) => {
      const r = createRustProject("game with Bevy engine", dir);
      expect(r.config.type).toBe("game");
    });
  });

  test("has CI workflow", () => {
    withTmp((dir) => {
      const r = createRustProject("CLI", dir);
      expect(r.files.some((f) => f.path.includes("ci.yml"))).toBe(true);
    });
  });
});
