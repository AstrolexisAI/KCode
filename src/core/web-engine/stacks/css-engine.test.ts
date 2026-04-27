import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCssProject } from "./css-engine";

describe("css-engine", () => {
  function withTmp(fn: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), "kcode-css-"));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("creates design system with tokens + components + animations", () => {
    withTmp((dir) => {
      const r = createCssProject("design system called myds", dir);
      expect(r.config.type).toBe("design-system");
      expect(r.config.name).toBe("myds");
      expect(existsSync(join(dir, "myds", "src/tokens.css"))).toBe(true);
      expect(existsSync(join(dir, "myds", "src/components.css"))).toBe(true);
      expect(existsSync(join(dir, "myds", "src/animations.css"))).toBe(true);
      expect(existsSync(join(dir, "myds", "demo/index.html"))).toBe(true);
    });
  });

  test("design system has dark mode by default", () => {
    withTmp((dir) => {
      const r = createCssProject("design system", dir);
      expect(r.config.darkMode).toBe(true);
      const tokens = readFileSync(join(r.projectPath, "src/tokens.css"), "utf-8");
      expect(tokens).toContain("prefers-color-scheme: dark");
    });
  });

  test("creates component library", () => {
    withTmp((dir) => {
      const r = createCssProject("UI component library with buttons and cards", dir);
      expect(r.config.type).toBe("component-library");
      const comps = readFileSync(join(r.projectPath, "src/components.css"), "utf-8");
      expect(comps).toContain("-btn");
      expect(comps).toContain("-card");
      expect(comps).toContain("-input");
      expect(comps).toContain("-modal");
      expect(comps).toContain("-badge");
    });
  });

  test("creates animation library", () => {
    withTmp((dir) => {
      const r = createCssProject("CSS animation library", dir);
      expect(r.config.type).toBe("animation-library");
      const anim = readFileSync(join(r.projectPath, `src/${r.config.name}.css`), "utf-8");
      expect(anim).toContain("fade-in");
      expect(anim).toContain("bounce");
      expect(anim).toContain("float");
      expect(anim).toContain("shimmer");
      expect(anim).toContain("prefers-reduced-motion");
    });
  });

  test("creates Tailwind plugin", () => {
    withTmp((dir) => {
      const r = createCssProject("Tailwind plugin for custom utilities", dir);
      expect(r.config.type).toBe("tailwind-plugin");
      expect(r.config.hasTailwind).toBe(true);
      expect(existsSync(join(r.projectPath, "src/index.js"))).toBe(true);
      const src = readFileSync(join(r.projectPath, "src/index.js"), "utf-8");
      expect(src).toContain("tailwindcss/plugin");
    });
  });

  test("creates Sass framework", () => {
    withTmp((dir) => {
      const r = createCssProject("Sass SCSS framework with mixins", dir);
      expect(r.config.type).toBe("sass-framework");
      expect(r.config.preprocessor).toBe("scss");
      expect(existsSync(join(r.projectPath, "src/_variables.scss"))).toBe(true);
      expect(existsSync(join(r.projectPath, "src/_mixins.scss"))).toBe(true);
    });
  });

  test("creates PostCSS plugin", () => {
    withTmp((dir) => {
      const r = createCssProject("PostCSS plugin for transforms", dir);
      expect(r.config.type).toBe("postcss-plugin");
      expect(existsSync(join(r.projectPath, "src/index.js"))).toBe(true);
    });
  });

  test("demo page has all component examples", () => {
    withTmp((dir) => {
      const r = createCssProject("design system called testds", dir);
      const demo = readFileSync(join(r.projectPath, "demo/index.html"), "utf-8");
      expect(demo).toContain("btn-primary");
      expect(demo).toContain("card");
      expect(demo).toContain("badge");
      expect(demo).toContain("alert");
      expect(demo).toContain("skeleton");
      expect(demo).toContain("Toggle Dark Mode");
    });
  });

  test("components include accessibility (sr-only, focus-visible)", () => {
    withTmp((dir) => {
      const r = createCssProject("component library", dir);
      const comps = readFileSync(join(r.projectPath, "src/components.css"), "utf-8");
      expect(comps).toContain("sr-only");
      expect(comps).toContain("focus-visible");
    });
  });

  test("has package.json with build scripts", () => {
    withTmp((dir) => {
      const r = createCssProject("design system", dir);
      const pkg = JSON.parse(readFileSync(join(r.projectPath, "package.json"), "utf-8"));
      expect(pkg.scripts.build).toBeDefined();
      expect(pkg.scripts.dev).toBeDefined();
    });
  });
});
