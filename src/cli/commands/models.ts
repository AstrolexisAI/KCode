import { createHash } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { detectHardware, formatHardware } from "../../core/hardware";
import {
  type CatalogEntry,
  findCatalogEntry,
  MODEL_CATALOG,
  MODELS_DIR_PATH,
  recommendModel,
} from "../../core/model-catalog";
import {
  addModel,
  listModels,
  loadModelsConfig,
  removeModel,
  setDefaultModel,
} from "../../core/models";
import { kcodePath } from "../../core/paths";

const HF_REPO_RE = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

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
      console.log(
        `Verifying ${entry.codename} (${(stat.size / (1024 * 1024 * 1024)).toFixed(2)} GB)...`,
      );

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

  modelsCmd
    .command("use <hf-repo>")
    .description(
      "Set the active MLX model to a HuggingFace repo (persists in ~/.kcode/server.json)",
    )
    .action(async (repo: string) => {
      if (!HF_REPO_RE.test(repo)) {
        console.error(`Invalid repo: "${repo}" — must be owner/name (e.g. mlx-community/...)`);
        process.exit(1);
      }
      const path = kcodePath("server.json");
      const file = Bun.file(path);
      let cfg: Record<string, unknown>;
      let bootstrapped = false;

      if (await file.exists()) {
        cfg = (await file.json()) as Record<string, unknown>;
      } else {
        // Bootstrap mode: no server.json yet (user downloaded the model
        // manually and never finished `kcode setup`). Synthesize a minimal
        // MLX config so the user doesn't have to sit through a redundant
        // wizard. Requires the MLX venv to exist — that's what runs
        // mlx_lm.server.
        const venvPython = kcodePath("mlx-venv", "bin", "python3");
        if (!existsSync(venvPython)) {
          console.error(`MLX venv not found at ${venvPython}`);
          console.error(
            "Run the download script first (it builds the venv):\n" +
              "  bash <(curl -fsSL https://raw.githubusercontent.com/AstrolexisAI/KCode/master/scripts/mlx-model-download.sh) " +
              repo,
          );
          process.exit(1);
        }
        cfg = {
          enginePath: venvPython,
          modelPath: "",
          codename: repo.split("/")[1] ?? repo,
          port: 10091,
          contextSize: 32768,
          gpuLayers: -1,
          gpus: [],
          engine: "mlx",
        };
        // Mark setup as complete so the main kcode entry point boots into
        // the TUI instead of re-launching the setup wizard.
        await Bun.write(
          kcodePath(".setup-complete"),
          `${new Date().toISOString()}\n${cfg.codename}\n`,
        );
        bootstrapped = true;
      }

      const previous = cfg.mlxRepo;
      cfg.mlxRepo = repo;
      cfg.codename = repo.split("/")[1] ?? repo;
      cfg.engine = "mlx";

      // Auto-size context based on available unified memory. The previous
      // contextSize (32k default from the wizard, or whatever the user
      // last left) doesn't track the new model's KV-cache footprint —
      // and on a 48 GB Mac the difference between 32k and "model max"
      // is the difference between fitting and OOMing 30s into a long
      // session. Compute the largest 32k/64k/128k/256k ceiling that
      // fits after accounting for model weights, OS reserve, and
      // headroom.
      try {
        const { autoSizeContext } = await import("../../core/context-sizing");
        const os = await import("node:os");
        const sized = autoSizeContext(repo, os.totalmem());
        if (sized) {
          const previousCtx = cfg.contextSize as number | undefined;
          cfg.contextSize = sized.contextSize;
          if (previousCtx && previousCtx !== sized.contextSize) {
            console.log(
              `Auto-sized context: ${previousCtx} → ${sized.contextSize} tokens` +
                ` (model max ${sized.shape.maxPositionEmbeddings}, ` +
                `weights ~${(sized.modelSizeBytes / 1024 ** 3).toFixed(1)} GB)`,
            );
          }
        } else {
          console.log(
            "Note: context auto-sizing skipped — model not yet downloaded. " +
              "Re-run after the download completes for an optimal ceiling.",
          );
        }
      } catch (err) {
        console.error(`Warning: context auto-sizing failed: ${err}`);
      }

      await Bun.write(path, `${JSON.stringify(cfg, null, 2)}\n`);

      // Also update the model registry + saved preference so the next
      // `kcode` boot uses this model end-to-end without surprises:
      //   - models.json: register the repo as a model entry pointing
      //     at the local mlx_lm.server URL, set as default. Without
      //     this, models.json may still default to a stale entry
      //     (e.g. a Kulvex shared model that's now unreachable) and
      //     kcode crashes with "External server not reachable".
      //   - settings.json: align lastSessionModel + confirmedModel so
      //     App.tsx's saved-preference restore is a no-op. Without
      //     this, the TUI flips back to whatever model was active
      //     last session as soon as it mounts.
      const port = (cfg.port as number | undefined) ?? 10091;
      const localUrl = `http://localhost:${port}`;
      try {
        // Remove any *other* registry entries pointing at the same local
        // URL. The previous local model (e.g. an old qwen3-coder
        // registered against :10091) cannot serve traffic anymore — the
        // mlx_lm.server is about to load `repo` instead. If we leave the
        // stale entry, the multi-model router can pick it and the chat
        // call fails with "model not found" or 404. The endpoint-alive
        // probe added in router.ts skips dead candidates, but only at
        // the cost of a 1.5s probe per call. Cleaning the registry up
        // front is cheaper and more honest.
        const existing = await listModels();
        for (const m of existing) {
          if (m.name === repo) continue; // we'll update this one via addModel
          if (m.baseUrl === localUrl) {
            await removeModel(m.name);
            console.log(`  Removed stale entry: ${m.name} (was pointing at ${localUrl})`);
          }
        }

        await addModel({
          name: repo,
          baseUrl: localUrl,
          // cfg.contextSize was just (re)written above by the auto-sizing
          // block. Reuse it so the registry's contextSize matches what
          // server.json will hand to mlx_lm.server.
          contextSize: (cfg.contextSize as number | undefined) ?? 32768,
          description: `Local MLX ${repo}`,
        });
        await setDefaultModel(repo);
      } catch (err) {
        console.error(`Warning: model registry update failed: ${err}`);
      }
      try {
        const settingsPath = kcodePath("settings.json");
        let s: Record<string, unknown> = {};
        if (existsSync(settingsPath)) {
          try {
            s = JSON.parse(await Bun.file(settingsPath).text()) as Record<string, unknown>;
          } catch {
            s = {};
          }
        }
        s.lastSessionModel = repo;
        s.confirmedModel = repo;
        s.model = repo;
        await Bun.write(settingsPath, JSON.stringify(s, null, 2));
      } catch (err) {
        console.error(`Warning: settings.json update failed: ${err}`);
      }

      if (bootstrapped) {
        console.log(`Active MLX model: ${repo}`);
        console.log(`Bootstrapped ${path} (no setup wizard needed).`);
      } else {
        console.log(`Active MLX model: ${previous ?? "(none)"} → ${repo}`);
      }
      console.log("Start kcode: kcode");
    });

  modelsCmd
    .command("discover")
    .description("Query cloud provider /v1/models endpoints and register new models")
    .option(
      "--provider <ids>",
      "Comma-separated provider IDs (anthropic,openai,groq,deepseek,together). Default: all with keys.",
    )
    .action(async (opts: { provider?: string }) => {
      const { runModelDiscovery } = await import("../../core/model-discovery");
      const providerFilter = opts.provider
        ? opts.provider
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;

      console.log("Discovering models from cloud providers...\n");
      const results = await runModelDiscovery({ providerFilter });

      let totalAdded = 0;
      for (const r of results) {
        const label = r.provider.padEnd(10);
        if (r.error) {
          console.log(`  ${label} — skipped (${r.error})`);
          continue;
        }
        if (r.added.length === 0) {
          console.log(`  ${label} — up to date (${r.skipped.length} known)`);
          continue;
        }
        totalAdded += r.added.length;
        console.log(`  ${label} — \x1b[32m+${r.added.length} new\x1b[0m:`);
        for (const id of r.added) {
          console.log(`      ${id}`);
        }
      }

      if (totalAdded === 0) {
        console.log("\nNo new models to add.");
      } else {
        console.log(`\n\x1b[32m✓\x1b[0m Added ${totalAdded} new model(s) to the registry.`);
      }
    });
}
