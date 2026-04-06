import { describe, test, expect } from "bun:test";
import { createDockerProject } from "./docker-engine";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("docker-engine", () => {
  function withTmp(fn: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), "kcode-docker-"));
    try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  test("creates Node + Postgres stack", () => {
    withTmp((dir) => {
      const r = createDockerProject("Node.js API with Postgres called mystack", dir);
      expect(r.config.name).toBe("mystack");
      expect(r.services.length).toBeGreaterThanOrEqual(2);
      expect(r.services.find(s => s.name === "postgres")).toBeTruthy();
      expect(r.services.find(s => s.name === "app")).toBeTruthy();
      expect(existsSync(join(dir, "mystack", "docker-compose.yml"))).toBe(true);
      expect(existsSync(join(dir, "mystack", "app/Dockerfile"))).toBe(true);
      expect(existsSync(join(dir, "mystack", "app/package.json"))).toBe(true);
    });
  });

  test("creates Python + Redis stack", () => {
    withTmp((dir) => {
      const r = createDockerProject("Python FastAPI with Redis", dir);
      expect(r.services.find(s => s.name === "redis")).toBeTruthy();
      expect(existsSync(join(dir, "mystack", "app/requirements.txt"))).toBe(true);
      expect(existsSync(join(dir, "mystack", "app/main.py"))).toBe(true);
    });
  });

  test("creates stack with Nginx reverse proxy", () => {
    withTmp((dir) => {
      const r = createDockerProject("Node API with Nginx reverse proxy and Postgres", dir);
      expect(r.config.hasNginx).toBe(true);
      expect(r.services.find(s => s.name === "nginx")).toBeTruthy();
      expect(existsSync(join(dir, "mystack", "nginx/nginx.conf"))).toBe(true);
    });
  });

  test("creates stack with monitoring (Prometheus + Grafana)", () => {
    withTmp((dir) => {
      const r = createDockerProject("Node API with monitoring", dir);
      expect(r.services.find(s => s.name === "prometheus")).toBeTruthy();
      expect(r.services.find(s => s.name === "grafana")).toBeTruthy();
      expect(existsSync(join(dir, "mystack", "prometheus/prometheus.yml"))).toBe(true);
    });
  });

  test("detects GPU for ML projects", () => {
    withTmp((dir) => {
      const r = createDockerProject("Python ML pipeline with GPU", dir);
      expect(r.config.hasGpu).toBe(true);
      const compose = readFileSync(join(dir, "mystack", "docker-compose.yml"), "utf-8");
      expect(compose).toContain("nvidia");
    });
  });

  test("creates Go app Dockerfile", () => {
    withTmp((dir) => {
      const r = createDockerProject("Go API with Postgres", dir);
      expect(existsSync(join(dir, "mystack", "app/main.go"))).toBe(true);
      expect(existsSync(join(dir, "mystack", "app/go.mod"))).toBe(true);
    });
  });

  test("creates default stack when nothing specific detected", () => {
    withTmp((dir) => {
      const r = createDockerProject("some project", dir);
      expect(r.services.length).toBeGreaterThanOrEqual(2);
      expect(existsSync(join(dir, "mystack", "docker-compose.yml"))).toBe(true);
    });
  });

  test("docker-compose.yml has volumes section", () => {
    withTmp((dir) => {
      const r = createDockerProject("Node with Postgres and Redis", dir);
      const compose = readFileSync(join(dir, "mystack", "docker-compose.yml"), "utf-8");
      expect(compose).toContain("volumes:");
      expect(compose).toContain("pgdata:");
    });
  });

  test("includes Makefile", () => {
    withTmp((dir) => {
      const r = createDockerProject("basic project", dir);
      expect(existsSync(join(dir, "mystack", "Makefile"))).toBe(true);
    });
  });
});
