// KCode — `kcode reproduce` command
//
// Build a standalone, compilable reproducer for a confirmed finding
// surfaced by `kcode audit`. The reproducer is a single-file (or
// minimal multi-file) artifact that demonstrates the bug shape
// outside the upstream repo — the same format that NASA F´ accepted
// for advisory GHSA-x8cp-v4fr-fg2x.
//
// Reproducer synthesis is done by Mender (Inquisitor sidecar);
// KCode acts as the client of the bridge.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join as pathJoin, resolve as pathResolve } from "node:path";
import type { Command } from "commander";
import {
  formatInquisitorError,
  InquisitorError,
  requireInquisitor,
  submitToInquisitor,
} from "../../integrations/inquisitor";

interface ReproduceResponse {
  session_id: string;
  artifacts: Array<{ path: string; content: string; executable?: boolean }>;
  notes?: string;
}

export function registerReproduceCommand(program: Command): void {
  program
    .command("reproduce <finding-id>")
    .description("Build a standalone compilable reproducer for a confirmed finding (Inquisitor)")
    .option(
      "-r, --report <path>",
      "audit report JSON to look up the finding in",
      "AUDIT_REPORT.json",
    )
    .option("-o, --out <dir>", "output directory for the reproducer artifacts", "./repro")
    .option(
      "-l, --language <lang>",
      "preferred reproducer language (c, cpp, java, python, js); default = auto",
    )
    .action(async (findingId: string, opts: { report: string; out: string; language?: string }) => {
      try {
        const reportPath = pathResolve(opts.report);
        if (!existsSync(reportPath)) {
          console.error(`✗ Audit report not found: ${reportPath}`);
          console.error("  Run `kcode audit <path>` first, or pass --report explicitly.");
          process.exit(2);
        }
        const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
          confirmed?: Array<Record<string, unknown>>;
        };
        const finding = (report.confirmed ?? []).find((f) => {
          const id = String(f.id ?? f.finding_id ?? "");
          return id === findingId;
        });
        if (!finding) {
          console.error(`✗ Finding '${findingId}' not found in ${reportPath}`);
          console.error("  Available IDs:");
          for (const f of (report.confirmed ?? []).slice(0, 20)) {
            console.error(`    ${f.id ?? f.finding_id} — ${f.pattern ?? "(no pattern)"}`);
          }
          process.exit(2);
        }

        const pre = await requireInquisitor("reproduce");
        console.log(
          `→ Inquisitor preflight ok (tier=${pre.tier}, balance=${pre.balance}). Building reproducer…`,
        );

        const result = await submitToInquisitor<ReproduceResponse>("reproduce", {
          finding,
          target_language: opts.language,
        });

        const outDir = pathResolve(opts.out);
        mkdirSync(outDir, { recursive: true });
        for (const a of result.artifacts) {
          const dest = pathJoin(outDir, a.path);
          mkdirSync(pathResolve(dest, ".."), { recursive: true });
          writeFileSync(dest, a.content, a.executable ? { mode: 0o755 } : undefined);
          console.log(`  wrote ${dest}`);
        }
        if (result.notes) {
          console.log(`\nNotes from Inquisitor:\n${result.notes}`);
        }
        console.log(`\n✓ Reproducer ready: ${outDir}`);
        console.log(`  Try: cd ${outDir} && make demo`);
      } catch (err) {
        if (err instanceof InquisitorError) {
          console.error(formatInquisitorError(err));
          process.exit(1);
        }
        throw err;
      }
    });
}
