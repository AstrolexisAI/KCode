import type { Command } from "commander";
import { HardwareDetector } from "../../core/hardware/detector";
import { HardwareOptimizer } from "../../core/hardware/optimizer";
import { getTotalVram } from "../../core/hardware/profiles";
import type { HardwareProfile, ModelRecommendation } from "../../core/hardware/types";
import { getAvailableModels, runSetup } from "../../core/model-manager";

function formatHardwareProfile(profile: HardwareProfile): string {
  const lines: string[] = [];
  lines.push(
    `  CPU:  ${profile.cpu.model} (${profile.cpu.cores} cores, ${profile.cpu.threads} threads${profile.cpu.features.length > 0 ? ", " + profile.cpu.features.join(", ").toUpperCase() : ""})`,
  );
  lines.push(`  RAM:  ${profile.memory.totalGb} GB (${profile.memory.availableGb} GB available)`);
  if (profile.gpus.length > 0) {
    for (const gpu of profile.gpus) {
      const parts = [`${gpu.model}`];
      if (gpu.vramGb > 0) parts.push(`${gpu.vramGb} GB VRAM`);
      if (gpu.computeCapability) parts.push(`CUDA ${gpu.computeCapability}`);
      if (gpu.driver) parts.push(`driver ${gpu.driver}`);
      lines.push(`  GPU:  ${parts.join(", ")}`);
    }
  } else {
    lines.push("  GPU:  None detected");
  }
  lines.push(
    `  Disk: ${profile.storage.availableGb} GB ${profile.storage.type.toUpperCase()} available`,
  );
  return lines.join("\n");
}

function formatRecommendation(
  rec: ModelRecommendation,
  index: number,
  isRecommended: boolean,
): string {
  const tag = isRecommended ? " [RECOMMENDED]" : "";
  const lines: string[] = [];
  lines.push(`  #${index + 1}${tag} ${rec.model}`);
  lines.push(
    `     VRAM: ${rec.vramRequired} GB | RAM: ${rec.ramRequired} GB | Context: ${(rec.contextWindow / 1024).toFixed(0)}K | ~${rec.estimatedTps} tok/s`,
  );
  lines.push(`     "${rec.reason}"`);
  return lines.join("\n");
}

export function registerSetupCommand(
  program: Command,
  exitWithPause: (code: number, errorMsg?: string) => Promise<never>,
): void {
  program
    .command("setup")
    .description("Auto-detect hardware, download engine and AI model")
    .option("--model <codename>", "Install a specific model (e.g. mnemo:mark5-14b)")
    .option("--force", "Force re-download even if already installed")
    .option("--list", "List available models")
    .option("--auto", "Auto-detect hardware and recommend optimal model configuration")
    .action(async (opts: { model?: string; force?: boolean; list?: boolean; auto?: boolean }) => {
      if (opts.list) {
        console.log("\nAvailable mnemo:mark5 models:\n");
        for (const m of getAvailableModels()) {
          console.log(
            `  ${m.codename.padEnd(20)} ${m.paramBillions}B params, ~${m.sizeGB} GB — ${m.description}`,
          );
          console.log(`  ${"".padEnd(20)} Min VRAM: ${(m.minVramMB / 1024).toFixed(0)} GB`);
        }
        console.log();
        return;
      }

      if (opts.auto) {
        try {
          console.log("\nDetecting hardware...\n");

          const detector = new HardwareDetector();
          const profile = await detector.detect();

          console.log(formatHardwareProfile(profile));
          console.log("\nRecommendations:\n");

          const optimizer = new HardwareOptimizer();
          const recs = optimizer.recommend(profile);

          if (recs.length === 0) {
            console.log("  No suitable models found for this hardware.");
            return;
          }

          for (let i = 0; i < recs.length; i++) {
            console.log(formatRecommendation(recs[i], i, i === 0));
            console.log();
          }

          // Show the optimized config for the top recommendation
          const topRec = recs[0];
          const llamaConfig = optimizer.generateLlamaCppConfig(topRec, profile);

          console.log("Optimized llama.cpp config for #1:");
          console.log(`  context_size: ${llamaConfig.contextSize}`);
          console.log(`  batch_size: ${llamaConfig.batchSize}`);
          console.log(`  threads: ${llamaConfig.threads}`);
          console.log(
            `  gpu_layers: ${llamaConfig.gpuLayers === -1 ? "-1 (all)" : llamaConfig.gpuLayers}`,
          );
          console.log(`  flash_attention: ${llamaConfig.flashAttention ? "enabled" : "disabled"}`);
          console.log(`  mmap: ${llamaConfig.mmap ? "enabled" : "disabled"}`);
          console.log(`  numa: ${llamaConfig.numa}`);
          console.log();
        } catch (err) {
          console.error(
            `\x1b[31mHardware detection failed: ${err instanceof Error ? err.message : err}\x1b[0m`,
          );
          await exitWithPause(1);
        }
        return;
      }

      try {
        await runSetup({ model: opts.model, force: opts.force });
      } catch (err) {
        console.error(`\x1b[31mSetup failed: ${err instanceof Error ? err.message : err}\x1b[0m`);
        await exitWithPause(1);
      }
    });
}
