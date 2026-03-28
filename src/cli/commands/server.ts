import type { Command } from "commander";
import { startServer, stopServer, getServerStatus } from "../../core/llama-server";

export function registerServerCommand(program: Command): void {
  const serverCmd = program
    .command("server")
    .description("Manage the local inference server (llama-server)");

  serverCmd
    .command("start")
    .description("Start the llama-server")
    .option("--port <port>", "Override server port", (v: string) => parseInt(v, 10))
    .action(async (opts: { port?: number }) => {
      try {
        console.log("Starting inference server...");
        const { port, pid } = await startServer({ port: opts.port });
        console.log(`\x1b[32m✓\x1b[0m Server running on port ${port} (PID: ${pid})`);
      } catch (err) {
        console.error(`\x1b[31m✗ ${err instanceof Error ? err.message : err}\x1b[0m`);
        process.exit(1);
      }
    });

  serverCmd
    .command("stop")
    .description("Stop the llama-server")
    .action(async () => {
      await stopServer();
      console.log("Server stopped.");
    });

  serverCmd
    .command("status")
    .description("Show server status")
    .action(async () => {
      const status = await getServerStatus();
      if (status.running) {
        console.log(`\x1b[32m● Running\x1b[0m on port ${status.port} (PID: ${status.pid})`);
        if (status.model) console.log(`  Model: ${status.model}`);
      } else {
        console.log("\x1b[2m○ Not running\x1b[0m");
        console.log("  Start with: kcode server start");
      }
    });

  serverCmd
    .command("restart")
    .description("Restart the llama-server")
    .action(async () => {
      console.log("Restarting server...");
      await stopServer();
      const { port, pid } = await startServer();
      console.log(`\x1b[32m✓\x1b[0m Server restarted on port ${port} (PID: ${pid})`);
    });
}
