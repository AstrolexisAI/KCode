// KCode - Doctor / Health Check
// Diagnoses setup issues and verifies dependencies.

import { existsSync, accessSync, constants, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createServer } from "node:net";
import { loadModelsConfig, getDefaultModel, getModelBaseUrl } from "./models";
import { getUserMemoryDir } from "./memory";
import { log } from "./logger";

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
      const bytes = parseInt(result.output.split("\t")[0], 10);
      return isNaN(bytes) ? 0 : bytes;
    }
  } catch (err) { log.debug("doctor", `Failed to get directory size for ${path}: ${err}`); }
  return 0;
}

// ─── Diagnostics ────────────────────────────────────────────────

export async function runDiagnostics(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const kcodeDir = join(homedir(), ".kcode");

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
      results.push({ name: "Config directory", status: "ok", message: `${kcodeDir} exists and is writable` });
    } else {
      results.push({ name: "Config directory", status: "fail", message: `${kcodeDir} exists but is not writable` });
    }
  } else {
    results.push({ name: "Config directory", status: "fail", message: `${kcodeDir} does not exist` });
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
      results.push({ name: "Models config", status: "fail", message: `${modelsPath} exists but is not valid JSON` });
    }
  } else {
    results.push({ name: "Models config", status: "warn", message: `${modelsPath} not found — no models registered` });
  }

  // 4. Default model
  const defaultModel = await getDefaultModel();
  const config = await loadModelsConfig();
  const modelEntry = config.models.find((m) => m.name === defaultModel);
  if (modelEntry) {
    results.push({ name: "Default model", status: "ok", message: `"${defaultModel}" is registered at ${modelEntry.baseUrl}` });
  } else if (config.models.length === 0) {
    results.push({ name: "Default model", status: "warn", message: `No models registered yet (default would be "${defaultModel}")` });
  } else {
    results.push({ name: "Default model", status: "fail", message: `Default model "${defaultModel}" is not in the registry` });
  }

  // 5. LLM connectivity
  try {
    const baseUrl = await getModelBaseUrl(defaultModel);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(`${baseUrl}/v1/models`, { signal: controller.signal });
    clearTimeout(timeout);
    if (response.ok) {
      results.push({ name: "LLM connectivity", status: "ok", message: `${baseUrl}/v1/models responded (${response.status})` });
    } else {
      results.push({ name: "LLM connectivity", status: "warn", message: `${baseUrl}/v1/models returned HTTP ${response.status}` });
    }
  } catch (err: any) {
    const baseUrl = await getModelBaseUrl(defaultModel);
    const reason = err?.name === "AbortError" ? "timed out after 5s" : (err?.message ?? "unreachable");
    results.push({ name: "LLM connectivity", status: "fail", message: `${baseUrl}/v1/models — ${reason}` });
  }

  // 6. Ripgrep
  const rgResult = await runCommand(["rg", "--version"]);
  if (rgResult.ok) {
    const version = rgResult.output.split("\n")[0];
    results.push({ name: "Ripgrep", status: "ok", message: version });
  } else {
    results.push({ name: "Ripgrep", status: "warn", message: "rg not found — file search may be limited" });
  }

  // 7. Git
  const gitResult = await runCommand(["git", "--version"]);
  if (gitResult.ok) {
    results.push({ name: "Git", status: "ok", message: gitResult.output });
  } else {
    results.push({ name: "Git", status: "warn", message: "git not found — version control features unavailable" });
  }

  // 8. Transcripts directory
  const transcriptsDir = join(kcodeDir, "transcripts");
  if (existsSync(transcriptsDir)) {
    results.push({ name: "Transcripts dir", status: "ok", message: `${transcriptsDir} exists` });
  } else {
    results.push({ name: "Transcripts dir", status: "warn", message: `${transcriptsDir} not found — will be created on first use` });
  }

  // 9. Logs directory
  const logsDir = join(kcodeDir, "logs");
  if (existsSync(logsDir)) {
    results.push({ name: "Logs dir", status: "ok", message: `${logsDir} exists` });
  } else {
    results.push({ name: "Logs dir", status: "warn", message: `${logsDir} not found — will be created on first use` });
  }

  // 10. Codebase index
  try {
    const { getCodebaseIndex } = await import("./codebase-index.js");
    const cwd = process.cwd();
    const idx = getCodebaseIndex(cwd);
    await idx.build();
    results.push({ name: "Codebase index", status: "ok", message: `Index built successfully for ${cwd}` });
  } catch (err: any) {
    results.push({ name: "Codebase index", status: "warn", message: `Index build failed — ${err?.message ?? "unknown error"}` });
  }

  // 11. Memory system
  try {
    const memDir = getUserMemoryDir();
    if (existsSync(memDir)) {
      if (dirWritable(memDir)) {
        results.push({ name: "Memory system", status: "ok", message: `${memDir} is writable` });
      } else {
        results.push({ name: "Memory system", status: "fail", message: `${memDir} exists but is not writable` });
      }
    } else {
      // Try creating it to verify writability
      try {
        mkdirSync(memDir, { recursive: true });
        results.push({ name: "Memory system", status: "ok", message: `${memDir} created and writable` });
      } catch (err) {
        log.debug("doctor", `Failed to create memory directory: ${err}`);
        results.push({ name: "Memory system", status: "fail", message: `Cannot create memory directory at ${memDir}` });
      }
    }
  } catch (err: any) {
    results.push({ name: "Memory system", status: "fail", message: `Memory system error — ${err?.message ?? "unknown"}` });
  }

  // 12. Shell completions (kcode in PATH)
  const whichResult = await runCommand(["which", "kcode"]);
  if (whichResult.ok) {
    results.push({ name: "Shell completions", status: "ok", message: `kcode found at ${whichResult.output}` });
  } else {
    results.push({ name: "Shell completions", status: "warn", message: "kcode not found in PATH — shell completions may not work" });
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
      results.push({ name: "HTTP server port", status: "warn", message: "Port 10101 is in use — server subcommand may fail" });
    }
  } catch (err) {
    log.debug("doctor", `Failed to check port 10101 availability: ${err}`);
    results.push({ name: "HTTP server port", status: "warn", message: "Could not check port 10101 availability" });
  }

  // 14. Keybindings (info-level)
  const keybindingsPath = join(kcodeDir, "keybindings.json");
  if (existsSync(keybindingsPath)) {
    try {
      const file = Bun.file(keybindingsPath);
      await file.json();
      results.push({ name: "Keybindings", status: "ok", message: `${keybindingsPath} is valid JSON` });
    } catch (err) {
      log.debug("doctor", `Failed to parse keybindings: ${err}`);
      results.push({ name: "Keybindings", status: "warn", message: `${keybindingsPath} exists but is not valid JSON` });
    }
  } else {
    results.push({ name: "Keybindings", status: "ok", message: "No custom keybindings (using defaults)" });
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
      results.push({ name: "Pricing data", status: "warn", message: `${pricingPath} exists but is not valid JSON` });
    }
  } else {
    results.push({ name: "Pricing data", status: "ok", message: "No custom pricing data (using defaults)" });
  }

  // 16. Disk space
  if (existsSync(kcodeDir)) {
    const bytes = await dirSizeBytes(kcodeDir);
    const mb = bytes / (1024 * 1024);
    if (mb > 500) {
      results.push({ name: "Disk space", status: "warn", message: `~/.kcode/ is ${mb.toFixed(0)}MB — consider cleaning old transcripts/logs` });
    } else {
      results.push({ name: "Disk space", status: "ok", message: `~/.kcode/ is ${mb.toFixed(1)}MB` });
    }
  } else {
    results.push({ name: "Disk space", status: "ok", message: "~/.kcode/ does not exist yet (0MB)" });
  }

  return results;
}
