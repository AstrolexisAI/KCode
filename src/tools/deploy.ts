// KCode - Deploy Automation Tool
// Auto-detects project stack and deploys to the appropriate target.
// Pro feature: requires active Pro subscription.

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition, ToolResult } from "../core/types";
import { log } from "../core/logger";

// ─── Stack Detection ────────────────────────────────────────────

type Stack = "docker" | "vercel" | "fly" | "node" | "rust" | "go" | "python" | "unknown";

function detectStack(cwd: string): Stack {
  if (existsSync(join(cwd, "Dockerfile")) || existsSync(join(cwd, "docker-compose.yml"))) {
    return "docker";
  }
  if (existsSync(join(cwd, "vercel.json")) || existsSync(join(cwd, ".vercel"))) {
    return "vercel";
  }
  if (existsSync(join(cwd, "fly.toml"))) {
    return "fly";
  }
  if (existsSync(join(cwd, "package.json"))) {
    try {
      const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf-8"));
      if (pkg.scripts?.build) return "node";
    } catch { /* ignore parse errors */ }
  }
  if (existsSync(join(cwd, "Cargo.toml"))) {
    return "rust";
  }
  if (existsSync(join(cwd, "go.mod"))) {
    return "go";
  }
  if (existsSync(join(cwd, "requirements.txt")) || existsSync(join(cwd, "pyproject.toml"))) {
    return "python";
  }
  return "unknown";
}

// ─── Target Resolution ──────────────────────────────────────────

type Target = "docker" | "vercel" | "fly" | "ssh";

function resolveTarget(target: string | undefined, stack: Stack): Target {
  if (target && ["docker", "vercel", "fly", "ssh"].includes(target)) {
    return target as Target;
  }

  // Auto-detect target from stack
  switch (stack) {
    case "docker": return "docker";
    case "vercel": return "vercel";
    case "fly": return "fly";
    default: return "docker"; // default fallback
  }
}

// ─── Command Runner ─────────────────────────────────────────────

function runCommand(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, {
      cwd,
      stdio: "pipe",
      timeout: 300_000, // 5 minute timeout for deploys
      maxBuffer: 10 * 1024 * 1024,
    }).toString().trim();
  } catch (err) {
    const msg = err instanceof Error ? (err as Error & { stderr?: Buffer }).stderr?.toString() || err.message : String(err);
    throw new Error(`Command failed: ${cmd}\n${msg}`);
  }
}

// ─── Deploy Functions ───────────────────────────────────────────

function deployDocker(cwd: string, env: string, dryRun: boolean): ToolResult {
  const hasCompose = existsSync(join(cwd, "docker-compose.yml"));
  const commands: string[] = [];

  if (hasCompose) {
    commands.push(`docker compose build`);
    commands.push(`docker compose up -d`);
  } else {
    const tag = `app:${env}`;
    commands.push(`docker build -t ${tag} .`);
    commands.push(`docker push ${tag}`);
  }

  if (dryRun) {
    return {
      tool_use_id: "",
      content: `[Dry Run] Docker deploy (${env}):\n${commands.map((c) => `  $ ${c}`).join("\n")}\n\nNo commands were executed.`,
    };
  }

  const outputs: string[] = [`Deploying via Docker (${env})...`];
  for (const cmd of commands) {
    log.info("tool", `Deploy: running ${cmd}`);
    outputs.push(`$ ${cmd}`);
    outputs.push(runCommand(cmd, cwd));
  }

  return { tool_use_id: "", content: outputs.join("\n") };
}

function deployVercel(cwd: string, env: string, dryRun: boolean): ToolResult {
  const commands: string[] = [];

  if (env === "production") {
    commands.push(`vercel --prod --yes`);
  } else {
    commands.push(`vercel deploy --yes`);
  }

  if (dryRun) {
    return {
      tool_use_id: "",
      content: `[Dry Run] Vercel deploy (${env}):\n${commands.map((c) => `  $ ${c}`).join("\n")}\n\nNo commands were executed.`,
    };
  }

  const outputs: string[] = [`Deploying via Vercel (${env})...`];
  for (const cmd of commands) {
    log.info("tool", `Deploy: running ${cmd}`);
    outputs.push(`$ ${cmd}`);
    outputs.push(runCommand(cmd, cwd));
  }

  return { tool_use_id: "", content: outputs.join("\n") };
}

function deployFly(cwd: string, env: string, dryRun: boolean): ToolResult {
  const commands: string[] = [`fly deploy`];

  if (env === "staging") {
    commands[0] = `fly deploy --app staging`;
  }

  if (dryRun) {
    return {
      tool_use_id: "",
      content: `[Dry Run] Fly.io deploy (${env}):\n${commands.map((c) => `  $ ${c}`).join("\n")}\n\nNo commands were executed.`,
    };
  }

  const outputs: string[] = [`Deploying via Fly.io (${env})...`];
  for (const cmd of commands) {
    log.info("tool", `Deploy: running ${cmd}`);
    outputs.push(`$ ${cmd}`);
    outputs.push(runCommand(cmd, cwd));
  }

  return { tool_use_id: "", content: outputs.join("\n") };
}

interface SSHConfig {
  host: string;
  user: string;
  path: string;
  restart?: string;
  exclude?: string[];
}

function deploySSH(cwd: string, env: string, dryRun: boolean): ToolResult {
  const configPath = join(cwd, ".kcode", "deploy.json");

  if (!existsSync(configPath)) {
    return {
      tool_use_id: "",
      content: `SSH deploy requires a config file at .kcode/deploy.json\n\nExpected format:\n{\n  "host": "user@server.com",\n  "user": "deploy",\n  "path": "/var/www/app",\n  "restart": "systemctl restart app",\n  "exclude": ["node_modules", ".git"]\n}`,
      is_error: true,
    };
  }

  let config: SSHConfig;
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return { tool_use_id: "", content: "Failed to parse .kcode/deploy.json", is_error: true };
  }

  if (!config.host || !config.path) {
    return { tool_use_id: "", content: ".kcode/deploy.json must contain 'host' and 'path' fields", is_error: true };
  }

  const excludeFlags = (config.exclude ?? ["node_modules", ".git", ".env"])
    .map((e) => `--exclude='${e}'`)
    .join(" ");

  const target = config.user ? `${config.user}@${config.host}` : config.host;
  const commands: string[] = [
    `rsync -avz --delete ${excludeFlags} ./ ${target}:${config.path}`,
  ];

  if (config.restart) {
    commands.push(`ssh ${target} '${config.restart}'`);
  }

  if (dryRun) {
    return {
      tool_use_id: "",
      content: `[Dry Run] SSH deploy to ${target}:${config.path} (${env}):\n${commands.map((c) => `  $ ${c}`).join("\n")}\n\nNo commands were executed.`,
    };
  }

  const outputs: string[] = [`Deploying via SSH to ${target}:${config.path} (${env})...`];
  for (const cmd of commands) {
    log.info("tool", `Deploy: running ${cmd}`);
    outputs.push(`$ ${cmd}`);
    outputs.push(runCommand(cmd, cwd));
  }

  return { tool_use_id: "", content: outputs.join("\n") };
}

// ─── Tool Definition ────────────────────────────────────────────

export const deployDefinition: ToolDefinition = {
  name: "Deploy",
  description: `Deploy the current project. Auto-detects stack and target.

Supported targets:
- **docker**: Builds and pushes Docker image (or docker compose up)
- **vercel**: Deploys via Vercel CLI (preview or --prod)
- **fly**: Deploys via Fly.io CLI
- **ssh**: Rsync + restart via SSH (reads .kcode/deploy.json)

Auto-detects stack from project files: Dockerfile, vercel.json, fly.toml, package.json, Cargo.toml, go.mod, requirements.txt, pyproject.toml.`,
  input_schema: {
    type: "object",
    properties: {
      target: {
        type: "string",
        description: "Deploy target: docker, vercel, fly, ssh, or omit for auto-detect",
        enum: ["docker", "vercel", "fly", "ssh"],
      },
      environment: {
        type: "string",
        description: "Deployment environment",
        enum: ["production", "staging", "preview"],
      },
      dryRun: {
        type: "boolean",
        description: "Show what would happen without actually deploying",
      },
    },
    required: [],
  },
};

// ─── Executor ───────────────────────────────────────────────────

export async function executeDeploy(input: Record<string, unknown>): Promise<ToolResult> {
  const { requirePro } = await import("../core/pro.js");
  await requirePro("deploy");

  const cwd = process.cwd();
  const targetInput = input.target as string | undefined;
  const env = (input.environment as string) ?? "production";
  const dryRun = (input.dryRun as boolean) ?? false;

  // Detect stack
  const stack = detectStack(cwd);
  log.info("tool", `Deploy: detected stack=${stack}, target=${targetInput ?? "auto"}, env=${env}, dryRun=${dryRun}`);

  // Resolve deploy target
  const target = resolveTarget(targetInput, stack);

  if (stack === "unknown" && !targetInput) {
    return {
      tool_use_id: "",
      content: "Could not auto-detect project stack. No Dockerfile, vercel.json, fly.toml, package.json (with build), Cargo.toml, go.mod, requirements.txt, or pyproject.toml found.\n\nSpecify a target explicitly: docker, vercel, fly, or ssh.",
      is_error: true,
    };
  }

  const header = `Stack: ${stack} | Target: ${target} | Environment: ${env}${dryRun ? " | DRY RUN" : ""}\n${"─".repeat(50)}\n`;

  try {
    let result: ToolResult;

    switch (target) {
      case "docker":
        result = deployDocker(cwd, env, dryRun);
        break;
      case "vercel":
        result = deployVercel(cwd, env, dryRun);
        break;
      case "fly":
        result = deployFly(cwd, env, dryRun);
        break;
      case "ssh":
        result = deploySSH(cwd, env, dryRun);
        break;
      default:
        return { tool_use_id: "", content: `Unknown deploy target: ${target}`, is_error: true };
    }

    return {
      tool_use_id: "",
      content: header + result.content,
      is_error: result.is_error,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("tool", `Deploy error: ${msg}`);
    return {
      tool_use_id: "",
      content: `${header}Deploy failed:\n${msg}`,
      is_error: true,
    };
  }
}
