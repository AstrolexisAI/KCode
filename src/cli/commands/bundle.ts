// KCode — `kcode bundle` command
//
// Generate a signed disclosure bundle from a set of confirmed
// findings + their reproducers + (optionally) validation results.
// The output is a tarball with a signature file, suitable for
// attaching to a GitHub Security Advisory, a Bugcrowd submission,
// or a coordinated-disclosure email thread.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import type { Command } from "commander";
import {
  formatInquisitorError,
  InquisitorError,
  requireInquisitor,
  submitToInquisitor,
} from "../../integrations/inquisitor";

interface BundleResponse {
  session_id: string;
  bundle_b64: string;
  bundle_filename: string;
  signature: string;
  format: string;
}

export function registerBundleCommand(program: Command): void {
  program
    .command("bundle <finding-ids...>")
    .description("Generate a signed disclosure bundle from confirmed findings (Inquisitor)")
    .option("-r, --report <path>", "audit report JSON to source findings from", "AUDIT_REPORT.json")
    .option("-f, --format <fmt>", "output format: ghsa, bugcrowd, soc-email, oss-pr", "ghsa")
    .option(
      "-o, --out <path>",
      "output file path (default: ./disclosure-bundle.tar.gz)",
      "./disclosure-bundle.tar.gz",
    )
    .option(
      "--include-repro <dir>",
      "include a pre-built reproducer directory (from `kcode reproduce`)",
    )
    .option("--include-screencast <path>", "include an asciinema .mp4/.gif demo screencast")
    .action(
      async (
        findingIds: string[],
        opts: {
          report: string;
          format: string;
          out: string;
          includeRepro?: string;
          includeScreencast?: string;
        },
      ) => {
        try {
          const reportPath = pathResolve(opts.report);
          if (!existsSync(reportPath)) {
            console.error(`✗ Audit report not found: ${reportPath}`);
            process.exit(2);
          }
          const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
            confirmed?: Array<Record<string, unknown>>;
          };
          const wanted = new Set(findingIds);
          const findings = (report.confirmed ?? []).filter((f) =>
            wanted.has(String(f.id ?? f.finding_id ?? "")),
          );
          if (findings.length === 0) {
            console.error(`✗ None of the requested findings were in the report`);
            process.exit(2);
          }
          if (findings.length !== findingIds.length) {
            const found = new Set(findings.map((f) => String(f.id ?? f.finding_id ?? "")));
            const missing = findingIds.filter((id) => !found.has(id));
            console.error(`! Missing findings (skipped): ${missing.join(", ")}`);
          }

          const repro = opts.includeRepro
            ? readReproDir(pathResolve(opts.includeRepro))
            : undefined;
          const screencast = opts.includeScreencast
            ? readBase64(pathResolve(opts.includeScreencast))
            : undefined;

          const pre = await requireInquisitor("bundle");
          console.log(
            `→ Inquisitor preflight ok (tier=${pre.tier}, balance=${pre.balance}). Generating ${opts.format} bundle for ${findings.length} finding(s)…`,
          );

          const result = await submitToInquisitor<BundleResponse>("bundle", {
            findings,
            format: opts.format,
            repro,
            screencast,
          });

          const outPath = pathResolve(opts.out);
          writeFileSync(outPath, Buffer.from(result.bundle_b64, "base64"));
          writeFileSync(`${outPath}.sig`, result.signature);
          console.log(`\n✓ Bundle: ${outPath}`);
          console.log(`  Signature: ${outPath}.sig`);
          console.log(`  Format: ${result.format}`);
          console.log(`\n  Verify: inquisitor verify ${outPath}`);
        } catch (err) {
          if (err instanceof InquisitorError) {
            console.error(formatInquisitorError(err));
            process.exit(1);
          }
          throw err;
        }
      },
    );
}

function readReproDir(
  dir: string,
): { manifest: unknown; files: Array<{ path: string; content_b64: string }> } | undefined {
  if (!existsSync(dir)) return undefined;
  // Minimal: caller passes a directory; Inquisitor will tar+gzip it
  // on its side. We just hand over the file list + contents as base64
  // so the bridge stays JSON.
  const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
  const out: Array<{ path: string; content_b64: string }> = [];
  const walk = (root: string, prefix: string) => {
    for (const name of readdirSync(root)) {
      const p = `${root}/${name}`;
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = statSync(p);
      if (st.isDirectory()) walk(p, rel);
      else if (st.isFile()) {
        out.push({ path: rel, content_b64: readFileSync(p).toString("base64") });
      }
    }
  };
  walk(dir, "");
  return { manifest: { source: dir, file_count: out.length }, files: out };
}

function readBase64(p: string): string | undefined {
  if (!existsSync(p)) return undefined;
  return readFileSync(p).toString("base64");
}
