// KCode - Remote runner
//
// Thin wrapper that runs a single command (or reads a single file) on
// a registered remote via SSH. Used by the BashOnRemote / ReadOnRemote
// tools so the model can operate authorized LAN hosts from a prompt.
//
// Security:
//   - We pass the command as an argv array to ssh (no local shell
//     interpolation). The remote shell still parses it as a string,
//     because that's how `ssh user@host <cmd>` works — that's the
//     model's responsibility, same as the local Bash tool.
//   - BatchMode=yes prevents hangs on password prompts.
//   - StrictHostKeyChecking=accept-new (TOFU). If the user wants
//     stricter hostkey policy they should configure ~/.ssh/config.
//   - Bytes are capped so a runaway `cat /dev/urandom` can't blow up
//     the model context.

import { spawn } from "node:child_process";
import { findRemote } from "./remote-authorize";

export interface RunResult {
  /** Exit code from the remote process (or 124 on timeout). */
  exitCode: number;
  /** stdout, truncated to maxBytes. */
  stdout: string;
  /** stderr, truncated to maxBytes. */
  stderr: string;
  /** True if stdout/stderr were truncated. */
  truncated: boolean;
  /** Wall-clock duration in ms. */
  durationMs: number;
  /** True if the run hit the timeout. */
  timedOut: boolean;
}

export interface RunOptions {
  /** Hard-cap on bytes per stream. Default 256 KiB. */
  maxBytes?: number;
  /** Wall-clock timeout in ms. Default 60_000. */
  timeoutMs?: number;
}

const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const TIMEOUT_EXIT_CODE = 124; // GNU `timeout` convention

const TRUNCATION_MARKER = "\n…[truncated]\n";

function buildSshArgs(target: string, command: string): string[] {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "StrictHostKeyChecking=accept-new",
    target,
    command,
  ];
}

/**
 * Resolve a registered remote name to its SSH target.
 * Returns null if the name is unknown.
 */
export function resolveRemoteTarget(name: string): string | null {
  const r = findRemote(name);
  return r?.target ?? null;
}

/**
 * Run a shell command on a registered remote.
 * The command runs through the target's login shell (whatever sshd
 * launches for that user — typically bash/zsh).
 */
export function runOnRemote(name: string, command: string, opts: RunOptions = {}): Promise<RunResult> {
  const target = resolveRemoteTarget(name);
  if (!target) {
    return Promise.reject(new Error(`unknown remote '${name}'`));
  }
  return runCommand(target, command, opts);
}

/**
 * Read a file from a registered remote. Implemented as `cat -- <path>`
 * via SSH with a hard byte cap (no `head`/`tail` semantics — the model
 * should use BashOnRemote for those).
 */
export async function readFromRemote(name: string, path: string, opts: RunOptions = {}): Promise<RunResult> {
  // Quote the path with single quotes for the remote shell. Reject
  // single quotes in the path itself — they'd require a more elaborate
  // escape than makes sense here, and any real path won't contain them.
  if (path.includes("'")) {
    throw new Error("path must not contain a single quote");
  }
  return runOnRemote(name, `cat -- '${path}'`, opts);
}

/**
 * Write a file on a registered remote. Content is piped through ssh's
 * stdin into `tee` on the remote so we never have to shell-escape it.
 * The path is single-quoted in the remote command, so a single quote
 * in the path is rejected for the same reason as readFromRemote.
 *
 * Atomicity: writes go to "<path>.kcode-<pid>.tmp" first, then `mv`
 * replaces the original. That gives us atomic-replace on POSIX
 * filesystems (same dir, same fs) so a partial write doesn't leave a
 * corrupted file behind.
 */
export async function writeToRemote(
  name: string,
  path: string,
  content: string,
  opts: RunOptions = {},
): Promise<RunResult> {
  if (path.includes("'")) {
    throw new Error("path must not contain a single quote");
  }
  const target = resolveRemoteTarget(name);
  if (!target) throw new Error(`unknown remote '${name}'`);

  // Random temp suffix so concurrent writes don't collide.
  const suffix = `.kcode-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`;
  // Single-quote the paths for the remote shell. Path is checked above
  // to not contain a single quote, so this is safe. cat reads stdin
  // into the temp file; mv -f makes the final replace atomic on POSIX
  // (same dir / same fs).
  const remoteCmd = `cat > '${path}${suffix}' && mv -f '${path}${suffix}' '${path}'`;
  return runCommandWithStdin(target, remoteCmd, content, opts);
}

function runCommand(target: string, command: string, opts: RunOptions): Promise<RunResult> {
  return runInternal(target, command, undefined, opts);
}

function runCommandWithStdin(
  target: string,
  command: string,
  stdinData: string,
  opts: RunOptions,
): Promise<RunResult> {
  return runInternal(target, command, stdinData, opts);
}

function runInternal(
  target: string,
  command: string,
  stdinData: string | undefined,
  opts: RunOptions,
): Promise<RunResult> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = Date.now();
  const args = buildSshArgs(target, command);
  const stdinMode: "ignore" | "pipe" = stdinData !== undefined ? "pipe" : "ignore";

  return new Promise((resolve) => {
    const child = spawn("ssh", args, { stdio: [stdinMode, "pipe", "pipe"] });
    if (stdinData !== undefined && child.stdin) {
      child.stdin.on("error", () => {
        // Remote may close stdin early; the exit handler will still fire.
      });
      child.stdin.end(stdinData, "utf-8");
    }
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      const remaining = maxBytes - stdoutBytes;
      if (remaining <= 0) {
        stdoutTruncated = true;
        return;
      }
      if (chunk.length <= remaining) {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      } else {
        stdoutChunks.push(chunk.subarray(0, remaining));
        stdoutBytes += remaining;
        stdoutTruncated = true;
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const remaining = maxBytes - stderrBytes;
      if (remaining <= 0) {
        stderrTruncated = true;
        return;
      }
      if (chunk.length <= remaining) {
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
      } else {
        stderrChunks.push(chunk.subarray(0, remaining));
        stderrBytes += remaining;
        stderrTruncated = true;
      }
    });

    const finalize = (code: number | null, _signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      const stdoutStr = Buffer.concat(stdoutChunks).toString("utf-8") + (stdoutTruncated ? TRUNCATION_MARKER : "");
      const stderrStr = Buffer.concat(stderrChunks).toString("utf-8") + (stderrTruncated ? TRUNCATION_MARKER : "");
      resolve({
        exitCode: timedOut ? TIMEOUT_EXIT_CODE : code ?? 1,
        stdout: stdoutStr,
        stderr: stderrStr,
        truncated: stdoutTruncated || stderrTruncated,
        durationMs: Date.now() - start,
        timedOut,
      });
    };

    child.on("exit", finalize);
    child.on("error", (err) => {
      // Failed to spawn ssh at all (very unusual)
      clearTimeout(timer);
      resolve({
        exitCode: 127,
        stdout: "",
        stderr: `ssh spawn error: ${err.message}`,
        truncated: false,
        durationMs: Date.now() - start,
        timedOut: false,
      });
    });
  });
}
