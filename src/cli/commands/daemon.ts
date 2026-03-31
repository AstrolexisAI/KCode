// KCode CLI - daemon subcommand
// Manages the KCode background daemon (start, stop, status, sessions).

import type { Command } from "commander";

export function registerDaemonCommand(program: Command): void {
  const daemon = program
    .command("daemon")
    .description("Manage the KCode background daemon");

  // ─── daemon start ───────────────────────────────────────────

  daemon
    .command("start")
    .description("Start the KCode daemon in the foreground")
    .option("-p, --port <port>", "Port to listen on (default: auto 19100-19199)", (v: string) => parseInt(v, 10))
    .action(async (opts: { port?: number }) => {
      try {
        const { startDaemon, isDaemonRunning } = await import("../../bridge/daemon");

        const status = isDaemonRunning();
        if (status.running) {
          console.log(`Daemon already running (PID ${status.pid}, port ${status.port})`);
          process.exit(0);
        }

        console.log("Starting KCode daemon...");
        const result = await startDaemon({ port: opts.port });
        console.log(`Daemon started on 127.0.0.1:${result.port} (PID ${result.pid})`);
        console.log(`Auth token written to ~/.kcode/daemon.token`);
        console.log("\nPress Ctrl+C to stop the daemon.");

        // Keep the process alive
        await new Promise<void>(() => {
          // Never resolves — daemon runs until signal
        });
      } catch (err) {
        console.error(`Failed to start daemon: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });

  // ─── daemon stop ────────────────────────────────────────────

  daemon
    .command("stop")
    .description("Stop the running KCode daemon")
    .action(async () => {
      try {
        const { isDaemonRunning, stopRemoteDaemon } = await import("../../bridge/daemon");

        const status = isDaemonRunning();
        if (!status.running) {
          console.log("No daemon is running.");
          process.exit(0);
        }

        console.log(`Stopping daemon (PID ${status.pid})...`);
        const stopped = stopRemoteDaemon();
        if (stopped) {
          console.log("Daemon stop signal sent.");
        } else {
          console.log("Failed to stop daemon (process may have already exited).");
        }
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });

  // ─── daemon status ──────────────────────────────────────────

  daemon
    .command("status")
    .description("Show the daemon status")
    .action(async () => {
      try {
        const { getDaemonStatus } = await import("../../bridge/daemon");

        const status = await getDaemonStatus();
        if (!status.running) {
          console.log("Daemon is not running.");
          process.exit(0);
        }

        console.log("Daemon is running:");
        console.log(`  PID:      ${status.pid}`);
        console.log(`  Port:     ${status.port}`);
        if (status.uptime !== undefined) {
          const mins = Math.floor(status.uptime / 60);
          const secs = Math.floor(status.uptime % 60);
          console.log(`  Uptime:   ${mins}m ${secs}s`);
        }
        if (status.sessions !== undefined) {
          console.log(`  Sessions: ${status.sessions}`);
        }
        if (status.clients !== undefined) {
          console.log(`  Clients:  ${status.clients}`);
        }
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });

  // ─── daemon sessions ───────────────────────────────────────

  daemon
    .command("sessions")
    .description("List active daemon sessions")
    .action(async () => {
      try {
        const { isDaemonRunning, listDaemonSessions } = await import("../../bridge/daemon");

        const status = isDaemonRunning();
        if (!status.running) {
          console.log("Daemon is not running.");
          process.exit(0);
        }

        const sessions = await listDaemonSessions();
        if (sessions.length === 0) {
          console.log("No active sessions.");
          process.exit(0);
        }

        console.log(`Active sessions (${sessions.length}):\n`);
        for (const s of sessions) {
          console.log(`  ${s.id}`);
          console.log(`    Dir:    ${s.dir}`);
          console.log(`    Status: ${s.status}`);
          console.log(`    Model:  ${s.model}`);
          console.log();
        }
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });
}
