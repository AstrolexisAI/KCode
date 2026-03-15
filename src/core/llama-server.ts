// KCode - Llama Server Manager
// Manages the llama-server process lifecycle (start, stop, health check)

import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { log } from "./logger";
import { getServerConfig } from "./model-manager";

const KCODE_HOME = join(homedir(), ".kcode");
const PID_FILE = join(KCODE_HOME, "server.pid");
const PORT_FILE = join(KCODE_HOME, "server.port");
const LOG_FILE = join(KCODE_HOME, "server.log");

let serverProcess: ChildProcess | null = null;

/** Check if llama-server is running (by PID or port) */
export async function isServerRunning(): Promise<boolean> {
  const port = getServerPort();
  if (!port) return false;

  try {
    const resp = await fetch(`http://localhost:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return resp.ok;
  } catch {
    // Server not responding — clean up stale PID file
    cleanupPidFile();
    return false;
  }
}

/** Get the port of the running server */
export function getServerPort(): number | null {
  try {
    if (existsSync(PORT_FILE)) {
      const port = parseInt(readFileSync(PORT_FILE, "utf-8").trim(), 10);
      if (port > 0) return port;
    }
  } catch { /* ignore */ }
  return null;
}

/** Get the PID of the running server */
function getServerPid(): number | null {
  try {
    if (existsSync(PID_FILE)) {
      const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
      if (pid > 0) return pid;
    }
  } catch { /* ignore */ }
  return null;
}

/** Start the llama-server with the configured model */
export async function startServer(options?: { port?: number }): Promise<{ port: number; pid: number }> {
  // Check if already running
  if (await isServerRunning()) {
    const port = getServerPort()!;
    const pid = getServerPid() ?? 0;
    log.info("server", `llama-server already running on port ${port}`);
    return { port, pid };
  }

  const config = await getServerConfig();
  if (!config) {
    throw new Error("Server not configured. Run 'kcode setup' first.");
  }

  if (!existsSync(config.enginePath)) {
    throw new Error(`Engine binary not found: ${config.enginePath}. Run 'kcode setup' to reinstall.`);
  }

  if (!existsSync(config.modelPath)) {
    throw new Error(`Model file not found: ${config.modelPath}. Run 'kcode setup' to redownload.`);
  }

  const port = options?.port ?? config.port;

  // Build llama-server arguments
  const args: string[] = [
    "--model", config.modelPath,
    "--port", port.toString(),
    "--host", "127.0.0.1",
    "--ctx-size", config.contextSize.toString(),
    "--n-gpu-layers", config.gpuLayers.toString(),
    "--flash-attn",           // enable flash attention
    "--cont-batching",        // continuous batching
    "--parallel", "1",        // single slot (one user)
    "--metrics",              // enable /metrics endpoint
  ];

  // Multi-GPU tensor split
  if (config.gpus.length > 1) {
    const totalVram = config.gpus.reduce((s, g) => s + g.vramMB, 0);
    const splits = config.gpus.map((g) => (g.vramMB / totalVram).toFixed(2));
    args.push("--tensor-split", splits.join(","));
  }

  log.info("server", `Starting llama-server on port ${port}: ${config.enginePath} ${args.join(" ")}`);

  return new Promise((resolve, reject) => {
    // Open log file for server output
    const logFile = Bun.file(LOG_FILE).writer();

    const proc = spawn(config.enginePath, args, {
      cwd: KCODE_HOME,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // Allow server to outlive KCode
    });

    serverProcess = proc;

    // Write PID and port files
    Bun.write(PID_FILE, `${proc.pid}\n`);
    Bun.write(PORT_FILE, `${port}\n`);

    proc.stdout?.on("data", (data: Buffer) => {
      logFile.write(data);
    });

    proc.stderr?.on("data", (data: Buffer) => {
      logFile.write(data);
    });

    proc.on("error", (err) => {
      log.error("server", `Failed to start llama-server: ${err.message}`);
      cleanupPidFile();
      reject(new Error(`Failed to start llama-server: ${err.message}`));
    });

    proc.on("exit", (code) => {
      log.info("server", `llama-server exited with code ${code}`);
      cleanupPidFile();
      serverProcess = null;
    });

    // Detach: allow server to keep running after KCode exits
    proc.unref();

    // Wait for server to be ready (poll /health endpoint)
    const startTime = Date.now();
    const maxWait = 120_000; // 2 minutes max for model loading
    const pollInterval = 500;

    const poll = async () => {
      while (Date.now() - startTime < maxWait) {
        try {
          const resp = await fetch(`http://localhost:${port}/health`, {
            signal: AbortSignal.timeout(1000),
          });
          if (resp.ok) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            log.info("server", `llama-server ready in ${elapsed}s (PID: ${proc.pid})`);
            resolve({ port, pid: proc.pid! });
            return;
          }
        } catch { /* not ready yet */ }

        await new Promise((r) => setTimeout(r, pollInterval));
      }

      // Timed out
      reject(new Error(`llama-server did not become ready within ${maxWait / 1000}s. Check ${LOG_FILE}`));
    };

    poll();
  });
}

/** Stop the llama-server */
export async function stopServer(): Promise<void> {
  const pid = getServerPid();
  if (!pid) {
    log.debug("server", "No server PID file found");
    return;
  }

  try {
    // Send SIGTERM first for graceful shutdown
    process.kill(pid, "SIGTERM");
    log.info("server", `Sent SIGTERM to llama-server (PID: ${pid})`);

    // Wait up to 5 seconds for graceful shutdown
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        process.kill(pid, 0); // Check if still alive
      } catch {
        // Process is dead
        break;
      }
    }

    // Force kill if still alive
    try {
      process.kill(pid, "SIGKILL");
      log.warn("server", `Force-killed llama-server (PID: ${pid})`);
    } catch { /* already dead */ }
  } catch (err) {
    // Process doesn't exist — clean up stale files
    log.debug("server", `Server PID ${pid} not found (already stopped)`);
  }

  cleanupPidFile();
  serverProcess = null;
}

/** Ensure the server is running, start if needed. Returns the base URL. */
export async function ensureServer(): Promise<string> {
  if (await isServerRunning()) {
    const port = getServerPort()!;
    return `http://localhost:${port}`;
  }

  // Auto-start
  const { port } = await startServer();
  return `http://localhost:${port}`;
}

/** Get the server base URL if running, null otherwise */
export function getServerUrl(): string | null {
  const port = getServerPort();
  return port ? `http://localhost:${port}` : null;
}

/** Get server status info */
export async function getServerStatus(): Promise<{
  running: boolean;
  port: number | null;
  pid: number | null;
  model?: string;
  uptime?: number;
}> {
  const running = await isServerRunning();
  const port = getServerPort();
  const pid = getServerPid();

  if (running && port) {
    try {
      const resp = await fetch(`http://localhost:${port}/props`, {
        signal: AbortSignal.timeout(2000),
      });
      if (resp.ok) {
        const props = await resp.json() as any;
        return { running, port, pid, model: props.default_generation_settings?.model };
      }
    } catch { /* ignore */ }
  }

  return { running, port, pid };
}

function cleanupPidFile(): void {
  try { unlinkSync(PID_FILE); } catch { /* ignore */ }
  try { unlinkSync(PORT_FILE); } catch { /* ignore */ }
}
