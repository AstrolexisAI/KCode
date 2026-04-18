// KCode — License Management CLI
//
// End-user commands (visible in help):
//   kcode license                → equivalent to `status`
//   kcode license status         → show current license state
//   kcode license activate <jwt> → activate a license from a .jwt file
//   kcode license deactivate     → remove license from this machine
//
// Admin-only commands (HIDDEN from --help, and refuse to run unless a
// private signing key is present on this machine):
//   kcode license serve          → launch Web UI for generating licenses
//   kcode license init-keypair   → generate a fresh RSA signing keypair
//   kcode license generate       → CLI-mode quick-gen (for scripting)
//
// Gating: admin commands check for ~/.kcode/license-signing.pem (or
// KCODE_LICENSE_PRIVATE_KEY env). End users never have that key, so
// those commands are unreachable for them regardless of whether they
// know the subcommand name.

import type { Command } from "commander";

/**
 * Cheap heuristic: does this look like a JWT string rather than a
 * file path? JWTs are three dot-separated base64url chunks with a
 * deterministic header prefix (eyJ = {"al...). Anything else is
 * treated as a path.
 */
function looksLikeJwt(s: string): boolean {
  const t = s.trim();
  if (t.length < 50) return false; // shortest plausible JWT still > 50 chars
  if (t.includes("/") || t.includes("\\")) return false; // path separator → it's a path
  if (t.includes(" ") || t.includes("\n")) return false; // whitespace → not a JWT arg
  const parts = t.split(".");
  if (parts.length !== 3) return false;
  return t.startsWith("eyJ"); // all base64url-encoded {"alg":...} headers start with this
}

/** True if this machine has a private signing key configured. */
function hasPrivateSigningKey(): boolean {
  const { existsSync } = require("node:fs") as typeof import("node:fs");
  const envPath = process.env.KCODE_LICENSE_PRIVATE_KEY;
  if (envPath && existsSync(envPath)) return true;
  const home = process.env.KCODE_HOME ?? `${process.env.HOME ?? ""}/.kcode`;
  return existsSync(`${home}/license-signing.pem`);
}

function refuseIfNotAdmin(cmd: string): boolean {
  if (hasPrivateSigningKey()) return false;
  console.error(
    `\x1b[31m✗\x1b[0m \`kcode license ${cmd}\` is admin-only and requires a private signing key.`,
  );
  console.error(
    `  No signing key found at \x1b[2m~/.kcode/license-signing.pem\x1b[0m or $KCODE_LICENSE_PRIVATE_KEY.`,
  );
  console.error(
    `  If you're an end user trying to activate a license, use: \x1b[1mkcode license activate <file.jwt>\x1b[0m`,
  );
  return true;
}

export function registerLicenseCommand(program: Command): void {
  const licenseCmd = program
    .command("license")
    .description("Manage your KCode license (status / activate / deactivate)")
    .action(async () => {
      // `kcode license` with no subcommand → show status (most common case)
      const { formatLicenseStatus } = await import("../../core/license");
      console.log(formatLicenseStatus());
    });

  // ─── status ──────────────────────────────────────────────────

  licenseCmd
    .command("status")
    .description("Show current license status")
    .action(async () => {
      const { formatLicenseStatus, checkOfflineLicense, formatLicenseFailureGuide } =
        await import("../../core/license");
      console.log(formatLicenseStatus());
      // If a license file exists but failed to verify, surface the
      // actionable fix list below the one-line status. If no file is
      // present at all, we stay silent — not every install needs a
      // license (free tier works fine without one).
      const check = checkOfflineLicense();
      if (!check.valid && check.error && check.error !== "No license file found") {
        console.log();
        console.log(formatLicenseFailureGuide(check.error));
      }
    });

  // ─── activate (end-user primary flow) ────────────────────────

  licenseCmd
    .command("activate [jwt-or-file]")
    .description(
      "Activate a license — accepts a .jwt file path OR the raw JWT string pasted directly. Omit argument for interactive paste prompt.",
    )
    .action(async (jwtOrFile: string | undefined) => {
      const { existsSync, readFileSync, mkdirSync, writeFileSync } = await import(
        "node:fs"
      );
      const { resolve, dirname } = await import("node:path");
      const { kcodePath } = await import("../../core/paths");
      const { verifyLicenseJwt } = await import("../../core/license");

      let token: string;

      if (!jwtOrFile) {
        // Interactive: prompt for paste. User pastes JWT, Enter.
        const { createInterface } = await import("node:readline");
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        token = await new Promise<string>((r) => {
          rl.question(
            "Paste your license JWT (press Enter when done):\n> ",
            (a) => {
              rl.close();
              r(a.trim());
            },
          );
        });
      } else if (looksLikeJwt(jwtOrFile)) {
        // User pasted the JWT directly as the argument.
        token = jwtOrFile.trim();
      } else {
        // Treat as file path (supports ~ expansion).
        const home = process.env.HOME ?? "";
        const expanded = jwtOrFile.startsWith("~/") ? home + jwtOrFile.slice(1) : jwtOrFile;
        const absPath = resolve(expanded);
        if (!existsSync(absPath)) {
          console.error(`\x1b[31m✗\x1b[0m File not found: ${absPath}`);
          console.error(
            `  \x1b[2mTip: if you meant to paste the JWT directly, wrap it in quotes.\x1b[0m`,
          );
          process.exit(1);
        }
        token = readFileSync(absPath, "utf-8").trim();
      }

      if (!token) {
        console.error(`\x1b[31m✗\x1b[0m No license token provided.`);
        process.exit(1);
      }

      const result = verifyLicenseJwt(token);
      if (!result.valid || !result.claims) {
        const { formatLicenseFailureGuide } = await import("../../core/license");
        console.error(formatLicenseFailureGuide(result.error ?? "License invalid"));
        process.exit(1);
      }

      // Install
      const targetPath = kcodePath("license.jwt");
      try {
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, token, "utf-8");
      } catch (err) {
        console.error(`\x1b[31m✗\x1b[0m Failed to save license: ${err}`);
        process.exit(1);
      }

      const c = result.claims;
      const daysLeft = Math.floor((c.exp - Math.floor(Date.now() / 1000)) / 86400);
      console.log(`\x1b[32m✓\x1b[0m License activated.`);
      console.log(`  Subject:  ${c.sub}`);
      console.log(`  Tier:     ${c.tier ?? "pro"}`);
      console.log(`  Seats:    ${c.seats}`);
      console.log(`  Features: ${c.features.join(", ")}`);
      console.log(`  Expires:  ${daysLeft} days (${new Date(c.exp * 1000).toISOString().slice(0, 10)})`);
      if (c.hardware) {
        console.log(`  \x1b[2mHardware-bound\x1b[0m`);
      }
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

  // ─── serve (Web UI) — ADMIN-ONLY, hidden from help ───────────

  licenseCmd
    .command("serve", { hidden: true })
    .description("[ADMIN] Launch the license generator Web UI on localhost")
    .option("-p, --port <port>", "Port to bind", "11200")
    .option("--host <host>", "Host to bind (default: 127.0.0.1)", "127.0.0.1")
    .option("--open", "Open in browser after starting", false)
    .action(
      async (opts: { port: string; host: string; open: boolean }) => {
        if (refuseIfNotAdmin("serve")) process.exit(1);

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

  // ─── init-keypair ── ADMIN-ONLY, hidden from help ────────────
  //
  // Special case: init-keypair is the ONE admin command that can run
  // without a pre-existing private key — because it creates one.
  // But it still shouldn't appear in --help for end users. Any user
  // who runs it gets a keypair but that alone doesn't help them
  // generate licenses because the public key in their kcode binary
  // won't match, so verifications of any JWTs they'd sign would fail.

  licenseCmd
    .command("init-keypair", { hidden: true })
    .description("[ADMIN] Generate a fresh RSA signing keypair (one-time setup)")
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

  // ─── generate (CLI-mode quick-gen) — ADMIN-ONLY, hidden ──────

  licenseCmd
    .command("generate", { hidden: true })
    .description("[ADMIN] Generate a signed license JWT from CLI flags (for scripts)")
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
        if (refuseIfNotAdmin("generate")) process.exit(1);
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
