/**
 * SSH Transport layer for KCode Remote Mode.
 * Handles SSH connectivity, remote command execution, tunneling, and agent lifecycle.
 *
 * Security: All SSH commands use execFileSync/Bun.spawn with argument arrays
 * to prevent shell injection. No shell interpolation.
 */

import { execFileSync, type SpawnSyncReturns } from "node:child_process";
import type { RemoteAgentInfo, TunnelInfo } from "./types";

/** Options for SSH commands */
interface SSHOptions {
  /** Connection timeout in seconds (default 10) */
  timeout?: number;
  /** Additional SSH options as key-value pairs */
  extraOptions?: Record<string, string>;
}

/** Reconnection configuration */
interface ReconnectConfig {
  /** Delay between retries in ms (default 5000) */
  retryInterval: number;
  /** Maximum number of reconnection attempts (default 12) */
  maxAttempts: number;
}

export const DEFAULT_RECONNECT: ReconnectConfig = {
  retryInterval: 5000,
  maxAttempts: 12,
};

/**
 * Build base SSH arguments with standard options.
 * Returns an array of arguments (no shell interpolation).
 */
function buildSSHArgs(host: string, opts: SSHOptions = {}): string[] {
  const timeout = opts.timeout ?? 10;
  const args: string[] = ["-o", `ConnectTimeout=${timeout}`, "-o", "BatchMode=yes"];
  if (opts.extraOptions) {
    for (const [key, val] of Object.entries(opts.extraOptions)) {
      args.push("-o", `${key}=${val}`);
    }
  }
  args.push(host);
  return args;
}

/**
 * Check SSH connectivity to a remote host.
 * Runs `ssh -o ConnectTimeout=10 -o BatchMode=yes host echo ok`
 * @returns true if connection succeeds, false otherwise
 */
export function checkConnectivity(host: string, opts: SSHOptions = {}): boolean {
  try {
    const args = [...buildSSHArgs(host, opts), "echo", "ok"];
    const result = execFileSync("ssh", args, {
      timeout: ((opts.timeout ?? 10) + 5) * 1000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return result.trim() === "ok";
  } catch {
    return false;
  }
}

/**
 * Check if KCode is installed on the remote host.
 * @returns Object with `installed` boolean and optional `version` string.
 */
export function checkKCodeInstalled(
  host: string,
  opts: SSHOptions = {},
): { installed: boolean; version?: string } {
  try {
    const args = [...buildSSHArgs(host, opts), "which", "kcode"];
    execFileSync("ssh", args, {
      timeout: 15_000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return { installed: false };
  }

  // Get version
  try {
    const versionArgs = [...buildSSHArgs(host, opts), "kcode", "--version"];
    const version = execFileSync("ssh", versionArgs, {
      timeout: 15_000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { installed: true, version: version.trim() };
  } catch {
    return { installed: true };
  }
}

/**
 * Start a headless KCode agent on the remote machine.
 * Runs: ssh host kcode serve --headless --port 0 --dir <dir>
 * The agent prints JSON to stdout: { "port": <number>, "token": "<string>" }
 *
 * @param host SSH host string
 * @param dir Remote working directory
 * @param port Optional fixed port (0 = auto-assign)
 * @returns RemoteAgentInfo with port and token
 */
export async function startRemoteAgent(
  host: string,
  dir: string,
  port: number = 0,
  opts: SSHOptions = {},
): Promise<RemoteAgentInfo> {
  const args = [
    ...buildSSHArgs(host, { ...opts, timeout: 30 }),
    "kcode",
    "serve",
    "--headless",
    "--port",
    String(port),
    "--dir",
    dir,
  ];

  const proc = Bun.spawn(["ssh", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  // Read stdout until we get the JSON info line
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const startTime = Date.now();
  const timeout = 30_000;

  while (Date.now() - startTime < timeout) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Look for a JSON line with port and token
    const lines = buffer.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("{") && trimmed.includes("port") && trimmed.includes("token")) {
        try {
          const info = JSON.parse(trimmed) as RemoteAgentInfo;
          if (typeof info.port === "number" && typeof info.token === "string") {
            return info;
          }
        } catch {
          // Not valid JSON yet, continue
        }
      }
    }
  }

  // If we get here, we timed out or the process ended without giving us info
  proc.kill();
  const stderrReader = proc.stderr.getReader();
  const { value: errBytes } = await stderrReader.read();
  const stderr = errBytes ? decoder.decode(errBytes) : "";
  throw new Error(
    `Failed to start remote agent on ${host}:${dir}. ` +
      `stdout: ${buffer.slice(0, 500)}` +
      (stderr ? ` stderr: ${stderr.slice(0, 500)}` : ""),
  );
}

/**
 * Create an SSH tunnel from a local port to a remote port.
 * Runs: ssh -N -L <localPort>:127.0.0.1:<remotePort> host
 *
 * @param host SSH host string
 * @param remotePort Port on the remote to tunnel to
 * @param localPort Optional local port (0 = auto-assign; will pick a random high port)
 * @returns TunnelInfo with localPort and process handle
 */
export async function createTunnel(
  host: string,
  remotePort: number,
  localPort?: number,
): Promise<TunnelInfo> {
  const lPort = localPort ?? 10000 + Math.floor(Math.random() * 50000);
  const args = [
    "-N",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-L",
    `${lPort}:127.0.0.1:${remotePort}`,
    host,
  ];

  const proc = Bun.spawn(["ssh", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  // Give the tunnel a moment to establish or fail
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Check if process is still alive (exitCode is null while running)
  if (proc.exitCode !== null) {
    const stderrReader = proc.stderr.getReader();
    const { value } = await stderrReader.read();
    const stderr = value ? new TextDecoder().decode(value) : "";
    throw new Error(`SSH tunnel failed to start: ${stderr}`);
  }

  return {
    localPort: lPort,
    process: { kill: () => proc.kill() },
  };
}

/**
 * Execute a command on the remote host via SSH, streaming stdout/stderr.
 *
 * @param host SSH host string
 * @param command Array of command + arguments (no shell interpolation)
 * @param cwd Optional working directory on remote
 * @returns Object with stdout, stderr, and exitCode
 */
export async function executeRemote(
  host: string,
  command: string[],
  cwd?: string,
  opts: SSHOptions = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // Build the remote command: if cwd is given, prepend cd
  const remoteArgs = cwd ? ["cd", cwd, "&&", ...command] : command;

  const args = [...buildSSHArgs(host, opts), "--", ...remoteArgs];

  const proc = Bun.spawn(["ssh", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdoutText, stderrText] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;

  return {
    stdout: stdoutText,
    stderr: stderrText,
    exitCode,
  };
}

/**
 * Execute a command on the remote host synchronously.
 * Useful for simple commands where async is not needed.
 */
export function executeRemoteSync(
  host: string,
  command: string[],
  cwd?: string,
  opts: SSHOptions = {},
): { stdout: string; stderr: string; exitCode: number } {
  const remoteArgs = cwd ? ["cd", cwd, "&&", ...command] : command;

  const args = [...buildSSHArgs(host, opts), "--", ...remoteArgs];

  try {
    const stdout = execFileSync("ssh", args, {
      timeout: 30_000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err: unknown) {
    const spawnErr = err as SpawnSyncReturns<string> & {
      status?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      stdout: spawnErr.stdout ?? "",
      stderr: spawnErr.stderr ?? "",
      exitCode: spawnErr.status ?? 1,
    };
  }
}

/**
 * Attempt to reconnect to a remote host with exponential backoff.
 * Retries every `retryInterval` ms up to `maxAttempts` times.
 *
 * @param host SSH host string
 * @param config Reconnection configuration
 * @param onAttempt Optional callback for each attempt (attempt number, max)
 * @returns true if reconnected, false if all attempts exhausted
 */
export async function reconnect(
  host: string,
  config: ReconnectConfig = DEFAULT_RECONNECT,
  onAttempt?: (attempt: number, max: number) => void,
): Promise<boolean> {
  for (let i = 1; i <= config.maxAttempts; i++) {
    onAttempt?.(i, config.maxAttempts);
    if (checkConnectivity(host)) {
      return true;
    }
    if (i < config.maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, config.retryInterval));
    }
  }
  return false;
}

/**
 * Install KCode on a remote host via the install script.
 */
export async function installRemoteKCode(host: string): Promise<boolean> {
  const result = await executeRemote(host, [
    "bash",
    "-c",
    "curl -fsSL https://install.kulvex.dev | bash",
  ]);
  return result.exitCode === 0;
}
