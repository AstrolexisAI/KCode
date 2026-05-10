// CLI subcommand: kcode ane
//
// User-facing diagnostics for the Apple Neural Engine embedder
// (paid `ane-embedder` addon, macOS-arm64-only). Lets the user run
// the full ANE pipeline end-to-end without having to spin up the
// RAG engine or write a TS probe.

import type { Command } from "commander";

export function registerAneCommand(program: Command): void {
  const aneCmd = program
    .command("ane")
    .description("Apple Neural Engine diagnostics (Pro addon: ane-embedder)");

  // ─── status ───────────────────────────────────────────────
  aneCmd
    .command("status")
    .description("Show ANE addon + helper + model availability")
    .action(async () => {
      const { aneHelperPath, aneModelPath, isANEAvailable } = await import(
        "../../core/rag/ane-embedder"
      );
      const { hasLicenseAddon, getLicenseTier } = await import("../../core/license");
      const { existsSync } = await import("node:fs");

      const tier = getLicenseTier();
      const addon = hasLicenseAddon("ane-embedder");
      const helperOK = existsSync(aneHelperPath());
      const modelOK = existsSync(aneModelPath());
      const platformOK = process.platform === "darwin" && process.arch === "arm64";
      const ready = isANEAvailable() && addon;

      console.log("KCode — Apple Neural Engine status");
      console.log();
      console.log(
        `  Platform        ${platformOK ? "✓" : "✗"} ${process.platform}/${process.arch}${platformOK ? "" : " (ANE requires darwin/arm64)"}`,
      );
      console.log(`  License tier    ${tier ?? "(none)"}`);
      console.log(
        `  Addon licensed  ${addon ? "✓ ane-embedder" : "✗ ane-embedder NOT in license"}`,
      );
      console.log(`  Helper binary   ${helperOK ? "✓" : "✗"} ${aneHelperPath()}`);
      console.log(`  Core ML model   ${modelOK ? "✓" : "✗"} ${aneModelPath()}`);
      console.log();
      if (ready) {
        console.log("  Status: READY — run `kcode ane probe` to test inference.");
      } else {
        console.log("  Status: NOT READY — fix the ✗ items above.");
        if (!helperOK) {
          console.log("    To build helper: cd vendor/ane-embedder && ./build.sh");
        }
        if (!modelOK) {
          console.log("    To convert model: python vendor/ane-embedder/scripts/convert-bge-m3.py");
        }
      }
    });

  // ─── probe ────────────────────────────────────────────────
  aneCmd
    .command("probe")
    .description("Run a real embedding through ANE — measures latency + shows vector head")
    .option(
      "--text <text>",
      "Text to embed (default: a Spanish + English mix)",
      "hola mundo, this is a test of the ane embedder",
    )
    .option(
      "--rounds <n>",
      "Number of warm-up rounds (default 3)",
      (v: string) => parseInt(v, 10),
      3,
    )
    .action(async (opts: { text: string; rounds: number }) => {
      const { ANEEmbedder, isANEAvailable } = await import("../../core/rag/ane-embedder");
      const { hasLicenseAddon } = await import("../../core/license");

      if (!isANEAvailable()) {
        console.error("✗ ANE not available. Run `kcode ane status` for details.");
        process.exit(1);
      }
      if (!hasLicenseAddon("ane-embedder")) {
        console.error("✗ ane-embedder addon not licensed. Contact sales@kulvex.ai.");
        process.exit(1);
      }

      console.log(`Probing ANE with: "${opts.text}"`);
      console.log();
      const embedder = new ANEEmbedder();
      try {
        const timings: number[] = [];
        let lastVec: number[] = [];
        for (let i = 1; i <= Math.max(1, opts.rounds); i++) {
          const start = performance.now();
          lastVec = await embedder.embed(opts.text);
          const ms = performance.now() - start;
          timings.push(ms);
          console.log(`  round ${i}: ${ms.toFixed(1)}ms  (dim=${lastVec.length})`);
        }
        console.log();
        const avg = timings.reduce((a, b) => a + b, 0) / timings.length;
        const min = Math.min(...timings);
        console.log(`  avg ${avg.toFixed(1)}ms  min ${min.toFixed(1)}ms`);
        console.log();
        const head = lastVec
          .slice(0, 8)
          .map((v) => v.toFixed(6))
          .join(", ");
        const tail = lastVec
          .slice(-3)
          .map((v) => v.toFixed(6))
          .join(", ");
        const norm = Math.sqrt(lastVec.reduce((s, v) => s + v * v, 0));
        console.log(`  vector[0..8]:  [${head}]`);
        console.log(`  vector[-3..]:  [${tail}]`);
        console.log(`  L2 norm:       ${norm.toFixed(6)}  (BGE-M3 normalizes to ≈ 1.0)`);
      } catch (err) {
        console.error(`✗ ANE probe failed: ${err instanceof Error ? err.message : err}`);
        process.exit(2);
      } finally {
        embedder.shutdown();
      }
    });

  // ─── similarity ────────────────────────────────────────────
  aneCmd
    .command("similarity <textA> <textB>")
    .description("Embed two texts and report cosine similarity")
    .action(async (textA: string, textB: string) => {
      const { ANEEmbedder, isANEAvailable } = await import("../../core/rag/ane-embedder");
      if (!isANEAvailable()) {
        console.error("✗ ANE not available. Run `kcode ane status` for details.");
        process.exit(1);
      }
      const embedder = new ANEEmbedder();
      try {
        const [a, b] = await embedder.embedBatch([textA, textB]);
        if (!a || !b) {
          console.error("✗ Embedder returned empty vectors");
          process.exit(2);
        }
        const dot = a.reduce((s, v, i) => s + v * (b[i] ?? 0), 0);
        const na = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
        const nb = Math.sqrt(b.reduce((s, v) => s + v * v, 0));
        const cos = dot / (na * nb);
        console.log(`  A: "${textA}"`);
        console.log(`  B: "${textB}"`);
        console.log(`  cosine similarity: ${cos.toFixed(4)}`);
        // BGE-M3 baseline cosine for unrelated text is ~0.7, so the
        // thresholds here are tuned for its distribution rather than
        // a generic 0.0-1.0 split. Calibrated against probe runs:
        //   auth/login:        0.7493
        //   auth/banana split: 0.7270
        //   auth ES/auth EN:   0.7756
        const verdict =
          cos > 0.85
            ? "→ very similar"
            : cos > 0.78
              ? "→ related"
              : cos > 0.72
                ? "→ loosely related"
                : "→ unrelated";
        console.log(`  ${verdict}`);
      } finally {
        embedder.shutdown();
      }
    });
}
