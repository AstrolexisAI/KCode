// Tests for Bridge Daemon - lifecycle, PID management, status

import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  isDaemonRunning,
  readPidFile,
  readPortFile,
  readTokenFile,
  startDaemon,
  stopDaemon,
  getDaemonStatus,
} from "./daemon";

const KCODE_DIR = join(homedir(), ".kcode");
const PID_FILE = join(KCODE_DIR, "daemon.pid");
const PORT_FILE = join(KCODE_DIR, "daemon.port");
const TOKEN_FILE = join(KCODE_DIR, "daemon.token");

// Ensure .kcode dir exists for tests
mkdirSync(KCODE_DIR, { recursive: true });

// Clean up any daemon state after each test
afterEach(async () => {
  try { await stopDaemon(); } catch { /* may not be running */ }
  for (const f of [PID_FILE, PORT_FILE, TOKEN_FILE]) {
    try { if (existsSync(f)) unlinkSync(f); } catch { /* ignore */ }
  }
});

// ─── PID/Port/Token File Helpers ────────────────────────────────

describe("file helpers", () => {
  test("readPidFile returns null when file does not exist", () => {
    try { unlinkSync(PID_FILE); } catch {}
    expect(readPidFile()).toBeNull();
  });

  test("readPidFile reads a valid PID", () => {
    writeFileSync(PID_FILE, "12345", "utf-8");
    expect(readPidFile()).toBe(12345);
  });

  test("readPidFile returns null for invalid content", () => {
    writeFileSync(PID_FILE, "not-a-number", "utf-8");
    expect(readPidFile()).toBeNull();
  });

  test("readPortFile returns null when file does not exist", () => {
    try { unlinkSync(PORT_FILE); } catch {}
    expect(readPortFile()).toBeNull();
  });

  test("readPortFile reads a valid port", () => {
    writeFileSync(PORT_FILE, "19100", "utf-8");
    expect(readPortFile()).toBe(19100);
  });

  test("readTokenFile returns null when file does not exist", () => {
    try { unlinkSync(TOKEN_FILE); } catch {}
    expect(readTokenFile()).toBeNull();
  });

  test("readTokenFile reads a token", () => {
    writeFileSync(TOKEN_FILE, "my-secret-token", "utf-8");
    expect(readTokenFile()).toBe("my-secret-token");
  });
});

// ─── isDaemonRunning ────────────────────────────────────────────

describe("isDaemonRunning", () => {
  test("returns not running when no PID file", () => {
    try { unlinkSync(PID_FILE); } catch {}
    const status = isDaemonRunning();
    expect(status.running).toBe(false);
  });

  test("returns not running for stale PID (non-existent process)", () => {
    // Use a PID that almost certainly doesn't exist
    writeFileSync(PID_FILE, "999999999", "utf-8");
    const status = isDaemonRunning();
    expect(status.running).toBe(false);
    // Should have cleaned up the stale PID file
    expect(existsSync(PID_FILE)).toBe(false);
  });

  test("returns running for current process PID", () => {
    writeFileSync(PID_FILE, String(process.pid), "utf-8");
    writeFileSync(PORT_FILE, "19100", "utf-8");
    const status = isDaemonRunning();
    expect(status.running).toBe(true);
    expect(status.pid).toBe(process.pid);
    expect(status.port).toBe(19100);
  });
});

// ─── Daemon Lifecycle ───────────────────────────────────────────

describe("startDaemon / stopDaemon", () => {
  test("starts and creates PID/port/token files", async () => {
    const result = await startDaemon({ port: 19190 });
    expect(result.port).toBe(19190);
    expect(result.pid).toBe(process.pid);
    expect(result.token.length).toBeGreaterThan(0);

    // Files should exist
    expect(existsSync(PID_FILE)).toBe(true);
    expect(existsSync(PORT_FILE)).toBe(true);
    expect(existsSync(TOKEN_FILE)).toBe(true);

    expect(readPidFile()).toBe(process.pid);
    expect(readPortFile()).toBe(19190);
    expect(readTokenFile()).toBe(result.token);
  });

  test("stop cleans up files", async () => {
    await startDaemon({ port: 19191 });
    await stopDaemon();

    expect(existsSync(PID_FILE)).toBe(false);
    expect(existsSync(PORT_FILE)).toBe(false);
    expect(existsSync(TOKEN_FILE)).toBe(false);
  });

  test("throws if daemon already running", async () => {
    await startDaemon({ port: 19192 });
    await expect(startDaemon({ port: 19193 })).rejects.toThrow("already running");
  });

  test("health endpoint responds after start", async () => {
    const result = await startDaemon({ port: 19194 });
    const resp = await fetch(`http://127.0.0.1:${result.port}/health`);
    expect(resp.status).toBe(200);
    const body = await resp.json() as { status: string };
    expect(body.status).toBe("ok");
  });
});

// ─── getDaemonStatus ────────────────────────────────────────────

describe("getDaemonStatus", () => {
  test("returns extended status with uptime", async () => {
    await startDaemon({ port: 19195 });
    const status = await getDaemonStatus();
    expect(status.running).toBe(true);
    expect(typeof status.uptime).toBe("number");
    expect(typeof status.sessions).toBe("number");
    expect(typeof status.clients).toBe("number");
  });

  test("returns basic not-running status when no daemon", async () => {
    const status = await getDaemonStatus();
    expect(status.running).toBe(false);
  });
});
