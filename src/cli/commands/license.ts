// KCode — License Management CLI
//
// Subcommands:
//   kcode license status        → show current license (verification only)
//   kcode license deactivate    → remove license from this machine
//   kcode license serve         → launch Web UI for generating licenses
//   kcode license init-keypair  → generate a fresh RSA signing keypair
//   kcode license generate      → CLI-mode quick-gen (for scripting)

import type { Command } from "commander";

export function registerLicenseCommand(program: Command): void {
  const licenseCmd = program
    .command("license")
    .description("Manage your KCode license");

  // ─── status ──────────────────────────────────────────────────

  licenseCmd
    .command("status")
    .description("Show current license status")
    .action(async () => {
      const { formatLicenseStatus } = await import("../../core/license");
      console.log(formatLicenseStatus());
    });

  // ─── deactivate ──────────────────────────────────────────────

  licenseCmd
    .command("deactivate")
    .description("Remove license from this machine")
    .action(async () => {
      const { existsSync, unlinkSync } = await import("node:fs");
      const { kcodePath } = await import("../../core/paths");
      const path = kcodePath("license.jwt");
      if (!existsSync(path)) {
        console.log("No license file found at", path);
        return;
      }
      unlinkSync(path);
      console.log("✓ License removed from this machine.");
    });

  // ─── serve (Web UI) ──────────────────────────────────────────

  licenseCmd
    .command("serve")
    .description("Launch the license generator Web UI on localhost")
    .option("-p, --port <port>", "Port to bind", "11200")
    .option("--host <host>", "Host to bind (default: 127.0.0.1)", "127.0.0.1")
    .option("--open", "Open in browser after starting", false)
    .action(
      async (opts: { port: string; host: string; open: boolean }) => {
        const port = parseInt(opts.port, 10);
        if (!Number.isFinite(port) || port < 1024 || port > 65535) {
          console.error(`Invalid port: ${opts.port} (must be 1024-65535)`);
          process.exit(1);
        }

        const { startLicenseServer } = await import("../../license-ui/server");
        const { url } = await startLicenseServer({ port, host: opts.host });

        console.log(`\n  \x1b[32m✓\x1b[0m License generator running at \x1b[36m${url}\x1b[0m`);
        console.log(`  \x1b[2mPress Ctrl+C to stop.\x1b[0m\n`);

        if (opts.open) {
          try {
            const proc = Bun.spawn(
              process.platform === "darwin"
                ? ["open", url]
                : process.platform === "win32"
                  ? ["cmd", "/c", "start", url]
                  : ["xdg-open", url],
              { stdout: "ignore", stderr: "ignore" },
            );
            proc.unref();
          } catch {
            /* best effort */
          }
        }

        // Keep process alive until Ctrl+C
        await new Promise(() => {});
      },
    );

  // ─── init-keypair ────────────────────────────────────────────

  licenseCmd
    .command("init-keypair")
    .description("Generate a fresh RSA signing keypair (one-time setup)")
    .option("--force", "Overwrite existing keypair (invalidates all prior licenses!)", false)
    .action(async (opts: { force: boolean }) => {
      const { generateKeypair } = await import("../../core/license-signer");
      const result = generateKeypair({ force: opts.force });

      if (result.preserved) {
        console.log(`✓ Existing keypair preserved at ${result.privateKeyPath}`);
        console.log(`  Use --force to regenerate (this will break all prior licenses).`);
      } else {
        console.log(`✓ New keypair generated`);
        console.log(`  Private: ${result.privateKeyPath} (keep secret — 0600 perms)`);
        console.log(`  Public:  ${result.publicKeyPath}`);
      }
      console.log();
      console.log(`Public key (paste into src/core/license.ts KULVEX_LICENSE_PUBLIC_KEY):`);
      console.log();
      console.log(result.publicKeyPem);
    });

  // ─── generate (CLI-mode quick-gen) ───────────────────────────

  licenseCmd
    .command("generate")
    .description("Generate a signed license JWT from CLI flags (for scripts)")
    .requiredOption("--sub <email>", "Subject (customer email)")
    .option("--tier <tier>", "pro | team | enterprise", "pro")
    .option("--seats <n>", "Number of seats", "1")
    .option(
      "--features <list>",
      "Comma-separated features (e.g. pro,enterprise,swarm)",
      "pro",
    )
    .option("--expires <date>", "Expiry as ISO date (e.g. 2027-01-01)")
    .option("--days <n>", "Expiry in N days from now (alternative to --expires)")
    .option("--org <name>", "Organization name")
    .option("--hardware <fingerprint>", "Bind to hardware fingerprint")
    .option("--offline", "Allow offline activation", false)
    .option("-o, --output <path>", "Write JWT to file instead of stdout")
    .action(
      async (opts: {
        sub: string;
        tier: string;
        seats: string;
        features: string;
        expires?: string;
        days?: string;
        org?: string;
        hardware?: string;
        offline: boolean;
        output?: string;
      }) => {
        const { signLicenseWithSummary } = await import("../../core/license-signer");
        const expiresAt = opts.expires
          ? opts.expires
          : opts.days
            ? Math.floor(Date.now() / 1000) + parseInt(opts.days, 10) * 86400
            : Math.floor(Date.now() / 1000) + 365 * 86400; // default 1 year

        try {
          const result = signLicenseWithSummary({
            sub: opts.sub,
            tier: opts.tier as "pro" | "team" | "enterprise",
            seats: parseInt(opts.seats, 10) || 1,
            features: opts.features.split(",").map((s) => s.trim()).filter(Boolean),
            expiresAt,
            orgName: opts.org,
            hardware: opts.hardware ?? null,
            offline: opts.offline,
          });

          if (opts.output) {
            const { writeFileSync } = await import("node:fs");
            writeFileSync(opts.output, result.jwt, "utf-8");
            console.log(`✓ License written to ${opts.output} (expires in ${result.expiresInDays} days)`);
          } else {
            console.log(result.jwt);
          }
        } catch (err) {
          console.error(`Error: ${err instanceof Error ? err.message : err}`);
          process.exit(1);
        }
      },
    );
}
