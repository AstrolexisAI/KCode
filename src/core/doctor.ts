// KCode - Doctor / Health Check
// Diagnoses setup issues and verifies dependencies.

import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { log } from "./logger";
import { getUserMemoryDir } from "./memory";
import { getDefaultModel, getModelBaseUrl, loadModelsConfig } from "./models";
import { kcodeHome } from "./paths";

// ─── Types ──────────────────────────────────────────────────────

export interface CheckResult {
  name: string;
  status: "ok" | "warn" | "fail";
  message: string;
}

// ─── Helpers ────────────────────────────────────────────────────

async function runCommand(cmd: string[]): Promise<{ ok: boolean; output: string }> {
  try {
    const proc = Bun.spawn(cmd, {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    return { ok: exitCode === 0, output: stdout.trim() };
  } catch (err) {
    log.debug("doctor", `Command failed [${cmd.join(" ")}]: ${err}`);
    return { ok: false, output: "" };
  }
}

function dirWritable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch (err) {
    log.debug("doctor", `Directory not writable ${path}: ${err}`);
    return false;
  }
}

/** Get the total size of a directory in bytes (non-recursive du). */
async function dirSizeBytes(path: string): Promise<number> {
  try {
    const result = await runCommand(["du", "-sb", path]);
    if (result.ok) {
      const bytes = parseInt(result.output.split("\t")[0]!, 10);
      return isNaN(bytes) ? 0 : bytes;
    }
  } catch (err) {
    log.debug("doctor", `Failed to get directory size for ${path}: ${err}`);
  }
  return 0;
}

// ─── Diagnostics ────────────────────────────────────────────────

export async function runDiagnostics(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const kcodeDir = kcodeHome();

  // 1. Bun runtime
  try {
    const version = Bun.version;
    results.push({ name: "Bun runtime", status: "ok", message: `Bun v${version}` });
  } catch (err) {
    log.debug("doctor", `Bun runtime check failed: ${err}`);
    results.push({ name: "Bun runtime", status: "fail", message: "Bun runtime not detected" });
  }

  // 2. Config directory
  if (existsSync(kcodeDir)) {
    if (dirWritable(kcodeDir)) {
      results.push({
        name: "Config directory",
        status: "ok",
        message: `${kcodeDir} exists and is writable`,
      });
    } else {
      results.push({
        name: "Config directory",
        status: "fail",
        message: `${kcodeDir} exists but is not writable`,
      });
    }
  } else {
    results.push({
      name: "Config directory",
      status: "fail",
      message: `${kcodeDir} does not exist`,
    });
  }

  // 3. Models config
  const modelsPath = join(kcodeDir, "models.json");
  if (existsSync(modelsPath)) {
    try {
      const file = Bun.file(modelsPath);
      await file.json();
      results.push({ name: "Models config", status: "ok", message: `${modelsPath} is valid JSON` });
    } catch (err) {
      log.debug("doctor", `Failed to parse models config: ${err}`);
      results.push({
        name: "Models config",
        status: "fail",
        message: `${modelsPath} exists but is not valid JSON`,
      });
    }
  } else {
    results.push({
      name: "Models config",
      status: "warn",
      message: `${modelsPath} not found — no models registered`,
    });
  }

  // 4. Default model
  const defaultModel = await getDefaultModel();
  const config = await loadModelsConfig();
  const modelEntry = config.models.find((m) => m.name === defaultModel);
  if (modelEntry) {
    results.push({
      name: "Default model",
      status: "ok",
      message: `"${defaultModel}" is registered at ${modelEntry.baseUrl}`,
    });
  } else if (config.models.length === 0) {
    results.push({
      name: "Default model",
      status: "warn",
      message: `No models registered yet (default would be "${defaultModel}")`,
    });
  } else {
    results.push({
      name: "Default model",
      status: "fail",
      message: `Default model "${defaultModel}" is not in the registry`,
    });
  }

  // 5. LLM connectivity
  try {
    const baseUrl = await getModelBaseUrl(defaultModel);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(`${baseUrl}/v1/models`, { signal: controller.signal });
    clearTimeout(timeout);
    if (response.ok) {
      results.push({
        name: "LLM connectivity",
        status: "ok",
        message: `${baseUrl}/v1/models responded (${response.status})`,
      });
    } else {
      results.push({
        name: "LLM connectivity",
        status: "warn",
        message: `${baseUrl}/v1/models returned HTTP ${response.status}`,
      });
    }
  } catch (err: any) {
    const baseUrl = await getModelBaseUrl(defaultModel);
    const reason =
      err?.name === "AbortError" ? "timed out after 5s" : (err?.message ?? "unreachable");
    results.push({
      name: "LLM connectivity",
      status: "fail",
      message: `${baseUrl}/v1/models — ${reason}`,
    });
  }

  // 6. Ripgrep
  const rgResult = await runCommand(["rg", "--version"]);
  if (rgResult.ok) {
    const version = rgResult.output.split("\n")[0]!;
    results.push({ name: "Ripgrep", status: "ok", message: version });
  } else {
    results.push({
      name: "Ripgrep",
      status: "warn",
      message: "rg not found — file search may be limited",
    });
  }

  // 7. Git
  const gitResult = await runCommand(["git", "--version"]);
  if (gitResult.ok) {
    results.push({ name: "Git", status: "ok", message: gitResult.output });
  } else {
    results.push({
      name: "Git",
      status: "warn",
      message: "git not found — version control features unavailable",
    });
  }

  // 8. Transcripts directory
  const transcriptsDir = join(kcodeDir, "transcripts");
  if (existsSync(transcriptsDir)) {
    results.push({ name: "Transcripts dir", status: "ok", message: `${transcriptsDir} exists` });
  } else {
    results.push({
      name: "Transcripts dir",
      status: "warn",
      message: `${transcriptsDir} not found — will be created on first use`,
    });
  }

  // 9. Logs directory
  const logsDir = join(kcodeDir, "logs");
  if (existsSync(logsDir)) {
    results.push({ name: "Logs dir", status: "ok", message: `${logsDir} exists` });
  } else {
    results.push({
      name: "Logs dir",
      status: "warn",
      message: `${logsDir} not found — will be created on first use`,
    });
  }

  // 10. Codebase index
  try {
    const { getCodebaseIndex } = await import("./codebase-index.js");
    const cwd = process.cwd();
    const idx = getCodebaseIndex(cwd);
    await idx.build();
    results.push({
      name: "Codebase index",
      status: "ok",
      message: `Index built successfully for ${cwd}`,
    });
  } catch (err: any) {
    results.push({
      name: "Codebase index",
      status: "warn",
      message: `Index build failed — ${err?.message ?? "unknown error"}`,
    });
  }

  // 11. Memory system
  try {
    const memDir = getUserMemoryDir();
    if (existsSync(memDir)) {
      if (dirWritable(memDir)) {
        results.push({ name: "Memory system", status: "ok", message: `${memDir} is writable` });
      } else {
        results.push({
          name: "Memory system",
          status: "fail",
          message: `${memDir} exists but is not writable`,
        });
      }
    } else {
      // Try creating it to verify writability
      try {
        mkdirSync(memDir, { recursive: true });
        results.push({
          name: "Memory system",
          status: "ok",
          message: `${memDir} created and writable`,
        });
      } catch (err) {
        log.debug("doctor", `Failed to create memory directory: ${err}`);
        results.push({
          name: "Memory system",
          status: "fail",
          message: `Cannot create memory directory at ${memDir}`,
        });
      }
    }
  } catch (err: any) {
    results.push({
      name: "Memory system",
      status: "fail",
      message: `Memory system error — ${err?.message ?? "unknown"}`,
    });
  }

  // 12. Shell completions (kcode in PATH)
  const whichResult = await runCommand(["which", "kcode"]);
  if (whichResult.ok) {
    results.push({
      name: "Shell completions",
      status: "ok",
      message: `kcode found at ${whichResult.output}`,
    });
  } else {
    results.push({
      name: "Shell completions",
      status: "warn",
      message: "kcode not found in PATH — shell completions may not work",
    });
  }

  // 13. HTTP server port (10101)
  try {
    const portAvailable = await new Promise<boolean>((resolve) => {
      const server = createServer();
      server.once("error", () => resolve(false));
      server.once("listening", () => {
        server.close(() => resolve(true));
      });
      server.listen(10101, "127.0.0.1");
    });
    if (portAvailable) {
      results.push({ name: "HTTP server port", status: "ok", message: "Port 10101 is available" });
    } else {
      results.push({
        name: "HTTP server port",
        status: "warn",
        message: "Port 10101 is in use — server subcommand may fail",
      });
    }
  } catch (err) {
    log.debug("doctor", `Failed to check port 10101 availability: ${err}`);
    results.push({
      name: "HTTP server port",
      status: "warn",
      message: "Could not check port 10101 availability",
    });
  }

  // 14. Keybindings (info-level)
  const keybindingsPath = join(kcodeDir, "keybindings.json");
  if (existsSync(keybindingsPath)) {
    try {
      const file = Bun.file(keybindingsPath);
      await file.json();
      results.push({
        name: "Keybindings",
        status: "ok",
        message: `${keybindingsPath} is valid JSON`,
      });
    } catch (err) {
      log.debug("doctor", `Failed to parse keybindings: ${err}`);
      results.push({
        name: "Keybindings",
        status: "warn",
        message: `${keybindingsPath} exists but is not valid JSON`,
      });
    }
  } else {
    results.push({
      name: "Keybindings",
      status: "ok",
      message: "No custom keybindings (using defaults)",
    });
  }

  // 15. Pricing data (info-level)
  const pricingPath = join(kcodeDir, "pricing.json");
  if (existsSync(pricingPath)) {
    try {
      const file = Bun.file(pricingPath);
      await file.json();
      results.push({ name: "Pricing data", status: "ok", message: `${pricingPath} is valid JSON` });
    } catch (err) {
      log.debug("doctor", `Failed to parse pricing data: ${err}`);
      results.push({
        name: "Pricing data",
        status: "warn",
        message: `${pricingPath} exists but is not valid JSON`,
      });
    }
  } else {
    results.push({
      name: "Pricing data",
      status: "ok",
      message: "No custom pricing data (using defaults)",
    });
  }

  // 16. Database migrations
  try {
    const { getDb } = await import("./db.js");
    const { MigrationRunner } = await import("../migrations/runner.js");
    const { ALL_MIGRATIONS } = await import("../migrations/registry.js");
    const db = getDb();
    const runner = new MigrationRunner(db, ALL_MIGRATIONS);
    const status = runner.getStatus();

    if (status.failed.length > 0) {
      const failedVersions = status.failed.map((f) => f.version).join(", ");
      results.push({
        name: "Database migrations",
        status: "fail",
        message: `Migration(s) ${failedVersions} failed — run \`kcode migrate --retry\` to re-attempt`,
      });
    } else if (status.pending > 0) {
      results.push({
        name: "Database migrations",
        status: "warn",
        message: `${status.applied}/${status.total} applied, ${status.pending} pending`,
      });
    } else {
      const lastInfo = status.lastApplied
        ? ` — last: ${status.lastApplied.version}_${status.lastApplied.name} (${status.lastApplied.applied_at})`
        : "";
      results.push({
        name: "Database migrations",
        status: "ok",
        message: `${status.applied}/${status.total} applied${lastInfo}`,
      });
    }
  } catch (err: any) {
    results.push({
      name: "Database migrations",
      status: "warn",
      message: `Could not check migration status — ${err?.message ?? "unknown error"}`,
    });
  }

  // 17. Disk space
  if (existsSync(kcodeDir)) {
    const bytes = await dirSizeBytes(kcodeDir);
    const mb = bytes / (1024 * 1024);
    if (mb > 500) {
      results.push({
        name: "Disk space",
        status: "warn",
        message: `~/.kcode/ is ${mb.toFixed(0)}MB — consider cleaning old transcripts/logs`,
      });
    } else {
      results.push({
        name: "Disk space",
        status: "ok",
        message: `~/.kcode/ is ${mb.toFixed(1)}MB`,
      });
    }
  } else {
    results.push({
      name: "Disk space",
      status: "ok",
      message: "~/.kcode/ does not exist yet (0MB)",
    });
  }

  return results;
}

// ─── Deep Diagnostics ───────────────────────────────────────────

export interface DeepDiagnosticSection {
  title: string;
  items: Array<{ label: string; value: string; status?: "ok" | "warn" | "fail" }>;
}

/**
 * Extended diagnostics: MCP health, storage paths, permission mode,
 * loaded plugins, config origin, and security posture.
 */
export async function runDeepDiagnostics(): Promise<DeepDiagnosticSection[]> {
  const sections: DeepDiagnosticSection[] = [];
  const kcodeDir = kcodeHome();

  // ── Storage Paths ─────────────────────────────────────────
  const storagePaths = [
    { label: "KCODE_HOME", value: kcodeDir },
    {
      label: "KCODE_HOME source",
      value: process.env.KCODE_HOME ? "env: KCODE_HOME" : "default (~/.kcode)",
    },
    { label: "Database", value: process.env.KCODE_DB_PATH ?? join(kcodeDir, "awareness.db") },
    { label: "Transcripts", value: join(kcodeDir, "transcripts") },
    { label: "Snapshots", value: join(kcodeDir, "snapshots") },
    { label: "Logs", value: join(kcodeDir, "logs") },
    { label: "Plugins", value: join(kcodeDir, "plugins") },
    { label: "Memory", value: getUserMemoryDir() },
  ];
  sections.push({
    title: "Storage Paths",
    items: storagePaths.map((p) => ({
      ...p,
      status: existsSync(p.value)
        ? dirWritable(p.value)
          ? ("ok" as const)
          : ("warn" as const)
        : undefined,
    })),
  });

  // ── Config Origin ─────────────────────────────────────────
  const configItems: DeepDiagnosticSection["items"] = [];
  const configFiles = [
    { label: "User settings", path: join(kcodeDir, "settings.json") },
    { label: "Project settings", path: join(process.cwd(), ".kcode", "settings.json") },
    { label: "Local settings", path: join(process.cwd(), ".kcode", "settings.local.json") },
    { label: "Models config", path: join(kcodeDir, "models.json") },
    { label: "KCODE.md", path: join(process.cwd(), "KCODE.md") },
  ];
  for (const cf of configFiles) {
    configItems.push({
      label: cf.label,
      value: existsSync(cf.path) ? cf.path : "(not found)",
      status: existsSync(cf.path) ? "ok" : undefined,
    });
  }

  // Active env var overrides
  const envOverrides = [
    "KCODE_MODEL",
    "KCODE_API_KEY",
    "KCODE_API_BASE",
    "KCODE_PERMISSION_MODE",
    "KCODE_HOME",
    "KCODE_DB_PATH",
    "KCODE_SAFE_PLUGINS",
  ];
  for (const key of envOverrides) {
    if (process.env[key]) {
      configItems.push({
        label: `env ${key}`,
        value: key === "KCODE_API_KEY" ? "(set, redacted)" : process.env[key]!,
        status: "ok",
      });
    }
  }
  sections.push({ title: "Config Origin", items: configItems });

  // ── Permission & Security ─────────────────────────────────
  const secItems: DeepDiagnosticSection["items"] = [];
  const { buildConfig } = await import("./config.js");
  try {
    const config = await buildConfig(process.cwd());
    secItems.push({
      label: "Permission mode",
      value: config.permissionMode ?? "ask",
      status: config.permissionMode === "auto" ? "warn" : "ok",
    });
    secItems.push({
      label: "Safe plugins",
      value: process.env.KCODE_SAFE_PLUGINS === "1" ? "enabled" : "disabled",
    });
    const ruleCount = config.permissionRules?.length ?? 0;
    secItems.push({ label: "Permission rules", value: `${ruleCount} rule(s) configured` });
  } catch {
    secItems.push({
      label: "Permission mode",
      value: "unknown (config load failed)",
      status: "fail",
    });
  }
  sections.push({ title: "Permission & Security", items: secItems });

  // ── MCP Health ────────────────────────────────────────────
  const mcpItems: DeepDiagnosticSection["items"] = [];
  try {
    const { getMcpManager } = await import("./mcp.js");
    const manager = getMcpManager();
    const servers = manager.getServerStatus();
    if (servers.length === 0) {
      mcpItems.push({ label: "MCP servers", value: "none configured" });
    } else {
      for (const s of servers) {
        mcpItems.push({
          label: `Server: ${s.name}`,
          value: `${s.alive ? "alive" : "dead"}, ${s.toolCount} tool(s)`,
          status: s.alive ? "ok" : "fail",
        });
      }
    }
  } catch {
    mcpItems.push({ label: "MCP servers", value: "MCP manager not available" });
  }
  sections.push({ title: "MCP Health", items: mcpItems });

  // ── Loaded Plugins ────────────────────────────────────────
  const pluginItems: DeepDiagnosticSection["items"] = [];
  try {
    const { PluginManager } = await import("./plugin-manager.js");
    const pm = new PluginManager();
    const plugins = await pm.list();
    if (plugins.length === 0) {
      pluginItems.push({ label: "Plugins", value: "none installed" });
    } else {
      for (const p of plugins) {
        const m = ((p as unknown as Record<string, unknown>).manifest as typeof p) ?? p;
        pluginItems.push({
          label: m.name,
          value: `v${m.version} — ${m.description || "no description"}`,
          status: "ok",
        });
      }
    }
  } catch {
    pluginItems.push({ label: "Plugins", value: "plugin manager not available" });
  }
  sections.push({ title: "Loaded Plugins", items: pluginItems });

  // ── HTTP Endpoints ────────────────────────────────────────
  const endpointItems: DeepDiagnosticSection["items"] = [];
  const endpoints = [
    "GET  /api/health",
    "GET  /api/status",
    "POST /api/prompt",
    "GET  /api/tools",
    "GET  /api/sessions",
    "POST /api/tool (allowlist only)",
    "GET  /api/context",
    "POST /api/compact",
    "GET  /api/plan",
    "GET  /api/mcp",
    "GET  /api/agents",
  ];
  for (const ep of endpoints) {
    endpointItems.push({ label: ep, value: "available" });
  }
  sections.push({ title: "HTTP API Endpoints (when serve is active)", items: endpointItems });

  return sections;
}

/**
 * Format deep diagnostics for terminal output.
 */
export function formatDeepDiagnostics(sections: DeepDiagnosticSection[]): string {
  const lines: string[] = [];
  const statusIcon = (s?: "ok" | "warn" | "fail") =>
    s === "ok"
      ? "\x1b[32m✓\x1b[0m"
      : s === "warn"
        ? "\x1b[33m⚠\x1b[0m"
        : s === "fail"
          ? "\x1b[31m✗\x1b[0m"
          : " ";

  for (const section of sections) {
    lines.push("");
    lines.push(
      `\x1b[1m── ${section.title} ${"─".repeat(Math.max(0, 50 - section.title.length))}\x1b[0m`,
    );
    for (const item of section.items) {
      const icon = statusIcon(item.status);
      lines.push(`  ${icon} ${item.label}: ${item.value}`);
    }
  }
  return lines.join("\n");
}
