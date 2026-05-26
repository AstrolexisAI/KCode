// KCode — `kcode disclose` command
//
// Submit a previously-generated disclosure bundle to an intake
// channel: GitHub Security Advisory (PVR), Bugcrowd VDP, vendor
// SOC email, or an OSS hygiene PR.
//
// This step is the last mile of the audit → disclosure pipeline.
// It is gated behind Inquisitor because (a) the intake adapters
// are non-trivial to maintain, (b) some intakes require signed
// bundles, and (c) audit-trail / receipt persistence lives on
// the Inquisitor side.

import { existsSync, readFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import type { Command } from "commander";
import {
  formatInquisitorError,
  InquisitorError,
  requireInquisitor,
  submitToInquisitor,
} from "../../integrations/inquisitor";

interface DiscloseResponse {
  session_id: string;
  submission_id: string;
  intake: string;
  intake_url: string;
  state: "submitted" | "queued" | "rejected";
  message?: string;
}

export function registerDiscloseCommand(program: Command): void {
  program
    .command("disclose <bundle-path>")
    .description("Submit a signed disclosure bundle to an intake channel (Inquisitor)")
    .requiredOption(
      "-i, --intake <target>",
      "intake spec — examples:\n" +
        "    ghsa:owner/repo            (GitHub Security Advisory, requires PVR enabled)\n" +
        "    bugcrowd:engagement-slug   (Bugcrowd VDP / bounty program)\n" +
        "    email:security@vendor.com  (vendor SOC email with bundle attached)\n" +
        "    pr:owner/repo              (open a public PR with hygiene patches only)",
    )
    .option("--dry-run", "validate the bundle + intake spec without actually submitting", false)
    .action(async (bundlePath: string, opts: { intake: string; dryRun: boolean }) => {
      try {
        const p = pathResolve(bundlePath);
        if (!existsSync(p)) {
          console.error(`✗ Bundle not found: ${p}`);
          console.error("  Generate one first with: kcode bundle <finding-ids…>");
          process.exit(2);
        }
        const sigPath = `${p}.sig`;
        if (!existsSync(sigPath)) {
          console.error(`✗ Bundle signature not found: ${sigPath}`);
          console.error("  Re-run `kcode bundle` to produce a signed bundle.");
          process.exit(2);
        }
        const bundle_b64 = readFileSync(p).toString("base64");
        const signature = readFileSync(sigPath, "utf8").trim();

        const pre = await requireInquisitor("disclose");
        console.log(`→ Inquisitor preflight ok (tier=${pre.tier}, balance=${pre.balance}).`);
        console.log(`  ${opts.dryRun ? "Dry-run validation" : "Submitting"} to ${opts.intake}…`);

        const result = await submitToInquisitor<DiscloseResponse>("disclose", {
          bundle_b64,
          signature,
          intake: opts.intake,
          dry_run: opts.dryRun,
        });

        if (opts.dryRun) {
          console.log(`\n✓ Dry-run ok — intake '${result.intake}' would accept the bundle.`);
          return;
        }
        console.log(`\n✓ Submitted: ${result.submission_id}`);
        console.log(`  State:    ${result.state}`);
        console.log(`  Intake:   ${result.intake}`);
        console.log(`  URL:      ${result.intake_url}`);
        if (result.message) console.log(`  Message:  ${result.message}`);
      } catch (err) {
        if (err instanceof InquisitorError) {
          console.error(formatInquisitorError(err));
          process.exit(1);
        }
        throw err;
      }
    });
}
