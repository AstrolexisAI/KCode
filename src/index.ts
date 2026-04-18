#!/usr/bin/env bun

// KCode - Main entry point
// AI-powered coding assistant for the terminal by Astrolexis (Kulvex Code)

import { resolve } from "node:path";
import { Command } from "commander";

// Heavy modules — lazy-loaded to reduce cold start time
async function lazyGetConversationManager() {
  const { ConversationManager } = await import("./core/conversation");
  return ConversationManager;
}
async function lazyGetStartUI() {
  const { startUI } = await import("./ui/render");
  return startUI;
}
async function lazyGetRunPrintMode() {
  const { runPrintMode } = await import("./ui/print-mode");
  return runPrintMode;
}

import { buildConfig } from "./core/config";
import { getServerPort, isServerRunning, startServer } from "./core/llama-server";
import { log } from "./core/logger";
import { isSetupComplete } from "./core/model-manager";
import { startPrefetch } from "./core/prefetch";
import { isProfilingEnabled, printProfileReport, profileCheckpoint } from "./core/startup-profiler";
import { setTheme } from "./core/theme";
import { TranscriptManager } from "./core/transcript";
import type { PermissionMode } from "./core/types";
import { clearSudoPasswordCache, setSandboxMode } from "./tools/bash";

// Lazy-loaded modules (deferred until needed)
async function lazyGetRulesManager() {
  const { getRulesManager } = await import("./core/rules");
  return getRulesManager();
}
async function lazyGetPluginManager() {
  const { getPluginManager } = await import("./core/plugins");
  return getPluginManager();
}
async function lazyGetLspManager(cwd: string) {
  const { getLspManager } = await import("./core/lsp");
  return getLspManager(cwd);
}
async function lazyRegisterBuiltinTools() {
  const { registerBuiltinTools } = await import("./tools");
  return registerBuiltinTools();
}
async function lazyCloseDb() {
  const { closeDb } = await import("./core/db");
  closeDb();
}
async function lazyShutdownMcpManager() {
  const { shutdownMcpManager } = await import("./core/mcp");
  shutdownMcpManager();
}
async function lazyShutdownLsp() {
  const { shutdownLsp } = await import("./core/lsp");
  shutdownLsp();
}
async function lazyVoiceToText() {
  const { voiceToText } = await import("./core/voice");
  return voiceToText();
}
async function lazyIsVoiceAvailable() {
  const { isVoiceAvailable } = await import("./core/voice");
  return isVoiceAvailable();
}

// Version — read from package.json at build time via Bun's JSON import
import pkg from "../package.json";
// CLI subcommand registrations
import {
  registerAuditCommand,
  registerAuthCommand,
  registerBenchmarkCommands,
  registerCloudCommand,
  registerCompletionsCommand,
  registerDaemonCommand,
  registerDashboardCommand,
  registerDistillCommand,
  registerDoctorCommand,
  registerHistoryCommand,
  registerInitCommand,
  registerLicenseCommand,
  registerMcpCommand,
  registerMeshCommand,
  registerModelsCommand,
  registerNewCommand,
  registerPluginCommand,
  registerProCommands,
  registerRemoteCommand,
  registerResumeCommand,
  registerSearchCommand,
  registerServeCommand,
  registerServerCommand,
  registerSessionsCommand,
  registerSetupCommand,
  registerStatsCommand,
  registerTeachCommand,
  registerTemplateCommand,
  registerTriggersCommand,
  registerUpdateCommand,
  registerWatchCommand,
  registerWebCommand,
} from "./cli/commands";

const VERSION = pkg.version;

/** On Windows, pause before exit so the user can read error messages (console closes on exit).
 *  Also writes error to a crash log file for diagnostics. */
async function exitWithPause(code: number, errorMsg?: string): Promise<never> {
  // Write crash log on Windows so users can report the issue even if the console closes
  if (process.platform === "win32" && code !== 0) {
    try {
      const crashLog = require("node:path").join(
        require("node:os").homedir(),
        ".kcode",
        "crash.log",
      );
      require("node:fs").mkdirSync(require("node:path").dirname(crashLog), { recursive: true });
      require("node:fs").appendFileSync(
        crashLog,
        `[${new Date().toISOString()}] Exit code ${code}${errorMsg ? `: ${errorMsg}` : ""}\n`,
      );
    } catch (err) {
      log.debug("index", `Failed to write crash log: ${err}`);
    }
  }

  if (process.platform === "win32") {
    // Always pause on Windows — isTTY may be unreliable in compiled binaries
    console.log("\n\x1b[2mPress Enter to exit...\x1b[0m");
    try {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 60_000); // auto-close after 60s
        try {
          process.stdin.resume();
          process.stdin.once("data", () => {
            clearTimeout(timer);
            resolve();
          });
        } catch (err) {
          log.debug("index", `Failed to resume stdin for pause: ${err}`);
          resolve();
        }
      });
    } catch (err) {
      log.debug("index", `Stdin pause error: ${err}`);
    }
  }
  process.exit(code);
}

// Prevent unhandled errors from background child processes from crashing kcode.
// Only exit on truly fatal errors — background I/O errors (ENXIO, ECONNREFUSED, etc.)
// from child processes or system sockets should be logged but not kill the TUI.
process.on("uncaughtException", (err) => {
  const msg = err.message ?? String(err);
  const code = (err as NodeJS.ErrnoException).code ?? msg.match(/^(E[A-Z]+):/)?.[1]; // fallback: extract code from message (Bun compat)

  // Non-fatal system errors from background I/O — log and continue
  const nonFatalCodes = new Set([
    "ENXIO",
    "ECONNREFUSED",
    "ECONNRESET",
    "EPIPE",
    "ENOENT",
    "ETIMEDOUT",
    "EACCES",
    "ENODEV",
    "EISDIR",
    "EMFILE",
    "ENFILE",
    "ENOSPC",
    "EROFS",
    "ENOTCONN",
    "EHOSTUNREACH",
    "ENETUNREACH",
  ]);
  if (code && nonFatalCodes.has(code)) {
    log.error("process", `Non-fatal uncaught exception (${code}): ${msg}`);
    return; // Don't exit
  }

  // Fatal errors — log to stderr synchronously and exit
  const crashMsg = err.stack ?? msg;
  process.stderr.write(`\n[KCode CRASH] ${crashMsg}\n`);
  log.error("process", `Uncaught exception: ${msg}`);
  log.shutdown();

  // On Windows, write crash log and pause so user can read the error
  if (process.platform === "win32") {
    try {
      const crashLog = require("node:path").join(
        require("node:os").homedir(),
        ".kcode",
        "crash.log",
      );
      require("node:fs").mkdirSync(require("node:path").dirname(crashLog), { recursive: true });
      require("node:fs").appendFileSync(
        crashLog,
        `[${new Date().toISOString()}] CRASH: ${crashMsg}\n`,
      );
      process.stderr.write(`\nCrash log saved to: ${crashLog}\n`);
      process.stderr.write("Press Enter to exit...\n");
      // Sync read — can't use async in uncaughtException handler
      try {
        require("node:fs").readSync(0, Buffer.alloc(1));
      } catch (err) {
        log.debug("index", `Sync stdin read for pause failed: ${err}`);
      }
    } catch (err) {
      log.debug("index", `Failed to write crash log on uncaught exception: ${err}`);
    }
  }
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : undefined;
  log.error("process", `Unhandled rejection: ${msg}`);

  // On Windows, write crash log for unhandled promise rejections too
  if (process.platform === "win32") {
    try {
      const crashLog = require("node:path").join(
        require("node:os").homedir(),
        ".kcode",
        "crash.log",
      );
      require("node:fs").mkdirSync(require("node:path").dirname(crashLog), { recursive: true });
      require("node:fs").appendFileSync(
        crashLog,
        `[${new Date().toISOString()}] UNHANDLED REJECTION: ${stack ?? msg}\n`,
      );
    } catch (err) {
      log.debug("index", `Failed to write crash log on unhandled rejection: ${err}`);
    }
  }
});

// Graceful cleanup on signals
function cleanupAndExit() {
  clearSudoPasswordCache();
  lazyShutdownLsp().catch((e) => {
    log.debug("shutdown", `LSP shutdown error: ${e}`);
  });
  lazyShutdownMcpManager().catch((e) => {
    log.debug("shutdown", `MCP manager shutdown error: ${e}`);
  });
  lazyCloseDb().catch((e) => {
    log.debug("shutdown", `DB close error: ${e}`);
  });
  log.shutdown();
  process.exit(0);
}

process.on("SIGINT", cleanupAndExit);
process.on("SIGTERM", cleanupAndExit);

// ─── CLI Setup ──────────────────────────────────────────────────

profileCheckpoint("process_start");

// Start prefetching credentials and config in parallel (non-blocking)
startPrefetch();

// Non-blocking background update check (prints one-line notice if new version available)
import("./core/update-notifier")
  .then((m) => m.maybeNotifyUpdate(VERSION))
  .catch((e) => {
    log.debug("update", `Update notifier failed: ${e}`);
  });

// Non-blocking license health banner. Runs only when a license.jwt
// is actually present — we don't want to nag free-tier users who
// never had a license. If the file exists but fails to verify
// (expired / wrong signature / hardware mismatch / revoked), we
// surface the actionable fix list once at startup instead of
// hard-failing later when the user tries to use a Pro feature.
//
// Suppressed when the user is already running a license subcommand
// (`kcode license ...`) — those commands print the guide themselves
// as part of their output, so the banner would be a duplicate.
// Also suppressed for `--version` / `--help` / raw subcommand
// queries that want clean stdout, and during piped/non-TTY runs
// that should stay machine-readable.
const _firstArg = process.argv[2];
const _licenseBannerSuppressed =
  _firstArg === "license" ||
  _firstArg === "-v" ||
  _firstArg === "--version" ||
  _firstArg === "-h" ||
  _firstArg === "--help" ||
  !process.stderr.isTTY;
if (!_licenseBannerSuppressed) {
  import("./core/license")
    .then(({ loadLicenseFile, checkOfflineLicense, formatLicenseFailureGuide }) => {
      // Cheap short-circuit: no file → nothing to warn about.
      if (!loadLicenseFile()) return;
      const result = checkOfflineLicense();
      if (result.valid) return;
      process.stderr.write(
        "\n" + formatLicenseFailureGuide(result.error ?? "License invalid") + "\n\n",
      );
    })
    .catch((e) => {
      log.debug("license", `Startup license banner failed: ${e}`);
    });
}

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
  .option(
    "--json-schema <schema>",
    "Validate output against JSON schema (inline JSON or file path)",
  )
  .option("--thinking", "Enable extended thinking mode")
  .option("--reasoning-budget <tokens>", "Thinking token budget (-1 = unlimited)")
  .option("--no-cache", "Disable response cache (always call the model)")
  .option("--worktree <name>", "Create and work in an isolated git worktree")
  .option("--theme <name>", "Set color theme (e.g. dracula, monokai, nord)")
  .option("--fork", "Fork the last session (new session with previous history)")
  .option("--sandbox [mode]", "Run bash commands in a sandbox (light or strict)")
  .option("--voice", "Enable voice input (record from microphone)")
  .option("--add-dir <dirs...>", "Add additional working directories")
  .option(
    "--compact-threshold <pct>",
    "Auto-compact threshold as percentage of context window (50-95, default 80)",
  )
  .option("--no-tools", "Chat-only mode without tool calling")
  .option("--fallback-model <model>", "Auto-switch to this model if primary fails")
  .option("--max-budget-usd <amount>", "Max spend per session in USD")
  .option("--output-format <format>", "Output format: text, json, stream-json (print mode only)")
  .option("--effort <level>", "Reasoning effort level (low, medium, high, max)")
  .option("--system-prompt <prompt>", "Override the system prompt entirely")
  .option("--append-system-prompt <text>", "Append text to the system prompt")
  .option("-n, --name <name>", "Name for this session")
  .option("--from-pr <number>", "Resume or start a session linked to a GitHub PR (number or URL)")
  .option("--allowed-tools <tools>", "Comma-separated list of allowed tool names")
  .option("--disallowed-tools <tools>", "Comma-separated list of blocked tool names")
  .option("--session-id <id>", "Use a specific session ID instead of generating one")
  .option("--agent <name>", "Use a named agent definition")
  .option("--no-session-persistence", "Do not save session transcript to disk")
  .option("--mcp-config <path>", "Load MCP server configuration from a JSON file")
  .option("--agents <json>", "Inline agent definitions as JSON array")
  .option("--tmux", "Open worktree agents in separate tmux panes")
  .option("--profile <name>", "Use an execution profile (safe, fast, review, implement, ops)")
  .option("--file <url>", "Download a file (URL or local path) and add to context at startup")
  .option("--debug", "Enable agent debug tracing (shows decision reasoning)")
  .option("--offline", "Force offline mode (block all remote network requests)")
  .option("--lang <locale>", "Set UI language (en, es, fr, de, ja, ko, pt, zh)")
  .option("--startup-profile", "Show startup profiling breakdown (timing, memory, modules)")
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
    const promptText = prompt ? (args.length > 1 ? args.join(" ") : prompt) : undefined;

    await runMain(promptText, options);
  });

// ─── Register subcommands ────────────────────────────────────────

registerAuthCommand(program);
registerModelsCommand(program);
registerPluginCommand(program);
registerMcpCommand(program);
registerServerCommand(program);
registerProCommands(program);
registerSetupCommand(program, exitWithPause);
registerAuditCommand(program);
registerDoctorCommand(program);
registerTeachCommand(program);
registerStatsCommand(program);
registerInitCommand(program);
registerLicenseCommand(program);
registerNewCommand(program);
registerResumeCommand(program);
registerSearchCommand(program);
registerWatchCommand(program);
registerUpdateCommand(program, VERSION);
registerBenchmarkCommands(program);
registerCompletionsCommand(program);
registerHistoryCommand(program);
registerServeCommand(program, VERSION);
registerRemoteCommand(program);
registerDaemonCommand(program);
registerMeshCommand(program);
registerDistillCommand(program);
registerCloudCommand(program);
registerTriggersCommand(program);
registerSessionsCommand(program);
registerDashboardCommand(program);
registerTemplateCommand(program);
registerWebCommand(program);

// Note: model auto-discovery now lives in src/ui/App.tsx (fires at
// TUI mount with a throttle) instead of here, so non-TUI CLI
// subcommands (kcode build, kcode status, etc.) don't make API
// calls they don't need.

// ─── Parse ──────────────────────────────────────────────────────

profileCheckpoint("cli_defined");
program.parse();

// ─── Main (interactive / single-prompt) ─────────────────────────

async function runMain(
  promptText: string | undefined,
  opts: {
    model?: string;
    permission?: string;
    continue?: boolean;
    print?: boolean;
    jsonSchema?: string;
    thinking?: boolean;
    noCache?: boolean;
    reasoningBudget?: string;
    worktree?: string;
    fork?: boolean;
    theme?: string;
    sandbox?: string | boolean;
    voice?: boolean;
    addDir?: string[];
    compactThreshold?: string;
    noTools?: boolean;
    fallbackModel?: string;
    maxBudgetUsd?: string;
    outputFormat?: string;
    effort?: string;
    systemPrompt?: string;
    appendSystemPrompt?: string;
    name?: string;
    fromPr?: string;
    allowedTools?: string;
    disallowedTools?: string;
    sessionId?: string;
    agent?: string;
    sessionPersistence?: boolean;
    mcpConfig?: string;
    agents?: string;
    tmux?: boolean;
    profile?: string;
    file?: string;
    debug?: boolean;
    offline?: boolean;
    lang?: string;
    startupProfile?: boolean;
  },
) {
  const cwd = process.cwd();

  // Activate startup profiling if --startup-profile flag is set
  if (opts.startupProfile) {
    process.env.KCODE_PROFILE_STARTUP = "1";
    const { _resetProfiler } = await import("./core/startup-profiler");
    _resetProfiler(); // Re-create profiler with enabled=true
    profileCheckpoint("process_start"); // Re-record since profiler was just enabled
  }

  // ─── i18n initialization ──────────────────────────────────
  // Initialize early so all subsequent messages can use t()
  {
    const { initI18n } = await import("./i18n");
    const config = await buildConfig(cwd);
    // CLI flag > config setting > env var > auto-detect
    initI18n(opts.lang ?? config.language);
  }

  // ─── Managed mode (launched by Kulvex WebUI) ──────────────
  // When KCODE_MANAGED=1, an external server (Jarvis) manages the llama-server.
  // Skip wizard and server auto-start — just connect to KCODE_API_BASE.
  const isManaged = process.env.KCODE_MANAGED === "1";

  // ─── Offline mode initialization ─────────────────────────
  {
    const { initOfflineMode } = await import("./core/offline/mode");
    const config = await buildConfig(cwd);
    const offlineInstance = initOfflineMode({
      settings: config.offline,
      forced: !!opts.offline,
    });
    // Auto-detect connectivity if not forced and autoDetect is not disabled
    if (!opts.offline && config.offline?.autoDetect !== false) {
      await offlineInstance.checkConnectivity();
    }
    if (offlineInstance.isActive()) {
      log.info("index", "Running in offline mode");
    }
  }

  if (!isManaged) {
    // Auto-setup on first run — launch the installation wizard
    // The wizard handles PATH installation and model setup
    if (!isSetupComplete()) {
      console.log(
        "\n\x1b[1m\x1b[36mWelcome to KCode!\x1b[0m\x1b[2m Starting first-time setup wizard...\x1b[0m\n",
      );
      try {
        const { runSetup } = await import("./core/model-manager");
        await runSetup();
      } catch (err) {
        console.error(`\x1b[31mSetup failed: ${err instanceof Error ? err.message : err}\x1b[0m`);
        console.error("You can run '\x1b[1mkcode setup\x1b[0m' manually to configure.");
        if (err instanceof Error && err.stack) {
          log.error("setup", err.stack);
        }
        await exitWithPause(1, `Setup failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    // ── Smart startup: detect local/cloud capability ──
    profileCheckpoint("server_check");
    if (isSetupComplete()) {
      const { resolveStartup, checkCloudProviders } = await import("./core/startup-resolver");
      const startup = await resolveStartup();

      if (startup.needsPrompt && startup.mode === "none" && !startup.message.includes("Choose")) {
        // No local, no cloud — guide to setup
        const providers = checkCloudProviders();
        console.log(`\n\x1b[33m⚠ ${startup.message}\x1b[0m\n`);
        console.log("  Available cloud providers:");
        for (const p of providers) {
          console.log(`    ${p.configured ? "\x1b[32m✓\x1b[0m" : "\x1b[2m○\x1b[0m"} ${p.name} ${p.configured ? "(configured)" : `(set ${p.envVar})`}`);
        }
        console.log(`\n  Run \x1b[1mkcode setup\x1b[0m or \x1b[1m/cloud\x1b[0m inside KCode to configure.\n`);
        // Don't exit — let it fall through to setup wizard or TUI
      } else if (startup.mode === "cloud" && startup.message) {
        process.stderr.write(`\x1b[36mℹ\x1b[0m ${startup.message}\n`);
      }

      // Check if the selected model has a registered baseUrl (external server).
      //
      // modelName resolution: CLI flag → env → registry default. The
      // third fallback matters: when the user ran `kcode setup`,
      // picked Anthropic, and the wizard set claude-sonnet-4-6 as
      // the default in models.json, we MUST read that default here
      // — otherwise modelName is "" and the detection below fails,
      // causing llama-server.ts to throw "Server not configured"
      // even though cloud is perfectly set up.
      let externalServerUrl: string | null = null;
      try {
        const { getModelBaseUrl, getModelProvider, getDefaultModel } = await import(
          "./core/models"
        );
        const modelName =
          opts.model || process.env.KCODE_MODEL || (await getDefaultModel()) || "";
        const modelBase = await getModelBaseUrl(modelName);
        const provider = await getModelProvider(modelName);
        // If the model has a non-default baseUrl or a non-openai provider, it's external
        if (provider === "anthropic" || (modelBase && !modelBase.includes("localhost:10091"))) {
          externalServerUrl = modelBase;
        }
      } catch {
        /* fallback to normal server management */
      }

      // Resolver said cloud but we didn't find an external URL?
      // Could be an unregistered model or a misconfigured registry.
      // Either way, do NOT try to start a local llama-server — it
      // would throw "Server not configured" and crash the user right
      // after a successful `kcode setup`. Skip the whole reachability
      // check and let the TUI boot; the conversation layer picks the
      // right cloud endpoint from the provider config / API key it
      // already has in settings.json.
      const skipServerCheck = !externalServerUrl && startup.mode === "cloud";

      if (skipServerCheck) {
        // Cloud mode with no registered base URL yet. Conversation
        // layer will route requests via the provider in the config
        // directly. Nothing to wait for; boot the TUI.
        profileCheckpoint("server_ready");
        process.stderr.write(
          `\x1b[32m✓\x1b[0m Cloud mode — requests route directly to the configured provider\x1b[K\n`,
        );
      } else if (externalServerUrl) {
        // External server: just check it's reachable, don't try to start llama.cpp
        const maxWait = 15_000;
        const start = Date.now();
        let ready = false;
        const healthEndpoints = ["/ready", "/health", "/v1/models"];
        while (Date.now() - start < maxWait) {
          for (const endpoint of healthEndpoints) {
            try {
              const resp = await fetch(`${externalServerUrl}${endpoint}`, {
                signal: AbortSignal.timeout(2000),
              });
              // Any HTTP response means the server is reachable — even
              // 401/403/404. Cloud providers (Anthropic, OpenAI) require
              // auth on /v1/models so they return 401, and their root /
              // returns 404. Only a true network failure (timeout,
              // ECONNREFUSED) means "not reachable". The original
              // resp.ok check flagged Anthropic as unreachable despite
              // the API being perfectly up.
              if (resp.status < 500) {
                ready = true;
                break;
              }
            } catch {
              /* retry */
            }
          }
          if (ready) break;
          await new Promise((r) => setTimeout(r, 500));
        }
        if (ready) {
          profileCheckpoint("server_ready");
          process.stderr.write(`\x1b[32m✓\x1b[0m Model loaded on ${externalServerUrl}\x1b[K\n`);
        } else {
          console.error(`\x1b[31m✗ External server not reachable: ${externalServerUrl}\x1b[0m`);
          console.error(`  Make sure your inference server is running.`);
          await exitWithPause(1, `External server not reachable: ${externalServerUrl}`);
        }
      } else {
        // Local llama.cpp server management
        const serverRunning = await isServerRunning();
        let port: number = 0;

        if (!serverRunning) {
          try {
            process.stderr.write("\x1b[2mStarting inference server...\x1b[0m");
            const result = await startServer();
            port = result.port;
            process.stderr.write(`\r\x1b[2mLoading model into VRAM...\x1b[0m\x1b[K`);
          } catch (err) {
            console.error(
              `\n\x1b[31m✗ Server start failed: ${err instanceof Error ? err.message : err}\x1b[0m`,
            );
            await exitWithPause(
              1,
              `Server start failed: ${err instanceof Error ? err.message : err}`,
            );
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
              const health = (await healthResp.json()) as Record<string, unknown>;
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
          } catch (err) {
            log.debug("index", `Server health check not ready yet: ${err}`);
          }

          const elapsed = Math.round((Date.now() - start) / 1000);
          if (!serverRunning) {
            process.stderr.write(`\r\x1b[2mLoading model into VRAM... (${elapsed}s)\x1b[0m\x1b[K`);
          }
          await new Promise((r) => setTimeout(r, 500));
        }

        if (ready) {
          profileCheckpoint("server_ready");
          if (!serverRunning) {
            process.stderr.write(`\r\x1b[32m✓\x1b[0m Model loaded on port ${port}\x1b[K\n`);
          }
        } else {
          // Model failed to load — suggest cloud fallback
          console.error(
            `\n\x1b[31m✗ Model failed to load within ${maxWait / 1000}s.\x1b[0m`,
          );
          console.error(`  Check: \x1b[2m~/.kcode/server.log\x1b[0m`);
          console.error(`\n  \x1b[33mTip:\x1b[0m If your hardware can't run local models, use cloud inference:`);
          console.error(`  Run \x1b[1mkcode setup\x1b[0m or use \x1b[1m/cloud\x1b[0m to configure Anthropic, OpenAI, or other providers.\n`);
          process.exit(1);
        }
      } // close else (local llama.cpp server management)
    }
  }

  // ─── Workspace trust prompt ──────────────────────────────────
  // If the workspace has .kcode/ config but isn't trusted, prompt the user
  // before loading anything from it (VS Code-style workspace trust).
  {
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { isWorkspaceTrusted, trustWorkspace } = await import("./core/hook-trust");
    const kcodeDir = join(cwd, ".kcode");
    if (existsSync(kcodeDir) && !isWorkspaceTrusted(cwd)) {
      const isTTY = process.stdin.isTTY && process.stdout.isTTY;
      if (isTTY) {
        process.stderr.write(
          `\n\x1b[33m⚠ This workspace has a .kcode/ directory with project-specific config.\x1b[0m\n`,
        );
        process.stderr.write(`  Path: ${kcodeDir}\n`);
        process.stderr.write(
          `  Trusting a workspace allows it to run hooks, MCP servers, and plugins.\n\n`,
        );
        process.stderr.write(`  \x1b[1mDo you trust this workspace? (y/N)\x1b[0m `);

        const answer = await new Promise<string>((resolve) => {
          const onData = (data: Buffer) => {
            process.stdin.removeListener("data", onData);
            process.stdin.setRawMode?.(false);
            resolve(data.toString().trim().toLowerCase());
          };
          process.stdin.setRawMode?.(true);
          process.stdin.resume();
          process.stdin.once("data", onData);
        });

        if (answer === "y" || answer === "yes" || answer === "s" || answer === "si") {
          trustWorkspace(cwd);
          process.stderr.write(`\x1b[32m✓\x1b[0m Workspace trusted.\n\n`);
        } else {
          process.stderr.write(
            `\x1b[2m  Skipping .kcode/ config. Run \`kcode init --trust\` to trust later.\x1b[0m\n\n`,
          );
        }
      }
    }
  }

  profileCheckpoint("config_loading");
  const config = await buildConfig(cwd);
  config.version = VERSION;
  log.init();
  profileCheckpoint("config_loaded");

  // Load path-specific rules (lazy)
  const rulesManager = await lazyGetRulesManager();
  rulesManager.load(cwd);

  // Load plugins (lazy)
  const pluginManager = await lazyGetPluginManager();
  pluginManager.load(cwd);
  profileCheckpoint("plugins_loaded");

  // Auto-start LSP language servers (non-blocking, lazy)
  const lsp = await lazyGetLspManager(cwd);
  if (lsp)
    lsp.autoStart().catch((e) => {
      log.debug("lsp", `LSP auto-start error: ${e}`);
    });

  // Apply execution profile (before CLI overrides, so flags can override profile settings)
  if (opts.profile) {
    const { getProfile, applyProfile } = await import("./core/profiles");
    const profile = getProfile(opts.profile);
    if (profile) {
      applyProfile(config, profile);
      console.error(
        `\x1b[36mProfile: ${profile.icon} ${profile.name}\x1b[0m — ${profile.description}`,
      );
    } else {
      const { listProfiles } = await import("./core/profiles");
      const available = listProfiles()
        .map((p) => p.name)
        .join(", ");
      console.error(
        `\x1b[33mWarning: unknown profile "${opts.profile}". Available: ${available}\x1b[0m`,
      );
    }
  }

  // Apply CLI overrides (respecting managed policy)
  if (opts.model) {
    const { loadManagedPolicy, isModelAllowedByPolicy } = await import("./core/config");
    const policy = await loadManagedPolicy();
    if (isModelAllowedByPolicy(opts.model, policy)) {
      config.model = opts.model;
      config.modelExplicitlySet = true;
      // Re-resolve apiBase for the selected model (may differ from default)
      const { loadModelsConfig, getModelBaseUrl: resolveBase } = await import("./core/models");
      const modelsConfig = await loadModelsConfig();
      const registered = modelsConfig.models.find((m) => m.name === opts.model);
      if (registered) {
        config.apiBase = await resolveBase(opts.model, config.apiBase);
      } else {
        console.error(
          `\x1b[33mWarning: model "${opts.model}" is not registered. Use 'kcode models add' to register it. Falling back to ${process.env.KCODE_API_BASE ?? "http://localhost:10091"}.\x1b[0m`,
        );
      }
    } else {
      console.error(
        `\x1b[33mWarning: model "${opts.model}" is blocked by managed policy. Using "${config.model}" instead.\x1b[0m`,
      );
    }
  }
  if (opts.permission) {
    // Check if managed policy forces a permission mode
    const { loadManagedPolicy } = await import("./core/config");
    const policy = await loadManagedPolicy();
    if (policy.permissionMode) {
      console.error(
        `\x1b[33mWarning: permission mode is locked to "${policy.permissionMode}" by managed policy.\x1b[0m`,
      );
    } else {
      config.permissionMode = opts.permission as PermissionMode;
    }
  }
  if (opts.jsonSchema) {
    config.jsonSchema = opts.jsonSchema;
  }
  if (opts.thinking) {
    config.thinking = true;
  }
  if (opts.noCache) {
    config.noCache = true;
  }
  if (opts.reasoningBudget !== undefined) {
    const budget = parseInt(opts.reasoningBudget);
    if (!isNaN(budget)) {
      config.reasoningBudget = budget;
    }
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

  // Apply fallback model
  if (opts.fallbackModel) {
    config.fallbackModel = opts.fallbackModel;
  }

  // Apply budget limit
  if (opts.maxBudgetUsd) {
    const budget = parseFloat(opts.maxBudgetUsd);
    if (budget > 0 && isFinite(budget)) {
      config.maxBudgetUsd = budget;
    } else {
      console.error("Warning: --max-budget-usd must be a positive number. Ignoring.");
    }
  }

  // Apply output format
  if (opts.outputFormat) {
    const valid = ["text", "json", "stream-json"];
    if (valid.includes(opts.outputFormat)) {
      config.outputFormat = opts.outputFormat as "text" | "json" | "stream-json";
    } else {
      console.error(`Warning: --output-format must be one of: ${valid.join(", ")}. Using text.`);
    }
  }

  // Apply effort level
  if (opts.effort) {
    const validEffort = ["low", "medium", "high", "max"];
    if (validEffort.includes(opts.effort)) {
      config.effortLevel = opts.effort as "low" | "medium" | "high" | "max";
    } else {
      console.error(`Warning: --effort must be one of: ${validEffort.join(", ")}. Using default.`);
    }
  }

  // Apply system prompt override
  if (opts.systemPrompt) {
    config.systemPromptOverride = opts.systemPrompt;
    // When both --system-prompt and --append-system-prompt are set,
    // append the extra text to the override so it is not silently dropped.
    if (opts.appendSystemPrompt) {
      config.systemPromptOverride += "\n\n" + opts.appendSystemPrompt;
    }
  } else if (opts.appendSystemPrompt) {
    // Apply system prompt append (only when there's no override)
    config.systemPromptAppend = opts.appendSystemPrompt;
  }

  // Apply session name
  if (opts.name) {
    config.sessionName = opts.name;
  }

  // Apply sandbox mode
  if (opts.sandbox) {
    const mode = typeof opts.sandbox === "string" ? opts.sandbox : "light";
    if (mode === "light" || mode === "strict") {
      setSandboxMode(mode);
      process.stderr.write(`\x1b[33m🛡 Sandbox: ${mode}\x1b[0m\n`);
    }
  }

  // Apply allowed/disallowed tools
  if (opts.allowedTools) {
    config.allowedTools = opts.allowedTools
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean);
  }
  if (opts.disallowedTools) {
    config.disallowedTools = opts.disallowedTools
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean);
  }

  // Validate and apply session ID
  if (opts.sessionId) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(opts.sessionId)) {
      console.error(
        "Error: --session-id must be a valid UUID (e.g. 550e8400-e29b-41d4-a716-446655440000)",
      );
      process.exit(1);
    }
  }

  // Apply --agent: load a named agent definition
  if (opts.agent) {
    const { findCustomAgent } = await import("./core/custom-agents");
    const agentDef = findCustomAgent(opts.agent, cwd);
    if (!agentDef) {
      console.error(
        `Error: Agent '${opts.agent}' not found. Place agent definitions in ~/.kcode/agents/${opts.agent}.md or .kcode/agents/${opts.agent}.md`,
      );
      process.exit(1);
    }
    if (agentDef.model) {
      config.model = agentDef.model;
      config.modelExplicitlySet = true;
    }
    if (agentDef.systemPrompt) {
      config.systemPromptOverride = agentDef.systemPrompt;
    }
    if (agentDef.tools && config.allowedTools) {
      // Intersect: only allow tools that are in BOTH the CLI --allowed-tools and agent's tools
      config.allowedTools = config.allowedTools.filter((t: string) => agentDef.tools!.includes(t));
    } else if (agentDef.tools) {
      config.allowedTools = agentDef.tools;
    }
    if (agentDef.permissionMode) {
      const validPerms = ["ask", "auto", "plan", "deny", "acceptEdits"];
      if (validPerms.includes(agentDef.permissionMode)) {
        config.permissionMode = agentDef.permissionMode as import("./core/types").PermissionMode;
      } else {
        console.error(
          `Warning: Agent '${agentDef.name}' has invalid permissionMode '${agentDef.permissionMode}'. Ignoring.`,
        );
      }
    }
    log.info("session", `Using agent '${agentDef.name}' from ${agentDef.sourcePath}`);
    console.error(`Using agent: ${agentDef.name}`);
  }

  // Apply --no-session-persistence
  if (opts.sessionPersistence === false) {
    config.noSessionPersistence = true;
  }

  // Initialize telemetry state from config
  if (config.telemetry !== undefined) {
    const { setTelemetryEnabled } = await import("./core/analytics");
    setTelemetryEnabled(config.telemetry);
  }

  // Voice input: record and transcribe before starting (lazy)
  if (opts.voice && !promptText) {
    try {
      const voiceStatus = await lazyIsVoiceAvailable();
      if (!voiceStatus.available) {
        console.error(
          "\x1b[31mVoice input not available. Install arecord/sox and faster-whisper.\x1b[0m",
        );
      } else {
        const text = await lazyVoiceToText();
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
    const { execFileSync } = await import("node:child_process");
    const worktreeName = opts.worktree.replace(/[^a-zA-Z0-9_\-./]/g, ""); // sanitize
    const worktreePath = `.kcode-worktrees/${worktreeName}`;

    try {
      // Create worktree with a new branch (using execFileSync to prevent shell injection)
      try {
        execFileSync("git", ["worktree", "add", worktreePath, "-b", `kcode/${worktreeName}`], {
          cwd,
          stdio: "pipe",
        });
      } catch (err) {
        log.debug(
          "index",
          `Worktree creation with new branch failed, trying existing branch: ${err}`,
        );
        execFileSync("git", ["worktree", "add", worktreePath, `kcode/${worktreeName}`], {
          cwd,
          stdio: "pipe",
        });
      }
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

  // Register tools (empty registry in --no-tools chat mode, lazy-loaded)
  profileCheckpoint("tools_registering");
  const tools = opts.noTools
    ? new (await import("./core/tool-registry.js")).ToolRegistry()
    : await lazyRegisterBuiltinTools();
  profileCheckpoint("tools_registered");

  if (opts.noTools) {
    console.error("\x1b[33mChat-only mode (no tools)\x1b[0m");
  }

  // Load MCP servers from --mcp-config JSON file
  profileCheckpoint("mcp_loading");
  if (opts.mcpConfig) {
    try {
      const mcpConfigPath = resolve(opts.mcpConfig);
      const file = Bun.file(mcpConfigPath);
      if (!(await file.exists())) {
        console.error(`Error: MCP config file not found: ${mcpConfigPath}`);
        process.exit(1);
      }
      const data = (await file.json()) as Record<string, unknown>;
      if (data?.mcpServers && typeof data.mcpServers === "object") {
        const { getMcpManager } = await import("./core/mcp");
        const manager = getMcpManager();
        await manager.loadFromConfigs(data.mcpServers as import("./core/mcp").McpServersConfig);
        manager.registerTools(tools);
        const serverNames = manager.getServerNames();
        if (serverNames.length > 0) {
          const toolCount = tools
            .getToolNames()
            .filter((n: string) => n.startsWith("mcp__")).length;
          console.error(
            `[MCP] Loaded ${serverNames.length} server(s) from ${mcpConfigPath}, registered ${toolCount} tool(s)`,
          );
        }
      } else {
        console.error(
          `Warning: --mcp-config file has no "mcpServers" key. Expected format: { "mcpServers": { ... } }`,
        );
      }
    } catch (err) {
      console.error(
        `Warning: Failed to load MCP config: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Parse --agents inline JSON definitions
  if (opts.agents) {
    try {
      const agentDefs = JSON.parse(opts.agents) as Array<{
        name: string;
        model?: string;
        systemPrompt?: string;
        tools?: string[];
        maxTurns?: number;
      }>;
      if (!Array.isArray(agentDefs)) {
        console.error("Error: --agents must be a JSON array of agent objects.");
        process.exit(1);
      }
      const { registerInlineAgents } = await import("./core/custom-agents");
      registerInlineAgents(agentDefs);
      console.error(`[Agents] Registered ${agentDefs.length} inline agent definition(s)`);
    } catch (err) {
      if (err instanceof SyntaxError) {
        console.error(`Error: --agents JSON is invalid: ${err.message}`);
        process.exit(1);
      }
      throw err;
    }
  }

  // Store --tmux flag for agent tool to use
  if (opts.tmux) {
    const { setTmuxMode } = await import("./tools/agent");
    setTmuxMode(true);
  }

  // Create conversation manager (lazy-loaded to reduce cold start)
  profileCheckpoint("conversation_init");
  const ConversationManager = await lazyGetConversationManager();
  const conversationManager = new ConversationManager(config, tools);
  profileCheckpoint("conversation_ready");

  // Enable debug tracing if --debug flag is set
  if (opts.debug) {
    const { getDebugTracer } = await import("./core/debug-tracer");
    const tracer = getDebugTracer();
    tracer.enable();
    conversationManager.setDebugTracer(tracer);
    console.error(
      "\x1b[36mDebug tracing enabled. Use /debug trace to view agent decisions.\x1b[0m",
    );
  }

  // Apply explicit session ID if provided
  if (opts.sessionId) {
    conversationManager.setSessionId(opts.sessionId);
  }

  // Wire the undo manager into the Undo tool
  try {
    const { setUndoManager } = await import("./tools/undo.js");
    setUndoManager(conversationManager.getUndo());
  } catch (err) {
    log.debug("index", `Failed to wire undo manager: ${err}`);
  }

  // Wire stash callbacks for conversation context snapshots
  try {
    const { setStashCallbacks } = await import("./tools/stash.js");
    setStashCallbacks(
      () => conversationManager.getState().messages,
      (msgs) => {
        conversationManager.restoreMessages(msgs);
      },
    );
  } catch (err) {
    log.debug("index", `Failed to wire stash callbacks: ${err}`);
  }

  log.info(
    "session",
    `Session started: model=${config.model}, cwd=${cwd}, version=${VERSION}, noTools=${!!opts.noTools}`,
  );

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

  // Resume or start session linked to a GitHub PR if --from-pr is set
  if (opts.fromPr) {
    try {
      // Parse PR number from argument (supports "123", "#123", or full URL)
      const prArg = opts.fromPr.replace(/^#/, "");
      const prMatch = prArg.match(/\/pull\/(\d+)/);
      const prNumber = prMatch ? prMatch[1] : prArg;

      if (!/^\d+$/.test(prNumber!)) {
        console.error(
          `Error: Invalid PR reference "${opts.fromPr}". Use a number, #number, or GitHub PR URL.`,
        );
        process.exit(1);
      }

      // Fetch PR details using gh CLI
      console.error(`Fetching PR #${prNumber} details...`);
      const { execSync } = await import("node:child_process");
      let prData: {
        title: string;
        body: string;
        files: Array<{ path: string }>;
        comments: Array<{ body: string; author: { login: string } }>;
      };
      try {
        const raw = execSync(`gh pr view ${prNumber} --json title,body,files,comments`, {
          encoding: "utf-8",
          timeout: 15_000,
        }).trim();
        prData = JSON.parse(raw);
      } catch (err) {
        console.error(
          `Error: Could not fetch PR #${prNumber}. Make sure 'gh' CLI is installed and authenticated.`,
        );
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      // Search transcript history for sessions related to this PR
      let resumedFromTranscript = false;
      try {
        const transcript = new TranscriptManager();
        const sessions = transcript.listSessions();
        const prSearchTerms = [`PR #${prNumber}`, `#${prNumber}`, prData.title.toLowerCase()];

        for (const session of sessions) {
          // Check if session prompt mentions this PR
          const promptLower = session.prompt.toLowerCase();
          const isRelated = prSearchTerms.some((term) => promptLower.includes(term.toLowerCase()));

          if (isRelated) {
            const messages = transcript.loadSessionMessages(session.filename);
            if (messages.length > 0) {
              conversationManager.restoreMessages(messages);
              console.error(
                `Resumed session linked to PR #${prNumber} (${messages.length} messages from ${session.startedAt})`,
              );
              log.info(
                "session",
                `Resumed PR-linked session from ${session.filename} for PR #${prNumber}`,
              );
              resumedFromTranscript = true;
              break;
            }
          }
        }
      } catch (err) {
        log.debug("index", `Transcript search for PR-linked session failed: ${err}`);
      }

      // If no related session found, inject PR context into the conversation
      if (!resumedFromTranscript) {
        const fileList =
          prData.files?.map((f: { path: string }) => f.path).join("\n  ") ?? "(none)";
        const commentSummary = prData.comments?.length
          ? prData.comments
              .slice(0, 5)
              .map(
                (c: { author: { login: string }; body: string }) =>
                  `  @${c.author.login}: ${c.body.slice(0, 200)}`,
              )
              .join("\n")
          : "(no comments)";

        const prContext = [
          `[PR CONTEXT] Starting session linked to PR #${prNumber}`,
          ``,
          `Title: ${prData.title}`,
          ``,
          `Description:`,
          prData.body?.slice(0, 1500) ?? "(no description)",
          ``,
          `Files changed:`,
          `  ${fileList}`,
          ``,
          `Recent comments:`,
          commentSummary,
        ].join("\n");

        // Inject as a system-like user message so the LLM has PR context
        conversationManager.restoreMessages([
          { role: "user", content: prContext },
          {
            role: "assistant",
            content: [
              {
                type: "text",
                text: `I have the context for PR #${prNumber}: "${prData.title}". I can see the changed files and comments. How can I help with this PR?`,
              },
            ],
          },
        ]);
        console.error(`Started new session with PR #${prNumber} context: "${prData.title}"`);
        log.info("session", `New session with PR #${prNumber} context injected`);
      }
    } catch (err) {
      if (!(err instanceof Error && err.message.includes("process.exit"))) {
        console.error(
          `Warning: --from-pr failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        console.error("Starting session without PR context.");
      } else {
        throw err;
      }
    }
  }

  // ─── Download --file content and inject into context ──────
  if (opts.file) {
    try {
      let fileContent: string;
      const fileArg = opts.file as string;

      if (fileArg.startsWith("http://") || fileArg.startsWith("https://")) {
        // Block private/internal URLs to prevent SSRF
        const url = new URL(fileArg);
        const hostname = url.hostname.toLowerCase();
        if (
          hostname === "localhost" ||
          hostname === "127.0.0.1" ||
          hostname === "::1" ||
          hostname.startsWith("169.254.") ||
          hostname.startsWith("10.") ||
          hostname.startsWith("192.168.") ||
          hostname.match(/^172\.(1[6-9]|2\d|3[01])\./) ||
          hostname === "metadata.google.internal" ||
          hostname.endsWith(".internal")
        ) {
          throw new Error(`Blocked: cannot fetch from private/internal URL: ${fileArg}`);
        }

        // Download from URL
        console.error(`Downloading ${fileArg}...`);
        const resp = await fetch(fileArg, { signal: AbortSignal.timeout(30_000) });
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
        }

        // Size guard: check content-length before reading body
        const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MB
        const contentLength = parseInt(resp.headers.get("content-length") || "0");
        if (contentLength > MAX_FILE_SIZE) {
          throw new Error(`File too large (${contentLength} bytes). Max: ${MAX_FILE_SIZE} bytes.`);
        }

        fileContent = await resp.text();

        // Enforce size limit on actual content (content-length may be absent or wrong)
        if (fileContent.length > MAX_FILE_SIZE) {
          fileContent = fileContent.slice(0, MAX_FILE_SIZE);
          console.error(`Warning: --file content truncated to ${MAX_FILE_SIZE} bytes.`);
        }
      } else {
        // Read local file using Bun.file()
        const filePath = resolve(fileArg);
        const file = Bun.file(filePath);
        if (!(await file.exists())) {
          throw new Error(`File not found: ${filePath}`);
        }
        fileContent = await file.text();
      }

      if (fileContent.trim()) {
        // Inject as context messages in the conversation
        const truncated =
          fileContent.length > 500_000
            ? fileContent.slice(0, 500_000) + "\n\n[... truncated at 500K characters ...]"
            : fileContent;
        conversationManager.restoreMessages([
          ...conversationManager.getState().messages,
          { role: "user", content: `<file source="${fileArg}">\n${truncated}\n</file>` },
          {
            role: "assistant",
            content: [
              {
                type: "text",
                text: `I have the contents of ${fileArg} in context. How can I help?`,
              },
            ],
          },
        ]);
        console.error(
          `Added file to context: ${fileArg} (${fileContent.length.toLocaleString()} chars)`,
        );
        log.info("session", `--file loaded: ${fileArg} (${fileContent.length} chars)`);
      }
    } catch (err) {
      console.error(`Warning: --file failed: ${err instanceof Error ? err.message : String(err)}`);
      console.error("Starting session without file context.");
    }
  }

  // ─── Read piped stdin if available ─────────────────────────

  if (promptText && !process.stdin.isTTY && process.stdin.readable) {
    try {
      // Only read stdin if data is available (don't block on empty pipe)
      const hasData = await Promise.race([
        new Promise<boolean>((resolve) => {
          process.stdin.once("readable", () => resolve(true));
          process.stdin.once("end", () => resolve(false));
          process.stdin.once("error", () => resolve(false));
        }),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
      ]);

      if (hasData) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
          chunks.push(chunk);
        }
        const stdinContent = Buffer.concat(chunks).toString("utf-8").trim();
        if (stdinContent) {
          promptText = `${promptText}\n\n<stdin>\n${stdinContent}\n</stdin>`;
        }
      }
    } catch (err) {
      log.debug("index", `Failed to read piped stdin: ${err}`);
    }
  }

  // ─── Route to the appropriate mode ──────────────────────────

  if (promptText && opts.print) {
    // Print mode: output only text, suitable for piping
    const runPrintMode = await lazyGetRunPrintMode();
    const exitCode = await runPrintMode(
      conversationManager,
      promptText,
      config.outputFormat ?? "text",
    );
    process.exit(exitCode);
  }

  if (promptText) {
    // Non-interactive mode: run a single prompt with simple console output
    await runNonInteractive(conversationManager, promptText);
    return;
  }

  // Start file watcher for codebase index auto-refresh
  let fileWatcher: import("./core/file-watcher").FileWatcher | null = null;
  try {
    const { getFileWatcher } = await import("./core/file-watcher.js");
    const { getCodebaseIndex } = await import("./core/codebase-index.js");
    fileWatcher = getFileWatcher(cwd);
    // Initialize RAG auto-indexer (lazy, non-blocking)
    let ragAutoIndexer: Awaited<
      ReturnType<typeof import("./core/rag/auto-index")["getRagAutoIndexer"]>
    > | null = null;
    try {
      const { getRagAutoIndexer } = await import("./core/rag/auto-index");
      ragAutoIndexer = getRagAutoIndexer(cwd);
    } catch (err) {
      log.debug("index", `RAG auto-indexer init skipped: ${err}`);
    }

    fileWatcher.start((changes) => {
      // Rebuild codebase index when files change externally
      try {
        const idx = getCodebaseIndex(cwd);
        idx.build();
        log.info("watcher", `Re-indexed after ${changes.length} external file change(s)`);
      } catch (err) {
        log.debug("index", `Failed to re-index after file changes: ${err}`);
      }

      // Feed changes to RAG auto-indexer for incremental re-indexing
      ragAutoIndexer?.onFileChanges(changes);
    });
  } catch (err) {
    log.debug("index", `File watcher initialization failed: ${err}`);
  }

  profileCheckpoint("ready");

  // Print startup profile if requested
  if (opts.startupProfile || isProfilingEnabled()) {
    printProfileReport();
  }

  // Interactive mode: start the Ink-based terminal UI
  profileCheckpoint("ui_rendering");
  const startUI = await lazyGetStartUI();
  const app = startUI({ config, conversationManager, tools });
  await app.waitUntilExit();

  // Stop file watcher
  fileWatcher?.stop();


  log.info("session", "Session ended");
  await lazyShutdownLsp();
  await lazyShutdownMcpManager();
  await lazyCloseDb();
  log.shutdown();
}

// ─── Non-interactive single-prompt mode ─────────────────────────

async function runNonInteractive(
  conversationManager: InstanceType<Awaited<ReturnType<typeof lazyGetConversationManager>>>,
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
          process.stderr.write(`\x1b[31m✗ ${event.name}: ${event.result}\x1b[0m\n`);
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
