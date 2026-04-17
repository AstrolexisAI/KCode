// KCode - Kodi Advisor Model Manager
//
// Manages a dedicated small abliterated LLM that powers the Kodi
// mascot's autonomous movement and (in a follow-up PR) advisory
// speech. Runs as a SECOND llama-server process on port 10092,
// completely separate from the main coding model on 10091 — so
// Kodi's "reactions" never steal GPU/VRAM from the user's primary
// model, and there's no token accounting to worry about.
//
// Tier gating: this module only ever fires for enterprise users.
// Free/pro/team get the deterministic Kodi (no LLM calls at all).
//
// State files (all under ~/.kcode/):
//   models/kodi/<candidate>.gguf   — the model weights
//   kodi-server.pid                 — running process id
//   kodi-server.port                — listening port (always 10092)
//   kodi-server.log                 — stdout/stderr
//
// Candidates are all abliterated (uncensored) — the user explicitly
// requested no refusal behavior. All default to Q4_K_M quantization,
// which is the sweet spot for small models (≈1 byte/param).

import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { freemem } from "node:os";
import { join } from "node:path";
import { log } from "./logger";
import { downloadFile, ensureDir } from "./model-file-utils";
import { getServerConfig } from "./model-manager";
import { kcodePath } from "./paths";

// ─── Constants ──────────────────────────────────────────────────

/** Kodi model lives here so `kcode setup`'s main-model directory
 * stays unaffected by Kodi's download/delete operations. */
const KODI_MODEL_DIR = kcodePath("models/kodi");

/** Fixed Kodi server port. 10092 sits just above the main model
 * (10091) and stays in the ≥10000 range KCode reserves for
 * privileged defaults. Never configurable — keeping it fixed
 * simplifies every piece of downstream code (health checks,
 * UI labels, logs). */
export const KODI_SERVER_PORT = 10092;

const KODI_PID_FILE = kcodePath("kodi-server.pid");
const KODI_PORT_FILE = kcodePath("kodi-server.port");
const KODI_LOG_FILE = kcodePath("kodi-server.log");

/** Narrow context window — Kodi only reacts to a few recent tool
 * events, never multi-turn chat, so 2048 is plenty and keeps RAM
 * footprint predictable. */
const KODI_CTX_SIZE = 2048;

/** One parallel slot — Kodi never needs concurrent generations. */
const KODI_PARALLEL = 1;

// ─── Candidate catalog ──────────────────────────────────────────

export interface KodiCandidate {
  /** Short id used in settings.kodiAdvisor.modelId and the UI. */
  id: string;
  /** User-facing label for the menu. */
  label: string;
  /** On-disk filename under KODI_MODEL_DIR. */
  filename: string;
  /** Direct HTTPS GGUF download URL. */
  url: string;
  /** Disk size of the downloaded file, MB. */
  sizeMB: number;
  /** Approximate runtime RAM footprint, MB. Used to pick a default. */
  ramMB: number;
  /** Short one-liner about what this model is best at. */
  note: string;
}

/**
 * Candidate lineup. All abliterated, all Q4_K_M. Ordered from
 * strongest to smallest — pickDefaultCandidate walks in this order
 * and takes the first one that fits in the user's free RAM.
 *
 * Adding a new candidate: just append here. The menu, settings,
 * and download flow all pick it up automatically.
 */
export const KODI_CANDIDATES: readonly KodiCandidate[] = [
  {
    id: "qwen-coder-1.5b-abliterated",
    label: "Qwen 2.5 Coder 1.5B abliterated (Q4_K_M)",
    filename: "Qwen2.5-Coder-1.5B-Instruct-abliterated-Q4_K_M.gguf",
    url:
      "https://huggingface.co/bartowski/Qwen2.5-Coder-1.5B-Instruct-abliterated-GGUF/" +
      "resolve/main/Qwen2.5-Coder-1.5B-Instruct-abliterated-Q4_K_M.gguf",
    sizeMB: 1147, // ≈1.12 GB
    ramMB: 1500,
    note: "Default — code-specialized, uncensored, best for advising on code.",
  },
  {
    id: "qwen-1.5b-abliterated",
    label: "Qwen 2.5 1.5B abliterated (Q4_K_M)",
    filename: "Qwen2.5-1.5B-Instruct-abliterated.i1-Q4_K_M.gguf",
    url:
      "https://huggingface.co/mradermacher/Qwen2.5-1.5B-Instruct-abliterated-i1-GGUF/" +
      "resolve/main/Qwen2.5-1.5B-Instruct-abliterated.i1-Q4_K_M.gguf",
    sizeMB: 986,
    ramMB: 1300,
    note: "General-purpose abliterated Qwen 1.5B. Slightly lighter than the Coder variant.",
  },
  {
    id: "gemma-3-1b-abliterated",
    label: "Gemma 3 1B abliterated (Q4_K_M)",
    filename: "huihui-ai_gemma-3-1b-it-abliterated-Q4_K_M.gguf",
    url:
      "https://huggingface.co/bartowski/huihui-ai_gemma-3-1b-it-abliterated-GGUF/" +
      "resolve/main/huihui-ai_gemma-3-1b-it-abliterated-Q4_K_M.gguf",
    sizeMB: 806,
    ramMB: 1000,
    note: "Low-RAM fallback — same abliterated family as mark6 in miniature. Requires a recent llama.cpp with Gemma 3 support.",
  },
] as const;

export function getCandidate(id: string): KodiCandidate | null {
  return KODI_CANDIDATES.find((c) => c.id === id) ?? null;
}

// ─── Status machine ─────────────────────────────────────────────

export type KodiModelStatus =
  | "not_installed"
  | "installed_stopped"
  | "starting"
  | "running"
  | "error";

export interface KodiStatusReport {
  status: KodiModelStatus;
  installedCandidate: KodiCandidate | null;
  port: number | null;
  pid: number | null;
  modelFilePath: string | null;
  modelFileSizeMB: number | null;
}

/**
 * Walk the candidate list and return the first whose GGUF file
 * is present on disk. A user can only have one Kodi model
 * installed at a time — installing a second one requires deleting
 * the first, which keeps things simple (one file → one decision).
 */
export function getInstalledKodiCandidate(): KodiCandidate | null {
  for (const c of KODI_CANDIDATES) {
    const path = candidatePath(c);
    if (existsSync(path)) return c;
  }
  return null;
}

export function candidatePath(c: KodiCandidate): string {
  return join(KODI_MODEL_DIR, c.filename);
}

/** Poll the current state. Cheap — safe to call from the UI. */
export async function getKodiStatusReport(): Promise<KodiStatusReport> {
  const installed = getInstalledKodiCandidate();
  if (!installed) {
    return {
      status: "not_installed",
      installedCandidate: null,
      port: null,
      pid: null,
      modelFilePath: null,
      modelFileSizeMB: null,
    };
  }
  const path = candidatePath(installed);
  const sizeMB = existsSync(path) ? Math.round(statSync(path).size / (1024 * 1024)) : null;

  const running = await isKodiRunning();
  if (running) {
    return {
      status: "running",
      installedCandidate: installed,
      port: KODI_SERVER_PORT,
      pid: readPidFile(),
      modelFilePath: path,
      modelFileSizeMB: sizeMB,
    };
  }
  return {
    status: "installed_stopped",
    installedCandidate: installed,
    port: null,
    pid: null,
    modelFilePath: path,
    modelFileSizeMB: sizeMB,
  };
}

/**
 * Pick the best candidate that fits in the user's CURRENT free RAM.
 * Walks KODI_CANDIDATES top-down (strongest first) and returns the
 * first one with headroom. Returns null if nothing fits — caller
 * should show an error / disable Kodi advisor.
 *
 * Leaves a ~500 MB cushion so Kodi doesn't push the system into swap.
 */
export function pickDefaultCandidate(): KodiCandidate | null {
  const freeMB = Math.round(freemem() / (1024 * 1024));
  const budget = freeMB - 500; // safety cushion
  for (const c of KODI_CANDIDATES) {
    if (c.ramMB <= budget) return c;
  }
  return null;
}

// ─── Download ───────────────────────────────────────────────────

/**
 * Download a candidate's GGUF file into KODI_MODEL_DIR. Supports
 * resume via the shared downloadFile helper. Progress is reported
 * as a human string ("42% • 450.1/1124.8 MB") which the UI can
 * render verbatim. Throws on HTTP errors.
 */
export async function downloadKodiModel(
  candidateId: string,
  onProgress: (msg: string) => void,
): Promise<void> {
  const c = getCandidate(candidateId);
  if (!c) throw new Error(`Unknown Kodi candidate: ${candidateId}`);

  ensureDir(KODI_MODEL_DIR);
  const dest = candidatePath(c);

  // Early-out if already downloaded at full size — avoids a pointless
  // HEAD/Range roundtrip if the user reopened the menu by mistake.
  if (existsSync(dest)) {
    const sizeMB = Math.round(statSync(dest).size / (1024 * 1024));
    // Allow a 2% tolerance — filesystem block rounding, mirror size
    // differences, etc.
    if (Math.abs(sizeMB - c.sizeMB) < c.sizeMB * 0.02) {
      onProgress("Already downloaded.");
      return;
    }
  }

  log.info("kodi-model", `Downloading ${c.id} from ${c.url}`);
  await downloadFile(c.url, dest, onProgress, c.sizeMB * 1024 * 1024);
  log.info("kodi-model", `Download complete: ${dest}`);
}

// ─── Server lifecycle ───────────────────────────────────────────

/**
 * Resolve the llama-server binary. We reuse the path configured for
 * the main model's server — if `kcode setup` has been run, we have a
 * known-good binary. If not, fall back to `llama-server` on PATH so
 * a user who manually installed llama.cpp can still run Kodi.
 */
async function resolveLlamaServerBinary(): Promise<string> {
  try {
    const cfg = await getServerConfig();
    if (cfg?.enginePath && existsSync(cfg.enginePath) && cfg.engine !== "mlx") {
      return cfg.enginePath;
    }
  } catch {
    // fall through to PATH
  }
  return "llama-server";
}

function readPidFile(): number | null {
  try {
    if (!existsSync(KODI_PID_FILE)) return null;
    const pid = parseInt(readFileSync(KODI_PID_FILE, "utf-8").trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function cleanupStateFiles(): void {
  for (const p of [KODI_PID_FILE, KODI_PORT_FILE]) {
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
}

/** Health probe against the Kodi server's /health endpoint. */
export async function isKodiRunning(): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${KODI_SERVER_PORT}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (resp.ok) return true;
  } catch {
    /* not running */
  }
  // /health may not exist on older llama.cpp — try /v1/models as fallback.
  try {
    const resp = await fetch(`http://127.0.0.1:${KODI_SERVER_PORT}/v1/models`, {
      signal: AbortSignal.timeout(1500),
    });
    if (resp.ok) return true;
  } catch {
    /* not running */
  }
  // Nothing responded — clean up any stale state files so a fresh
  // start() doesn't confuse itself.
  cleanupStateFiles();
  return false;
}

/**
 * Spawn llama-server with the installed Kodi model. CPU-only by
 * default (`--n-gpu-layers 0`) to keep the GPU available for the
 * main coding model. Detached so it survives the TUI exiting — the
 * user can come back to a running Kodi instead of re-warming it.
 */
export async function startKodiServer(): Promise<{ port: number; pid: number }> {
  if (await isKodiRunning()) {
    const pid = readPidFile() ?? 0;
    return { port: KODI_SERVER_PORT, pid };
  }

  const candidate = getInstalledKodiCandidate();
  if (!candidate) {
    throw new Error("No Kodi model installed. Run `/kodi-advisor` to download one first.");
  }
  const modelPath = candidatePath(candidate);
  if (!existsSync(modelPath)) {
    throw new Error(`Kodi model file missing: ${modelPath}`);
  }

  const binary = await resolveLlamaServerBinary();
  const args = [
    "--model",
    modelPath,
    "--port",
    String(KODI_SERVER_PORT),
    "--host",
    "127.0.0.1",
    "--ctx-size",
    String(KODI_CTX_SIZE),
    "--n-gpu-layers",
    "0", // keep GPU for the main model
    "--parallel",
    String(KODI_PARALLEL),
    "--mmap",
  ];

  log.info("kodi-model", `Starting Kodi server: ${binary} ${args.join(" ")}`);

  const logFd = Bun.file(KODI_LOG_FILE).writer();
  const child = spawn(binary, args, {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => logFd.write(d));
  child.stderr?.on("data", (d) => logFd.write(d));
  child.on("error", (err) => {
    log.warn("kodi-model", `spawn error: ${err}`);
  });
  child.unref();

  if (!child.pid) {
    throw new Error("Failed to spawn Kodi server (no PID)");
  }
  writeFileSync(KODI_PID_FILE, String(child.pid));
  writeFileSync(KODI_PORT_FILE, String(KODI_SERVER_PORT));

  // Wait for the server to become reachable. llama.cpp takes a few
  // seconds to load weights on cold start, especially from disk.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isKodiRunning()) {
      log.info("kodi-model", `Kodi server ready on port ${KODI_SERVER_PORT}`);
      return { port: KODI_SERVER_PORT, pid: child.pid };
    }
  }

  // Didn't come up — kill what we started and tell the caller.
  try {
    process.kill(child.pid, "SIGTERM");
  } catch {
    /* already dead */
  }
  cleanupStateFiles();
  throw new Error("Kodi server failed to start within 30s. Check ~/.kcode/kodi-server.log");
}

/** Signal the running Kodi server and clean up its state files. */
export async function stopKodiServer(): Promise<void> {
  const pid = readPidFile();
  if (pid) {
    try {
      process.kill(pid, "SIGTERM");
      log.info("kodi-model", `Sent SIGTERM to Kodi server pid=${pid}`);
    } catch (err) {
      log.debug("kodi-model", `kill ${pid}: ${err}`);
    }
  }
  // Give the process a moment to exit cleanly before force.
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (!(await isKodiRunning())) break;
  }
  if (pid && (await isKodiRunning())) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already dead */
    }
  }
  cleanupStateFiles();
}

/**
 * Delete the installed Kodi model from disk. Stops the server first
 * if it's running. Returns the number of bytes freed, for a nice
 * confirmation message in the UI.
 */
export async function deleteKodiModel(): Promise<number> {
  if (await isKodiRunning()) {
    await stopKodiServer();
  }
  const candidate = getInstalledKodiCandidate();
  if (!candidate) return 0;
  const path = candidatePath(candidate);
  let freed = 0;
  try {
    freed = statSync(path).size;
    unlinkSync(path);
    log.info("kodi-model", `Deleted ${path} (${(freed / (1024 * 1024)).toFixed(1)} MB freed)`);
  } catch (err) {
    log.warn("kodi-model", `Failed to delete ${path}: ${err}`);
  }
  return freed;
}

/**
 * Public helper consumed by Kodi.tsx to decide whether to route LLM
 * reactions through Kodi's dedicated server or through the main
 * coding model. Null means "no dedicated server — fall back."
 */
export async function getKodiBaseUrl(): Promise<string | null> {
  return (await isKodiRunning()) ? `http://127.0.0.1:${KODI_SERVER_PORT}` : null;
}
