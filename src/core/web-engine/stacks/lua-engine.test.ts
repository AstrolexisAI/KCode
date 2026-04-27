import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLuaProject } from "./lua-engine";

describe("lua-engine", () => {
  function withTmp(fn: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), "kcode-lua-"));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("creates Love2D game project", () => {
    withTmp((dir) => {
      const r = createLuaProject("Love2D game called mygame", dir);
      expect(r.config.type).toBe("game");
      expect(r.config.framework).toBe("love2d");
      expect(r.config.name).toBe("mygame");
      expect(existsSync(join(dir, "mygame", "conf.lua"))).toBe(true);
      expect(existsSync(join(dir, "mygame", "main.lua"))).toBe(true);
      expect(existsSync(join(dir, "mygame", "mygame-0.1.0-1.rockspec"))).toBe(true);
    });
  });

  test("creates Neovim plugin", () => {
    withTmp((dir) => {
      const r = createLuaProject("neovim plugin called treesearch", dir);
      expect(r.config.type).toBe("neovim");
      expect(r.config.framework).toBe("neovim");
      expect(existsSync(join(dir, "treesearch", "lua/treesearch/init.lua"))).toBe(true);
      expect(existsSync(join(dir, "treesearch", "plugin/treesearch.vim"))).toBe(true);
    });
  });

  test("creates script project", () => {
    withTmp((dir) => {
      const r = createLuaProject("Lua script tool called fetcher", dir);
      expect(r.config.type).toBe("script");
      expect(r.config.name).toBe("fetcher");
      expect(existsSync(join(dir, "fetcher", "main.lua"))).toBe(true);
      expect(existsSync(join(dir, "fetcher", "Makefile"))).toBe(true);
    });
  });

  test("creates library package", () => {
    withTmp((dir) => {
      const r = createLuaProject("Lua library", dir);
      expect(r.config.type).toBe("library");
      expect(r.config.name).toBe("mylib");
      expect(existsSync(join(dir, "mylib", "src/mylib/init.lua"))).toBe(true);
      expect(existsSync(join(dir, "mylib", "mylib-0.1.0-1.rockspec"))).toBe(true);
    });
  });

  test("creates server with lapis", () => {
    withTmp((dir) => {
      const r = createLuaProject("lapis web server called myapi", dir);
      expect(r.config.type).toBe("server");
      expect(r.config.framework).toBe("lapis");
      expect(r.config.deps).toContain("lapis");
      expect(existsSync(join(dir, "myapi", "app.lua"))).toBe(true);
      expect(existsSync(join(dir, "myapi", "config.lua"))).toBe(true);
    });
  });

  test("defaults to script type", () => {
    withTmp((dir) => {
      const r = createLuaProject("something in Lua", dir);
      expect(r.config.type).toBe("script");
      expect(r.config.name).toBe("myapp");
      expect(existsSync(join(dir, "myapp", "main.lua"))).toBe(true);
      expect(existsSync(join(dir, "myapp", ".gitignore"))).toBe(true);
      expect(existsSync(join(dir, "myapp", ".luacheckrc"))).toBe(true);
      expect(existsSync(join(dir, "myapp", "spec/main_spec.lua"))).toBe(true);
    });
  });

  test("detects dependency keywords", () => {
    withTmp((dir) => {
      const r = createLuaProject("Lua script with luasocket and json and lpeg", dir);
      expect(r.config.deps).toContain("luasocket");
      expect(r.config.deps).toContain("cjson");
      expect(r.config.deps).toContain("lpeg");
    });
  });
});
