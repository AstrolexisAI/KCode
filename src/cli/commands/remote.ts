/**
 * CLI subcommand: kcode remote
 * Provides commands for remote mode operations.
 */

import type { Command } from "commander";
import { DEFAULT_SYNC_EXCLUDES, DEFAULT_REMOTE_CONFIG } from "../../remote/types";

/**
 * Parse a host:/path target string.
 * Supports "user@server:/path" and "user@server" (no path).
 */
function parseTarget(target: string): { host: string; dir?: string } {
  const colonIdx = target.indexOf(":/");
  if (colonIdx !== -1) {
    return {
      host: target.slice(0, colonIdx),
      dir: target.slice(colonIdx + 1),
    };
  }
  return { host: target };
}

export function registerRemoteCommand(program: Command): void {
  const remoteCmd = program
    .command("remote")
    .description("Remote mode: execute, sync, or watch KCode sessions on remote machines");

  // ─── connect ──────────────────────────────────────────────
  remoteCmd
    .command("connect <target>")
    .description("Mode 1: Run KCode entirely on a remote server (e.g. user@server:/path)")
    .option("--local-only", "Force remote to use only local models", false)
    .action(async (target: string, opts: { localOnly: boolean }) => {
      const { host, dir } = parseTarget(target);
      if (!dir) {
        console.error("\x1b[31m✗ Please specify a remote directory: user@server:/path/to/project\x1b[0m");
        process.exit(1);
      }

      const { RemoteSession } = await import("../../remote/remote-session");
      const session = new RemoteSession({
        config: {
          host,
          remoteDir: dir,
          ...DEFAULT_REMOTE_CONFIG,
          localOnly: opts.localOnly,
        },
        mode: "execution",
        localDir: process.cwd(),
        onEvent: (event) => {
          switch (event.type) {
            case "connecting":
              console.log(`Connecting to ${host}...`);
              break;
            case "connected":
              console.log(`\x1b[32m✓\x1b[0m Connected. Session: ${event.sessionId}`);
              break;
            case "disconnected":
              console.log(`\x1b[33m⚠ Disconnected: ${event.reason}\x1b[0m`);
              break;
            case "reconnecting":
              console.log(`  Reconnecting (${event.attempt}/${event.maxAttempts})...`);
              break;
            case "reconnected":
              console.log("\x1b[32m✓\x1b[0m Reconnected.");
              break;
            case "error":
              console.error(`\x1b[31m✗ ${event.error}\x1b[0m`);
              break;
            case "session-ended":
              console.log("Session ended.");
              break;
          }
        },
      });

      try {
        await session.connect();

        // Handle Ctrl+C
        process.on("SIGINT", async () => {
          console.log("\nDisconnecting...");
          await session.disconnect(false);
          process.exit(0);
        });
      } catch (err) {
        console.error(`\x1b[31m✗ ${err instanceof Error ? err.message : err}\x1b[0m`);
        process.exit(1);
      }
    });

  // ─── sync ─────────────────────────────────────────────────
  remoteCmd
    .command("sync <target>")
    .description("Mode 2: Local KCode with file sync and remote Bash (e.g. user@server:/path)")
    .option("--interval <ms>", "Sync interval in milliseconds", (v: string) => parseInt(v, 10))
    .option("--no-watch", "Disable automatic file watching")
    .action(async (target: string, opts: { interval?: number; watch?: boolean }) => {
      const { host, dir } = parseTarget(target);
      if (!dir) {
        console.error("\x1b[31m✗ Please specify a remote directory: user@server:/path/to/project\x1b[0m");
        process.exit(1);
      }

      const { RemoteSession } = await import("../../remote/remote-session");
      const session = new RemoteSession({
        config: {
          host,
          remoteDir: dir,
          syncExclude: DEFAULT_SYNC_EXCLUDES,
          syncInterval: opts.interval ?? 2000,
          syncOnSave: opts.watch !== false,
          localOnly: false,
        },
        mode: "sync",
        localDir: process.cwd(),
        onEvent: (event) => {
          switch (event.type) {
            case "connecting":
              console.log(`Setting up sync with ${host}:${dir}...`);
              break;
            case "connected":
              console.log(`\x1b[32m✓\x1b[0m Sync active. Session: ${event.sessionId}`);
              break;
            case "sync-started":
              if (event.files[0] !== "*") {
                console.log(`\x1b[2m  Syncing ${event.files.length} file(s)...\x1b[0m`);
              } else {
                console.log("  Initial sync in progress...");
              }
              break;
            case "sync-completed":
              if (event.files[0] === "*") {
                console.log("  Initial sync complete.");
              }
              break;
            case "error":
              console.error(`\x1b[31m✗ ${event.error}\x1b[0m`);
              break;
            case "session-ended":
              console.log("Sync stopped.");
              break;
          }
        },
      });

      try {
        await session.connect();

        process.on("SIGINT", async () => {
          console.log("\nStopping sync...");
          await session.disconnect(false);
          process.exit(0);
        });
      } catch (err) {
        console.error(`\x1b[31m✗ ${err instanceof Error ? err.message : err}\x1b[0m`);
        process.exit(1);
      }
    });

  // ─── watch ────────────────────────────────────────────────
  remoteCmd
    .command("watch <host>")
    .description("Mode 3: Watch a remote session in read-only mode")
    .requiredOption("--session <id>", "Session ID to watch")
    .action(async (host: string, opts: { session: string }) => {
      const { RemoteSession } = await import("../../remote/remote-session");
      const session = new RemoteSession({
        config: {
          host,
          remoteDir: "/",
          ...DEFAULT_REMOTE_CONFIG,
        },
        mode: "viewer",
        localDir: process.cwd(),
        sessionId: opts.session,
        onEvent: (event) => {
          switch (event.type) {
            case "connecting":
              console.log(`Connecting to ${host} (session: ${opts.session})...`);
              break;
            case "connected":
              console.log(`\x1b[32m✓\x1b[0m Watching session ${event.sessionId}`);
              console.log("\x1b[2m  Read-only mode. Ctrl+C to stop watching.\x1b[0m");
              break;
            case "message": {
              const data = event.data as Record<string, unknown>;
              if (data.type === "session.text") {
                process.stdout.write(String(data.text ?? ""));
              } else if (data.type === "session.tool_use") {
                console.log(`\x1b[36m[tool] ${data.tool}: ${data.input}\x1b[0m`);
              } else if (data.type === "session.done") {
                console.log("\n\x1b[2mRemote session ended.\x1b[0m");
              }
              break;
            }
            case "error":
              console.error(`\x1b[31m✗ ${event.error}\x1b[0m`);
              break;
            case "session-ended":
              console.log("Stopped watching.");
              break;
          }
        },
      });

      try {
        await session.connect();

        process.on("SIGINT", async () => {
          console.log("\nStopping viewer...");
          await session.disconnect(false);
          process.exit(0);
        });
      } catch (err) {
        console.error(`\x1b[31m✗ ${err instanceof Error ? err.message : err}\x1b[0m`);
        process.exit(1);
      }
    });

  // ─── sessions ─────────────────────────────────────────────
  remoteCmd
    .command("sessions <host>")
    .description("List active remote sessions")
    .action(async (host: string) => {
      try {
        const { RemoteSession } = await import("../../remote/remote-session");
        const sessions = await RemoteSession.listSessions(host);
        if (sessions.length === 0) {
          console.log("No active sessions.");
          return;
        }
        console.log(`Active sessions on ${host}:\n`);
        for (const s of sessions) {
          const statusColor = s.status === "active" ? "32" : "33";
          console.log(
            `  \x1b[${statusColor}m●\x1b[0m ${s.id}  ${s.dir}  [${s.status}]  ${s.createdAt}`,
          );
        }
      } catch (err) {
        console.error(`\x1b[31m✗ ${err instanceof Error ? err.message : err}\x1b[0m`);
        process.exit(1);
      }
    });

  // ─── resume ───────────────────────────────────────────────
  remoteCmd
    .command("resume <host>")
    .description("Resume a disconnected remote session")
    .requiredOption("--session <id>", "Session ID to resume")
    .action(async (host: string, opts: { session: string }) => {
      const { RemoteSession } = await import("../../remote/remote-session");
      const session = new RemoteSession({
        config: {
          host,
          remoteDir: "/",
          ...DEFAULT_REMOTE_CONFIG,
        },
        mode: "execution",
        localDir: process.cwd(),
        sessionId: opts.session,
        onEvent: (event) => {
          switch (event.type) {
            case "connecting":
              console.log(`Resuming session ${opts.session} on ${host}...`);
              break;
            case "connected":
              console.log(`\x1b[32m✓\x1b[0m Resumed session ${event.sessionId}`);
              break;
            case "error":
              console.error(`\x1b[31m✗ ${event.error}\x1b[0m`);
              break;
          }
        },
      });

      try {
        await session.connect();

        process.on("SIGINT", async () => {
          console.log("\nDisconnecting...");
          await session.disconnect(false);
          process.exit(0);
        });
      } catch (err) {
        console.error(`\x1b[31m✗ ${err instanceof Error ? err.message : err}\x1b[0m`);
        process.exit(1);
      }
    });

  // ─── install ──────────────────────────────────────────────
  remoteCmd
    .command("install <host>")
    .description("Install KCode on a remote server")
    .action(async (host: string) => {
      try {
        const { checkConnectivity, installRemoteKCode, checkKCodeInstalled } = await import("../../remote/ssh-transport");

        console.log(`Checking connectivity to ${host}...`);
        if (!checkConnectivity(host)) {
          console.error("\x1b[31m✗ Cannot connect. Check SSH configuration.\x1b[0m");
          process.exit(1);
        }

        const existing = checkKCodeInstalled(host);
        if (existing.installed) {
          console.log(`\x1b[33mKCode is already installed (${existing.version ?? "unknown version"})\x1b[0m`);
          return;
        }

        console.log("Installing KCode on remote...");
        const success = await installRemoteKCode(host);
        if (success) {
          console.log("\x1b[32m✓\x1b[0m KCode installed successfully.");
        } else {
          console.error("\x1b[31m✗ Installation failed. Check remote logs.\x1b[0m");
          process.exit(1);
        }
      } catch (err) {
        console.error(`\x1b[31m✗ ${err instanceof Error ? err.message : err}\x1b[0m`);
        process.exit(1);
      }
    });
}
