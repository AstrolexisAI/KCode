import { describe, test, expect } from "bun:test";
import { createRubyProject } from "./ruby-engine";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("ruby-engine", () => {
  function withTmp(fn: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), "kcode-rb-"));
    try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  test("creates Sinatra API project", () => {
    withTmp((dir) => {
      const r = createRubyProject("Sinatra REST API called myapi", dir);
      expect(r.config.type).toBe("api");
      expect(r.config.framework).toBe("sinatra");
      expect(existsSync(join(dir, "myapi", "Gemfile"))).toBe(true);
      expect(existsSync(join(dir, "myapi", "app.rb"))).toBe(true);
      expect(existsSync(join(dir, "myapi", "config.ru"))).toBe(true);
    });
  });

  test("creates CLI project with Thor", () => {
    withTmp((dir) => {
      const r = createRubyProject("CLI command tool", dir);
      expect(r.config.type).toBe("cli");
      expect(r.config.gems).toContain("thor");
    });
  });

  test("creates gem library", () => {
    withTmp((dir) => {
      const r = createRubyProject("gem library", dir);
      expect(r.config.type).toBe("library");
      expect(r.config.name).toBe("mylib");
      expect(existsSync(join(dir, "mylib", "mylib.gemspec"))).toBe(true);
    });
  });

  test("creates Sidekiq worker", () => {
    withTmp((dir) => {
      const r = createRubyProject("Sidekiq background worker", dir);
      expect(r.config.type).toBe("worker");
      expect(r.config.gems).toContain("sidekiq");
    });
  });

  test("includes RSpec setup", () => {
    withTmp((dir) => {
      const r = createRubyProject("API", dir);
      expect(existsSync(join(dir, "myapp", "spec/spec_helper.rb"))).toBe(true);
    });
  });
});
