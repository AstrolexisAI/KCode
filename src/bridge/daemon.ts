// KCode Bridge/Daemon Mode - Daemon Process
// Long-running background process that manages KCode sessions via WebSocket.

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../core/logger";
import { PermissionBridge } from "./permission-bridge";
import { createMessage, serializeMessage } from "./protocol";
import { SessionManager } from "./session-manager";
import type { ShutdownMessage } from "./types";
import { BridgeWebSocketServer } from "./websocket-server";

// ─── Constants ──────────────────────────────────────────────────

const KCODE_DIR = join(homedir(), ".kcode");
const PID_FILE = join(KCODE_DIR, "daemon.pid");
const PORT_FILE = join(KCODE_DIR, "daemon.port");
const TOKEN_FILE = join(KCODE_DIR, "daemon.token");
const DEFAULT_PORT_MIN = 19100;
const DEFAULT_PORT_MAX = 19199;

// ─── Helpers ────────────────────────────────────────────────────

function ensureKcodeDir(): void {
  if (!existsSync(KCODE_DIR)) {
    mkdirSync(KCODE_DIR, { recursive: true });
  }
}

/** Generate a cryptographically random token (64 hex chars). */
function generateToken(): string {
  return randomBytes(32).toString("hex");
}

/** Check if a process with the given PID is running. */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Read the PID from the PID file. Returns null if file doesn't exist or contains invalid data. */
export function readPidFile(): number | null {
  try {
    if (!existsSync(PID_FILE)) return null;
    const content = readFileSync(PID_FILE, "utf-8").trim();
    const pid = parseInt(content, 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/** Read the port from the port file. */
export function readPortFile(): number | null {
  try {
    if (!existsSync(PORT_FILE)) return null;
    const content = readFileSync(PORT_FILE, "utf-8").trim();
    const port = parseInt(content, 10);
    return isNaN(port) ? null : port;
  } catch {
    return null;
  }
}

/** Read the auth token from the token file. */
export function readTokenFile(): string | null {
  try {
    if (!existsSync(TOKEN_FILE)) return null;
    return readFileSync(TOKEN_FILE, "utf-8").trim();
  } catch {
    return null;
  }
}

/** Clean up all daemon state files. */
function cleanupFiles(): void {
  for (const f of [PID_FILE, PORT_FILE, TOKEN_FILE]) {
    try {
      if (existsSync(f)) unlinkSync(f);
    } catch (err) {
      log.error("daemon", `Failed to remove ${f}: ${err}`);
    }
  }
}

/** Find a free port in the given range. */
async function findFreePort(min: number, max: number): Promise<number> {
  for (let port = min; port <= max; port++) {
    try {
      // Try to listen — if it succeeds, the port is free
      const testServer = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("") });
      testServer.stop(true);
      return port;
    } catch {
      // Port in use, try next
    }
  }
  throw new Error(`No free port found in range ${min}-${max}`);
}

// ─── Daemon Status ──────────────────────────────────────────────

export interface DaemonStatus {
  running: boolean;
  pid?: number;
  port?: number;
  uptime?: number;
  sessions?: number;
  clients?: number;
}

/**
 * Check if the daemon is currently running.
 */
export function isDaemonRunning(): DaemonStatus {
  const pid = readPidFile();
  if (pid === null) {
    return { running: false };
  }

  if (!isProcessRunning(pid)) {
    // Stale PID file — clean up
    cleanupFiles();
    return { running: false };
  }

  const port = readPortFile();
  return { running: true, pid, port: port ?? undefined };
}

/**
 * Fetch extended status from the running daemon's health endpoint.
 */
export async function getDaemonStatus(): Promise<DaemonStatus> {
  const basic = isDaemonRunning();
  if (!basic.running || !basic.port) return basic;

  try {
    const resp = await fetch(`http://127.0.0.1:${basic.port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (resp.ok) {
      const health = (await resp.json()) as {
        status: string;
        sessions: number;
        clients: number;
        uptime: number;
      };
      return {
        ...basic,
        uptime: health.uptime,
        sessions: health.sessions,
        clients: health.clients,
      };
    }
  } catch {
    // Health check failed — daemon may be unhealthy
  }

  return basic;
}

// ─── Daemon Lifecycle ───────────────────────────────────────────

/** State of the running daemon (only populated after startDaemon). */
let activeDaemon: {
  sessionManager: SessionManager;
  wsServer: BridgeWebSocketServer;
  permissionBridge: PermissionBridge;
  port: number;
} | null = null;

/**
 * Start the KCode daemon.
 * @param opts.port - Specific port to use (default: auto-find in 19100-19199).
 * @param opts.foreground - If true, run in foreground (don't detach). Default true for direct invocation.
 */
export async function startDaemon(opts?: {
  port?: number;
}): Promise<{ port: number; token: string; pid: number }> {
  // Check if already running
  const status = isDaemonRunning();
  if (status.running) {
    throw new Error(`Daemon already running (PID ${status.pid}, port ${status.port})`);
  }

  ensureKcodeDir();

  // Find port
  const port = opts?.port ?? (await findFreePort(DEFAULT_PORT_MIN, DEFAULT_PORT_MAX));

  // Generate auth token
  const token = generateToken();

  // Initialize components first — we must NOT persist state files
  // until the WebSocket server has actually bound the port. Otherwise
  // a port-in-use / EADDRINUSE after writeFileSync leaves a "zombie"
  // daemon.pid/port/token on disk pointing at our own PID, and
  // isDaemonRunning() will return true forever (until cleaned up
  // manually). Issue #111 v304 audit finding #3.
  const sessionManager = new SessionManager();
  const permissionBridge = new PermissionBridge();
  const wsServer = new BridgeWebSocketServer({
    token,
    sessionManager,
    permissionBridge,
  });

  // Start server — if this throws, we don't write any state files.
  try {
    wsServer.start(port);
  } catch (err) {
    throw new Error(
      `Daemon failed to bind 127.0.0.1:${port}: ${err instanceof Error ? err.message : err}. No state files written.`,
    );
  }

  // WebSocket is up. NOW it's safe to write the state files so other
  // processes can connect.
  writeFileSync(PID_FILE, String(process.pid), "utf-8");
  writeFileSync(PORT_FILE, String(port), "utf-8");
  writeFileSync(TOKEN_FILE, token, "utf-8");
  try {
    chmodSync(TOKEN_FILE, 0o600);
  } catch {
    // chmod may fail on Windows — not critical
  }

  activeDaemon = { sessionManager, wsServer, permissionBridge, port };

  // Register signal handlers for graceful shutdown
  const shutdown = async () => {
    await stopDaemon();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  log.info("daemon", `Daemon started on 127.0.0.1:${port} (PID ${process.pid})`);

  return { port, token, pid: process.pid };
}

/**
 * Stop the running daemon gracefully.
 */
export async function stopDaemon(): Promise<void> {
  if (!activeDaemon) {
    log.warn("daemon", "stopDaemon called but no active daemon");
    return;
  }

  log.info("daemon", "Shutting down daemon...");

  // Notify all clients
  const shutdownMsg = createMessage<ShutdownMessage>("shutdown", { reason: "daemon stopping" });
  activeDaemon.wsServer.broadcastAll(shutdownMsg);

  // Cancel pending permissions
  activeDaemon.permissionBridge.cancelAll();

  // Shut down sessions
  await activeDaemon.sessionManager.shutdown();

  // Stop WebSocket server
  activeDaemon.wsServer.stop();

  // Clean up files
  cleanupFiles();

  activeDaemon = null;
  log.info("daemon", "Daemon stopped");
}

/**
 * Stop a remote daemon by sending SIGTERM to its PID.
 */
export function stopRemoteDaemon(): boolean {
  const pid = readPidFile();
  if (pid === null) {
    return false;
  }

  if (!isProcessRunning(pid)) {
    cleanupFiles();
    return false;
  }

  try {
    process.kill(pid, "SIGTERM");
    // Give it a moment, then clean up files if still present
    setTimeout(() => {
      if (existsSync(PID_FILE)) {
        const currentPid = readPidFile();
        if (currentPid === pid && !isProcessRunning(pid)) {
          cleanupFiles();
        }
      }
    }, 2000);
    return true;
  } catch {
    return false;
  }
}

/**
 * List sessions on the running daemon via the session manager (local) or health endpoint (remote).
 */
export async function listDaemonSessions(): Promise<
  Array<{ id: string; dir: string; status: string; model: string }>
> {
  if (activeDaemon) {
    return activeDaemon.sessionManager.listSessions().map((s) => ({
      id: s.id,
      dir: s.dir,
      status: s.status,
      model: s.model,
    }));
  }

  // Try to connect to running daemon
  const status = isDaemonRunning();
  if (!status.running || !status.port) return [];

  const token = readTokenFile();
  if (!token) return [];

  try {
    // Use a simple fetch to health endpoint for basic info
    const resp = await fetch(`http://127.0.0.1:${status.port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (resp.ok) {
      const health = (await resp.json()) as { sessions: number };
      // Health endpoint doesn't list sessions in detail — return count indication
      return [{ id: "(remote)", dir: "-", status: `${health.sessions} session(s)`, model: "-" }];
    }
  } catch {
    // Daemon unreachable
  }

  return [];
}

/**
 * Get the active daemon's session manager (for in-process use).
 */
export function getActiveDaemon() {
  return activeDaemon;
}
