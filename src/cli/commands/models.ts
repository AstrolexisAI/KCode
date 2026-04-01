import { createHash } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { detectHardware, formatHardware } from "../../core/hardware";
import {
  type CatalogEntry,
  MODEL_CATALOG,
  MODELS_DIR_PATH,
  findCatalogEntry,
  recommendModel,
} from "../../core/model-catalog";
import {
  addModel,
  listModels,
  loadModelsConfig,
  removeModel,
  setDefaultModel,
} from "../../core/models";

export function registerModelsCommand(program: Command): void {
  const modelsCmd = program.command("models").description("Manage registered LLM models");

  modelsCmd
    .command("list")
    .alias("ls")
    .description("List all registered models")
    .action(async () => {
      const models = await listModels();
      const config = await loadModelsConfig();

      if (models.length === 0) {
        console.log("No models registered. Use 'kcode models add' to register one.");
        console.log("\nExample:");
        console.log(
          "  kcode models add mnemo:code3 http://localhost:8091 --context 32000 --gpu 'RTX 5090'",
        );
        return;
      }

      console.log("Registered models:\n");
      for (const m of models) {
        const isDefault = m.name === config.defaultModel ? " (default)" : "";
        const ctx = m.contextSize ? `, ctx: ${m.contextSize.toLocaleString()}` : "";
        const gpu = m.gpu ? `, gpu: ${m.gpu}` : "";
        const caps = m.capabilities?.length ? `, caps: [${m.capabilities.join(", ")}]` : "";
        const desc = m.description ? `\n    ${m.description}` : "";
        console.log(`  ${m.name}${isDefault}`);
        console.log(`    ${m.baseUrl}${ctx}${gpu}${caps}${desc}`);
      }
    });

  modelsCmd
    .command("add <name> <baseUrl>")
    .description("Add or update a model")
    .option("--context <size>", "Context window size in tokens", (v: string) => parseInt(v, 10))
    .option("--gpu <gpu>", "GPU identifier (informational)")
    .option("--caps <capabilities>", "Comma-separated capabilities (e.g. code,vision)")
    .option("--desc <description>", "Description of the model")
    .option("--default", "Set as default model")
    .action(async (name: string, baseUrl: string, opts: any) => {
      await addModel({
        name,
        baseUrl,
        contextSize: opts.context,
        gpu: opts.gpu,
        capabilities: opts.caps ? opts.caps.split(",").map((s: string) => s.trim()) : undefined,
        description: opts.desc,
      });

      if (opts.default) {
        await setDefaultModel(name);
      }

      console.log(`Model "${name}" registered at ${baseUrl}`);
      if (opts.default) {
        console.log(`Set "${name}" as default model.`);
      }
    });

  modelsCmd
    .command("remove <name>")
    .alias("rm")
    .description("Remove a registered model")
    .action(async (name: string) => {
      const removed = await removeModel(name);
      if (removed) {
        console.log(`Model "${name}" removed.`);
      } else {
        console.error(`Model "${name}" not found.`);
        process.exit(1);
      }
    });

  modelsCmd
    .command("default <name>")
    .description("Set the default model")
    .action(async (name: string) => {
      await setDefaultModel(name);
      console.log(`Default model set to "${name}".`);
    });

  modelsCmd
    .command("catalog")
    .description("Show all catalog models with VRAM requirements and scores")
    .action(() => {
      console.log("Model Catalog:\n");
      console.log(
        "  " +
          "Codename".padEnd(30) +
          "Params".padEnd(10) +
          "Quant".padEnd(10) +
          "Size".padEnd(10) +
          "Min VRAM".padEnd(12) +
          "Context".padEnd(10) +
          "Description",
      );
      console.log("  " + "-".repeat(120));

      for (const entry of MODEL_CATALOG) {
        const downloaded = existsSync(join(MODELS_DIR_PATH, entry.localFile)) ? " [ok]" : "";
        console.log(
          "  " +
            (entry.codename + downloaded).padEnd(30) +
            `${entry.paramBillions}B`.padEnd(10) +
            entry.quant.padEnd(10) +
            `${entry.sizeGB} GB`.padEnd(10) +
            `${(entry.minVramMB / 1024).toFixed(0)} GB`.padEnd(12) +
            `${(entry.contextSize / 1024).toFixed(0)}K`.padEnd(10) +
            entry.description,
        );
      }

      console.log(`\n  Total: ${MODEL_CATALOG.length} models in catalog`);
    });

  modelsCmd
    .command("recommend")
    .description("Show recommended model based on detected hardware")
    .action(async () => {
      console.log("Detecting hardware...\n");
      const hw = await detectHardware();
      console.log(formatHardware(hw));
      console.log("");

      const recommended = recommendModel(hw);
      console.log(`Recommended model: ${recommended.codename}`);
      console.log(`  ${recommended.description}`);
      console.log(
        `  Size: ${recommended.sizeGB} GB | Min VRAM: ${(recommended.minVramMB / 1024).toFixed(0)} GB | Context: ${(recommended.contextSize / 1024).toFixed(0)}K`,
      );

      const downloaded = existsSync(join(MODELS_DIR_PATH, recommended.localFile));
      console.log(`  Status: ${downloaded ? "Downloaded" : "Not downloaded"}`);

      if (!downloaded) {
        console.log(`\n  To download: kcode setup`);
      }
    });

  modelsCmd
    .command("verify <codename>")
    .description("Verify SHA256 hash of a downloaded model file")
    .action(async (codename: string) => {
      const entry = findCatalogEntry(codename);
      if (!entry) {
        console.error(`Unknown model: ${codename}`);
        console.error(`Use 'kcode models catalog' to see available models.`);
        process.exit(1);
      }

      const filePath = join(MODELS_DIR_PATH, entry.localFile);
      if (!existsSync(filePath)) {
        console.error(`Model file not found: ${filePath}`);
        console.error(`Download it first with 'kcode setup'.`);
        process.exit(1);
      }

      const stat = statSync(filePath);
      console.log(`Verifying ${entry.codename} (${(stat.size / (1024 * 1024 * 1024)).toFixed(2)} GB)...`);

      const hash = createHash("sha256");
      const stream = createReadStream(filePath);

      await new Promise<void>((resolve, reject) => {
        stream.on("data", (chunk: Buffer) => hash.update(chunk));
        stream.on("end", resolve);
        stream.on("error", reject);
      });

      const sha256 = hash.digest("hex");
      console.log(`SHA256: ${sha256}`);
      console.log(`File size: ${stat.size} bytes`);
    });

  modelsCmd
    .command("benchmark <codename>")
    .description("Quick benchmark — measure tokens/sec and time-to-first-token")
    .option("--port <port>", "Server port", (v: string) => parseInt(v, 10), 10091)
    .option("--base-url <url>", "API base URL")
    .action(async (codename: string, opts: { port: number; baseUrl?: string }) => {
      const entry = findCatalogEntry(codename);
      if (!entry) {
        console.error(`Unknown model: ${codename}`);
        process.exit(1);
      }

      const baseUrl = opts.baseUrl ?? `http://localhost:${opts.port}`;
      const prompt = "Write a function that returns the Fibonacci sequence up to n terms.";

      console.log(`Benchmarking ${entry.codename} at ${baseUrl}...`);
      console.log(`Prompt: "${prompt}"\n`);

      const startTime = performance.now();
      let firstTokenTime = 0;
      let totalTokens = 0;

      try {
        const response = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: codename,
            messages: [{ role: "user", content: prompt }],
            max_tokens: 256,
            stream: true,
          }),
        });

        if (!response.ok) {
          throw new Error(`Server returned ${response.status}: ${response.statusText}`);
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error("No response body");
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const text = decoder.decode(value, { stream: true });
          for (const line of text.split("\n")) {
            if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
            try {
              const data = JSON.parse(line.slice(6));
              const content = data.choices?.[0]?.delta?.content;
              if (content) {
                if (firstTokenTime === 0) {
                  firstTokenTime = performance.now();
                }
                totalTokens++;
              }
            } catch {
              // skip malformed SSE lines
            }
          }
        }
      } catch (err: any) {
        console.error(`Benchmark failed: ${err.message}`);
        console.error(`Make sure the model is loaded and the server is running at ${baseUrl}.`);
        process.exit(1);
      }

      const endTime = performance.now();
      const totalMs = endTime - startTime;
      const ttft = firstTokenTime > 0 ? firstTokenTime - startTime : 0;
      const genMs = firstTokenTime > 0 ? endTime - firstTokenTime : totalMs;
      const tokensPerSec = genMs > 0 ? (totalTokens / genMs) * 1000 : 0;

      console.log("Results:");
      console.log(`  Time to first token (TTFT): ${ttft.toFixed(0)} ms`);
      console.log(`  Total tokens generated:     ${totalTokens}`);
      console.log(`  Generation speed:           ${tokensPerSec.toFixed(1)} tokens/sec`);
      console.log(`  Total time:                 ${(totalMs / 1000).toFixed(2)} s`);
    });
}
