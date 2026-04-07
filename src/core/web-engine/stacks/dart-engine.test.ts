import { describe, test, expect } from "bun:test";
import { createDartProject } from "./dart-engine";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("dart-engine", () => {
  function withTmp(fn: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), "kcode-dart-"));
    try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  test("creates Flutter mobile app", () => {
    withTmp((dir) => {
      const r = createDartProject("Flutter mobile app called myflutter", dir);
      expect(r.config.type).toBe("mobile");
      expect(r.config.framework).toBe("flutter");
      expect(r.config.name).toBe("myflutter");
      expect(existsSync(join(dir, "myflutter", "pubspec.yaml"))).toBe(true);
      expect(existsSync(join(dir, "myflutter", "lib/main.dart"))).toBe(true);
      expect(existsSync(join(dir, "myflutter", "lib/app.dart"))).toBe(true);
      expect(existsSync(join(dir, "myflutter", "lib/screens/home_screen.dart"))).toBe(true);
      expect(existsSync(join(dir, "myflutter", "analysis_options.yaml"))).toBe(true);
    });
  });

  test("creates CLI project", () => {
    withTmp((dir) => {
      const r = createDartProject("command line tool called mytool", dir);
      expect(r.config.type).toBe("cli");
      expect(r.config.name).toBe("mytool");
      expect(existsSync(join(dir, "mytool", "bin/main.dart"))).toBe(true);
    });
  });

  test("creates server with dart_frog", () => {
    withTmp((dir) => {
      const r = createDartProject("dart_frog server called myserver", dir);
      expect(r.config.type).toBe("server");
      expect(r.config.framework).toBe("dart_frog");
      expect(r.config.name).toBe("myserver");
      expect(existsSync(join(dir, "myserver", "routes/index.dart"))).toBe(true);
      expect(existsSync(join(dir, "myserver", "routes/health.dart"))).toBe(true);
    });
  });

  test("creates library package", () => {
    withTmp((dir) => {
      const r = createDartProject("library package called mylib", dir);
      expect(r.config.type).toBe("library");
      expect(r.config.name).toBe("mylib");
      expect(existsSync(join(dir, "mylib", "lib/src/mylib.dart"))).toBe(true);
      expect(existsSync(join(dir, "mylib", "lib/mylib.dart"))).toBe(true);
    });
  });

  test("detects riverpod dependency", () => {
    withTmp((dir) => {
      const r = createDartProject("Flutter app with riverpod", dir);
      expect(r.config.deps.some(d => d.name.includes("riverpod"))).toBe(true);
    });
  });

  test("detects dio dependency", () => {
    withTmp((dir) => {
      const r = createDartProject("Flutter app with dio", dir);
      expect(r.config.deps.some(d => d.name === "dio")).toBe(true);
    });
  });

  test("uses default name", () => {
    withTmp((dir) => {
      const r = createDartProject("Flutter mobile app", dir);
      expect(r.config.name).toBe("myapp");
    });
  });
});
