import type { Command } from "commander";
import { runDiagnostics } from "../../core/doctor";

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Check KCode setup and diagnose issues")
    .action(async () => {
      console.log("KCode Doctor\n");
      const results = await runDiagnostics();

      const icons = { ok: "\x1b[32m✓\x1b[0m", warn: "\x1b[33m⚠\x1b[0m", fail: "\x1b[31m✗\x1b[0m" };

      for (const r of results) {
        console.log(`  ${icons[r.status]} ${r.name}: ${r.message}`);
      }

      const fails = results.filter((r) => r.status === "fail").length;
      const warns = results.filter((r) => r.status === "warn").length;
      console.log();

      if (fails > 0) {
        console.log(`\x1b[31m${fails} issue(s) need attention.\x1b[0m`);
        process.exit(1);
      } else if (warns > 0) {
        console.log(`\x1b[33m${warns} warning(s), but KCode should work.\x1b[0m`);
      } else {
        console.log("\x1b[32mAll checks passed!\x1b[0m");
      }
    });
}
