import type { Command } from "commander";

export function registerServeCommand(program: Command, VERSION: string): void {
  program
    .command("serve")
    .description("Start KCode as an HTTP API server")
    .option("-p, --port <port>", "Port to listen on", (v: string) => parseInt(v, 10), 10101)
    .option("-h, --host <host>", "Host to bind to", "127.0.0.1")
    .option("--api-key <key>", "Require this API key for authentication")
    .action(async (opts: { port?: number; host?: string; apiKey?: string }) => {
      try {
        const { startHttpServer } = await import("../../core/http-server.js");
        process.env.KCODE_VERSION = VERSION;
        await startHttpServer({
          port: opts.port ?? 10101,
          host: opts.host ?? "127.0.0.1",
          apiKey: opts.apiKey,
        });
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });
}
