import { describe, test, expect } from "bun:test";
import { createScalaProject } from "./scala-engine";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("scala-engine", () => {
  function withTmp(fn: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), "kcode-scala-"));
    try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  test("creates http4s API project", () => {
    withTmp((dir) => {
      const r = createScalaProject("REST API called myapi", dir);
      expect(r.config.type).toBe("api");
      expect(r.config.framework).toBe("http4s");
      expect(r.config.name).toBe("myapi");
      expect(existsSync(join(dir, "myapi", "build.sbt"))).toBe(true);
      expect(existsSync(join(dir, "myapi", "project/build.properties"))).toBe(true);
      expect(existsSync(join(dir, "myapi", "project/plugins.sbt"))).toBe(true);
      expect(existsSync(join(dir, "myapi", "src/main/scala/com/myapi/Main.scala"))).toBe(true);
      expect(existsSync(join(dir, "myapi", "src/test/scala/com/myapi/MainSpec.scala"))).toBe(true);
      expect(existsSync(join(dir, "myapi", ".scalafmt.conf"))).toBe(true);
    });
  });

  test("creates Spark data engineering project", () => {
    withTmp((dir) => {
      const r = createScalaProject("Spark ETL pipeline called etljob", dir);
      expect(r.config.type).toBe("spark");
      expect(r.config.framework).toBe("spark");
      expect(r.config.name).toBe("etljob");
      expect(r.config.deps.some(d => d.includes("spark-sql"))).toBe(true);
      expect(existsSync(join(dir, "etljob", "src/main/scala/com/etljob/Main.scala"))).toBe(true);
    });
  });

  test("creates CLI project with scopt", () => {
    withTmp((dir) => {
      const r = createScalaProject("command line tool", dir);
      expect(r.config.type).toBe("cli");
      expect(r.config.deps.some(d => d.includes("scopt"))).toBe(true);
    });
  });

  test("creates library project", () => {
    withTmp((dir) => {
      const r = createScalaProject("library package", dir);
      expect(r.config.type).toBe("library");
      expect(r.config.name).toBe("mylib");
      expect(existsSync(join(dir, "mylib", "src/main/scala/com/mylib/Mylib.scala"))).toBe(true);
    });
  });

  test("detects Akka HTTP framework", () => {
    withTmp((dir) => {
      const r = createScalaProject("Akka HTTP API called svc", dir);
      expect(r.config.type).toBe("api");
      expect(r.config.framework).toBe("akka");
      expect(r.config.deps.some(d => d.includes("akka-http"))).toBe(true);
    });
  });

  test("detects stream project types", () => {
    withTmp((dir) => {
      const r = createScalaProject("fs2 streaming app", dir);
      expect(r.config.type).toBe("stream");
      expect(r.config.framework).toBe("fs2");
      expect(r.config.deps.some(d => d.includes("fs2-core"))).toBe(true);
    });
  });

  test("defaults name to myapp", () => {
    withTmp((dir) => {
      const r = createScalaProject("REST API", dir);
      expect(r.config.name).toBe("myapp");
      expect(r.config.pkg).toBe("com.myapp");
    });
  });

  test("adds doobie for database keyword", () => {
    withTmp((dir) => {
      const r = createScalaProject("API with database", dir);
      expect(r.config.deps.some(d => d.includes("doobie"))).toBe(true);
    });
  });

  test("adds ZIO deps", () => {
    withTmp((dir) => {
      const r = createScalaProject("CLI tool with zio", dir);
      expect(r.config.deps.some(d => d.includes("zio"))).toBe(true);
    });
  });

  test("generates all expected files", () => {
    withTmp((dir) => {
      const r = createScalaProject("API called demo", dir);
      expect(existsSync(join(dir, "demo", ".gitignore"))).toBe(true);
      expect(existsSync(join(dir, "demo", ".scalafmt.conf"))).toBe(true);
      expect(existsSync(join(dir, "demo", ".github/workflows/ci.yml"))).toBe(true);
      expect(existsSync(join(dir, "demo", "Dockerfile"))).toBe(true);
      expect(existsSync(join(dir, "demo", "README.md"))).toBe(true);
    });
  });
});
