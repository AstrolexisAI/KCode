import type { Command } from "commander";
import { buildConfig } from "../../core/config";
import { getBenchmarkSummary, formatBenchmarks, initBenchmarkSchema } from "../../core/benchmarks";

export function registerBenchmarkCommands(program: Command): void {
  // ─── Warmup subcommand ─────────────────────────────────────────
  program
    .command("warmup")
    .description("Warm up the model with a probe request")
    .option("-m, --model <model>", "Model to warm up")
    .action(async (opts: { model?: string }) => {
      const config = await buildConfig(process.cwd());
      const model = opts.model ?? config.model;
      const { getModelBaseUrl } = await import("../../core/models");
      const baseUrl = await getModelBaseUrl(model, config.apiBase);

      console.log(`Warming up ${model} at ${baseUrl}...`);
      const start = Date.now();

      try {
        const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(config.apiKey ? { "Authorization": `Bearer ${config.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: "Say OK" }],
            max_tokens: 8,
            stream: false,
          }),
          signal: AbortSignal.timeout(30000),
        });

        const data = await resp.json() as Record<string, unknown>;
        const elapsed = Date.now() - start;
        const choices = data.choices as Record<string, unknown>[] | undefined;
        const usage = data.usage as Record<string, unknown> | undefined;
        const text = ((choices?.[0]?.message as Record<string, unknown> | undefined)?.content as string) ?? "(no response)";
        const tokens = (usage?.total_tokens as number) ?? 0;

        console.log(`\x1b[32m✓\x1b[0m Model ready (${elapsed}ms, ${tokens} tok)`);
        console.log(`  Response: ${text.slice(0, 50)}`);

        if (elapsed > 5000) {
          console.log(`\x1b[33m⚠\x1b[0m Slow response — model may still be loading into VRAM`);
        }
      } catch (err) {
        const elapsed = Date.now() - start;
        console.error(`\x1b[31m✗\x1b[0m Warmup failed after ${elapsed}ms`);
        console.error(`  ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  // ─── Benchmark subcommand ───────────────────────────────────────
  program
    .command("benchmark")
    .alias("bench")
    .description("Show model quality benchmark results")
    .option("-m, --model <model>", "Filter by model name")
    .option("-d, --days <days>", "Number of days to look back", parseInt, 30)
    .action(async (opts: { model?: string; days?: number }) => {
      try { initBenchmarkSchema(); } catch { /* ignore */ }
      const summaries = getBenchmarkSummary(opts.model, opts.days ?? 30);
      console.log(formatBenchmarks(summaries));
    });
}
