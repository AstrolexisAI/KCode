// KCode CLI - `kulvex` command
//
// Inspect/control the Kulvex platform discovery used at startup. KCode
// probes localhost on configured ports to find a Kulvex inference
// service and shares its loaded model instead of starting its own.

import type { Command } from "commander";

export function registerKulvexCommand(program: Command): void {
  const kulvex = program
    .command("kulvex")
    .description("Inspect Kulvex platform discovery (shared inference)");

  kulvex
    .command("status")
    .description("Probe configured Kulvex endpoints and report what's reachable")
    .action(async () => {
      const { discoverKulvex } = await import("../../core/kulvex-discovery");
      const start = Date.now();
      const result = await discoverKulvex();
      const elapsedMs = Date.now() - start;

      if (!result) {
        console.log("Kulvex discovery: no shared endpoint reachable.");
        console.log(`  Probed in ${elapsedMs}ms`);
        console.log("  KCode will start its own local mlx_lm.server on next run.");
        console.log("");
        console.log("  Override endpoints:");
        console.log("    KCODE_KULVEX_ENDPOINTS=http://localhost:8090,http://other-host:9000");
        console.log("  Disable discovery:");
        console.log("    KCODE_KULVEX_DISCOVER=off");
        return;
      }

      console.log("Kulvex discovery: shared inference available.");
      console.log(`  Endpoint: ${result.baseUrl}`);
      console.log(`  Model:    ${result.modelId}`);
      console.log(`  Backend:  ${result.backend}`);
      console.log(`  Probed in ${elapsedMs}ms`);
      console.log("");
      console.log("  Next 'kcode' run will route through this endpoint instead of starting");
      console.log("  its own server, sharing the loaded model in unified memory.");
    });
}
