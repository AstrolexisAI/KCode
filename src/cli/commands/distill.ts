// KCode - CLI Command: distill
// Subcommands for the model distillation pipeline:
//   distill export   - Export training datasets from distilled examples
//   distill curate   - Filter, deduplicate, and balance a dataset
//   distill train    - Launch fine-tuning on a dataset
//   distill eval     - Evaluate a distilled model
//   distill deploy   - Register a distilled model in KCode

import type { Command } from "commander";

export function registerDistillCommand(program: Command): void {
  const distill = program
    .command("distill")
    .description("Model distillation pipeline: export, curate, train, eval, deploy");

  // ─── distill export ──────────────────────────────────────────
  distill
    .command("export")
    .description("Export distilled examples as a fine-tuning dataset")
    .option(
      "-f, --format <format>",
      "Output format: jsonl-chat, sharegpt, alpaca, openai",
      "jsonl-chat",
    )
    .option("-o, --output <path>", "Output directory")
    .option(
      "-q, --min-quality <n>",
      "Minimum quality score (0.0-2.0)",
      parseFloat,
      0.5,
    )
    .option("-n, --max <n>", "Maximum examples to export", parseInt, 5000)
    .option("--no-tools", "Exclude tool call sequences")
    .option("--project <project>", "Filter by project path")
    .option("--tag <tag>", "Filter by tag (repeatable)")
    .action(
      async (opts: {
        format: string;
        output?: string;
        minQuality: number;
        max: number;
        tools: boolean;
        project?: string;
        tag?: string;
      }) => {
        const { DatasetExporter } = await import(
          "../../core/distillation/exporter"
        );
        const { kcodePath } = await import("../../core/paths");

        const exporter = new DatasetExporter();
        const config = DatasetExporter.defaults({
          format: opts.format as any,
          outputPath: opts.output ?? kcodePath("datasets"),
          minQuality: opts.minQuality,
          maxExamples: opts.max,
          includeToolCalls: opts.tools,
          filterProjects: opts.project ? [opts.project] : undefined,
          filterTags: opts.tag ? [opts.tag] : undefined,
        });

        console.log(
          `Exporting dataset (format: ${config.format}, min quality: ${config.minQuality})...`,
        );
        const report = await exporter.export(config);

        console.log(`\x1b[32m+\x1b[0m Exported ${report.examplesExported} examples`);
        console.log(`  Format: ${report.format}`);
        console.log(`  Tokens: ~${report.totalTokens.toLocaleString()}`);
        console.log(`  Output: ${report.outputFile}`);
      },
    );

  // ─── distill curate ──────────────────────────────────────────
  distill
    .command("curate <input>")
    .description("Curate a dataset: deduplicate, filter, balance, clean")
    .option("-o, --output <path>", "Output file path")
    .action(async (input: string, opts: { output?: string }) => {
      const { DatasetCurator } = await import(
        "../../core/distillation/curator"
      );
      const { resolve, basename, dirname, join } = await import("node:path");

      const inputPath = resolve(input);
      const outputPath =
        opts.output ??
        join(dirname(inputPath), `curated_${basename(inputPath)}`);

      console.log(`Curating dataset: ${inputPath}`);
      const curator = new DatasetCurator();
      const report = await curator.curate(inputPath, outputPath);

      console.log(`\x1b[32m+\x1b[0m Curation complete`);
      console.log(
        `  ${report.inputCount} -> ${report.outputCount} examples`,
      );
      console.log(`  Duplicates removed: ${report.removedDuplicates}`);
      console.log(`  Short/broken removed: ${report.removedShort}`);
      console.log(`  Rebalanced: ${report.rebalanced}`);
      console.log(`  Output: ${outputPath}`);
    });

  // ─── distill train ──────────────────────────────────────────
  distill
    .command("train")
    .description("Launch fine-tuning on a curated dataset")
    .requiredOption("-d, --dataset <path>", "Path to training dataset")
    .option(
      "-b, --backend <backend>",
      "Training backend: unsloth, axolotl, llamafactory, mlx-lm",
      "unsloth",
    )
    .option(
      "--base <model>",
      "Base model name/path",
      "unsloth/Qwen2.5-Coder-7B-Instruct",
    )
    .option("-o, --output <dir>", "Output directory for model")
    .option("--epochs <n>", "Training epochs", parseInt, 3)
    .option("--batch-size <n>", "Batch size", parseInt, 4)
    .option("--lr <n>", "Learning rate", parseFloat, 2e-5)
    .option("--lora-rank <n>", "LoRA rank", parseInt, 16)
    .option("--quant <mode>", "Quantization: 4bit, 8bit, none", "4bit")
    .option("--cuda <devices>", "CUDA devices", "0")
    .action(
      async (opts: {
        dataset: string;
        backend: string;
        base: string;
        output?: string;
        epochs: number;
        batchSize: number;
        lr: number;
        loraRank: number;
        quant: string;
        cuda: string;
      }) => {
        const { ModelTrainer } = await import(
          "../../core/distillation/trainer"
        );
        const { kcodePath } = await import("../../core/paths");
        const { resolve } = await import("node:path");

        const trainer = new ModelTrainer();
        const config = ModelTrainer.defaults({
          backend: opts.backend as any,
          baseModel: opts.base,
          datasetPath: resolve(opts.dataset),
          outputDir: opts.output ?? kcodePath("models", "finetuned"),
          epochs: opts.epochs,
          batchSize: opts.batchSize,
          learningRate: opts.lr,
          loraRank: opts.loraRank,
          quantization: opts.quant as any,
          cudaDevices: opts.cuda,
        });

        console.log(
          `Launching ${config.backend} training with ${config.baseModel}...`,
        );
        const handle = await trainer.train(config);

        console.log(`\x1b[32m+\x1b[0m Training started (PID: ${handle.pid})`);
        console.log(`  Log: ${handle.logFile}`);
        console.log(`  Output: ${handle.outputDir}`);
        console.log(
          `  Monitor: tail -f ${handle.logFile}`,
        );
      },
    );

  // ─── distill eval ───────────────────────────────────────────
  distill
    .command("eval")
    .description("Evaluate a distilled model against benchmarks")
    .requiredOption("-m, --model <path>", "Model path or name")
    .option(
      "--benchmark <type>",
      "Benchmark: coding-tasks, general, tool-use",
      "coding-tasks",
    )
    .option("-n, --num <n>", "Number of eval prompts", parseInt, 50)
    .option("--api-base <url>", "API base URL", "http://localhost:10091")
    .option("--base-model <path>", "Base model to compare against")
    .action(
      async (opts: {
        model: string;
        benchmark: string;
        num: number;
        apiBase: string;
        baseModel?: string;
      }) => {
        const { ModelEvaluator } = await import(
          "../../core/distillation/evaluator"
        );

        const evaluator = new ModelEvaluator();
        const config = ModelEvaluator.defaults({
          modelPath: opts.model,
          benchmark: opts.benchmark as any,
          numPrompts: opts.num,
          apiBase: opts.apiBase,
          baseModelPath: opts.baseModel,
        });

        console.log(
          `Evaluating ${config.modelPath} on ${config.benchmark} (${config.numPrompts} tasks)...`,
        );
        const report = await evaluator.evaluate(config);

        console.log(`\n\x1b[32m+\x1b[0m Evaluation Results`);
        console.log(`  Tasks: ${report.totalTasks}`);
        console.log(
          `  Passed: ${report.passed}/${report.totalTasks} (${Math.round(report.passRate * 100)}%)`,
        );
        console.log(`  Avg latency: ${report.avgLatencyMs}ms`);
        console.log(`  Avg tokens: ${report.avgTokens}`);

        if (opts.baseModel) {
          console.log(`\nComparing against base model: ${opts.baseModel}`);
          const baseConfig = ModelEvaluator.defaults({
            modelPath: opts.baseModel,
            benchmark: opts.benchmark as any,
            numPrompts: opts.num,
            apiBase: opts.apiBase,
          });
          const baseReport = await evaluator.evaluate(baseConfig);
          const comparison = evaluator.compareReports(report, baseReport);
          console.log(`\n${comparison.summary}`);
        }
      },
    );

  // ─── distill deploy ─────────────────────────────────────────
  distill
    .command("deploy")
    .description("Register a distilled model in KCode")
    .requiredOption("-m, --model <path>", "Path to model file (GGUF)")
    .option("-n, --name <name>", "Model name to register")
    .option("--description <desc>", "Model description")
    .option("--default", "Set as the default model", false)
    .action(
      async (opts: {
        model: string;
        name?: string;
        description?: string;
        default: boolean;
      }) => {
        const { ModelDeployer } = await import(
          "../../core/distillation/deployer"
        );
        const { resolve } = await import("node:path");

        const deployer = new ModelDeployer();
        const report = await deployer.deploy({
          modelPath: resolve(opts.model),
          name: opts.name ?? "",
          description: opts.description,
          setAsDefault: opts.default,
        });

        console.log(`\x1b[32m+\x1b[0m Model deployed`);
        console.log(`  Name: ${report.modelName}`);
        console.log(`  Path: ${report.modelPath}`);
        console.log(
          `  Default: ${report.setAsDefault ? "yes" : "no"}`,
        );
        console.log(`  Registered at: ${report.registeredAt}`);
      },
    );
}
