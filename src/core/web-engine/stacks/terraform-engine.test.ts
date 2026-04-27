import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTerraformProject } from "./terraform-engine";

describe("terraform-engine", () => {
  function withTmp(fn: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), "kcode-terraform-"));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("creates AWS infrastructure project", () => {
    withTmp((dir) => {
      const r = createTerraformProject("AWS infrastructure with VPC and EC2 called myinfra", dir);
      expect(r.config.name).toBe("myinfra");
      expect(r.config.type).toBe("aws");
      expect(existsSync(join(dir, "myinfra", "main.tf"))).toBe(true);
      expect(existsSync(join(dir, "myinfra", "variables.tf"))).toBe(true);
      expect(existsSync(join(dir, "myinfra", "outputs.tf"))).toBe(true);
      expect(existsSync(join(dir, "myinfra", "providers.tf"))).toBe(true);
      expect(existsSync(join(dir, "myinfra", "terraform.tfvars.example"))).toBe(true);
      const providers = readFileSync(join(dir, "myinfra", "providers.tf"), "utf-8");
      expect(providers).toContain('provider "aws"');
      expect(providers).toContain("var.aws_region");
    });
  });

  test("creates GCP project", () => {
    withTmp((dir) => {
      const r = createTerraformProject("GCP infrastructure called mygcp", dir);
      expect(r.config.type).toBe("gcp");
      const providers = readFileSync(join(dir, "mygcp", "providers.tf"), "utf-8");
      expect(providers).toContain('provider "google"');
      expect(providers).toContain("var.gcp_project");
      expect(providers).toContain("var.gcp_region");
      const main = readFileSync(join(dir, "mygcp", "main.tf"), "utf-8");
      expect(main).toContain("google_compute_network");
    });
  });

  test("creates Kubernetes deployment", () => {
    withTmp((dir) => {
      const r = createTerraformProject("Kubernetes deployment with ingress", dir);
      expect(r.config.type).toBe("kubernetes");
      const main = readFileSync(join(dir, "infra", "main.tf"), "utf-8");
      expect(main).toContain("kubernetes_deployment");
      expect(main).toContain("kubernetes_service");
      expect(main).toContain("kubernetes_ingress_v1");
      const vars = readFileSync(join(dir, "infra", "variables.tf"), "utf-8");
      expect(vars).toContain("container_image");
      expect(vars).toContain("replicas");
    });
  });

  test("creates module structure", () => {
    withTmp((dir) => {
      const r = createTerraformProject("reusable module called mymodule", dir);
      expect(r.config.type).toBe("module");
      expect(existsSync(join(dir, "mymodule", "main.tf"))).toBe(true);
      expect(existsSync(join(dir, "mymodule", "variables.tf"))).toBe(true);
      expect(existsSync(join(dir, "mymodule", "outputs.tf"))).toBe(true);
      expect(existsSync(join(dir, "mymodule", "examples/basic/main.tf"))).toBe(true);
    });
  });

  test("detects VPC component", () => {
    withTmp((dir) => {
      const r = createTerraformProject("AWS with VPC and EC2 compute instances", dir);
      expect(r.config.components.find((c) => c.kind === "vpc")).toBeTruthy();
      expect(existsSync(join(dir, "infra", "modules/vpc/main.tf"))).toBe(true);
      const vpcMain = readFileSync(join(dir, "infra", "modules/vpc/main.tf"), "utf-8");
      expect(vpcMain).toContain("aws_vpc");
      expect(vpcMain).toContain("aws_subnet");
    });
  });

  test("detects RDS database", () => {
    withTmp((dir) => {
      const r = createTerraformProject("AWS with RDS database", dir);
      expect(r.config.components.find((c) => c.kind === "database")).toBeTruthy();
      const main = readFileSync(join(dir, "infra", "main.tf"), "utf-8");
      expect(main).toContain("aws_db_instance");
      const vars = readFileSync(join(dir, "infra", "variables.tf"), "utf-8");
      expect(vars).toContain("db_instance_class");
      expect(vars).toContain("db_password");
    });
  });

  test("detects S3 storage", () => {
    withTmp((dir) => {
      const r = createTerraformProject("AWS with S3 bucket for storage", dir);
      expect(r.config.components.find((c) => c.kind === "storage")).toBeTruthy();
      const main = readFileSync(join(dir, "infra", "main.tf"), "utf-8");
      expect(main).toContain("aws_s3_bucket");
      expect(main).toContain("aws_s3_bucket_versioning");
    });
  });

  test("has backend config with S3 state", () => {
    withTmp((dir) => {
      const r = createTerraformProject("AWS infrastructure called myproj", dir);
      expect(r.config.hasBackend).toBe(true);
      expect(existsSync(join(dir, "myproj", "backend.tf"))).toBe(true);
      const backend = readFileSync(join(dir, "myproj", "backend.tf"), "utf-8");
      expect(backend).toContain('backend "s3"');
      expect(backend).toContain("dynamodb_table");
      expect(backend).toContain("encrypt");
    });
  });

  test("includes CI workflow", () => {
    withTmp((dir) => {
      const r = createTerraformProject("AWS project", dir);
      expect(existsSync(join(dir, "infra", ".github/workflows/ci.yml"))).toBe(true);
      const ci = readFileSync(join(dir, "infra", ".github/workflows/ci.yml"), "utf-8");
      expect(ci).toContain("terraform fmt");
      expect(ci).toContain("terraform validate");
    });
  });

  test("includes Makefile and .gitignore", () => {
    withTmp((dir) => {
      const r = createTerraformProject("basic infra", dir);
      expect(existsSync(join(dir, "infra", "Makefile"))).toBe(true);
      expect(existsSync(join(dir, "infra", ".gitignore"))).toBe(true);
      const gitignore = readFileSync(join(dir, "infra", ".gitignore"), "utf-8");
      expect(gitignore).toContain(".terraform/");
      expect(gitignore).toContain("*.tfstate");
    });
  });

  test("includes .terraform-version file", () => {
    withTmp((dir) => {
      const r = createTerraformProject("basic infra", dir);
      expect(existsSync(join(dir, "infra", ".terraform-version"))).toBe(true);
      const ver = readFileSync(join(dir, "infra", ".terraform-version"), "utf-8");
      expect(ver).toContain("1.9.0");
    });
  });

  test("Azure project has azurerm provider", () => {
    withTmp((dir) => {
      const r = createTerraformProject("Azure infrastructure", dir);
      expect(r.config.type).toBe("azure");
      const providers = readFileSync(join(dir, "infra", "providers.tf"), "utf-8");
      expect(providers).toContain('provider "azurerm"');
      expect(providers).toContain("features {}");
      const main = readFileSync(join(dir, "infra", "main.tf"), "utf-8");
      expect(main).toContain("azurerm_resource_group");
    });
  });
});
