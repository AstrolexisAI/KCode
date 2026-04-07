// KCode - Terraform/Infrastructure-as-Code Project Engine
// Creates: main.tf, variables.tf, outputs.tf, providers.tf, backend.tf, modules/, CI/CD

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type TerraformProjectType = "aws" | "gcp" | "azure" | "kubernetes" | "docker" | "multi-cloud" | "module";

interface InfraComponent {
  name: string;
  kind: "vpc" | "compute" | "database" | "storage" | "serverless" | "container" | "k8s" | "cdn" | "dns" | "security";
}

interface TerraformConfig {
  name: string;
  type: TerraformProjectType;
  components: InfraComponent[];
  hasBackend: boolean;
  hasModules: boolean;
  hasCi: boolean;
}

interface GenFile { path: string; content: string; needsLlm: boolean; }

export interface TerraformProjectResult { config: TerraformConfig; files: GenFile[]; projectPath: string; prompt: string; }

// ── Detection ────────────────────────────────────────────────

function detectProjectType(msg: string): TerraformProjectType {
  const lower = msg.toLowerCase();
  if (/\b(?:module|reusable|library)\b/i.test(lower)) return "module";
  if (/\b(?:multi[- ]?cloud)\b/i.test(lower)) return "multi-cloud";
  if (/\b(?:kubernetes|k8s|kubectl|helm)\b/i.test(lower)) return "kubernetes";
  if (/\b(?:docker|container(?:s)?)\b/i.test(lower) && !/\b(?:ecs|ecr|fargate|aws|gcp|azure)\b/i.test(lower)) return "docker";
  if (/\b(?:gcp|google\s*cloud|gke|cloud\s*run|bigquery)\b/i.test(lower)) return "gcp";
  if (/\b(?:azure|azurerm|aks|blob\s*storage)\b/i.test(lower)) return "azure";
  return "aws";
}

function detectComponents(msg: string): InfraComponent[] {
  const lower = msg.toLowerCase();
  const components: InfraComponent[] = [];

  if (/\b(?:vpc|network|subnet|cidr)\b/i.test(lower)) components.push({ name: "vpc", kind: "vpc" });
  if (/\b(?:ec2|instance|compute|vm|server)\b/i.test(lower)) components.push({ name: "compute", kind: "compute" });
  if (/\b(?:rds|database|db|aurora|mysql|postgres)\b/i.test(lower)) components.push({ name: "database", kind: "database" });
  if (/\b(?:s3|bucket|storage|blob)\b/i.test(lower)) components.push({ name: "storage", kind: "storage" });
  if (/\b(?:lambda|function|serverless|cloud\s*function)\b/i.test(lower)) components.push({ name: "serverless", kind: "serverless" });
  if (/\b(?:ecs|fargate|container|docker)\b/i.test(lower)) components.push({ name: "container", kind: "container" });
  if (/\b(?:eks|gke|aks|k8s|kubernetes)\b/i.test(lower)) components.push({ name: "k8s", kind: "k8s" });
  if (/\b(?:cloudfront|cdn|distribution)\b/i.test(lower)) components.push({ name: "cdn", kind: "cdn" });
  if (/\b(?:route53|dns|domain|hosted\s*zone)\b/i.test(lower)) components.push({ name: "dns", kind: "dns" });
  if (/\b(?:iam|role|policy|security|identity)\b/i.test(lower)) components.push({ name: "security", kind: "security" });

  return components;
}

function detectTerraformProject(msg: string): TerraformConfig {
  const type = detectProjectType(msg);
  const components = detectComponents(msg);
  const nameMatch = msg.match(/(?:called|named|nombre)\s+(\w[\w-]*)/i);
  const name = nameMatch?.[1] ?? "infra";
  const hasBackend = !/\bno[- ]?backend\b/i.test(msg);
  const hasModules = type !== "module" && (components.length >= 2 || /\bmodule/i.test(msg));
  const hasCi = !/\bno[- ]?ci\b/i.test(msg);

  return { name, type, components, hasBackend, hasModules, hasCi };
}

// ── File generators ──────────────────────────────────────────

function buildProvidersFile(cfg: TerraformConfig): string {
  const lines: string[] = [`terraform {\n  required_version = ">= 1.9.0"\n\n  required_providers {`];

  if (cfg.type === "aws" || cfg.type === "multi-cloud") {
    lines.push(`    aws = {\n      source  = "hashicorp/aws"\n      version = "~> 5.0"\n    }`);
  }
  if (cfg.type === "gcp" || cfg.type === "multi-cloud") {
    lines.push(`    google = {\n      source  = "hashicorp/google"\n      version = "~> 6.0"\n    }`);
  }
  if (cfg.type === "azure" || cfg.type === "multi-cloud") {
    lines.push(`    azurerm = {\n      source  = "hashicorp/azurerm"\n      version = "~> 4.0"\n    }`);
  }
  if (cfg.type === "kubernetes") {
    lines.push(`    kubernetes = {\n      source  = "hashicorp/kubernetes"\n      version = "~> 2.0"\n    }`);
  }
  if (cfg.type === "docker") {
    lines.push(`    docker = {\n      source  = "kreuzwerker/docker"\n      version = "~> 3.0"\n    }`);
  }
  if (cfg.type === "module") {
    lines.push(`    # Add provider requirements for your module`);
  }

  lines.push(`  }\n}\n`);

  // Provider configuration blocks
  if (cfg.type === "aws" || cfg.type === "multi-cloud") {
    lines.push(`provider "aws" {\n  region = var.aws_region\n\n  default_tags {\n    tags = var.default_tags\n  }\n}\n`);
  }
  if (cfg.type === "gcp" || cfg.type === "multi-cloud") {
    lines.push(`provider "google" {\n  project = var.gcp_project\n  region  = var.gcp_region\n}\n`);
  }
  if (cfg.type === "azure" || cfg.type === "multi-cloud") {
    lines.push(`provider "azurerm" {\n  features {}\n\n  subscription_id = var.azure_subscription_id\n}\n`);
  }
  if (cfg.type === "kubernetes") {
    lines.push(`provider "kubernetes" {\n  config_path = var.kubeconfig_path\n}\n`);
  }
  if (cfg.type === "docker") {
    lines.push(`provider "docker" {\n  host = var.docker_host\n}\n`);
  }

  return lines.join("\n");
}

function buildVariablesFile(cfg: TerraformConfig): string {
  const lines: string[] = [`# Variables for ${cfg.name}\n`];

  lines.push(`variable "environment" {\n  description = "Environment name (dev, staging, prod)"\n  type        = string\n  default     = "dev"\n}\n`);
  lines.push(`variable "project_name" {\n  description = "Project name used for resource naming"\n  type        = string\n  default     = "${cfg.name}"\n}\n`);

  if (cfg.type === "aws" || cfg.type === "multi-cloud") {
    lines.push(`variable "aws_region" {\n  description = "AWS region"\n  type        = string\n  default     = "us-east-1"\n}\n`);
    lines.push(`variable "default_tags" {\n  description = "Default tags for all AWS resources"\n  type        = map(string)\n  default = {\n    ManagedBy = "terraform"\n    Project   = "${cfg.name}"\n  }\n}\n`);
  }
  if (cfg.type === "gcp" || cfg.type === "multi-cloud") {
    lines.push(`variable "gcp_project" {\n  description = "GCP project ID"\n  type        = string\n}\n`);
    lines.push(`variable "gcp_region" {\n  description = "GCP region"\n  type        = string\n  default     = "us-central1"\n}\n`);
  }
  if (cfg.type === "azure" || cfg.type === "multi-cloud") {
    lines.push(`variable "azure_subscription_id" {\n  description = "Azure subscription ID"\n  type        = string\n}\n`);
    lines.push(`variable "azure_location" {\n  description = "Azure region"\n  type        = string\n  default     = "eastus"\n}\n`);
  }
  if (cfg.type === "kubernetes") {
    lines.push(`variable "kubeconfig_path" {\n  description = "Path to kubeconfig file"\n  type        = string\n  default     = "~/.kube/config"\n}\n`);
    lines.push(`variable "namespace" {\n  description = "Kubernetes namespace"\n  type        = string\n  default     = "default"\n}\n`);
  }
  if (cfg.type === "docker") {
    lines.push(`variable "docker_host" {\n  description = "Docker daemon host"\n  type        = string\n  default     = "unix:///var/run/docker.sock"\n}\n`);
  }

  // Component-specific variables
  for (const comp of cfg.components) {
    if (comp.kind === "vpc") {
      lines.push(`variable "vpc_cidr" {\n  description = "CIDR block for the VPC"\n  type        = string\n  default     = "10.0.0.0/16"\n}\n`);
    }
    if (comp.kind === "compute") {
      lines.push(`variable "instance_type" {\n  description = "EC2 instance type"\n  type        = string\n  default     = "t3.micro"\n}\n`);
    }
    if (comp.kind === "database") {
      lines.push(`variable "db_instance_class" {\n  description = "RDS instance class"\n  type        = string\n  default     = "db.t3.micro"\n}\n`);
      lines.push(`variable "db_name" {\n  description = "Database name"\n  type        = string\n  default     = "appdb"\n}\n`);
    }
  }

  return lines.join("\n");
}

function buildOutputsFile(cfg: TerraformConfig): string {
  const lines: string[] = [`# Outputs for ${cfg.name}\n`];

  if (cfg.type === "aws" || cfg.type === "multi-cloud") {
    if (cfg.components.find(c => c.kind === "vpc")) {
      lines.push(`output "vpc_id" {\n  description = "ID of the VPC"\n  value       = module.vpc.vpc_id\n}\n`);
    }
    if (cfg.components.find(c => c.kind === "compute")) {
      lines.push(`output "instance_public_ip" {\n  description = "Public IP of the EC2 instance"\n  value       = aws_instance.main.public_ip\n}\n`);
    }
    if (cfg.components.find(c => c.kind === "database")) {
      lines.push(`output "db_endpoint" {\n  description = "RDS endpoint"\n  value       = aws_db_instance.main.endpoint\n  sensitive   = true\n}\n`);
    }
    if (cfg.components.find(c => c.kind === "storage")) {
      lines.push(`output "bucket_arn" {\n  description = "S3 bucket ARN"\n  value       = aws_s3_bucket.main.arn\n}\n`);
    }
  }
  if (cfg.type === "kubernetes") {
    lines.push(`output "namespace" {\n  description = "Kubernetes namespace"\n  value       = kubernetes_namespace.main.metadata[0].name\n}\n`);
    lines.push(`output "service_endpoint" {\n  description = "Service cluster IP"\n  value       = kubernetes_service.main.spec[0].cluster_ip\n}\n`);
  }

  if (lines.length === 1) {
    lines.push(`# Add outputs as resources are defined\n`);
  }

  return lines.join("\n");
}

function buildBackendFile(cfg: TerraformConfig): string {
  if (cfg.type === "gcp") {
    return `terraform {\n  backend "gcs" {\n    bucket = "${cfg.name}-tfstate"\n    prefix = "terraform/state"\n  }\n}\n`;
  }
  if (cfg.type === "azure") {
    return `terraform {\n  backend "azurerm" {\n    resource_group_name  = "${cfg.name}-tfstate-rg"\n    storage_account_name = "${cfg.name.replace(/-/g, "")}tfstate"\n    container_name       = "tfstate"\n    key                  = "terraform.tfstate"\n  }\n}\n`;
  }
  // Default: AWS S3 backend
  return `terraform {\n  backend "s3" {\n    bucket         = "${cfg.name}-tfstate"\n    key            = "terraform.tfstate"\n    region         = "us-east-1"\n    dynamodb_table = "${cfg.name}-tflock"\n    encrypt        = true\n  }\n}\n`;
}

function buildMainTf(cfg: TerraformConfig): string {
  const lines: string[] = [`# ${cfg.name} — Terraform configuration\n`];
  lines.push(`locals {\n  name_prefix = "\${var.project_name}-\${var.environment}"\n}\n`);

  if (cfg.type === "aws" || cfg.type === "multi-cloud") {
    if (cfg.hasModules && cfg.components.find(c => c.kind === "vpc")) {
      lines.push(`module "vpc" {\n  source = "./modules/vpc"\n\n  name_prefix = local.name_prefix\n  vpc_cidr    = var.vpc_cidr\n}\n`);
    }
    if (cfg.components.find(c => c.kind === "compute")) {
      lines.push(`resource "aws_instance" "main" {\n  ami           = data.aws_ami.amazon_linux.id\n  instance_type = var.instance_type\n${cfg.components.find(c => c.kind === "vpc") ? '  subnet_id     = module.vpc.public_subnet_ids[0]\n' : ''}\n  tags = {\n    Name = "\${local.name_prefix}-instance"\n  }\n}\n`);
      lines.push(`data "aws_ami" "amazon_linux" {\n  most_recent = true\n  owners      = ["amazon"]\n\n  filter {\n    name   = "name"\n    values = ["al2023-ami-*-x86_64"]\n  }\n}\n`);
    }
    if (cfg.components.find(c => c.kind === "database")) {
      lines.push(`resource "aws_db_instance" "main" {\n  identifier     = "\${local.name_prefix}-db"\n  engine         = "postgres"\n  engine_version = "16"\n  instance_class = var.db_instance_class\n  db_name        = var.db_name\n  username       = "admin"\n  password       = var.db_password\n\n  allocated_storage     = 20\n  max_allocated_storage = 100\n  storage_encrypted     = true\n  skip_final_snapshot   = var.environment != "prod"\n\n  tags = {\n    Name = "\${local.name_prefix}-db"\n  }\n}\n`);
    }
    if (cfg.components.find(c => c.kind === "storage")) {
      lines.push(`resource "aws_s3_bucket" "main" {\n  bucket = "\${local.name_prefix}-assets"\n\n  tags = {\n    Name = "\${local.name_prefix}-assets"\n  }\n}\n`);
      lines.push(`resource "aws_s3_bucket_versioning" "main" {\n  bucket = aws_s3_bucket.main.id\n\n  versioning_configuration {\n    status = "Enabled"\n  }\n}\n`);
      lines.push(`resource "aws_s3_bucket_server_side_encryption_configuration" "main" {\n  bucket = aws_s3_bucket.main.id\n\n  rule {\n    apply_server_side_encryption_by_default {\n      sse_algorithm = "aws:kms"\n    }\n  }\n}\n`);
    }
    if (cfg.components.find(c => c.kind === "serverless")) {
      lines.push(`resource "aws_lambda_function" "main" {\n  function_name = "\${local.name_prefix}-handler"\n  runtime       = "nodejs20.x"\n  handler       = "index.handler"\n  filename      = "lambda.zip"\n\n  role = aws_iam_role.lambda_exec.arn\n\n  environment {\n    variables = {\n      ENVIRONMENT = var.environment\n    }\n  }\n}\n`);
      lines.push(`resource "aws_iam_role" "lambda_exec" {\n  name = "\${local.name_prefix}-lambda-role"\n\n  assume_role_policy = jsonencode({\n    Version = "2012-10-17"\n    Statement = [{\n      Action = "sts:AssumeRole"\n      Effect = "Allow"\n      Principal = {\n        Service = "lambda.amazonaws.com"\n      }\n    }]\n  })\n}\n`);
    }
    if (cfg.components.find(c => c.kind === "container")) {
      lines.push(`resource "aws_ecs_cluster" "main" {\n  name = "\${local.name_prefix}-cluster"\n\n  setting {\n    name  = "containerInsights"\n    value = "enabled"\n  }\n}\n`);
    }
    if (cfg.components.find(c => c.kind === "cdn")) {
      lines.push(`resource "aws_cloudfront_distribution" "main" {\n  enabled             = true\n  default_root_object = "index.html"\n\n  origin {\n    domain_name = aws_s3_bucket.main.bucket_regional_domain_name\n    origin_id   = "s3-origin"\n  }\n\n  default_cache_behavior {\n    allowed_methods  = ["GET", "HEAD"]\n    cached_methods   = ["GET", "HEAD"]\n    target_origin_id = "s3-origin"\n\n    forwarded_values {\n      query_string = false\n      cookies { forward = "none" }\n    }\n\n    viewer_protocol_policy = "redirect-to-https"\n  }\n\n  restrictions {\n    geo_restriction { restriction_type = "none" }\n  }\n\n  viewer_certificate {\n    cloudfront_default_certificate = true\n  }\n}\n`);
    }
    if (cfg.components.find(c => c.kind === "dns")) {
      lines.push(`resource "aws_route53_zone" "main" {\n  name = var.domain_name\n}\n`);
    }
  }

  if (cfg.type === "gcp") {
    lines.push(`resource "google_compute_network" "main" {\n  name                    = "\${local.name_prefix}-network"\n  auto_create_subnetworks = false\n}\n`);
    lines.push(`resource "google_compute_subnetwork" "main" {\n  name          = "\${local.name_prefix}-subnet"\n  ip_cidr_range = "10.0.0.0/24"\n  region        = var.gcp_region\n  network       = google_compute_network.main.id\n}\n`);
  }

  if (cfg.type === "azure") {
    lines.push(`resource "azurerm_resource_group" "main" {\n  name     = "\${local.name_prefix}-rg"\n  location = var.azure_location\n}\n`);
    lines.push(`resource "azurerm_virtual_network" "main" {\n  name                = "\${local.name_prefix}-vnet"\n  address_space       = ["10.0.0.0/16"]\n  location            = azurerm_resource_group.main.location\n  resource_group_name = azurerm_resource_group.main.name\n}\n`);
  }

  if (cfg.type === "kubernetes") {
    lines.push(`resource "kubernetes_namespace" "main" {\n  metadata {\n    name = var.namespace\n    labels = {\n      managed-by = "terraform"\n    }\n  }\n}\n`);
    lines.push(`resource "kubernetes_deployment" "main" {\n  metadata {\n    name      = var.project_name\n    namespace = kubernetes_namespace.main.metadata[0].name\n    labels = {\n      app = var.project_name\n    }\n  }\n\n  spec {\n    replicas = var.replicas\n\n    selector {\n      match_labels = {\n        app = var.project_name\n      }\n    }\n\n    template {\n      metadata {\n        labels = {\n          app = var.project_name\n        }\n      }\n\n      spec {\n        container {\n          name  = var.project_name\n          image = var.container_image\n\n          port {\n            container_port = var.container_port\n          }\n\n          resources {\n            limits = {\n              cpu    = "500m"\n              memory = "256Mi"\n            }\n            requests = {\n              cpu    = "250m"\n              memory = "128Mi"\n            }\n          }\n\n          liveness_probe {\n            http_get {\n              path = "/health"\n              port = var.container_port\n            }\n            initial_delay_seconds = 10\n            period_seconds        = 30\n          }\n        }\n      }\n    }\n  }\n}\n`);
    lines.push(`resource "kubernetes_service" "main" {\n  metadata {\n    name      = var.project_name\n    namespace = kubernetes_namespace.main.metadata[0].name\n  }\n\n  spec {\n    selector = {\n      app = var.project_name\n    }\n\n    port {\n      port        = 80\n      target_port = var.container_port\n    }\n\n    type = "ClusterIP"\n  }\n}\n`);
    lines.push(`resource "kubernetes_ingress_v1" "main" {\n  metadata {\n    name      = var.project_name\n    namespace = kubernetes_namespace.main.metadata[0].name\n    annotations = {\n      "kubernetes.io/ingress.class" = "nginx"\n    }\n  }\n\n  spec {\n    rule {\n      http {\n        path {\n          path      = "/"\n          path_type = "Prefix"\n          backend {\n            service {\n              name = kubernetes_service.main.metadata[0].name\n              port {\n                number = 80\n              }\n            }\n          }\n        }\n      }\n    }\n  }\n}\n`);
  }

  if (cfg.type === "docker") {
    lines.push(`resource "docker_image" "main" {\n  name = "\${var.project_name}:latest"\n\n  build {\n    context = var.build_context\n  }\n}\n`);
    lines.push(`resource "docker_container" "main" {\n  name  = var.project_name\n  image = docker_image.main.image_id\n\n  ports {\n    internal = 10080\n    external = 10080\n  }\n\n  restart = "unless-stopped"\n}\n`);
  }

  if (cfg.type === "module") {
    lines.push(`# Module resources\n# Define reusable infrastructure components here\n`);
  }

  if (lines.length === 1) {
    lines.push(`# TODO: Define your infrastructure resources\n`);
  }

  return lines.join("\n");
}

function buildVpcModule(): { main: string; variables: string; outputs: string } {
  const main = `# VPC Module

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name = "\${var.name_prefix}-vpc"
  }
}

data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_subnet" "public" {
  count = 2

  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true

  tags = {
    Name = "\${var.name_prefix}-public-\${count.index + 1}"
  }
}

resource "aws_subnet" "private" {
  count = 2

  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, count.index + 10)
  availability_zone = data.aws_availability_zones.available.names[count.index]

  tags = {
    Name = "\${var.name_prefix}-private-\${count.index + 1}"
  }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "\${var.name_prefix}-igw"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name = "\${var.name_prefix}-public-rt"
  }
}

resource "aws_route_table_association" "public" {
  count = 2

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}
`;
  const variables = `variable "name_prefix" {\n  description = "Prefix for resource names"\n  type        = string\n}\n\nvariable "vpc_cidr" {\n  description = "CIDR block for the VPC"\n  type        = string\n  default     = "10.0.0.0/16"\n}\n`;
  const outputs = `output "vpc_id" {\n  description = "ID of the VPC"\n  value       = aws_vpc.main.id\n}\n\noutput "public_subnet_ids" {\n  description = "IDs of public subnets"\n  value       = aws_subnet.public[*].id\n}\n\noutput "private_subnet_ids" {\n  description = "IDs of private subnets"\n  value       = aws_subnet.private[*].id\n}\n`;

  return { main, variables, outputs };
}

function buildTfvarsExample(cfg: TerraformConfig): string {
  const lines: string[] = [`# Terraform variables — copy to terraform.tfvars and fill in\n`];
  lines.push(`environment  = "dev"\nproject_name = "${cfg.name}"\n`);

  if (cfg.type === "aws" || cfg.type === "multi-cloud") {
    lines.push(`aws_region = "us-east-1"\n`);
  }
  if (cfg.type === "gcp" || cfg.type === "multi-cloud") {
    lines.push(`gcp_project = "YOUR_GCP_PROJECT_ID"\ngcp_region  = "us-central1"\n`);
  }
  if (cfg.type === "azure" || cfg.type === "multi-cloud") {
    lines.push(`azure_subscription_id = "YOUR_AZURE_SUBSCRIPTION_ID"\nazure_location        = "eastus"\n`);
  }
  if (cfg.type === "kubernetes") {
    lines.push(`kubeconfig_path = "~/.kube/config"\nnamespace       = "default"\n`);
  }

  return lines.join("\n");
}

function buildGitignore(): string {
  return `# Terraform
.terraform/
*.tfstate
*.tfstate.backup
*.tfstate.*.backup
.terraform.lock.hcl
*.tfvars
!terraform.tfvars.example
crash.log
crash.*.log
override.tf
override.tf.json
*_override.tf
*_override.tf.json
.terraformrc
terraform.rc
`;
}

function buildTerraformVersion(): string {
  return `1.9.0\n`;
}

function buildCiWorkflow(cfg: TerraformConfig): string {
  return `name: Terraform CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

permissions:
  contents: read
  pull-requests: write

jobs:
  terraform:
    name: Terraform
    runs-on: ubuntu-latest

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Terraform
        uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: "1.9.0"

      - name: Terraform Format
        run: terraform fmt -check -recursive

      - name: Terraform Init
        run: terraform init -backend=false

      - name: Terraform Validate
        run: terraform validate

      - name: Terraform Plan
        if: github.event_name == 'pull_request'
        run: terraform plan -no-color -input=false
        continue-on-error: true
`;
}

function buildMakefile(cfg: TerraformConfig): string {
  return `.PHONY: init plan apply destroy fmt validate

init:
\tterraform init

plan:
\tterraform plan

apply:
\tterraform apply

destroy:
\tterraform destroy

fmt:
\tterraform fmt -recursive

validate:
\tterraform validate

lint: fmt validate

output:
\tterraform output
`;
}

function buildReadme(cfg: TerraformConfig): string {
  const components = cfg.components.length > 0
    ? cfg.components.map(c => `- **${c.name}** (${c.kind})`).join("\n")
    : "- Base infrastructure";

  return `# ${cfg.name}

Terraform infrastructure project. Built with KCode.

## Provider

${cfg.type === "aws" ? "Amazon Web Services (AWS)" : cfg.type === "gcp" ? "Google Cloud Platform (GCP)" : cfg.type === "azure" ? "Microsoft Azure" : cfg.type === "kubernetes" ? "Kubernetes" : cfg.type === "docker" ? "Docker" : cfg.type === "multi-cloud" ? "Multi-cloud (AWS + GCP + Azure)" : "Terraform Module"}

## Components

${components}

## Usage

\`\`\`bash
# Initialize
make init

# Preview changes
make plan

# Apply infrastructure
make apply

# Destroy infrastructure
make destroy
\`\`\`

## Requirements

| Name | Version |
|------|---------|
| terraform | >= 1.9.0 |

<!-- BEGIN_TF_DOCS -->
<!-- END_TF_DOCS -->

*Astrolexis.space — Kulvex Code*
`;
}

// ── Main export ──────────────────────────────────────────────

export function createTerraformProject(userRequest: string, cwd: string): TerraformProjectResult {
  const cfg = detectTerraformProject(userRequest);
  const files: GenFile[] = [];

  // Core Terraform files
  files.push({ path: "providers.tf", content: buildProvidersFile(cfg), needsLlm: false });
  files.push({ path: "variables.tf", content: buildVariablesFile(cfg), needsLlm: false });
  files.push({ path: "outputs.tf", content: buildOutputsFile(cfg), needsLlm: false });
  files.push({ path: "main.tf", content: buildMainTf(cfg), needsLlm: true });
  files.push({ path: "terraform.tfvars.example", content: buildTfvarsExample(cfg), needsLlm: false });

  // Backend
  if (cfg.hasBackend) {
    files.push({ path: "backend.tf", content: buildBackendFile(cfg), needsLlm: false });
  }

  // Modules
  if (cfg.hasModules) {
    if (cfg.components.find(c => c.kind === "vpc") && (cfg.type === "aws" || cfg.type === "multi-cloud")) {
      const vpc = buildVpcModule();
      files.push({ path: "modules/vpc/main.tf", content: vpc.main, needsLlm: false });
      files.push({ path: "modules/vpc/variables.tf", content: vpc.variables, needsLlm: false });
      files.push({ path: "modules/vpc/outputs.tf", content: vpc.outputs, needsLlm: false });
    }
  }

  // Module type: standard module structure
  if (cfg.type === "module") {
    files.push({ path: "examples/basic/main.tf", content: `module "${cfg.name}" {\n  source = "../../"\n\n  # Required variables\n  environment  = "dev"\n  project_name = "${cfg.name}"\n}\n`, needsLlm: false });
    files.push({ path: "examples/basic/outputs.tf", content: `output "result" {\n  value = module.${cfg.name}\n}\n`, needsLlm: false });
  }

  // Kubernetes extra variables
  if (cfg.type === "kubernetes") {
    const extraVars = `variable "replicas" {\n  description = "Number of pod replicas"\n  type        = number\n  default     = 2\n}\n\nvariable "container_image" {\n  description = "Container image to deploy"\n  type        = string\n  default     = "nginx:latest"\n}\n\nvariable "container_port" {\n  description = "Container port"\n  type        = number\n  default     = 80\n}\n`;
    // Append to variables.tf
    const existingVars = files.find(f => f.path === "variables.tf")!;
    existingVars.content += "\n" + extraVars;
  }

  // Docker extra variables
  if (cfg.type === "docker") {
    const extraVars = `variable "build_context" {\n  description = "Docker build context path"\n  type        = string\n  default     = "."\n}\n`;
    const existingVars = files.find(f => f.path === "variables.tf")!;
    existingVars.content += "\n" + extraVars;
  }

  // Database password variable (when database component detected)
  if (cfg.components.find(c => c.kind === "database")) {
    const existingVars = files.find(f => f.path === "variables.tf")!;
    existingVars.content += `\nvariable "db_password" {\n  description = "Database master password"\n  type        = string\n  sensitive   = true\n}\n`;
  }

  // Extras
  files.push({ path: ".gitignore", content: buildGitignore(), needsLlm: false });
  files.push({ path: ".terraform-version", content: buildTerraformVersion(), needsLlm: false });
  files.push({ path: "README.md", content: buildReadme(cfg), needsLlm: false });
  files.push({ path: "Makefile", content: buildMakefile(cfg), needsLlm: false });

  if (cfg.hasCi) {
    files.push({ path: ".github/workflows/ci.yml", content: buildCiWorkflow(cfg), needsLlm: false });
  }

  const projectPath = join(cwd, cfg.name);
  for (const f of files) { const p = join(projectPath, f.path); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, f.content); }

  const m = files.filter(f => !f.needsLlm).length;
  return { config: cfg, files, projectPath, prompt: `Terraform ${cfg.type} project with ${cfg.components.length} components. ${m} files machine. USER: "${userRequest}"` };
}
