import type { Command } from "commander";
import { formatDeepDiagnostics, runDeepDiagnostics, runDiagnostics } from "../../core/doctor";
import { renderHealthReport, runHealthChecks } from "../../core/doctor/health-score";
import { getProfileReport, printProfileReport } from "../../core/startup-profiler";

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Check KCode setup and diagnose issues")
    .option(
      "--deep",
      "Run extended diagnostics (MCP health, storage, plugins, security, config origin)",
    )
    .option("--legacy", "Use legacy diagnostic format (without health score)")
    .option(
      "--providers",
      "Probe every configured cloud provider (auth + content round-trip) to pinpoint which one is behind 'empty response' errors",
    )
    .action(async (opts: { deep?: boolean; legacy?: boolean; providers?: boolean }) => {
      if (opts.providers) {
        const { probeAllProviders, renderProbeReport } = await import(
          "../../core/doctor/provider-probe"
        );
        console.log("Probing configured cloud providers...\n");
        const results = await probeAllProviders();
        console.log(renderProbeReport(results));
        console.log();
        const failures = results.filter(
          (r) => r.configured && (!r.auth.reachable || !r.content.ok),
        );
        if (failures.length > 0) {
          console.log(
            `\x1b[33m  ${failures.length} provider(s) had issues. See details above.\x1b[0m`,
          );
          process.exitCode = 1;
        } else {
          const configured = results.filter((r) => r.configured).length;
          console.log(`\x1b[32m  All ${configured} configured provider(s) responded with content.\x1b[0m`);
        }
        return;
      }
      if (opts.legacy) {
        // Legacy format
        console.log("KCode Doctor\n");
        const results = await runDiagnostics();
        const icons = {
          ok: "\x1b[32m✓\x1b[0m",
          warn: "\x1b[33m⚠\x1b[0m",
          fail: "\x1b[31m✗\x1b[0m",
        };
        for (const r of results) {
          console.log(`  ${icons[r.status]} ${r.name}: ${r.message}`);
        }
        const fails = results.filter((r) => r.status === "fail").length;
        const warns = results.filter((r) => r.status === "warn").length;
        console.log();
        if (fails > 0) console.log(`\x1b[31m${fails} issue(s) need attention.\x1b[0m`);
        else if (warns > 0)
          console.log(`\x1b[33m${warns} warning(s), but KCode should work.\x1b[0m`);
        else console.log("\x1b[32mAll checks passed!\x1b[0m");
      } else {
        // New health score format
        const report = await runHealthChecks();
        console.log(renderHealthReport(report));

        // Exit code based on score
        if (report.score < 60) process.exitCode = 1;
      }

      // Startup performance profile
      const profileEntries = getProfileReport();
      if (profileEntries.length > 0) {
        console.log("\n\x1b[1mPerformance:\x1b[0m");
        printProfileReport();
        console.log();
      }

      // Deep diagnostics
      if (opts.deep) {
        console.log("\n\x1b[1m═══ Deep Diagnostics ═══════════════════════════════\x1b[0m");
        const deepSections = await runDeepDiagnostics();
        console.log(formatDeepDiagnostics(deepSections));
        console.log();
      }
    });
}
