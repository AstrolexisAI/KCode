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
        const host = opts.host ?? "127.0.0.1";
        const isLocal = host === "127.0.0.1" || host === "localhost" || host === "::1";

        // Require --api-key when binding beyond localhost
        if (!isLocal && !opts.apiKey) {
          console.error(
            "\x1b[31mError:\x1b[0m --api-key is required when binding to a non-localhost address.\n" +
              "Exposing KCode without authentication is a security risk.\n" +
              "Use: kcode serve --host " +
              host +
              " --api-key <secret>",
          );
          process.exit(1);
        }

        // Warn on 0.0.0.0 even with api-key
        if (host === "0.0.0.0" && opts.apiKey) {
          console.warn(
            "\x1b[33m⚠ Warning:\x1b[0m Binding to 0.0.0.0 exposes KCode to all network interfaces.\n" +
              "  Ensure this server is behind a firewall or reverse proxy.\n",
          );
        }

        const { startHttpServer } = await import("../../core/http-server.js");
        process.env.KCODE_VERSION = VERSION;
        await startHttpServer({
          port: opts.port ?? 10101,
          host,
          apiKey: opts.apiKey,
        });
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });
}
