#!/usr/bin/env bun
// KCode - Main entry point
// AI-powered coding assistant for the terminal by Astrolexis (Kulvex Code)

import { Command } from "commander";
import { resolve } from "node:path";
import { ConversationManager } from "./core/conversation";
import { registerBuiltinTools } from "./tools";
import { startUI } from "./ui/render";
import { runPrintMode } from "./ui/print-mode";
import { buildConfig } from "./core/config";
import type { PermissionMode } from "./core/types";
import {
  loadModelsConfig,
  saveModelsConfig,
  listModels,
  addModel,
  removeModel,
  setDefaultModel,
} from "./core/models";
import { setTheme } from "./core/theme";
import { log } from "./core/logger";
import { TranscriptManager } from "./core/transcript";
import { collectStats, formatStats } from "./core/stats";
import { runDiagnostics } from "./core/doctor";
import { getNarrativeManager } from "./core/narrative";
import { closeDb } from "./core/db";
import { shutdownMcpManager } from "./core/mcp";
import { getRulesManager } from "./core/rules";
import { getPluginManager } from "./core/plugins";
import { getLspManager, shutdownLsp } from "./core/lsp";
import { runSetup, isSetupComplete, getAvailableModels } from "./core/model-manager";
import { startServer, stopServer, getServerStatus, ensureServer, isServerRunning, getServerPort } from "./core/llama-server";
import { activateLicense, checkLicense, hasLicense, getLicenseInfo, clearLicense } from "./core/license";
import { performUpdate, checkForUpdate } from "./core/updater";
import { setSandboxMode } from "./tools/bash";
import { getSandboxCapabilities } from "./core/sandbox";
import { voiceToText, isVoiceAvailable } from "./core/voice";
import { getBenchmarkSummary, formatBenchmarks, initBenchmarkSchema } from "./core/benchmarks";

// Version — hardcoded to avoid Bun bundler resolving wrong package.json
const VERSION = "0.8.0";

// Prevent unhandled errors from background child processes from crashing kcode
process.on("uncaughtException", (err) => {
  log.error("process", `Uncaught exception: ${err.message}`);
  log.shutdown();
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  log.error("process", `Unhandled rejection: ${reason}`);
});

// Graceful cleanup on signals
function cleanupAndExit() {
  shutdownLsp();
  shutdownMcpManager();
  closeDb();
  log.shutdown();
  process.exit(0);
}

process.on("SIGINT", cleanupAndExit);
process.on("SIGTERM", cleanupAndExit);

// ─── CLI Setup ──────────────────────────────────────────────────

const program = new Command()
  .name("kcode")
  .description("Kulvex Code - AI-powered coding assistant by Astrolexis")
  .version(VERSION, "-v, --version");

// ─── Default command (interactive / single prompt) ──────────────

program
  .argument("[prompt]", "Run a single prompt non-interactively and exit")
  .option("-m, --model <model>", "Override the AI model")
  .option("-p, --permission <mode>", "Set permission mode (ask/auto/plan/deny/acceptEdits)")
  .option("-c, --continue", "Continue the last session")
  .option("--print", "Print mode: output only text, no UI (for piping)")
  .option("--json-schema <schema>", "Validate output against JSON schema (inline JSON or file path)")
  .option("--thinking", "Enable extended thinking mode")
  .option("--worktree <name>", "Create and work in an isolated git worktree")
  .option("--theme <name>", "Set color theme (e.g. dracula, monokai, nord)")
  .option("--fork", "Fork the last session (new session with previous history)")
  .option("--sandbox [mode]", "Run bash commands in a sandbox (light or strict)")
  .option("--voice", "Enable voice input (record from microphone)")
  .option("--add-dir <dirs...>", "Add additional working directories")
  .option("--compact-threshold <pct>", "Auto-compact threshold as percentage of context window (50-95, default 80)")
  .option("--no-tools", "Chat-only mode without tool calling")
  .allowExcessArguments(true)
  .action(async (prompt: string | undefined, options: any) => {
    // Validate permission mode
    const validPermissions = ["ask", "auto", "plan", "deny", "acceptEdits"];
    if (options.permission && !validPermissions.includes(options.permission)) {
      console.error(
        `Error: Invalid permission mode "${options.permission}". Must be one of: ${validPermissions.join(", ")}`,
      );
      process.exit(1);
    }

    // Collect any excess args as part of the prompt
    const args = program.args;
    const promptText = prompt
      ? args.length > 1
        ? args.join(" ")
        : prompt
      : undefined;

    await runMain(promptText, options);
  });

// ─── Models subcommand ──────────────────────────────────────────

const modelsCmd = program
  .command("models")
  .description("Manage registered LLM models");

modelsCmd
  .command("list")
  .alias("ls")
  .description("List all registered models")
  .action(async () => {
    const models = await listModels();
    const config = await loadModelsConfig();

    if (models.length === 0) {
      console.log("No models registered. Use 'kcode models add' to register one.");
      console.log("\nExample:");
      console.log("  kcode models add mnemo:code3 http://localhost:8091 --context 32000 --gpu 'RTX 5090'");
      return;
    }

    console.log("Registered models:\n");
    for (const m of models) {
      const isDefault = m.name === config.defaultModel ? " (default)" : "";
      const ctx = m.contextSize ? `, ctx: ${m.contextSize.toLocaleString()}` : "";
      const gpu = m.gpu ? `, gpu: ${m.gpu}` : "";
      const caps = m.capabilities?.length ? `, caps: [${m.capabilities.join(", ")}]` : "";
      const desc = m.description ? `\n    ${m.description}` : "";
      console.log(`  ${m.name}${isDefault}`);
      console.log(`    ${m.baseUrl}${ctx}${gpu}${caps}${desc}`);
    }
  });

modelsCmd
  .command("add <name> <baseUrl>")
  .description("Add or update a model")
  .option("--context <size>", "Context window size in tokens", parseInt)
  .option("--gpu <gpu>", "GPU identifier (informational)")
  .option("--caps <capabilities>", "Comma-separated capabilities (e.g. code,vision)")
  .option("--desc <description>", "Description of the model")
  .option("--default", "Set as default model")
  .action(async (name: string, baseUrl: string, opts: any) => {
    await addModel({
      name,
      baseUrl,
      contextSize: opts.context,
      gpu: opts.gpu,
      capabilities: opts.caps ? opts.caps.split(",").map((s: string) => s.trim()) : undefined,
      description: opts.desc,
    });

    if (opts.default) {
      await setDefaultModel(name);
    }

    console.log(`Model "${name}" registered at ${baseUrl}`);
    if (opts.default) {
      console.log(`Set "${name}" as default model.`);
    }
  });

modelsCmd
  .command("remove <name>")
  .alias("rm")
  .description("Remove a registered model")
  .action(async (name: string) => {
    const removed = await removeModel(name);
    if (removed) {
      console.log(`Model "${name}" removed.`);
    } else {
      console.error(`Model "${name}" not found.`);
      process.exit(1);
    }
  });

modelsCmd
  .command("default <name>")
  .description("Set the default model")
  .action(async (name: string) => {
    await setDefaultModel(name);
    console.log(`Default model set to "${name}".`);
  });

// ─── Plugin subcommand ──────────────────────────────────────

const pluginCmd = program
  .command("plugin")
  .description("Manage KCode plugins");

pluginCmd
  .command("search [query]")
  .description("Search the plugin registry")
  .action(async (query?: string) => {
    const { fetchRegistry, searchRegistry } = await import("./core/plugin-registry");
    const entries = await fetchRegistry();
    const results = query ? searchRegistry(entries, query) : entries;

    if (results.length === 0) {
      console.log("No plugins found.");
      return;
    }

    console.log(`\nAvailable plugins${query ? ` matching "${query}"` : ""}:\n`);
    for (const p of results) {
      console.log(`  ${p.name} v${p.version} \u2014 ${p.description}`);
      console.log(`    by ${p.author} [${p.tags.join(", ")}]`);
    }
  });

pluginCmd
  .command("install <name>")
  .alias("add")
  .description("Install a plugin from the registry")
  .action(async (name: string) => {
    const { installPlugin } = await import("./core/plugin-registry");
    const result = await installPlugin(name);
    console.log(result.success ? `\u2713 ${result.message}` : `\u2717 ${result.message}`);
  });

pluginCmd
  .command("uninstall <name>")
  .alias("rm")
  .description("Uninstall a plugin")
  .action(async (name: string) => {
    const { uninstallPlugin } = await import("./core/plugin-registry");
    const result = await uninstallPlugin(name);
    console.log(result.success ? `\u2713 ${result.message}` : `\u2717 ${result.message}`);
  });

// ─── Stats subcommand ────────────────────────────────────────────

program
  .command("stats")
  .description("Show usage statistics")
  .option("--days <n>", "Number of days to look back", parseInt, 7)
  .action(async (opts: { days: number }) => {
    const stats = await collectStats(opts.days);
    console.log(formatStats(stats));
  });

// ─── Doctor subcommand ───────────────────────────────────────────

program
  .command("doctor")
  .description("Check KCode setup and diagnose issues")
  .action(async () => {
    console.log("KCode Doctor\n");
    const results = await runDiagnostics();

    const icons = { ok: "\x1b[32m✓\x1b[0m", warn: "\x1b[33m⚠\x1b[0m", fail: "\x1b[31m✗\x1b[0m" };

    for (const r of results) {
      console.log(`  ${icons[r.status]} ${r.name}: ${r.message}`);
    }

    const fails = results.filter((r) => r.status === "fail").length;
    const warns = results.filter((r) => r.status === "warn").length;
    console.log();

    if (fails > 0) {
      console.log(`\x1b[31m${fails} issue(s) need attention.\x1b[0m`);
      process.exit(1);
    } else if (warns > 0) {
      console.log(`\x1b[33m${warns} warning(s), but KCode should work.\x1b[0m`);
    } else {
      console.log("\x1b[32mAll checks passed!\x1b[0m");
    }
  });

// ─── Setup subcommand ────────────────────────────────────────────

program
  .command("setup")
  .description("Auto-detect hardware, download engine and AI model")
  .option("--model <codename>", "Install a specific model (e.g. mnemo:mark5-14b)")
  .option("--force", "Force re-download even if already installed")
  .option("--list", "List available models")
  .action(async (opts: { model?: string; force?: boolean; list?: boolean }) => {
    if (opts.list) {
      console.log("\nAvailable mnemo:mark5 models:\n");
      for (const m of getAvailableModels()) {
        console.log(`  ${m.codename.padEnd(20)} ${m.paramBillions}B params, ~${m.sizeGB} GB — ${m.description}`);
        console.log(`  ${"".padEnd(20)} Min VRAM: ${(m.minVramMB / 1024).toFixed(0)} GB`);
      }
      console.log();
      return;
    }

    try {
      await runSetup({ model: opts.model, force: opts.force });
    } catch (err) {
      console.error(`\x1b[31mSetup failed: ${err instanceof Error ? err.message : err}\x1b[0m`);
      process.exit(1);
    }
  });

// ─── Server subcommand ──────────────────────────────────────────

const serverCmd = program
  .command("server")
  .description("Manage the local inference server (llama-server)");

serverCmd
  .command("start")
  .description("Start the llama-server")
  .option("--port <port>", "Override server port", parseInt)
  .action(async (opts: { port?: number }) => {
    try {
      console.log("Starting inference server...");
      const { port, pid } = await startServer({ port: opts.port });
      console.log(`\x1b[32m✓\x1b[0m Server running on port ${port} (PID: ${pid})`);
    } catch (err) {
      console.error(`\x1b[31m✗ ${err instanceof Error ? err.message : err}\x1b[0m`);
      process.exit(1);
    }
  });

serverCmd
  .command("stop")
  .description("Stop the llama-server")
  .action(async () => {
    await stopServer();
    console.log("Server stopped.");
  });

serverCmd
  .command("status")
  .description("Show server status")
  .action(async () => {
    const status = await getServerStatus();
    if (status.running) {
      console.log(`\x1b[32m● Running\x1b[0m on port ${status.port} (PID: ${status.pid})`);
      if (status.model) console.log(`  Model: ${status.model}`);
    } else {
      console.log("\x1b[2m○ Not running\x1b[0m");
      console.log("  Start with: kcode server start");
    }
  });

serverCmd
  .command("restart")
  .description("Restart the llama-server")
  .action(async () => {
    console.log("Restarting server...");
    await stopServer();
    const { port, pid } = await startServer();
    console.log(`\x1b[32m✓\x1b[0m Server restarted on port ${port} (PID: ${pid})`);
  });

// ─── Activate subcommand ────────────────────────────────────────

program
  .command("activate <license-key>")
  .description("Activate a license key for this machine")
  .action(async (licenseKey: string) => {
    console.log("\nActivating license...\n");

    const result = await activateLicense(licenseKey);

    if (result.valid) {
      console.log(`\x1b[32m✓\x1b[0m License activated successfully!`);
      console.log(`  Tier: ${result.tier}`);
      console.log(`  This license is now bound to this machine.\n`);
    } else {
      console.error(`\x1b[31m✗\x1b[0m ${result.message}\n`);
      process.exit(1);
    }
  });

// ─── License subcommand ─────────────────────────────────────────

const licenseCmd = program
  .command("license")
  .description("Manage your KCode license");

licenseCmd
  .command("status")
  .description("Show current license status")
  .action(async () => {
    const info = getLicenseInfo();
    if (!info) {
      console.log("\x1b[2m○ No license\x1b[0m");
      console.log("  Activate with: kcode activate <license-key>");
      return;
    }

    const result = await checkLicense();
    if (result.valid) {
      console.log(`\x1b[32m● Licensed\x1b[0m`);
      console.log(`  Tier:      ${info.tier}`);
      console.log(`  Activated: ${new Date(info.activatedAt).toLocaleDateString()}`);
      console.log(`  Validated: ${new Date(info.lastValidated).toLocaleDateString()}`);
      if (result.grace) {
        console.log(`  \x1b[33m⚠ Offline mode — connect to re-validate\x1b[0m`);
      }
    } else {
      console.log(`\x1b[31m● Invalid\x1b[0m`);
      console.log(`  ${result.message}`);
    }
  });

licenseCmd
  .command("deactivate")
  .description("Remove license from this machine")
  .action(() => {
    clearLicense();
    console.log("License removed from this machine.");
  });

// ─── Teach subcommand ──────────────────────────────────────────

const teachCmd = program
  .command("teach")
  .description("Teach KCode about your environment (awareness modules)");

teachCmd
  .command("add <name>")
  .description("Create a new awareness module (opens in $EDITOR)")
  .option("-g, --global", "Create in ~/.kcode/awareness/ instead of project")
  .action(async (name: string, opts: { global?: boolean }) => {
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const { mkdirSync, existsSync, writeFileSync } = await import("node:fs");
    const { execSync } = await import("node:child_process");

    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-$/, "");
    const dir = opts.global
      ? join(homedir(), ".kcode", "awareness")
      : join(process.cwd(), ".kcode", "awareness");

    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, `${slug}.md`);

    if (existsSync(filePath)) {
      console.log(`\x1b[33m!\x1b[0m Already exists: ${filePath}`);
      console.log("  Edit it with: $EDITOR " + filePath);
      return;
    }

    const template = `# ${name}

<!-- KCode loads this file into every session automatically. -->
<!-- Write anything you want KCode to always know about. -->
<!-- Examples: API endpoints, device IPs, project conventions, team rules. -->

`;
    writeFileSync(filePath, template, "utf-8");
    console.log(`\x1b[32m+\x1b[0m Created: ${filePath}`);

    const editor = process.env.EDITOR || process.env.VISUAL || "nano";
    try {
      execSync(`${editor} "${filePath}"`, { stdio: "inherit" });
    } catch {
      console.log(`  Edit it with: ${editor} ${filePath}`);
    }
  });

teachCmd
  .command("list")
  .description("List all awareness modules")
  .action(async () => {
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const { readdirSync, existsSync, readFileSync, statSync } = await import("node:fs");

    const globalDir = join(homedir(), ".kcode", "awareness");
    const projectDir = join(process.cwd(), ".kcode", "awareness");

    let found = false;

    for (const [label, dir] of [["Global", globalDir], ["Project", projectDir]] as const) {
      if (!existsSync(dir)) continue;
      const files = readdirSync(dir).filter(f => f.endsWith(".md")).sort();
      if (files.length === 0) continue;

      found = true;
      console.log(`\n\x1b[1m${label}\x1b[0m \x1b[2m(${dir})\x1b[0m`);
      for (const f of files) {
        const content = readFileSync(join(dir, f), "utf-8");
        const firstLine = content.split("\n").find(l => l.startsWith("# "))?.replace("# ", "") || f;
        const size = statSync(join(dir, f)).size;
        console.log(`  \x1b[36m${f}\x1b[0m — ${firstLine} \x1b[2m(${size} bytes)\x1b[0m`);
      }
    }

    if (!found) {
      console.log("\nNo awareness modules found.");
      console.log("Create one with: \x1b[1mkcode teach add <name>\x1b[0m");
      console.log("\nExamples:");
      console.log("  kcode teach add sonoff       # Teach about IoT devices");
      console.log("  kcode teach add deploy        # Teach deployment steps");
      console.log("  kcode teach add team-rules    # Teach coding conventions");
    }
  });

teachCmd
  .command("remove <name>")
  .description("Remove an awareness module")
  .option("-g, --global", "Remove from ~/.kcode/awareness/")
  .action(async (name: string, opts: { global?: boolean }) => {
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const { existsSync, unlinkSync } = await import("node:fs");

    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-$/, "");
    const dir = opts.global
      ? join(homedir(), ".kcode", "awareness")
      : join(process.cwd(), ".kcode", "awareness");

    const filePath = join(dir, `${slug}.md`);
    if (!existsSync(filePath)) {
      console.log(`\x1b[31m!\x1b[0m Not found: ${filePath}`);
      return;
    }

    unlinkSync(filePath);
    console.log(`\x1b[32m-\x1b[0m Removed: ${filePath}`);
  });

teachCmd
  .command("edit <name>")
  .description("Edit an existing awareness module")
  .option("-g, --global", "Edit from ~/.kcode/awareness/")
  .action(async (name: string, opts: { global?: boolean }) => {
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const { existsSync } = await import("node:fs");
    const { execSync } = await import("node:child_process");

    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-$/, "");
    const dir = opts.global
      ? join(homedir(), ".kcode", "awareness")
      : join(process.cwd(), ".kcode", "awareness");

    const filePath = join(dir, `${slug}.md`);
    if (!existsSync(filePath)) {
      console.log(`\x1b[31m!\x1b[0m Not found: ${filePath}`);
      console.log("  Create it with: kcode teach add " + name);
      return;
    }

    const editor = process.env.EDITOR || process.env.VISUAL || "nano";
    try {
      execSync(`${editor} "${filePath}"`, { stdio: "inherit" });
      console.log(`\x1b[32m*\x1b[0m Updated: ${filePath}`);
    } catch {
      console.log(`  Edit manually: ${editor} ${filePath}`);
    }
  });

// ─── Init subcommand ──────────────────────────────────────────

program
  .command("init")
  .description("Initialize KCode in the current project")
  .option("--force", "Overwrite existing files")
  .action(async (opts: { force?: boolean }) => {
    const { mkdirSync, existsSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const cwd = process.cwd();

    const created: string[] = [];
    const skipped: string[] = [];

    // 1. Create KCODE.md
    const kcodeMdPath = join(cwd, "KCODE.md");
    if (!existsSync(kcodeMdPath) || opts.force) {
      const dirName = cwd.split("/").pop() ?? "project";
      writeFileSync(kcodeMdPath, `# KCODE.md

## Project: ${dirName}

<!-- KCode reads this file at the start of every session. -->
<!-- Add project-specific instructions, conventions, and context here. -->

## Build & Development

\`\`\`bash
# Add your build/test/dev commands here
\`\`\`

## Key Conventions

- <!-- Add coding conventions, naming patterns, etc. -->

## Architecture

- <!-- Describe the high-level architecture, key files, modules -->
`, "utf-8");
      created.push("KCODE.md");
    } else {
      skipped.push("KCODE.md (exists)");
    }

    // 2. Create .kcode/ directory structure
    const kcodeDir = join(cwd, ".kcode");
    mkdirSync(kcodeDir, { recursive: true });

    // 3. Create settings.json
    const settingsPath = join(kcodeDir, "settings.json");
    if (!existsSync(settingsPath) || opts.force) {
      writeFileSync(settingsPath, JSON.stringify({
        hooks: {
          PostToolUse: [],
          PreToolUse: [],
        },
      }, null, 2) + "\n", "utf-8");
      created.push(".kcode/settings.json");
    } else {
      skipped.push(".kcode/settings.json (exists)");
    }

    // 4. Create awareness directory
    const awarenessDir = join(kcodeDir, "awareness");
    mkdirSync(awarenessDir, { recursive: true });

    const exampleAwareness = join(awarenessDir, "project.md");
    if (!existsSync(exampleAwareness) || opts.force) {
      writeFileSync(exampleAwareness, `# Project Context

<!-- Add anything KCode should always know about this project. -->
<!-- Examples: API endpoints, environment setup, team conventions. -->
`, "utf-8");
      created.push(".kcode/awareness/project.md");
    } else {
      skipped.push(".kcode/awareness/project.md (exists)");
    }

    // 5. Create rules directory
    const rulesDir = join(kcodeDir, "rules");
    mkdirSync(rulesDir, { recursive: true });

    // 6. Add .kcode to .gitignore if not already there
    const gitignorePath = join(cwd, ".gitignore");
    if (existsSync(gitignorePath)) {
      const gitignore = (await import("node:fs")).readFileSync(gitignorePath, "utf-8");
      if (!gitignore.includes(".kcode/")) {
        (await import("node:fs")).appendFileSync(gitignorePath, "\n# KCode local config\n.kcode/\n", "utf-8");
        created.push(".gitignore (appended .kcode/)");
      }
    }

    // Report
    if (created.length > 0) {
      console.log("\x1b[32m✓\x1b[0m KCode initialized:");
      for (const f of created) console.log(`  + ${f}`);
    }
    if (skipped.length > 0) {
      for (const f of skipped) console.log(`  \x1b[2m- ${f}\x1b[0m`);
    }
    console.log("\nEdit \x1b[1mKCODE.md\x1b[0m to teach KCode about this project.");
    console.log("Add awareness modules: \x1b[1mkcode teach add <name>\x1b[0m");
  });

// ─── New subcommand (project scaffolding) ───────────────────────

program
  .command("new <template> [name]")
  .description("Create a new project from a template (api, cli, web, library)")
  .action(async (template: string, name?: string) => {
    const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");

    const projectName = name ?? template;
    const projectDir = join(process.cwd(), projectName);

    if (existsSync(projectDir)) {
      console.error(`\x1b[31mDirectory "${projectName}" already exists.\x1b[0m`);
      process.exit(1);
    }

    mkdirSync(projectDir, { recursive: true });

    const templates: Record<string, () => void> = {
      api: () => {
        mkdirSync(join(projectDir, "src"), { recursive: true });
        mkdirSync(join(projectDir, "src", "routes"), { recursive: true });
        writeFileSync(join(projectDir, "package.json"), JSON.stringify({
          name: projectName,
          version: "0.1.0",
          type: "module",
          scripts: { start: "bun run src/index.ts", dev: "bun --watch run src/index.ts", test: "bun test" },
          devDependencies: { "@types/bun": "latest" },
        }, null, 2) + "\n");
        writeFileSync(join(projectDir, "tsconfig.json"), JSON.stringify({
          compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "bundler", strict: true, outDir: "dist" },
          include: ["src"],
        }, null, 2) + "\n");
        writeFileSync(join(projectDir, "src", "index.ts"), `const server = Bun.serve({
  port: 10080,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return Response.json({ status: "ok" });
    return new Response("Not found", { status: 404 });
  },
});

console.log(\`Server running at http://localhost:\${server.port}\`);
`);
        writeFileSync(join(projectDir, "KCODE.md"), `# ${projectName}\n\nBun API project. Run with \`bun run dev\`.\n`);
      },
      cli: () => {
        mkdirSync(join(projectDir, "src"), { recursive: true });
        writeFileSync(join(projectDir, "package.json"), JSON.stringify({
          name: projectName,
          version: "0.1.0",
          type: "module",
          bin: { [projectName]: "src/index.ts" },
          scripts: { start: "bun run src/index.ts", build: "bun build src/index.ts --compile --outfile dist/" + projectName, test: "bun test" },
          devDependencies: { "@types/bun": "latest" },
          dependencies: { commander: "^14.0.0" },
        }, null, 2) + "\n");
        writeFileSync(join(projectDir, "tsconfig.json"), JSON.stringify({
          compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "bundler", strict: true },
          include: ["src"],
        }, null, 2) + "\n");
        writeFileSync(join(projectDir, "src", "index.ts"), `#!/usr/bin/env bun
import { Command } from "commander";

const program = new Command()
  .name("${projectName}")
  .description("A CLI tool")
  .version("0.1.0")
  .argument("[input]", "Input to process")
  .action((input?: string) => {
    console.log(\`Hello from ${projectName}!\`, input ?? "");
  });

program.parse();
`);
        writeFileSync(join(projectDir, "KCODE.md"), `# ${projectName}\n\nBun CLI project. Run with \`bun run start\`, build with \`bun run build\`.\n`);
      },
      web: () => {
        mkdirSync(join(projectDir, "src"), { recursive: true });
        mkdirSync(join(projectDir, "public"), { recursive: true });
        writeFileSync(join(projectDir, "package.json"), JSON.stringify({
          name: projectName,
          version: "0.1.0",
          type: "module",
          scripts: { start: "bun run src/server.ts", dev: "bun --watch run src/server.ts", test: "bun test" },
          devDependencies: { "@types/bun": "latest" },
        }, null, 2) + "\n");
        writeFileSync(join(projectDir, "src", "server.ts"), `const server = Bun.serve({
  port: 10080,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/") return new Response(Bun.file("public/index.html"));
    const file = Bun.file("public" + url.pathname);
    return new Response(file);
  },
});
console.log(\`Server running at http://localhost:\${server.port}\`);
`);
        writeFileSync(join(projectDir, "public", "index.html"), `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>${projectName}</title><link rel="stylesheet" href="/styles.css"></head>
<body><h1>${projectName}</h1><script src="/app.js"></script></body>
</html>
`);
        writeFileSync(join(projectDir, "public", "styles.css"), "body { font-family: system-ui; max-width: 800px; margin: 2rem auto; }\n");
        writeFileSync(join(projectDir, "public", "app.js"), "console.log('Ready');\n");
        writeFileSync(join(projectDir, "KCODE.md"), `# ${projectName}\n\nBun web project. Run with \`bun run dev\`.\n`);
      },
      library: () => {
        mkdirSync(join(projectDir, "src"), { recursive: true });
        mkdirSync(join(projectDir, "tests"), { recursive: true });
        writeFileSync(join(projectDir, "package.json"), JSON.stringify({
          name: projectName,
          version: "0.1.0",
          type: "module",
          main: "src/index.ts",
          scripts: { test: "bun test", build: "bun build src/index.ts --outdir dist" },
          devDependencies: { "@types/bun": "latest" },
        }, null, 2) + "\n");
        writeFileSync(join(projectDir, "tsconfig.json"), JSON.stringify({
          compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "bundler", strict: true, declaration: true, outDir: "dist" },
          include: ["src"],
        }, null, 2) + "\n");
        writeFileSync(join(projectDir, "src", "index.ts"), `export function hello(name: string): string {
  return \`Hello, \${name}!\`;
}
`);
        writeFileSync(join(projectDir, "tests", "index.test.ts"), `import { test, expect } from "bun:test";
import { hello } from "../src/index";

test("hello returns greeting", () => {
  expect(hello("World")).toBe("Hello, World!");
});
`);
        writeFileSync(join(projectDir, "KCODE.md"), `# ${projectName}\n\nBun library project. Test with \`bun test\`.\n`);
      },
    };

    if (!templates[template]) {
      console.error(`\x1b[31mUnknown template "${template}". Available: ${Object.keys(templates).join(", ")}\x1b[0m`);
      process.exit(1);
    }

    templates[template]();

    // Initialize KCode in the new project
    const kcodeDir = join(projectDir, ".kcode");
    mkdirSync(join(kcodeDir, "awareness"), { recursive: true });
    writeFileSync(join(kcodeDir, "settings.json"), JSON.stringify({ hooks: {} }, null, 2) + "\n");

    // Add .gitignore
    writeFileSync(join(projectDir, ".gitignore"), "node_modules/\ndist/\n.kcode/\n");

    console.log(`\x1b[32m✓\x1b[0m Created ${template} project: ${projectName}/`);
    console.log(`\n  cd ${projectName}`);
    console.log("  bun install");
    console.log("  kcode\n");
  });

// ─── Resume subcommand ──────────────────────────────────────────

program
  .command("resume")
  .description("List and resume previous sessions")
  .option("-l, --list", "List recent sessions")
  .option("-n, --number <n>", "Number of sessions to show", parseInt, 10)
  .action(async (opts: { list?: boolean; number?: number }) => {
    const transcript = new TranscriptManager();
    const sessions = transcript.listSessions();

    if (sessions.length === 0) {
      console.log("No previous sessions found.");
      return;
    }

    const count = Math.min(opts.number ?? 10, sessions.length);
    console.log(`\nRecent sessions (${count} of ${sessions.length}):\n`);

    for (let i = 0; i < count; i++) {
      const s = sessions[i];
      const date = s.startedAt.replace("T", " ");
      const prompt = s.prompt.slice(0, 60);
      console.log(`  \x1b[36m${i + 1}.\x1b[0m ${date}  ${prompt}`);
    }

    console.log("\nTo resume a session:");
    console.log("  \x1b[1mkcode --continue\x1b[0m         Resume the most recent session");
    console.log("  \x1b[1mkcode --fork\x1b[0m             Fork the most recent session (new transcript)");
  });

// ─── Search subcommand ──────────────────────────────────────────

program
  .command("search <query>")
  .description("Search through past session transcripts")
  .option("-n, --number <n>", "Max results to show", parseInt, 10)
  .option("-d, --days <days>", "Limit search to last N days", parseInt, 30)
  .action(async (query: string, opts: { number?: number; days?: number }) => {
    const transcript = new TranscriptManager();
    const sessions = transcript.listSessions();
    const cutoff = Date.now() - (opts.days ?? 30) * 24 * 60 * 60 * 1000;
    const queryLower = query.toLowerCase();
    const maxResults = opts.number ?? 10;

    interface SearchResult {
      session: string;
      date: string;
      role: string;
      content: string;
      lineNum: number;
    }

    const results: SearchResult[] = [];

    for (const session of sessions) {
      // Check date cutoff from filename
      const dateStr = session.filename.slice(0, 10);
      const fileDate = new Date(dateStr).getTime();
      if (!isNaN(fileDate) && fileDate < cutoff) continue;

      const entries = transcript.loadSession(session.filename);
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (entry.content.toLowerCase().includes(queryLower)) {
          results.push({
            session: session.filename,
            date: session.startedAt,
            role: entry.role,
            content: entry.content,
            lineNum: i + 1,
          });
          if (results.length >= maxResults) break;
        }
      }
      if (results.length >= maxResults) break;
    }

    if (results.length === 0) {
      console.log(`No matches for "${query}" in last ${opts.days ?? 30} days.`);
      return;
    }

    console.log(`\nFound ${results.length} match(es) for "${query}":\n`);
    for (const r of results) {
      const preview = r.content.slice(0, 120).replace(/\n/g, " ");
      console.log(`  \x1b[36m${r.date}\x1b[0m [${r.role}]`);
      console.log(`    ${preview}${r.content.length > 120 ? "..." : ""}`);
      console.log(`    \x1b[2mSession: ${r.session}:${r.lineNum}\x1b[0m`);
      console.log();
    }
  });

// ─── Watch subcommand ───────────────────────────────────────────

program
  .command("watch [glob]")
  .description("Watch files for changes and auto-run commands")
  .option("-p, --pattern <glob>", "Glob pattern to watch", "**/*.{ts,js,tsx,jsx,py,rs,go}")
  .option("-i, --ignore <dirs>", "Directories to ignore (comma-separated)", "node_modules,dist,build,.git,__pycache__")
  .option("--run <command>", "Command to run on file change (default: auto-detect test runner)")
  .option("--debounce <ms>", "Debounce interval in milliseconds", parseInt, 500)
  .action(async (glob: string | undefined, opts: { pattern?: string; ignore?: string; run?: string; debounce?: number }) => {
    const { watch } = await import("node:fs");
    const { join, relative, resolve: resolvePath } = await import("node:path");
    const { readdirSync, existsSync } = await import("node:fs");
    const { execSync } = await import("node:child_process");
    const cwd = process.cwd();
    const ignoreDirs = new Set((opts.ignore ?? "").split(",").map((d) => d.trim()));
    const debounceMs = opts.debounce ?? 500;

    // Detect test runner if no --run provided
    let command = opts.run;
    if (!command) {
      if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bunfig.toml"))) command = "bun test";
      else if (existsSync(join(cwd, "package.json"))) command = "npm test";
      else if (existsSync(join(cwd, "pytest.ini")) || existsSync(join(cwd, "pyproject.toml"))) command = "pytest";
      else if (existsSync(join(cwd, "go.mod"))) command = "go test ./...";
      else if (existsSync(join(cwd, "Cargo.toml"))) command = "cargo test";
    }

    const watchPattern = glob ?? opts.pattern ?? "**/*.{ts,js,tsx,jsx,py,rs,go}";

    if (command) {
      console.log(`\x1b[36mWatching:\x1b[0m ${watchPattern}`);
      console.log(`\x1b[36mCommand:\x1b[0m ${command}`);
      console.log(`\x1b[2mPress Ctrl+C to stop\x1b[0m\n`);
    } else {
      console.log(`\x1b[36mWatching for changes...\x1b[0m (Ctrl+C to stop)`);
      console.log(`  Pattern: ${watchPattern}`);
      console.log(`  Ignoring: ${Array.from(ignoreDirs).join(", ")}\n`);
    }

    let timeout: ReturnType<typeof setTimeout> | null = null;
    let runCount = 0;

    const runCommand = (changedFile: string) => {
      if (!command) return;
      runCount++;
      const rel = relative(cwd, changedFile);
      console.log(`\x1b[33m[${runCount}]\x1b[0m ${rel} changed — running: ${command}`);

      try {
        const output = execSync(command!, { cwd, timeout: 60000, stdio: "pipe" }).toString();
        const lines = output.trim().split("\n");
        const lastLines = lines.slice(-5).join("\n");
        console.log(`\x1b[32m✓\x1b[0m ${lastLines}\n`);
      } catch (err: any) {
        const stderr = err.stderr?.toString() || err.stdout?.toString() || err.message;
        const lines = stderr.trim().split("\n").slice(-8).join("\n");
        console.log(`\x1b[31m✗\x1b[0m ${lines}\n`);
      }
    };

    // Collect directories to watch
    function getDirs(dir: string): string[] {
      const dirs = [dir];
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          if (entry.name.startsWith(".") || ignoreDirs.has(entry.name)) continue;
          dirs.push(...getDirs(join(dir, entry.name)));
        }
      } catch { /* ignore */ }
      return dirs;
    }

    const watchDirs = getDirs(cwd);
    const watchers: ReturnType<typeof watch>[] = [];
    const recentChanges = new Map<string, number>();

    for (const dir of watchDirs) {
      try {
        const watcher = watch(dir, { recursive: false }, (eventType, filename) => {
          if (!filename) return;
          const fullPath = join(dir, filename);
          const relPath = relative(cwd, fullPath);

          // Ignore node_modules, dist, .git
          if (relPath.includes("node_modules") || relPath.includes("dist/") || relPath.includes(".git/")) return;

          // Deduplicate rapid-fire events (debounce)
          const now = Date.now();
          const last = recentChanges.get(relPath) ?? 0;
          if (now - last < debounceMs) return;
          recentChanges.set(relPath, now);

          // Check pattern match (simple extension check)
          const ext = filename.split(".").pop() ?? "";
          const allowedExts = (watchPattern)
            .replace(/\*\*\/\*\.\{?/g, "")
            .replace(/\}$/g, "")
            .split(",");
          if (allowedExts.length > 0 && !allowedExts.includes(ext)) return;

          if (command) {
            // Auto-run mode: debounce and run command
            if (timeout) clearTimeout(timeout);
            timeout = setTimeout(() => runCommand(resolvePath(cwd, relPath)), debounceMs);
          } else {
            // Report mode: just print the change
            const time = new Date().toLocaleTimeString("en-US", { hour12: false });
            const icon = eventType === "rename" ? "+" : "*";
            console.log(`  \x1b[33m${time}\x1b[0m ${icon} ${relPath}`);
          }
        });
        watchers.push(watcher);
      } catch { /* skip unwatchable dirs */ }
    }

    console.log(`  Watching ${watchDirs.length} directories\n`);

    // Keep process alive
    await new Promise(() => {
      process.on("SIGINT", () => {
        for (const w of watchers) w.close();
        if (command) {
          console.log(`\n\x1b[2mStopped watching. ${runCount} runs total.\x1b[0m`);
        } else {
          console.log("\n  Watch stopped.");
        }
        process.exit(0);
      });
    });
  });

// ─── Update subcommand ──────────────────────────────────────────

program
  .command("update")
  .description("Check for updates and self-update KCode")
  .option("--check", "Only check, don't download")
  .option("--url <url>", "Custom update URL")
  .action(async (opts: { check?: boolean; url?: string }) => {
    if (opts.check) {
      const newVersion = await checkForUpdate(VERSION);
      if (newVersion) {
        console.log(`\x1b[33mUpdate available: v${VERSION} → v${newVersion}\x1b[0m`);
        console.log("Run \x1b[1mkcode update\x1b[0m to install.");
      } else {
        console.log(`\x1b[32m✓\x1b[0m KCode v${VERSION} is up to date.`);
      }
      return;
    }

    const result = await performUpdate(VERSION, opts.url);
    if (result.error) {
      console.error(`\x1b[31m✗ ${result.error}\x1b[0m`);
      process.exit(1);
    }
  });

// ─── Warmup subcommand ─────────────────────────────────────────

program
  .command("warmup")
  .description("Warm up the model with a probe request")
  .option("-m, --model <model>", "Model to warm up")
  .action(async (opts: { model?: string }) => {
    const config = await buildConfig(process.cwd());
    const model = opts.model ?? config.model;
    const { getModelBaseUrl } = await import("./core/models");
    const baseUrl = await getModelBaseUrl(model, config.apiBase);

    console.log(`Warming up ${model} at ${baseUrl}...`);
    const start = Date.now();

    try {
      const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(config.apiKey ? { "Authorization": `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "Say OK" }],
          max_tokens: 8,
          stream: false,
        }),
        signal: AbortSignal.timeout(30000),
      });

      const data = await resp.json() as any;
      const elapsed = Date.now() - start;
      const text = data.choices?.[0]?.message?.content ?? "(no response)";
      const tokens = data.usage?.total_tokens ?? 0;

      console.log(`\x1b[32m✓\x1b[0m Model ready (${elapsed}ms, ${tokens} tok)`);
      console.log(`  Response: ${text.slice(0, 50)}`);

      if (elapsed > 5000) {
        console.log(`\x1b[33m⚠\x1b[0m Slow response — model may still be loading into VRAM`);
      }
    } catch (err) {
      const elapsed = Date.now() - start;
      console.error(`\x1b[31m✗\x1b[0m Warmup failed after ${elapsed}ms`);
      console.error(`  ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ─── Benchmark subcommand ───────────────────────────────────────

program
  .command("benchmark")
  .alias("bench")
  .description("Show model quality benchmark results")
  .option("-m, --model <model>", "Filter by model name")
  .option("-d, --days <days>", "Number of days to look back", parseInt, 30)
  .action(async (opts: { model?: string; days?: number }) => {
    try { initBenchmarkSchema(); } catch { /* ignore */ }
    const summaries = getBenchmarkSummary(opts.model, opts.days ?? 30);
    console.log(formatBenchmarks(summaries));
  });

// ─── Completions subcommand ──────────────────────────────────────

program
  .command("completions <shell>")
  .description("Generate shell completion script (bash or zsh)")
  .action((shell: string) => {
    if (shell === "bash") {
      console.log(`# KCode bash completion - add to ~/.bashrc:
# eval "$(kcode completions bash)"

_kcode_completions() {
  local cur prev commands subcommands
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  commands="models setup server activate license stats doctor teach init resume search watch new update benchmark completions serve history"

  if [ $COMP_CWORD -eq 1 ]; then
    COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
    return
  fi

  case "$prev" in
    models)
      COMPREPLY=( $(compgen -W "list add remove set-default" -- "$cur") )
      ;;
    new)
      COMPREPLY=( $(compgen -W "api cli web library" -- "$cur") )
      ;;
    completions)
      COMPREPLY=( $(compgen -W "bash zsh" -- "$cur") )
      ;;
    *)
      COMPREPLY=( $(compgen -f -- "$cur") )
      ;;
  esac
}
complete -F _kcode_completions kcode`);
    } else if (shell === "zsh") {
      console.log(`#compdef kcode
# KCode zsh completion - add to ~/.zshrc:
# eval "$(kcode completions zsh)"

_kcode() {
  local -a commands
  commands=(
    'models:Manage registered LLM models'
    'setup:Run the setup wizard'
    'server:Manage local inference server'
    'init:Initialize a new project'
    'resume:List and resume sessions'
    'search:Search session transcripts'
    'watch:Watch for file changes'
    'new:Create project from template'
    'update:Check for updates'
    'benchmark:Show benchmark results'
    'completions:Generate shell completions'
    'serve:Start HTTP API server'
    'history:Browse session history'
  )

  _arguments -C \\
    '1:command:->cmd' \\
    '*::arg:->args'

  case $state in
    cmd)
      _describe 'command' commands
      ;;
    args)
      case $words[1] in
        models)
          _values 'subcommand' list add remove set-default
          ;;
        new)
          _values 'template' api cli web library
          ;;
        completions)
          _values 'shell' bash zsh
          ;;
        *)
          _files
          ;;
      esac
      ;;
  esac
}

_kcode`);
    } else {
      console.error(`Unsupported shell: ${shell}. Use 'bash' or 'zsh'.`);
      process.exit(1);
    }
  });

// ─── History subcommand ──────────────────────────────────────────

program
  .command("history")
  .description("Browse and manage session history")
  .option("-n, --limit <count>", "Number of sessions to show", parseInt, 20)
  .option("--load <filename>", "Load a specific session by filename")
  .option("--delete <filename>", "Delete a specific session")
  .option("--clear", "Delete all sessions")
  .action(async (opts: { limit?: number; load?: string; delete?: string; clear?: boolean }) => {
    const { readdirSync, unlinkSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const transcriptsDir = join(homedir(), ".kcode", "transcripts");

    if (opts.clear) {
      try {
        const files = readdirSync(transcriptsDir).filter(f => f.endsWith(".jsonl"));
        for (const f of files) unlinkSync(join(transcriptsDir, f));
        console.log(`Deleted ${files.length} sessions.`);
      } catch { console.log("No sessions to delete."); }
      return;
    }

    if (opts.delete) {
      try {
        unlinkSync(join(transcriptsDir, opts.delete));
        console.log(`Deleted: ${opts.delete}`);
      } catch { console.error(`Session not found: ${opts.delete}`); process.exit(1); }
      return;
    }

    if (opts.load) {
      // Load and display session contents
      try {
        const { readFileSync } = await import("node:fs");
        const content = readFileSync(join(transcriptsDir, opts.load), "utf-8");
        const entries = content.trim().split("\n").filter(Boolean).map(line => {
          try { return JSON.parse(line); } catch { return null; }
        }).filter(Boolean);

        console.log(`\n\x1b[1mSession: ${opts.load}\x1b[0m`);
        console.log(`Entries: ${entries.length}\n`);

        for (const entry of entries) {
          const time = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString("en-US", { hour12: false }) : "??:??";
          const role = entry.role ?? "?";
          const type = entry.type ?? "?";
          const content = (entry.content ?? "").slice(0, 120);

          if (type === "user_message") {
            console.log(`  \x1b[36m${time}\x1b[0m \x1b[1m❯\x1b[0m ${content}`);
          } else if (type === "assistant_text") {
            console.log(`  \x1b[36m${time}\x1b[0m   ${content}`);
          } else if (type === "tool_use") {
            try {
              const parsed = JSON.parse(content);
              console.log(`  \x1b[36m${time}\x1b[0m \x1b[33m⚡ ${parsed.name}\x1b[0m`);
            } catch {
              console.log(`  \x1b[36m${time}\x1b[0m \x1b[33m⚡ tool\x1b[0m`);
            }
          }
        }
        console.log();
      } catch {
        console.error(`Could not read session: ${opts.load}`);
        process.exit(1);
      }
      return;
    }

    // List recent sessions
    try {
      const files = readdirSync(transcriptsDir)
        .filter(f => f.endsWith(".jsonl"))
        .sort()
        .reverse()
        .slice(0, opts.limit ?? 20);

      if (files.length === 0) {
        console.log("No session history found.");
        return;
      }

      console.log(`\n\x1b[1mRecent sessions\x1b[0m (${files.length}):\n`);
      for (const f of files) {
        try {
          const stat = statSync(join(transcriptsDir, f));
          const sizeKB = Math.round(stat.size / 1024);
          // Extract date and slug from filename: 2026-03-17T12-30-45-slug.jsonl
          const match = f.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}-\d{2}-\d{2})-(.+)\.jsonl$/);
          if (match) {
            const date = match[1];
            const time = match[2].replace(/-/g, ":");
            const slug = match[3].replace(/-/g, " ");
            console.log(`  \x1b[36m${date} ${time}\x1b[0m  ${slug.slice(0, 50).padEnd(52)} \x1b[2m${sizeKB}KB\x1b[0m`);
          } else {
            console.log(`  ${f}  \x1b[2m${sizeKB}KB\x1b[0m`);
          }
        } catch {
          console.log(`  ${f}`);
        }
      }
      console.log(`\n  Load a session: \x1b[1mkcode history --load <filename>\x1b[0m`);
      console.log(`  Continue it:    \x1b[1mkcode --continue\x1b[0m\n`);
    } catch {
      console.log("No session history found.");
    }
  });

// ─── Serve subcommand (HTTP API) ─────────────────────────────────

program
  .command("serve")
  .description("Start KCode as an HTTP API server")
  .option("-p, --port <port>", "Port to listen on", parseInt, 10101)
  .option("-h, --host <host>", "Host to bind to", "127.0.0.1")
  .option("--api-key <key>", "Require this API key for authentication")
  .action(async (opts: { port?: number; host?: string; apiKey?: string }) => {
    const { startHttpServer } = await import("./core/http-server.js");
    process.env.KCODE_VERSION = VERSION;
    await startHttpServer({
      port: opts.port ?? 10101,
      host: opts.host ?? "127.0.0.1",
      apiKey: opts.apiKey,
    });
  });

// ─── Parse ──────────────────────────────────────────────────────

program.parse();

// ─── Main (interactive / single-prompt) ─────────────────────────

async function runMain(
  promptText: string | undefined,
  opts: { model?: string; permission?: string; continue?: boolean; print?: boolean; jsonSchema?: string; thinking?: boolean; worktree?: string; fork?: boolean; theme?: string; sandbox?: string | boolean; voice?: boolean; addDir?: string[]; compactThreshold?: string; noTools?: boolean },
) {
  const cwd = process.cwd();

  // ─── Managed mode (launched by Kulvex WebUI) ──────────────
  // When KCODE_MANAGED=1, an external server (Jarvis) manages the llama-server.
  // Skip wizard, license check, and server auto-start — just connect to KCODE_API_BASE.
  const isManaged = process.env.KCODE_MANAGED === "1";

  if (!isManaged) {
    // Auto-setup on first run — launch the installation wizard
    // The wizard handles license activation and PATH installation
    if (!isSetupComplete()) {
      console.log("\n\x1b[1m\x1b[36mWelcome to KCode!\x1b[0m\x1b[2m Starting first-time setup wizard...\x1b[0m\n");
      try {
        await runSetup();
      } catch (err) {
        console.error(`\x1b[31mSetup failed: ${err instanceof Error ? err.message : err}\x1b[0m`);
        console.error("You can run '\x1b[1mkcode setup\x1b[0m' manually to configure.");
      }
    }

    // ─── License check ─────────────────────────────────────────
    if (!hasLicense()) {
      console.log("\n\x1b[33m⚠  KCode requires a license key to run.\x1b[0m");
      console.log("  Activate with: \x1b[1mkcode activate <license-key>\x1b[0m");
      console.log("  Purchase at:   \x1b[36mhttps://kulvex.ai\x1b[0m\n");
      process.exit(1);
    }

    const licenseCheck = await checkLicense();
    if (!licenseCheck.valid) {
      console.log(`\n\x1b[31m✗  License error: ${licenseCheck.message}\x1b[0m\n`);
      process.exit(1);
    }

    if (licenseCheck.grace) {
      process.stderr.write("\x1b[33m⚠ Offline mode — connect to the internet to re-validate your license\x1b[0m\n");
    }

    // Auto-start llama-server and wait for model to be fully loaded
    if (isSetupComplete()) {
      const serverRunning = await isServerRunning();
      let port: number;

      if (!serverRunning) {
        try {
          process.stderr.write("\x1b[2mStarting inference server...\x1b[0m");
          const result = await startServer();
          port = result.port;
          process.stderr.write(`\r\x1b[2mLoading model into VRAM...\x1b[0m\x1b[K`);
        } catch (err) {
          console.error(`\n\x1b[31m✗ Server start failed: ${err instanceof Error ? err.message : err}\x1b[0m`);
          process.exit(1);
        }
      } else {
        port = getServerPort()!;
      }

      // Wait until model is fully loaded and ready — do NOT proceed without this
      const maxWait = 180_000;
      const start = Date.now();
      let ready = false;
      while (Date.now() - start < maxWait) {
        try {
          const healthResp = await fetch(`http://localhost:${port}/health`, {
            signal: AbortSignal.timeout(3000),
          });
          if (healthResp.ok) {
            const health = await healthResp.json() as any;
            if (health.status === "ok") {
              const modelsResp = await fetch(`http://localhost:${port}/v1/models`, {
                signal: AbortSignal.timeout(3000),
              });
              if (modelsResp.ok) {
                ready = true;
                break;
              }
            }
          }
        } catch { /* not ready yet */ }

        const elapsed = Math.round((Date.now() - start) / 1000);
        if (!serverRunning) {
          process.stderr.write(`\r\x1b[2mLoading model into VRAM... (${elapsed}s)\x1b[0m\x1b[K`);
        }
        await new Promise((r) => setTimeout(r, 500));
      }

      if (ready) {
        if (!serverRunning) {
          process.stderr.write(`\r\x1b[32m✓\x1b[0m Model loaded on port ${port}\x1b[K\n`);
        }
      } else {
        console.error(`\n\x1b[31m✗ Model failed to load within ${maxWait / 1000}s. Check ~/.kcode/server.log\x1b[0m`);
        process.exit(1);
      }
    }
  }

  const config = await buildConfig(cwd);
  config.version = VERSION;
  log.init();

  // Load path-specific rules
  getRulesManager().load(cwd);

  // Load plugins
  getPluginManager().load(cwd);

  // Auto-start LSP language servers (non-blocking)
  const lsp = getLspManager(cwd);
  if (lsp) lsp.autoStart().catch(() => {});

  // Apply CLI overrides
  if (opts.model) {
    config.model = opts.model;
    config.modelExplicitlySet = true;
  }
  if (opts.permission) {
    config.permissionMode = opts.permission as PermissionMode;
  }
  if (opts.jsonSchema) {
    config.jsonSchema = opts.jsonSchema;
  }
  if (opts.thinking) {
    config.thinking = true;
  }
  if (opts.compactThreshold) {
    const pct = parseInt(opts.compactThreshold);
    if (pct >= 50 && pct <= 95) {
      config.compactThreshold = pct / 100;
    } else {
      console.error("Warning: --compact-threshold must be between 50 and 95. Using default (80).");
    }
  }

  // Apply theme from CLI flag, env var, or config
  const themeName = opts.theme ?? process.env.KCODE_THEME ?? config.theme;
  if (themeName) {
    setTheme(themeName);
  }

  // Apply sandbox mode
  if (opts.sandbox) {
    const mode = typeof opts.sandbox === "string" ? opts.sandbox : "light";
    if (mode === "light" || mode === "strict") {
      setSandboxMode(mode);
      process.stderr.write(`\x1b[33m🛡 Sandbox: ${mode}\x1b[0m\n`);
    }
  }

  // Voice input: record and transcribe before starting
  if (opts.voice && !promptText) {
    try {
      const voiceStatus = isVoiceAvailable();
      if (!voiceStatus.available) {
        console.error("\x1b[31mVoice input not available. Install arecord/sox and faster-whisper.\x1b[0m");
      } else {
        const text = await voiceToText();
        if (text) {
          promptText = text;
          console.error(`\x1b[36mVoice:\x1b[0m ${text}`);
        }
      }
    } catch (err) {
      console.error(`\x1b[31mVoice error: ${err instanceof Error ? err.message : err}\x1b[0m`);
    }
  }

  // Create git worktree if --worktree flag is set
  if (opts.worktree) {
    const { execSync } = await import("node:child_process");
    const worktreeName = opts.worktree;
    const worktreePath = `.kcode-worktrees/${worktreeName}`;

    try {
      // Create worktree with a new branch
      execSync(`git worktree add ${worktreePath} -b kcode/${worktreeName} 2>/dev/null || git worktree add ${worktreePath} kcode/${worktreeName}`, { cwd });
      // Change working directory to worktree
      process.chdir(resolve(cwd, worktreePath));
      config.workingDirectory = process.cwd();
      log.info("session", `Working in worktree: ${worktreePath} (branch: kcode/${worktreeName})`);
      console.error(`Working in worktree: ${worktreePath}`);
    } catch (err) {
      console.error(`Failed to create worktree: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  }

  // Additional directories
  if (opts.addDir && opts.addDir.length > 0) {
    const { resolve } = await import("node:path");
    config.additionalDirs = opts.addDir.map((d: string) => resolve(d));
    log.info("session", `Additional directories: ${config.additionalDirs.join(", ")}`);
  }

  // No API key required for local LLMs (llama-server).
  // If ASTROLEXIS_API_KEY is set, it will be sent as a Bearer token.

  // Register tools (empty registry in --no-tools chat mode)
  const tools = opts.noTools
    ? new (await import("./core/tool-registry.js")).ToolRegistry()
    : registerBuiltinTools();

  if (opts.noTools) {
    console.error("\x1b[33mChat-only mode (no tools)\x1b[0m");
  }

  // Create conversation manager
  const conversationManager = new ConversationManager(config, tools);
  log.info("session", `Session started: model=${config.model}, cwd=${cwd}, version=${VERSION}, noTools=${!!opts.noTools}`);

  // Resume previous session if --continue flag is set
  if (opts.continue) {
    const transcript = new TranscriptManager();
    const latestFile = transcript.getLatestSession();
    if (latestFile) {
      const messages = transcript.loadSessionMessages(latestFile);
      if (messages.length > 0) {
        conversationManager.restoreMessages(messages);
        console.error(`Resuming session (${messages.length} messages)`);
        log.info("session", `Resumed session from ${latestFile} with ${messages.length} messages`);
      } else {
        console.error("Warning: Previous session is empty, starting fresh.");
      }
    } else {
      console.error("Warning: No previous session found, starting fresh.");
    }
  }

  // Fork previous session if --fork flag is set (new session with previous history)
  if (opts.fork) {
    const transcript = new TranscriptManager();
    const latestFile = transcript.getLatestSession();
    if (latestFile) {
      const messages = transcript.loadSessionMessages(latestFile);
      if (messages.length > 0) {
        conversationManager.restoreMessages(messages);
        console.error(`Forked session (${messages.length} messages from previous)`);
        log.info("session", `Forked session from ${latestFile} with ${messages.length} messages`);
      }
    }
    // Don't set opts.continue — this starts a NEW transcript file
  }

  // ─── Read piped stdin if available ─────────────────────────

  if (promptText && !process.stdin.isTTY) {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk);
      }
      const stdinContent = Buffer.concat(chunks).toString("utf-8").trim();
      if (stdinContent) {
        promptText = `${promptText}\n\n<stdin>\n${stdinContent}\n</stdin>`;
      }
    } catch { /* no stdin data */ }
  }

  // ─── Route to the appropriate mode ──────────────────────────

  if (promptText && opts.print) {
    // Print mode: output only text, suitable for piping
    const exitCode = await runPrintMode(conversationManager, promptText);
    process.exit(exitCode);
  }

  if (promptText) {
    // Non-interactive mode: run a single prompt with simple console output
    await runNonInteractive(conversationManager, promptText);
    return;
  }

  // Interactive mode: start the Ink-based terminal UI
  const app = startUI({ config, conversationManager, tools });
  await app.waitUntilExit();

  // Layer 10: Save session narrative before exiting
  try {
    const sessionData = conversationManager.collectSessionData();
    if (sessionData.messagesCount > 1) {
      getNarrativeManager().updateNarrative(sessionData);
    }
  } catch { /* ignore */ }

  log.info("session", "Session ended");
  shutdownLsp();
  shutdownMcpManager();
  closeDb();
  log.shutdown();
}

// ─── Non-interactive single-prompt mode ─────────────────────────

async function runNonInteractive(
  conversationManager: ConversationManager,
  prompt: string,
): Promise<void> {
  let hadError = false;

  for await (const event of conversationManager.sendMessage(prompt)) {
    switch (event.type) {
      case "text_delta":
        process.stdout.write(event.text);
        break;

      case "thinking_delta":
        // Show thinking in non-interactive mode (dimmed)
        process.stderr.write(`\x1b[2m${event.thinking}\x1b[0m`);
        break;

      case "tool_use_start":
        process.stderr.write(`\x1b[36m● ${event.name}\x1b[0m\n`);
        break;

      case "tool_result":
        if (event.isError) {
          process.stderr.write(
            `\x1b[31m✗ ${event.name}: ${event.result}\x1b[0m\n`,
          );
        }
        break;

      case "error":
        process.stderr.write(`\x1b[31mError: ${event.error.message}\x1b[0m\n`);
        hadError = true;
        break;

      case "turn_end":
        if (event.stopReason === "error") hadError = true;
        break;
    }
  }

  process.stdout.write("\n");

  if (hadError) {
    process.exit(1);
  }
}
