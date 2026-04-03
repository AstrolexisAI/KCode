import type { Command } from "commander";
import { kcodePath } from "../../core/paths";

export function registerTeachCommand(program: Command): void {
  const teachCmd = program
    .command("teach")
    .description("Teach KCode about your environment, collect training data, and fine-tune models");

  // ─── Training Data Collection ───────────────────────────────

  teachCmd
    .command("collect")
    .description("Enable training data collection for fine-tuning")
    .action(async () => {
      const { writeFileSync, existsSync, readFileSync, mkdirSync } = await import("node:fs");
      const { join } = await import("node:path");
      const settingsPath = kcodePath("settings.json");

      let settings: Record<string, unknown> = {};
      if (existsSync(settingsPath)) {
        try {
          settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
        } catch {
          /* fresh settings */
        }
      }

      settings.trainingDataCollection = true;
      mkdirSync(kcodePath(), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");

      console.log("\x1b[32m+\x1b[0m Training data collection \x1b[1menabled\x1b[0m.");
      console.log("  Accepted, rejected, and edited responses will be saved to:");
      console.log(`  ${kcodePath("training-data", "pairs.jsonl")}`);
      console.log("\n  View stats:  \x1b[1mkcode teach stats\x1b[0m");
      console.log("  Export data: \x1b[1mkcode teach export\x1b[0m");
    });

  teachCmd
    .command("stats")
    .description("Show training data collection statistics")
    .action(async () => {
      const { DataCollector } = await import("../../core/training/data-collector");
      const collector = new DataCollector();
      const stats = collector.getStats();

      console.log("\n\x1b[1mTraining Data Statistics\x1b[0m\n");
      console.log(`  Total pairs:    ${stats.total}`);
      console.log(`  Accepted:       \x1b[32m${stats.accepted}\x1b[0m`);
      console.log(`  Rejected:       \x1b[31m${stats.rejected}\x1b[0m`);
      console.log(`  Edited:         \x1b[33m${stats.edited}\x1b[0m`);
      console.log(`  Size on disk:   ${(stats.sizeBytes / 1024).toFixed(1)} KB`);

      if (stats.total === 0) {
        console.log(
          "\n  No data collected yet. Enable collection with: \x1b[1mkcode teach collect\x1b[0m",
        );
      } else if (stats.total < 100) {
        console.log(
          `\n  \x1b[33m!\x1b[0m Need at least 100 pairs for fine-tuning (${100 - stats.total} more needed).`,
        );
      } else {
        console.log(
          `\n  \x1b[32m*\x1b[0m Ready for fine-tuning! Run: \x1b[1mkcode teach train\x1b[0m`,
        );
      }
    });

  teachCmd
    .command("export")
    .description("Export training data as JSONL for fine-tuning")
    .option("-o, --output <path>", "Output file path", "./kcode-training-data.jsonl")
    .action(async (opts: { output: string }) => {
      const { resolve } = await import("node:path");
      const { DataCollector } = await import("../../core/training/data-collector");

      const collector = new DataCollector();
      const outputPath = resolve(opts.output);
      const count = await collector.exportJSONL(outputPath);

      if (count === 0) {
        console.log(
          "\x1b[33m!\x1b[0m No exportable data (only accepted/edited pairs are exported).",
        );
        return;
      }

      console.log(`\x1b[32m+\x1b[0m Exported ${count} training pairs to:`);
      console.log(`  ${outputPath}`);
      console.log(`\n  Format: OpenAI-compatible JSONL (messages array)`);
    });

  teachCmd
    .command("train")
    .description("Start fine-tuning a model with collected training data")
    .option("-m, --model <model>", "Base model name or path", "unsloth/llama-3-8b-bnb-4bit")
    .option("--method <method>", "Fine-tuning method: lora, qlora, full", "qlora")
    .option("--epochs <n>", "Number of training epochs", "3")
    .option("--lr <rate>", "Learning rate", "2e-4")
    .option("--lora-rank <n>", "LoRA rank", "16")
    .option("-o, --output <dir>", "Output directory", "./kcode-finetune-output")
    .action(
      async (opts: {
        model: string;
        method: string;
        epochs: string;
        lr: string;
        loraRank: string;
        output: string;
      }) => {
        const { resolve, join } = await import("node:path");
        const { DataCollector } = await import("../../core/training/data-collector");
        const { FineTuner } = await import("../../core/training/fine-tuner");

        // First export the data
        const collector = new DataCollector();
        const stats = collector.getStats();

        if (stats.total < 100) {
          console.log(
            `\x1b[31m!\x1b[0m Insufficient training data: ${stats.total} pairs (need 100+).`,
          );
          console.log("  Continue collecting data with normal KCode usage.");
          return;
        }

        const outputDir = resolve(opts.output);
        const exportPath = join(outputDir, "training-data.jsonl");
        const count = await collector.exportJSONL(exportPath);

        if (count < 100) {
          console.log(`\x1b[31m!\x1b[0m Only ${count} usable pairs after filtering (need 100+).`);
          return;
        }

        const config: FineTuneConfig = {
          baseModel: opts.model,
          trainingDataPath: exportPath,
          outputDir,
          method: opts.method as "lora" | "qlora" | "full",
          epochs: parseInt(opts.epochs, 10),
          learningRate: parseFloat(opts.lr),
          loraRank: parseInt(opts.loraRank, 10),
        };

        console.log("\n\x1b[1mFine-tuning Configuration\x1b[0m\n");
        console.log(`  Base model:   ${config.baseModel}`);
        console.log(`  Method:       ${config.method}`);
        console.log(`  Epochs:       ${config.epochs}`);
        console.log(`  Learning rate: ${config.learningRate}`);
        console.log(`  LoRA rank:    ${config.loraRank}`);
        console.log(`  Training data: ${count} pairs`);
        console.log(`  Output:       ${config.outputDir}`);

        const tuner = new FineTuner();
        const validation = await tuner.validate(config);

        if (!validation.ready) {
          console.log("\n\x1b[31m!\x1b[0m Validation failed:\n");
          for (const issue of validation.issues) {
            console.log(`  - ${issue}`);
          }
          return;
        }

        console.log("\n\x1b[32m*\x1b[0m Validation passed. Starting training...\n");

        const result = await tuner.run(config, (msg) => {
          console.log(`  ${msg}`);
        });

        if (result.success) {
          console.log(`\n\x1b[32m+\x1b[0m Fine-tuning complete!`);
          console.log(`  Duration: ${(result.duration / 1000).toFixed(1)}s`);
          if (result.adapterPath) {
            console.log(`  Adapter:  ${result.adapterPath}`);
          }
        } else {
          console.log(`\n\x1b[31m!\x1b[0m Fine-tuning failed: ${result.error}`);
        }
      },
    );

  teachCmd
    .command("review")
    .description("Show a sample of collected training pairs")
    .option("-n, --count <n>", "Number of pairs to show", "5")
    .action(async (opts: { count: string }) => {
      const { DataCollector } = await import("../../core/training/data-collector");
      const collector = new DataCollector();
      const pairs = collector.readPairs();

      if (pairs.length === 0) {
        console.log("\x1b[33m!\x1b[0m No training data collected yet.");
        console.log("  Enable collection with: \x1b[1mkcode teach collect\x1b[0m");
        return;
      }

      const count = Math.min(parseInt(opts.count, 10) || 5, pairs.length);
      // Show the most recent pairs
      const recent = pairs.slice(-count).reverse();

      console.log(`\n\x1b[1mRecent Training Pairs\x1b[0m (${count} of ${pairs.length} total)\n`);

      for (const pair of recent) {
        const status = pair.editedResponse
          ? "\x1b[33mEdited\x1b[0m"
          : pair.accepted
            ? "\x1b[32mAccepted\x1b[0m"
            : "\x1b[31mRejected\x1b[0m";
        const date = new Date(pair.timestamp).toLocaleString();
        const promptPreview =
          pair.prompt.length > 80 ? pair.prompt.slice(0, 77) + "..." : pair.prompt;
        const responsePreview = pair.editedResponse ?? pair.response;
        const respShort =
          responsePreview.length > 80 ? responsePreview.slice(0, 77) + "..." : responsePreview;

        console.log(`  [${status}] ${date} (${pair.model})`);
        console.log(`  \x1b[2mPrompt:\x1b[0m ${promptPreview}`);
        console.log(`  \x1b[2mResponse:\x1b[0m ${respShort}`);
        console.log("");
      }
    });

  // ─── Awareness Modules (original teach subcommands) ─────────

  teachCmd
    .command("add <name>")
    .description("Create a new awareness module (opens in $EDITOR)")
    .option("-g, --global", "Create in ~/.kcode/awareness/ instead of project")
    .action(async (name: string, opts: { global?: boolean }) => {
      const { join } = await import("node:path");
      const { mkdirSync, existsSync, writeFileSync } = await import("node:fs");
      const { execSync } = await import("node:child_process");

      const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/-$/, "");
      const dir = opts.global ? kcodePath("awareness") : join(process.cwd(), ".kcode", "awareness");

      mkdirSync(dir, { recursive: true });
      const filePath = join(dir, `${slug}.md`);

      if (existsSync(filePath)) {
        console.log(`\x1b[33m!\x1b[0m Already exists: ${filePath}`);
        console.log("  Edit it with: $EDITOR " + filePath);
        return;
      }

      const template = `# ${name}

<!-- KCode loads this file into every session automatically. -->
<!-- Write anything you want KCode to always know about. -->
<!-- Examples: API endpoints, device IPs, project conventions, team rules. -->

`;
      writeFileSync(filePath, template, "utf-8");
      console.log(`\x1b[32m+\x1b[0m Created: ${filePath}`);

      const editor = process.env.EDITOR || process.env.VISUAL || "nano";
      try {
        const { execFileSync: editorExec } = await import("node:child_process");
        editorExec(editor, [filePath], { stdio: "inherit" });
      } catch {
        console.log(`  Edit it with: ${editor} ${filePath}`);
      }
    });

  teachCmd
    .command("list")
    .description("List all awareness modules")
    .action(async () => {
      const { join } = await import("node:path");
      const { readdirSync, existsSync, readFileSync, statSync } = await import("node:fs");

      const globalDir = kcodePath("awareness");
      const projectDir = join(process.cwd(), ".kcode", "awareness");

      let found = false;

      for (const [label, dir] of [
        ["Global", globalDir],
        ["Project", projectDir],
      ] as const) {
        if (!existsSync(dir)) continue;
        const files = readdirSync(dir)
          .filter((f) => f.endsWith(".md"))
          .sort();
        if (files.length === 0) continue;

        found = true;
        console.log(`\n\x1b[1m${label}\x1b[0m \x1b[2m(${dir})\x1b[0m`);
        for (const f of files) {
          const content = readFileSync(join(dir, f), "utf-8");
          const firstLine =
            content
              .split("\n")
              .find((l) => l.startsWith("# "))
              ?.replace("# ", "") || f;
          const size = statSync(join(dir, f)).size;
          console.log(`  \x1b[36m${f}\x1b[0m — ${firstLine} \x1b[2m(${size} bytes)\x1b[0m`);
        }
      }

      if (!found) {
        console.log("\nNo awareness modules found.");
        console.log("Create one with: \x1b[1mkcode teach add <name>\x1b[0m");
        console.log("\nExamples:");
        console.log("  kcode teach add sonoff       # Teach about IoT devices");
        console.log("  kcode teach add deploy        # Teach deployment steps");
        console.log("  kcode teach add team-rules    # Teach coding conventions");
      }
    });

  teachCmd
    .command("remove <name>")
    .description("Remove an awareness module")
    .option("-g, --global", "Remove from ~/.kcode/awareness/")
    .action(async (name: string, opts: { global?: boolean }) => {
      const { join } = await import("node:path");
      const { existsSync, unlinkSync } = await import("node:fs");

      const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/-$/, "");
      const dir = opts.global ? kcodePath("awareness") : join(process.cwd(), ".kcode", "awareness");

      const filePath = join(dir, `${slug}.md`);
      if (!existsSync(filePath)) {
        console.log(`\x1b[31m!\x1b[0m Not found: ${filePath}`);
        return;
      }

      unlinkSync(filePath);
      console.log(`\x1b[32m-\x1b[0m Removed: ${filePath}`);
    });

  teachCmd
    .command("edit <name>")
    .description("Edit an existing awareness module")
    .option("-g, --global", "Edit from ~/.kcode/awareness/")
    .action(async (name: string, opts: { global?: boolean }) => {
      const { join } = await import("node:path");
      const { existsSync } = await import("node:fs");
      const { execSync } = await import("node:child_process");

      const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/-$/, "");
      const dir = opts.global ? kcodePath("awareness") : join(process.cwd(), ".kcode", "awareness");

      const filePath = join(dir, `${slug}.md`);
      if (!existsSync(filePath)) {
        console.log(`\x1b[31m!\x1b[0m Not found: ${filePath}`);
        console.log("  Create it with: kcode teach add " + name);
        return;
      }

      const editor = process.env.EDITOR || process.env.VISUAL || "nano";
      try {
        const { execFileSync: editorExec } = await import("node:child_process");
        editorExec(editor, [filePath], { stdio: "inherit" });
        console.log(`\x1b[32m*\x1b[0m Updated: ${filePath}`);
      } catch {
        console.log(`  Edit manually: ${editor} ${filePath}`);
      }
    });
}
