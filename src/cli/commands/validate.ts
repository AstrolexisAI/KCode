// KCode — `kcode validate` command
//
// Run a binary scan against a compiled target to confirm that a
// static finding actually crashes the binary under adversarial
// input. Delegates to Inquisitor's VulnHunter agent.

import { existsSync, statSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import type { Command } from "commander";
import {
  formatInquisitorError,
  InquisitorError,
  requireInquisitor,
  submitToInquisitor,
} from "../../integrations/inquisitor";

interface ValidateResponse {
  session_id: string;
  job_id: string;
  status: "running" | "done" | "failed";
  crashes: Array<{
    input_b64: string;
    signal?: string;
    exit_code?: number;
    short_trace?: string;
  }>;
  runs_completed: number;
  duration_seconds: number;
}

export function registerValidateCommand(program: Command): void {
  program
    .command("validate <binary>")
    .description(
      "Run adversarial-input binary scan against a target to validate findings (Inquisitor)",
    )
    .option("-f, --finding <id>", "validate a specific finding from the audit report")
    .option("-n, --probes <n>", "number of scenarios to generate", "10")
    .option("-r, --reruns <n>", "reruns per scenario to filter false positives", "4")
    .action(async (binary: string, opts: { finding?: string; probes: string; reruns: string }) => {
      try {
        const binPath = pathResolve(binary);
        if (!existsSync(binPath)) {
          console.error(`✗ Binary not found: ${binPath}`);
          process.exit(2);
        }
        const st = statSync(binPath);
        if (!st.isFile()) {
          console.error(`✗ Not a regular file: ${binPath}`);
          process.exit(2);
        }

        const pre = await requireInquisitor("validate");
        console.log(
          `→ Inquisitor preflight ok (tier=${pre.tier}, balance=${pre.balance}). Submitting scan…`,
        );

        const result = await submitToInquisitor<ValidateResponse>("validate", {
          binary_path: binPath,
          finding_id: opts.finding,
          probes: Number(opts.probes),
          reruns: Number(opts.reruns),
        });

        console.log(`\n✓ Scan job ${result.job_id} ${result.status}`);
        console.log(`  Runs: ${result.runs_completed} · Duration: ${result.duration_seconds}s`);
        if (result.crashes.length === 0) {
          console.log(`  Crashes: 0 — VulnHunter could not validate the finding`);
        } else {
          console.log(`  Crashes: ${result.crashes.length}`);
          for (const [i, c] of result.crashes.entries()) {
            console.log(
              `    [${i + 1}] signal=${c.signal ?? "?"} exit=${c.exit_code ?? "?"}` +
                (c.short_trace ? `\n        ${c.short_trace.split("\n")[0]}` : ""),
            );
          }
          console.log(`\n  Pull full crash details: inquisitor inspect ${result.job_id} --full`);
        }
      } catch (err) {
        if (err instanceof InquisitorError) {
          console.error(formatInquisitorError(err));
          process.exit(1);
        }
        throw err;
      }
    });
}
