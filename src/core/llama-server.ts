// KCode - Inference Server Manager
// Manages the inference server process lifecycle (start, stop, health check)
// Supports two engines:
//   - llama.cpp (llama-server) on Linux/Windows
//   - MLX (mlx_lm.server) on macOS Apple Silicon

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { log } from "./logger";
import { getServerConfig } from "./model-manager";
import { kcodeHome, kcodePath } from "./paths";

const KCODE_HOME = kcodeHome();
const PID_FILE = kcodePath("server.pid");
const PORT_FILE = kcodePath("server.port");
const LOG_FILE = kcodePath("server.log");

let serverProcess: ChildProcess | null = null;

/** Check if the inference server is running (by PID or port) */
export async function isServerRunning(): Promise<boolean> {
  const port = getServerPort();
  if (!port) return false;

  // Try llama.cpp /health first, then MLX /v1/models
  for (const endpoint of ["/health", "/v1/models"]) {
    try {
      const resp = await fetch(`http://localhost:${port}${endpoint}`, {
        signal: AbortSignal.timeout(2000),
      });
      if (resp.ok) return true;
    } catch (err) {
      log.debug("llama-server", `Health check ${endpoint} failed: ${err}`);
    }
  }

  // Server not responding — clean up stale PID file
  cleanupPidFile();
  return false;
}

/** Get the port of the running server */
export function getServerPort(): number | null {
  try {
    if (existsSync(PORT_FILE)) {
      const port = parseInt(readFileSync(PORT_FILE, "utf-8").trim(), 10);
      if (port > 0) return port;
    }
  } catch (err) {
    log.debug("llama-server", `Failed to read port file: ${err}`);
  }
  return null;
}

/** Get the PID of the running server */
function getServerPid(): number | null {
  try {
    if (existsSync(PID_FILE)) {
      const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
      if (pid > 0) return pid;
    }
  } catch (err) {
    log.debug("llama-server", `Failed to read PID file: ${err}`);
  }
  return null;
}

/** Start the inference server with the configured model */
export async function startServer(options?: {
  port?: number;
}): Promise<{ port: number; pid: number }> {
  // Check if already running
  if (await isServerRunning()) {
    const port = getServerPort();
    const pid = getServerPid();
    if (port) {
      log.info("server", `Server already running on port ${port}`);
      return { port, pid: pid ?? 0 };
    }
  }

  const config = await getServerConfig();
  if (!config) {
    throw new Error("Server not configured. Run 'kcode setup' first.");
  }

  if (!existsSync(config.enginePath)) {
    throw new Error(`Engine not found: ${config.enginePath}. Run 'kcode setup' to reinstall.`);
  }

  const port = options?.port ?? config.port;
  const isMlx = config.engine === "mlx";

  // Build command and args based on engine type
  let cmd: string;
  let args: string[];

  if (isMlx) {
    // MLX: python3 -m mlx_lm.server --model <repo> --port <port> --host 127.0.0.1
    // If model > RAM, use a wrapper that sets mx.metal.set_wired_limit() for disk offloading.
    // Inspired by flash-moe's "Trust the OS" — let the page cache stream weights from NVMe SSD.
    cmd = config.enginePath; // venv python3
    const mlxModel = config.mlxRepo ?? config.modelPath;

    if (config.mlxWiredLimitMB) {
      // Disk offloading mode: cap wired memory so OS has room for page cache.
      // mx.set_wired_limit() controls how much RAM is locked (non-swappable).
      // Excess model weights stream from NVMe SSD via OS page cache (~7 GB/s).
      // We monkey-patch set_wired_limit after our call so main() can't override it.
      const wiredBytes = Math.floor(Number(config.mlxWiredLimitMB) * 1024 * 1024);
      if (!Number.isFinite(wiredBytes) || wiredBytes <= 0) {
        throw new Error(
          `Invalid mlxWiredLimitMB: ${config.mlxWiredLimitMB} — must be a positive number`,
        );
      }
      // Validate port as integer to prevent Python injection via interpolation
      const safePort = Math.floor(Number(port));
      if (!Number.isInteger(safePort) || safePort <= 0 || safePort > 65535) {
        throw new Error(`Invalid port: ${port} — must be integer 1-65535`);
      }
      // Sanitize model name to prevent injection (only allow alphanumeric, -, /, .)
      const safeModel = mlxModel.replace(/[^a-zA-Z0-9\-/._]/g, "");
      const wrapperScript = `import mlx.core as mx
if hasattr(mx, 'set_wired_limit'):
    mx.set_wired_limit(${wiredBytes})
    _orig = mx.set_wired_limit
    mx.set_wired_limit = lambda *a, **kw: _orig(${wiredBytes})
import sys
sys.argv = ['mlx_lm.server', '--model', '${safeModel}', '--port', '${safePort}', '--host', '127.0.0.1']
from mlx_lm.server import main
main()`;
      args = ["-c", wrapperScript];
      log.info(
        "server",
        `Starting MLX server with disk offloading (wired: ${config.mlxWiredLimitMB}MB) on port ${port}`,
      );
    } else {
      args = [
        "-m",
        "mlx_lm.server",
        "--model",
        mlxModel,
        "--port",
        port.toString(),
        "--host",
        "127.0.0.1",
      ];
      log.info("server", `Starting MLX server on port ${port}: ${cmd} ${args.join(" ")}`);
    }
  } else {
    // llama.cpp
    if (!existsSync(config.modelPath)) {
      throw new Error(
        `Model file not found: ${config.modelPath}. Run 'kcode setup' to redownload.`,
      );
    }

    cmd = config.enginePath;
    args = [
      "--model",
      config.modelPath,
      "--port",
      port.toString(),
      "--host",
      "127.0.0.1",
      "--ctx-size",
      config.contextSize.toString(),
      "--n-gpu-layers",
      config.gpuLayers.toString(),
      "--parallel",
      "1",
      "--metrics",
      "--mmap", // Enable mmap for SSD-backed weight streaming (flash-moe principle)
    ];

    // Multi-GPU tensor split
    if (config.gpus.length > 1) {
      const totalVram = config.gpus.reduce((s, g) => s + g.vramMB, 0);
      const splits = config.gpus.map((g) => (g.vramMB / totalVram).toFixed(2));
      args.push("--tensor-split", splits.join(","));
    }

    const isPartialOffload = config.gpuLayers > 0 && config.gpuLayers !== -1;
    if (isPartialOffload) {
      log.info(
        "server",
        `Partial GPU offload: ${config.gpuLayers} layers on GPU, rest via mmap (SSD/RAM)`,
      );
    }

    log.info("server", `Starting llama-server on port ${port}: ${cmd} ${args.join(" ")}`);
  }

  return new Promise((resolve, reject) => {
    // Open log file for server output
    const logFile = Bun.file(LOG_FILE).writer();

    // Set library paths (only needed for llama.cpp)
    const envOverrides: Record<string, string> = {};

    if (!isMlx) {
      const engineDir = join(config.enginePath, "..");
      const libDirs = [engineDir, ...findLibDirs(engineDir)];

      if (process.platform === "darwin") {
        envOverrides.DYLD_LIBRARY_PATH = [...libDirs, process.env.DYLD_LIBRARY_PATH ?? ""]
          .filter(Boolean)
          .join(":");
      } else if (process.platform === "win32") {
        envOverrides.PATH = [...libDirs, process.env.PATH ?? ""].filter(Boolean).join(";");
      } else {
        envOverrides.LD_LIBRARY_PATH = [...libDirs, process.env.LD_LIBRARY_PATH ?? ""]
          .filter(Boolean)
          .join(":");
      }
    }

    const proc = spawn(cmd, args, {
      cwd: KCODE_HOME,
      env: { ...process.env, ...envOverrides },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    serverProcess = proc;

    // PID/PORT files are written AFTER the health check succeeds (in poll())
    // to prevent isServerRunning() from returning true before the server is ready.

    proc.stdout?.on("data", (data: Buffer) => {
      logFile.write(data);
    });

    proc.stderr?.on("data", (data: Buffer) => {
      logFile.write(data);
    });

    proc.on("error", (err) => {
      log.error("server", `Failed to start server: ${err.message}`);
      try {
        logFile.flush();
        logFile.end();
      } catch (err) {
        log.debug("llama-server", `Failed to flush log file: ${err}`);
      }
      cleanupPidFile();
      reject(new Error(`Failed to start server: ${err.message}`));
    });

    proc.on("exit", (code) => {
      log.info("server", `Server exited with code ${code}`);
      try {
        logFile.flush();
        logFile.end();
      } catch {
        /* ignore — file may already be closed */
      }
      cleanupPidFile();
      serverProcess = null;
    });

    // Detach: allow server to keep running after KCode exits
    if (process.platform !== "win32") {
      proc.unref();
    }

    // Wait for server to be ready
    // llama.cpp exposes /health, MLX exposes /v1/models
    const healthEndpoint = isMlx ? "/v1/models" : "/health";
    const startTime = Date.now();
    const maxWait = 120_000; // 2 minutes max for model loading
    const pollInterval = 500;
    let settled = false;

    proc.on("error", () => {
      settled = true;
    });

    const poll = async () => {
      while (Date.now() - startTime < maxWait) {
        if (settled) return; // process errored out, stop polling
        try {
          const resp = await fetch(`http://localhost:${port}${healthEndpoint}`, {
            signal: AbortSignal.timeout(1000),
          });
          if (resp.ok) {
            settled = true;
            // Write PID/PORT files only after server is confirmed ready
            await Bun.write(PID_FILE, `${proc.pid}\n`);
            await Bun.write(PORT_FILE, `${port}\n`);
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            log.info(
              "server",
              `Server ready in ${elapsed}s (PID: ${proc.pid}, engine: ${isMlx ? "mlx" : "llama.cpp"})`,
            );
            resolve({ port, pid: proc.pid ?? 0 });
            return;
          }
        } catch (err) {
          log.debug("llama-server", `Server not ready yet: ${err}`);
        }

        await new Promise((r) => setTimeout(r, pollInterval));
      }

      if (!settled) {
        settled = true;
        // Timed out
        reject(
          new Error(`Server did not become ready within ${maxWait / 1000}s. Check ${LOG_FILE}`),
        );
      }
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
    if (process.platform === "win32") {
      // Windows: use taskkill
      Bun.spawnSync(["taskkill", "/PID", pid.toString(), "/F"], { stdout: "pipe", stderr: "pipe" });
      log.info("server", `Killed llama-server (PID: ${pid})`);
    } else {
      // Unix: Send SIGTERM first for graceful shutdown
      process.kill(pid, "SIGTERM");
      log.info("server", `Sent SIGTERM to llama-server (PID: ${pid})`);

      // Wait up to 5 seconds for graceful shutdown
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          process.kill(pid, 0); // Check if still alive
        } catch (err) {
          // Process is dead
          log.debug("llama-server", `Server process already dead: ${err}`);
          break;
        }
      }

      // Force kill if still alive
      try {
        process.kill(pid, "SIGKILL");
        log.warn("server", `Force-killed llama-server (PID: ${pid})`);
      } catch (err) {
        log.debug("llama-server", `Force-kill failed (process already dead): ${err}`);
      }
    }
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
    const port = getServerPort();
    if (port) return `http://localhost:${port}`;
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
    // Try llama.cpp /props first, then MLX /v1/models
    try {
      const resp = await fetch(`http://localhost:${port}/props`, {
        signal: AbortSignal.timeout(2000),
      });
      if (resp.ok) {
        const props = (await resp.json()) as { default_generation_settings?: { model?: string } };
        return { running, port, pid, model: props.default_generation_settings?.model };
      }
    } catch (err) {
      log.debug("llama-server", `Failed to fetch /props for server status: ${err}`);
    }

    try {
      const resp = await fetch(`http://localhost:${port}/v1/models`, {
        signal: AbortSignal.timeout(2000),
      });
      if (resp.ok) {
        const data = (await resp.json()) as { data?: Array<{ id?: string }> };
        const model = data?.data?.[0]?.id;
        return { running, port, pid, model };
      }
    } catch (err) {
      log.debug("llama-server", `Failed to fetch /v1/models for server status: ${err}`);
    }
  }

  return { running, port, pid };
}

function cleanupPidFile(): void {
  try {
    unlinkSync(PID_FILE);
  } catch (err) {
    log.debug("llama-server", `Failed to remove PID file: ${err}`);
  }
  try {
    unlinkSync(PORT_FILE);
  } catch (err) {
    log.debug("llama-server", `Failed to remove port file: ${err}`);
  }
}

/** Find directories containing shared library files under a given path (cross-platform) */
function findLibDirs(baseDir: string): string[] {
  const patterns =
    process.platform === "darwin"
      ? ["**/*.dylib"]
      : process.platform === "win32"
        ? ["**/*.dll"]
        : ["**/*.so", "**/*.so.*"];

  try {
    const dirs = new Set<string>();
    for (const pattern of patterns) {
      const glob = new Bun.Glob(pattern);
      for (const match of glob.scanSync({ cwd: baseDir, onlyFiles: true })) {
        dirs.add(join(baseDir, join(match, "..")));
      }
    }
    return [...dirs];
  } catch (err) {
    log.debug("llama-server", `Failed to scan for shared libraries: ${err}`);
    return [];
  }
}
