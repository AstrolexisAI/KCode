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

// Read version from package.json at build time (Bun supports JSON imports)
import pkg from "../package.json";
const VERSION = pkg.version;

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
  .option("--fork", "Fork the last session (new session with previous history)")
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

// ─── Parse ──────────────────────────────────────────────────────

program.parse();

// ─── Main (interactive / single-prompt) ─────────────────────────

async function runMain(
  promptText: string | undefined,
  opts: { model?: string; permission?: string; continue?: boolean; print?: boolean; jsonSchema?: string; thinking?: boolean; worktree?: string; fork?: boolean },
) {
  const cwd = process.cwd();
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

  // No API key required for local LLMs (llama-server).
  // If ASTROLEXIS_API_KEY is set, it will be sent as a Bearer token.

  // Register tools
  const tools = registerBuiltinTools();

  // Create conversation manager
  const conversationManager = new ConversationManager(config, tools);
  log.info("session", `Session started: model=${config.model}, cwd=${cwd}, version=${VERSION}`);

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
