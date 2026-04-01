// KCode - Web UI Command
// Starts the browser-based UI server with WebSocket streaming
//
// Usage:
//   kcode web                  # Start web UI on localhost:19300
//   kcode web --port 8080      # Custom port
//   kcode web --no-open        # Don't open browser automatically

import type { Command } from "commander";

export function registerWebCommand(program: Command): void {
  program
    .command("web")
    .description("Start the browser-based Web UI")
    .option("-p, --port <port>", "Port to listen on", (v: string) => parseInt(v, 10))
    .option("--host <host>", "Host to bind to", "127.0.0.1")
    .option("--no-open", "Don't open browser automatically")
    .option("--no-auth", "Disable token authentication (insecure)")
    .action(async (opts: { port?: number; host?: string; open?: boolean; auth?: boolean }) => {
      try {
        const { WebServer } = await import("../../web/server");

        const server = new WebServer({
          port: opts.port ?? 19300,
          host: opts.host ?? "127.0.0.1",
          auth: {
            enabled: opts.auth !== false,
            token: crypto.randomUUID(),
          },
          openBrowser: opts.open !== false,
        });

        const { url, token } = await server.start();

        console.log();
        console.log(`\x1b[1m\x1b[36mKCode Web UI\x1b[0m`);
        console.log(`  URL:   ${url}`);
        if (opts.auth !== false) {
          console.log(`  Token: ${token}`);
        }
        console.log();
        console.log(`  Press Ctrl+C to stop the server.`);
        console.log();

        // Open browser if requested
        if (opts.open !== false) {
          const fullUrl = opts.auth !== false ? `${url}?token=${token}` : url;
          try {
            const { exec } = await import("node:child_process");
            const cmd =
              process.platform === "darwin"
                ? "open"
                : process.platform === "win32"
                  ? "start"
                  : "xdg-open";
            exec(`${cmd} "${fullUrl}"`);
          } catch {
            console.log(`  Open in browser: ${fullUrl}`);
          }
        }

        // Keep alive
        await new Promise(() => {}); // Block forever until Ctrl+C
      } catch (err) {
        console.error(
          `\x1b[31mFailed to start Web UI:\x1b[0m ${err instanceof Error ? err.message : err}`,
        );
        process.exit(1);
      }
    });
}
