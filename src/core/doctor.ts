// KCode - Doctor / Health Check
// Diagnoses setup issues and verifies dependencies.

import { existsSync, accessSync, constants } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadModelsConfig, getDefaultModel, getModelBaseUrl } from "./models";

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
  } catch {
    return { ok: false, output: "" };
  }
}

function dirWritable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
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
  } catch { /* ignore */ }
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
  } catch {
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
    } catch {
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

  // 10. Disk space
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
