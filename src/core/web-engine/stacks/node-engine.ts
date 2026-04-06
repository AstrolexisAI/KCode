// KCode - Node.js/JavaScript Project Engine
// For NON-web projects: CLI tools, libraries, workers, bots, scripts

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type NodeProjectType = "cli" | "library" | "worker" | "bot" | "script" | "lambda" | "custom";

interface NodeConfig { name: string; type: NodeProjectType; useTs: boolean; deps: string[]; devDeps: string[]; }

function detectNodeProject(msg: string): NodeConfig {
  const lower = msg.toLowerCase();
  let type: NodeProjectType = "cli";
  const useTs = !/\bjavascript\b|\.js\b|\bno\s*typescript\b/i.test(lower);
  const deps: string[] = [];
  const devDeps: string[] = useTs ? ["typescript", "@types/node", "tsx"] : [];
  devDeps.push("vitest");

  if (/\b(?:cli|command|tool|herramienta)\b/i.test(lower)) { type = "cli"; deps.push("commander", "chalk", "ora"); }
  else if (/\b(?:lib|library|package|npm\s*package)\b/i.test(lower)) { type = "library"; devDeps.push("tsup"); }
  else if (/\b(?:worker|queue|job|bull|redis\s*queue)\b/i.test(lower)) { type = "worker"; deps.push("bullmq", "ioredis"); }
  else if (/\b(?:bot|discord|slack)\b/i.test(lower)) { type = "bot"; if (/\bdiscord\b/i.test(lower)) deps.push("discord.js"); else deps.push("@slack/bolt"); }
  else if (/\b(?:script|automation|cron)\b/i.test(lower)) { type = "script"; deps.push("node-cron", "dotenv"); }
  else if (/\b(?:lambda|serverless|edge|cloudflare)\b/i.test(lower)) { type = "lambda"; }
  else { deps.push("commander", "chalk"); }

  if (/\b(?:prisma|database|db)\b/i.test(lower)) deps.push("prisma", "@prisma/client");
  if (/\b(?:axios|fetch|http\s*client)\b/i.test(lower)) deps.push("axios");
  if (/\b(?:zod|validation)\b/i.test(lower)) deps.push("zod");
  if (/\b(?:dotenv|env)\b/i.test(lower) && !deps.includes("dotenv")) deps.push("dotenv");

  const nameMatch = msg.match(/(?:called|named|nombre)\s+(\w[\w-]*)/i);
  const name = nameMatch?.[1] ?? "myapp";
  return { name, type, useTs, deps: [...new Set(deps)], devDeps: [...new Set(devDeps)] };
}

interface GenFile { path: string; content: string; needsLlm: boolean; }
export interface NodeProjectResult { config: NodeConfig; files: GenFile[]; projectPath: string; prompt: string; }

export function createNodeProject(userRequest: string, cwd: string): NodeProjectResult {
  const cfg = detectNodeProject(userRequest);
  const files: GenFile[] = [];
  const ext = cfg.useTs ? "ts" : "js";

  files.push({ path: "package.json", content: JSON.stringify({
    name: cfg.name, version: "0.1.0", type: "module",
    ...(cfg.type === "cli" ? { bin: { [cfg.name]: `./dist/cli.js` } } : {}),
    ...(cfg.type === "library" ? { main: "./dist/index.js", types: "./dist/index.d.ts", exports: { ".": { import: "./dist/index.js", types: "./dist/index.d.ts" } } } : {}),
    scripts: {
      dev: cfg.useTs ? "tsx watch src/index.ts" : "node --watch src/index.js",
      build: cfg.useTs ? (cfg.type === "library" ? "tsup src/index.ts --format esm --dts" : "tsc") : "echo 'no build'",
      test: "vitest run",
      lint: "biome check .",
      ...(cfg.type === "cli" ? { start: cfg.useTs ? "tsx src/cli.ts" : "node src/cli.js" } : { start: cfg.useTs ? "tsx src/index.ts" : "node src/index.js" }),
    },
    dependencies: Object.fromEntries(cfg.deps.map(d => [d, "*"])),
    devDependencies: Object.fromEntries(cfg.devDeps.map(d => [d, "*"])),
  }, null, 2), needsLlm: false });

  if (cfg.useTs) {
    files.push({ path: "tsconfig.json", content: JSON.stringify({
      compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "bundler", strict: true, outDir: "dist", rootDir: "src", declaration: true, esModuleInterop: true, skipLibCheck: true },
      include: ["src"],
    }, null, 2), needsLlm: false });
  }

  // Main templates
  const mains: Record<string, string> = {
    cli: `${cfg.useTs ? 'import { Command } from "commander";\nimport chalk from "chalk";\nimport ora from "ora";\n' : 'const { Command } = require("commander");\nconst chalk = require("chalk");\nconst ora = require("ora");\n'}
const program = new Command();

program
  .name("${cfg.name}")
  .version("0.1.0")
  .description("${cfg.name} — CLI tool");

program
  .command("run")
  .description("Run the main command")
  .argument("<input>", "Input file")
  .option("-o, --output <path>", "Output path", "output.txt")
  .option("-v, --verbose", "Verbose output")
  .action(${cfg.useTs ? "async (input: string, opts: { output: string; verbose: boolean })" : "async (input, opts)"} => {
    const spinner = ora("Processing...").start();

    // TODO: implement logic

    spinner.succeed(chalk.green("Done!"));
  });

program.parse();
`,
    library: `/**
 * ${cfg.name} — Main module
 */

${cfg.useTs ? `export interface Config {
  debug?: boolean;
}

export class ${capitalize(cfg.name)} {
  private config: Config;
  private initialized = false;

  constructor(config: Config = {}) {
    this.config = config;
  }

  async init(): Promise<void> {
    // TODO: setup
    this.initialized = true;
  }

  async process(data: unknown): Promise<unknown> {
    if (!this.initialized) throw new Error("Not initialized");
    // TODO: main logic
    return data;
  }
}

export default ${capitalize(cfg.name)};
` : `class ${capitalize(cfg.name)} {
  constructor(config = {}) {
    this.config = config;
    this.initialized = false;
  }
  async init() { this.initialized = true; }
  async process(data) {
    if (!this.initialized) throw new Error("Not initialized");
    return data;
  }
}
module.exports = { ${capitalize(cfg.name)} };
`}`,
    worker: `${cfg.useTs ? 'import { Worker, Queue } from "bullmq";\nimport { Redis } from "ioredis";\n' : ''}
const QUEUE_NAME = "${cfg.name}-jobs";

// TODO: implement worker logic
console.log("${cfg.name} worker started");

process.on("SIGINT", () => { console.log("\\nShutdown"); process.exit(0); });
process.on("SIGTERM", () => { console.log("\\nShutdown"); process.exit(0); });
`,
    bot: `// ${cfg.name} bot
// TODO: implement bot logic
console.log("${cfg.name} bot starting...");
`,
    script: `${cfg.useTs ? 'import cron from "node-cron";\nimport "dotenv/config";\n' : 'const cron = require("node-cron");\nrequire("dotenv").config();\n'}

function task() {
  console.log("Running task...", new Date().toISOString());
  // TODO: implement task
}

// Run every 10 minutes
cron.schedule("*/10 * * * *", task);
task(); // run once immediately
console.log("${cfg.name} scheduler started");
`,
  };

  const mainFile = cfg.type === "cli" ? `src/cli.${ext}` : `src/index.${ext}`;
  files.push({ path: mainFile, content: mains[cfg.type] ?? mains["cli"]!, needsLlm: true });

  // Test
  files.push({ path: `tests/${cfg.name}.test.${ext}`, content: `import { describe, test, expect } from "vitest";

describe("${cfg.name}", () => {
  test("basic", () => {
    expect(true).toBe(true);
  });

  // TODO: add tests
});
`, needsLlm: true });

  // Extras
  files.push({ path: ".gitignore", content: "node_modules/\ndist/\n.env\n*.log\n", needsLlm: false });
  files.push({ path: ".env.example", content: `# ${cfg.name} config\nNODE_ENV=development\n`, needsLlm: false });
  files.push({ path: "Dockerfile", content: `FROM node:22-slim\nWORKDIR /app\nCOPY package*.json ./\nRUN npm install --production\nCOPY . .\n${cfg.useTs ? "RUN npm run build\nCMD [\"node\", \"dist/index.js\"]" : 'CMD ["node", "src/index.js"]'}\n`, needsLlm: false });
  files.push({ path: ".github/workflows/ci.yml", content: `name: CI\non: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with: { node-version: 22 }\n      - run: npm install\n      - run: npm test\n`, needsLlm: false });
  files.push({ path: "README.md", content: `# ${cfg.name}\n\nBuilt with KCode.\n\n\`\`\`bash\nnpm install\nnpm run dev\nnpm test\n\`\`\`\n\n*Astrolexis.space — Kulvex Code*\n`, needsLlm: false });

  const projectPath = join(cwd, cfg.name);
  for (const f of files) { const p = join(projectPath, f.path); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, f.content); }

  const m = files.filter(f => !f.needsLlm).length;
  return { config: cfg, files, projectPath, prompt: `Implement Node.js ${cfg.type}. ${m} files machine. USER: "${userRequest}"` };
}

function capitalize(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1).replace(/-(\w)/g, (_, c) => c.toUpperCase()); }
