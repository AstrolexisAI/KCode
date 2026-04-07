import { describe, test, expect } from "bun:test";
import { createCicdProject } from "./cicd-engine";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("cicd-engine", () => {
  function withTmp(fn: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), "kcode-cicd-"));
    try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  test("creates GitHub Actions for Node.js", () => {
    withTmp((dir) => {
      const r = createCicdProject("Node.js CI pipeline", dir);
      expect(r.config.platform).toBe("github");
      expect(r.config.projectType).toBe("node");
      expect(existsSync(join(r.projectPath, ".github/workflows/ci.yml"))).toBe(true);
      const ci = readFileSync(join(r.projectPath, ".github/workflows/ci.yml"), "utf-8");
      expect(ci).toContain("npm");
      expect(ci).toContain("Test");
    });
  });

  test("creates GitHub Actions for Python", () => {
    withTmp((dir) => {
      const r = createCicdProject("Python CI with pytest", dir);
      expect(r.config.projectType).toBe("python");
      const ci = readFileSync(join(r.projectPath, ".github/workflows/ci.yml"), "utf-8");
      expect(ci).toContain("pytest");
    });
  });

  test("creates GitHub Actions for Rust", () => {
    withTmp((dir) => {
      const r = createCicdProject("Rust CI pipeline", dir);
      expect(r.config.projectType).toBe("rust");
      const ci = readFileSync(join(r.projectPath, ".github/workflows/ci.yml"), "utf-8");
      expect(ci).toContain("cargo");
    });
  });

  test("creates GitLab CI", () => {
    withTmp((dir) => {
      const r = createCicdProject("GitLab CI for Node.js", dir);
      expect(r.config.platform).toBe("gitlab");
      expect(existsSync(join(r.projectPath, ".gitlab-ci.yml"))).toBe(true);
    });
  });

  test("creates Jenkinsfile", () => {
    withTmp((dir) => {
      const r = createCicdProject("Jenkins pipeline for Java", dir);
      expect(r.config.platform).toBe("jenkins");
      expect(existsSync(join(r.projectPath, "Jenkinsfile"))).toBe(true);
    });
  });

  test("creates deploy workflow for Vercel", () => {
    withTmp((dir) => {
      const r = createCicdProject("Node.js deploy to Vercel", dir);
      expect(r.config.hasDeploy).toBe(true);
      expect(r.config.deployTarget).toBe("vercel");
      expect(existsSync(join(r.projectPath, ".github/workflows/deploy.yml"))).toBe(true);
    });
  });

  test("creates Docker build in pipeline", () => {
    withTmp((dir) => {
      const r = createCicdProject("Go with Docker container build", dir);
      expect(r.config.hasDocker).toBe(true);
      expect(r.config.projectType).toBe("go");
    });
  });

  test("includes dependabot config", () => {
    withTmp((dir) => {
      const r = createCicdProject("Node.js CI", dir);
      expect(existsSync(join(r.projectPath, ".github/dependabot.yml"))).toBe(true);
    });
  });

  test("detects Terraform project type", () => {
    withTmp((dir) => {
      const r = createCicdProject("Terraform infrastructure CI", dir);
      expect(r.config.projectType).toBe("terraform");
      const ci = readFileSync(join(r.projectPath, ".github/workflows/ci.yml"), "utf-8");
      expect(ci).toContain("terraform");
    });
  });
});
