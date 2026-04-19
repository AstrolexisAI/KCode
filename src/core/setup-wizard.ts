// KCode - Setup Wizard
// Interactive terminal wizard for first-time setup: hardware detection, model selection,
// engine installation, model download, and configuration.
// Extracted from model-manager.ts for modularity.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { detectHardware, formatHardware } from "./hardware";
import { log } from "./logger";
import {
  calculateConcurrency,
  calculateGpuLayers,
  findCatalogEntry,
  getModelPath,
  isModelDownloaded,
  MODEL_CATALOG,
  recommendModel,
} from "./model-catalog";
import { downloadEngine } from "./model-engine";
import { installToPath } from "./model-file-utils";
import { downloadMlxModel, installMlxEngine } from "./model-mlx";
import { addModel, setDefaultModel } from "./models";
import { kcodeHome, kcodePath } from "./paths";

const KCODE_HOME = kcodeHome();
const SETUP_MARKER = kcodePath(".setup-complete");

/**
 * Map a cloud provider id (from cloud-setup.ts) to the API base URL
 * used when registering the model in models.json. Kept as a single
 * source of truth so adding a provider touches one line instead of
 * two identical conditional chains.
 *
 * xAI (Grok) uses an OpenAI-compatible endpoint at api.x.ai/v1, so
 * the generic OpenAI request builder works out of the box.
 */
function providerBaseUrl(providerId: string): string {
  switch (providerId) {
    case "anthropic":
      return "https://api.anthropic.com";
    case "openai":
      return "https://api.openai.com";
    case "groq":
      return "https://api.groq.com/openai";
    case "deepseek":
      return "https://api.deepseek.com";
    case "xai":
      return "https://api.x.ai";
    case "together":
    default:
      return "https://api.together.xyz";
  }
}

// Forward imports — these are used inside the wizard but defined in model-manager.ts.
// We import the functions we need from the sibling modules and from model-manager for
// status checks. To avoid circular deps, we duplicate the small inline helpers here.

/** Check if we should use MLX on this platform (macOS Apple Silicon) */
function shouldUseMlx(): boolean {
  return process.platform === "darwin" && process.arch === "arm64";
}

/** Check if MLX engine is installed */
function isMlxInstalled(): boolean {
  return existsSync(kcodePath(".mlx-engine"));
}

/** Get the mlx_lm.server command path (inside the venv) */
function getMlxServerPath(): string | null {
  const MLX_VENV = kcodePath("mlx-venv");
  const python = join(MLX_VENV, "bin", "python3");
  if (existsSync(python) && isMlxInstalled()) return python;
  return null;
}

/** Get the llama-server binary path */
function getEnginePath(): string | null {
  if (shouldUseMlx() && isMlxInstalled()) {
    return getMlxServerPath();
  }
  const ENGINE_DIR = kcodePath("engine");
  const names = process.platform === "win32" ? ["llama-server.exe"] : ["llama-server"];
  for (const name of names) {
    const path = join(ENGINE_DIR, name);
    if (existsSync(path)) return path;
  }
  return null;
}

// Import downloadModel from model-manager would be circular.
// Instead, accept it as a parameter or import from the module that owns it.
// We use a lazy import to avoid circular dependency.
async function lazyDownloadModel(
  codename: string,
  onProgress?: (msg: string) => void,
): Promise<string> {
  const { downloadModel } = await import("./model-manager");
  return downloadModel(codename, onProgress);
}

/** Run the full auto-setup wizard: detect hardware, download engine, download best model */
export async function runSetup(options?: {
  model?: string;
  force?: boolean;
}): Promise<{ model: string; enginePath: string; modelPath: string }> {
  const C = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    italic: "\x1b[3m",
    underline: "\x1b[4m",
    cyan: "\x1b[36m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    magenta: "\x1b[35m",
    blue: "\x1b[34m",
    red: "\x1b[31m",
    white: "\x1b[97m",
    bgCyan: "\x1b[46m",
    bgBlue: "\x1b[44m",
    bgGreen: "\x1b[42m",
    bgMagenta: "\x1b[45m",
  };

  // Clear screen for the wizard
  process.stdout.write("\x1b[2J\x1b[H");

  // ── Banner ──────────────────────────────────────────────────────
  // The ASCII-art KCODE logo is ~44 cols wide plus 4 cols of leading
  // indent. On Termux / narrow terminals (~35 cols) it wraps into an
  // unreadable blob. Switch to a compact banner under that threshold.
  const cols = process.stdout.columns || 80;
  const isNarrow = cols < 50;
  const banner = isNarrow
    ? [
        "",
        `  ${C.bold}${C.cyan}KCODE${C.reset}  ${C.dim}— Deterministic Security Audit${C.reset}`,
        `  ${C.dim}${"━".repeat(Math.max(6, cols - 4))}${C.reset}`,
        "",
      ]
    : [
        "",
        `${C.bold}${C.cyan}    ██╗  ██╗ ██████╗ ██████╗ ██████╗ ███████╗`,
        `    ██║ ██╔╝██╔════╝██╔═══██╗██╔══██╗██╔════╝`,
        `    █████╔╝ ██║     ██║   ██║██║  ██║█████╗  `,
        `    ██╔═██╗ ██║     ██║   ██║██║  ██║██╔══╝  `,
        `    ██║  ██╗╚██████╗╚██████╔╝██████╔╝███████╗`,
        `    ╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝${C.reset}`,
        "",
        `    ${C.dim}Kulvex Code — Deterministic Security Audit by Astrolexis${C.reset}`,
        `    ${C.dim}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}`,
        "",
      ];
  console.log(banner.join("\n"));

  // ── Spinner helper ──────────────────────────────────────────────
  const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  // Strip ANSI codes to get real visible length for padding
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  function createSpinner(label: string) {
    let frame = 0;
    let suffix = "";
    let stopped = false;
    const interval = setInterval(() => {
      if (stopped) return;
      const spinner = `${C.cyan}${spinnerFrames[frame % spinnerFrames.length]}${C.reset}`;
      const line = `    ${spinner} ${label}${suffix}`;
      const pad = Math.max(0, 90 - stripAnsi(line).length);
      process.stderr.write(`\r${line}${" ".repeat(pad)}\r`);
      frame++;
    }, 80);
    return {
      update(msg: string) {
        suffix = ` ${C.dim}${msg.replace(/\n/g, "")}${C.reset}`;
      },
      stop() {
        stopped = true;
        clearInterval(interval);
      },
      succeed(msg: string) {
        stopped = true;
        clearInterval(interval);
        const line = `    ${C.green}✓${C.reset} ${msg}`;
        const pad = Math.max(0, 90 - stripAnsi(line).length);
        process.stderr.write(`\r${line}${" ".repeat(pad)}\n`);
      },
      fail(msg: string) {
        stopped = true;
        clearInterval(interval);
        const line = `    ${C.red}✗${C.reset} ${msg}`;
        const pad = Math.max(0, 90 - stripAnsi(line).length);
        process.stderr.write(`\r${line}${" ".repeat(pad)}\n`);
      },
    };
  }

  // ── Progress bar helper ─────────────────────────────────────────
  function renderProgressBar(pct: number, width: number = 30): string {
    const filled = Math.round((pct / 100) * width);
    const empty = width - filled;
    const bar = `${C.cyan}${"█".repeat(filled)}${C.dim}${"░".repeat(empty)}${C.reset}`;
    return `${bar} ${pct}%`;
  }

  // ── Step header ─────────────────────────────────────────────────
  function stepHeader(num: number, title: string) {
    console.log(`  ${C.bold}${C.bgCyan}${C.white} ${num} ${C.reset} ${C.bold}${title}${C.reset}`);
  }

  // ═══════════════════════════════════════════════════════════════
  //  Step 1: Hardware Detection
  // ═══════════════════════════════════════════════════════════════

  stepHeader(1, "Scanning your hardware");
  console.log();

  const hwSpinner = createSpinner("Detecting GPUs, VRAM, and platform...");
  const hw = await detectHardware();
  hwSpinner.succeed("Hardware detected");

  // Display hardware info. On wide terminals we draw a decorated
  // box; on narrow (Termux etc.) we skip the box entirely and just
  // print the lines with a small indent — a 56-col box wraps and
  // looks worse than plain text on a 35-col screen.
  const hwLines = formatHardware(hw).split("\n");
  console.log();
  if (isNarrow) {
    for (const line of hwLines) {
      console.log(`  ${line}`);
    }
  } else {
    const maxLen = Math.max(...hwLines.map((l) => l.length));
    const boxWidth = maxLen + 4; // 2 padding each side
    console.log(`    ${C.dim}┌${"─".repeat(boxWidth)}┐${C.reset}`);
    for (const line of hwLines) {
      console.log(`    ${C.dim}│${C.reset}  ${line.padEnd(maxLen + 2)}${C.dim}│${C.reset}`);
    }
    console.log(`    ${C.dim}└${"─".repeat(boxWidth)}┘${C.reset}`);
  }
  console.log();

  // ═══════════════════════════════════════════════════════════════
  //  Step 1b: Live VRAM check + Hardware Tier Classification
  // ═══════════════════════════════════════════════════════════════
  //
  // Query nvidia-smi BEFORE tier classification so the tier reflects
  // what's actually free right now, not what's physically installed.
  // A 12GB card with only 1GB free (Blender/other LLM holding it)
  // should be classified as "weak/unusable", not "medium".
  //
  // Skip this branch when:
  //   - options.model is explicit (they know what they want)
  //   - KCODE_FORCE_LOCAL env is set (escape hatch)

  const forceLocal = process.env.KCODE_FORCE_LOCAL === "1";

  // Pre-compute live usable VRAM so both tier classification (here)
  // and model recommendation (below) use the same figure.
  let wizardUsableVramMB: number | undefined;
  let wizardVramAvailability: { usedMB: number | null; freeMB: number | null; totalMB: number } | null = null;
  if (hw.totalVramMB > 0) {
    try {
      const { detectGpuAvailability, effectiveUsableVramMB } = await import(
        "./gpu-availability.js"
      );
      const avail = await detectGpuAvailability(hw.platform, hw.totalVramMB);
      wizardUsableVramMB = effectiveUsableVramMB(avail, hw.totalVramMB);
      wizardVramAvailability = avail;
    } catch (err) {
      log.debug("setup", `live VRAM detection failed: ${err}`);
    }
  }

  if (!options?.model && !forceLocal) {
    const { classifyHardware } = await import("./hardware-tier.js");
    const tier = classifyHardware(hw, { liveUsableVramMB: wizardUsableVramMB });

    if (tier.primary === "cloud") {
      console.log(
        `    ${C.yellow}⚡${C.reset} Hardware tier: ${C.bold}${tier.tier}${C.reset} — ${tier.reason}`,
      );
      console.log(`    ${C.dim}Local inference would be slow on this hardware. Routing to cloud setup.${C.reset}`);
      console.log();

      const { runCloudSetup } = await import("./cloud-setup.js");
      const cloudResult = await runCloudSetup({ tierReason: tier.reason });

      if (!cloudResult.declined) {
        // Cloud path succeeded — record as default model and finish.
        try {
          const { addModel: addM, setDefaultModel: setDef } = await import("./models.js");
          const { guessContextSize } = await import("./model-context-sizes.js");
          await addM({
            name: cloudResult.defaultModel,
            baseUrl: providerBaseUrl(cloudResult.providerId),
            provider: cloudResult.providerId === "anthropic" ? "anthropic" : "openai",
            contextSize: guessContextSize(cloudResult.defaultModel),
            description: `Configured via setup wizard (${new Date().toISOString().slice(0, 10)})`,
          });
          await setDef(cloudResult.defaultModel);
        } catch (err) {
          log.warn("setup", `failed to register cloud model: ${err}`);
        }

        // Mark setup complete
        try {
          const { writeFileSync, mkdirSync } = await import("node:fs");
          const { dirname } = await import("node:path");
          mkdirSync(dirname(SETUP_MARKER), { recursive: true });
          writeFileSync(SETUP_MARKER, new Date().toISOString());
        } catch {
          /* non-fatal */
        }

        console.log();
        console.log(
          `    ${C.green}✓${C.reset} ${C.bold}Setup complete (cloud mode)${C.reset}`,
        );
        console.log(`    Default model: ${C.cyan}${cloudResult.defaultModel}${C.reset}`);
        console.log(`    Run ${C.bold}kcode${C.reset} to start.`);
        console.log();
        return;
      }

      // User declined cloud → fall through to local path with
      // whatever mark5-pico / nano fits. Print a note explaining.
      console.log(
        `    ${C.dim}Cloud skipped. Proceeding with local setup (expect slow inference).${C.reset}`,
      );
      console.log();
    } else if (tier.offerAlternative) {
      // Strong/medium hardware: ASK the user whether they want local
      // or cloud, don't assume local. A 12GB VRAM card can run
      // local but cloud might be preferable for quality/speed
      // reasons. Default = local (preserves local-first philosophy).
      console.log(
        `    ${C.dim}Hardware tier: ${C.reset}${C.bold}${tier.tier}${C.reset} ${C.dim}— ${tier.reason}${C.reset}`,
      );
      console.log();
      const { createInterface } = await import("node:readline");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const choice = await new Promise<string>((resolve) => {
        rl.question(
          `    Setup path: ${C.bold}[L]${C.reset}ocal model (recommended for your HW) or ${C.bold}[C]${C.reset}loud provider? [L/c]: `,
          (a) => {
            rl.close();
            resolve(a.trim().toLowerCase());
          },
        );
      });
      console.log();

      if (choice.startsWith("c")) {
        // User picked cloud even on medium HW — run cloud setup
        const { runCloudSetup } = await import("./cloud-setup.js");
        const cloudResult = await runCloudSetup({ tierReason: tier.reason });

        if (!cloudResult.declined) {
          try {
            const { addModel: addM, setDefaultModel: setDef } = await import("./models.js");
            const { guessContextSize } = await import("./model-context-sizes.js");
            await addM({
              name: cloudResult.defaultModel,
              baseUrl: providerBaseUrl(cloudResult.providerId),
              provider: cloudResult.providerId === "anthropic" ? "anthropic" : "openai",
              contextSize: guessContextSize(cloudResult.defaultModel),
              description: `Configured via setup wizard (${new Date().toISOString().slice(0, 10)})`,
            });
            await setDef(cloudResult.defaultModel);
          } catch (err) {
            log.warn("setup", `failed to register cloud model: ${err}`);
          }

          try {
            const { writeFileSync, mkdirSync } = await import("node:fs");
            const { dirname } = await import("node:path");
            mkdirSync(dirname(SETUP_MARKER), { recursive: true });
            writeFileSync(SETUP_MARKER, new Date().toISOString());
          } catch {
            /* non-fatal */
          }

          console.log(
            `    ${C.green}✓${C.reset} ${C.bold}Setup complete (cloud mode)${C.reset}`,
          );
          console.log(`    Default model: ${C.cyan}${cloudResult.defaultModel}${C.reset}`);
          console.log();
          return;
        }
        // Declined cloud too → fall through to local
      }
      // Default or 'L' → continue with local path below
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  Step 2: Model Selection
  // ═══════════════════════════════════════════════════════════════

  stepHeader(2, "Selecting the best model for your system");
  console.log();

  // Reuse the wizardUsableVramMB / wizardVramAvailability computed
  // in Step 1b above — no second nvidia-smi call.
  if (
    wizardVramAvailability &&
    wizardVramAvailability.freeMB !== null &&
    wizardVramAvailability.usedMB !== null &&
    wizardVramAvailability.usedMB > 500
  ) {
    const usedGB = (wizardVramAvailability.usedMB / 1024).toFixed(1);
    const freeGB = (wizardVramAvailability.freeMB / 1024).toFixed(1);
    const totalGB = (wizardVramAvailability.totalMB / 1024).toFixed(0);
    console.log(
      `    ${C.yellow}⚠${C.reset} Live VRAM check: ${C.bold}${usedGB} GB in use${C.reset} by other processes ` +
        `(${freeGB} GB free of ${totalGB} GB total)`,
    );
    console.log(
      `    ${C.dim}Recommending based on FREE VRAM, not total. Close other GPU apps for a larger model.${C.reset}`,
    );
    console.log();
  }

  const recommended = recommendModel(hw, { usableVramMB: wizardUsableVramMB });
  const targetCodename = options?.model ?? recommended.codename;
  const entry = findCatalogEntry(targetCodename) ?? recommended;

  // Show model catalog as a visual table
  const isMacMLX = shouldUseMlx() && entry.mlxRepo;
  const availableVram = hw.totalVramMB > 0 ? hw.totalVramMB : hw.ramMB * 0.7;
  console.log(
    `    ${C.dim}Model                Size    ${isMacMLX ? "  Needs" : "  VRAM"}     Status${C.reset}`,
  );
  console.log(`    ${C.dim}${"─".repeat(58)}${C.reset}`);

  for (const m of MODEL_CATALOG) {
    const isSelected = m.codename === entry.codename;
    let fits: boolean;
    let statusStr: string;

    if (isMacMLX && m.mlxRepo) {
      // macOS Apple Silicon: unified memory + SSD disk offloading
      const modelMB = m.sizeGB * 1024;
      const fitsInRam = modelMB <= hw.ramMB * 0.8;
      const fitsWithOffload = modelMB <= hw.ramMB * 2;
      fits = fitsWithOffload;

      if (isSelected) {
        statusStr = fitsInRam
          ? `${C.green}${C.bold}← SELECTED${C.reset}`
          : `${C.green}${C.bold}← SELECTED ${C.yellow}(SSD offload)${C.reset}`;
      } else if (fitsInRam) {
        statusStr = `${C.green}compatible${C.reset}`;
      } else if (fitsWithOffload) {
        statusStr = `${C.cyan}SSD offload${C.reset}`;
      } else {
        statusStr = `${C.red}too large${C.reset}`;
      }
    } else {
      // Linux/Windows: check VRAM fit, GPU+RAM fit (mmap), or too large
      const fitsVram = m.minVramMB <= availableVram;
      const modelMB = m.sizeGB * 1024;
      const totalCapMB = (hw.totalVramMB > 0 ? hw.totalVramMB : 0) + hw.ramMB * 0.7;
      const fitsWithMmap = modelMB <= totalCapMB;
      fits = fitsWithMmap;

      if (isSelected) {
        statusStr = fitsVram
          ? `${C.green}${C.bold}← SELECTED${C.reset}`
          : `${C.green}${C.bold}← SELECTED ${C.cyan}(mmap)${C.reset}`;
      } else if (fitsVram) {
        statusStr = `${C.green}compatible${C.reset}`;
      } else if (fitsWithMmap) {
        statusStr = `${C.cyan}GPU+mmap${C.reset}`;
      } else {
        statusStr = `${C.red}too large${C.reset}`;
      }
    }

    const icon = isSelected ? `${C.green}▸` : fits ? `${C.dim} ` : `${C.red} `;
    const nameColor = isSelected ? C.bold + C.green : fits ? C.white : C.dim;
    const sizeStr = `${m.sizeGB} GB`.padStart(8);
    // macOS: show model size (RAM needed at full speed), not minVramMB
    const vramStr = isMacMLX
      ? `${Math.ceil(m.sizeGB)} GB`.padStart(6)
      : `${(m.minVramMB / 1024).toFixed(0)} GB`.padStart(6);

    console.log(
      `    ${icon} ${nameColor}${m.codename.padEnd(20)}${C.reset}${sizeStr}  ${vramStr}    ${statusStr}`,
    );
  }

  console.log();
  console.log(
    `    ${C.bold}Selected:${C.reset} ${C.green}${C.bold}${entry.codename}${C.reset} ${C.dim}— ${entry.description}${C.reset}`,
  );
  if (targetCodename !== recommended.codename) {
    console.log(
      `    ${C.yellow}Note: Using manually selected model instead of recommended ${recommended.codename}${C.reset}`,
    );
  }
  // Show disk offloading info for macOS
  if (isMacMLX) {
    const modelMB = entry.sizeGB * 1024;
    if (modelMB > hw.ramMB * 0.8) {
      const overflowGB = ((modelMB - hw.ramMB * 0.8) / 1024).toFixed(1);
      console.log();
      console.log(`    ${C.cyan}SSD Disk Offloading enabled${C.reset}`);
      console.log(
        `    ${C.dim}   ~${overflowGB} GB will stream from NVMe SSD via page cache.${C.reset}`,
      );
      console.log(
        `    ${C.dim}   Speed: slightly slower than full-RAM, but runs models up to 2x your RAM.${C.reset}`,
      );
      console.log(
        `    ${C.dim}   Technique inspired by flash-moe: "Trust the OS" page cache principle.${C.reset}`,
      );
    }
    // Show mmap/partial offload info for Linux/Windows
  } else if (hw.totalVramMB > 0 && hw.totalVramMB < entry.minVramMB) {
    const gpuPct = Math.min(100, Math.round((hw.totalVramMB / (entry.sizeGB * 1024)) * 100));
    console.log();
    console.log(`    ${C.cyan}mmap SSD streaming enabled${C.reset}`);
    console.log(
      `    ${C.dim}   Model doesn't fit fully in VRAM — using partial GPU offload + mmap.${C.reset}`,
    );
    if (hw.totalVramMB >= 2048) {
      console.log(
        `    ${C.dim}   ~${gpuPct}% of layers on GPU, rest streamed from SSD/RAM via mmap.${C.reset}`,
      );
    }
    console.log(
      `    ${C.dim}   For best speed, use an NVMe SSD. SATA SSDs will be slower.${C.reset}`,
    );
  } else if (hw.totalVramMB === 0 && entry.sizeGB * 1024 > hw.ramMB * 0.7) {
    console.log();
    console.log(`    ${C.cyan}mmap SSD streaming enabled${C.reset}`);
    console.log(
      `    ${C.dim}   Model larger than RAM — overflow streamed from SSD via mmap.${C.reset}`,
    );
    console.log(
      `    ${C.dim}   Speed depends on SSD. NVMe recommended for usable performance.${C.reset}`,
    );
  } else if (hw.totalVramMB === 0 && !isMacMLX) {
    console.log();
    console.log(
      `    ${C.yellow}⚠  No GPU detected — model will run on CPU only (slower).${C.reset}`,
    );
    console.log(
      `    ${C.dim}   For faster inference, install an NVIDIA GPU with 4+ GB VRAM.${C.reset}`,
    );
  }
  console.log();

  // ═══════════════════════════════════════════════════════════════
  //  Step 3: Engine Installation
  // ═══════════════════════════════════════════════════════════════

  const useMlx = isMacMLX;
  const engineLabel = useMlx ? "MLX (Apple Silicon optimized)" : "llama.cpp";

  stepHeader(3, `Installing inference engine (${engineLabel})`);
  console.log();

  if (useMlx) {
    const modelMB = entry.sizeGB * 1024;
    const offloading = modelMB > hw.ramMB * 0.8;
    console.log(
      `    ${C.magenta}Apple Silicon detected — using MLX for optimized inference${C.reset}`,
    );
    if (offloading) {
      console.log(
        `    ${C.cyan}Disk offloading active — model will stream from NVMe SSD${C.reset}`,
      );
    }
    console.log();
  }

  let enginePath = getEnginePath();
  if (enginePath && !options?.force) {
    console.log(`    ${C.green}✓${C.reset} Engine already installed`);
    console.log();
  } else if (useMlx) {
    // Install MLX engine on macOS
    enginePath = await installMlxEngine((msg) => {
      const clean = msg.replace(/\n/g, "");
      const line = `    ${C.cyan}⠸${C.reset} ${clean}`;
      const pad = Math.max(0, 90 - stripAnsi(line).length);
      process.stderr.write(`\r${line}${" ".repeat(pad)}\r`);
    });
    const mlxDone = `    ${C.green}✓${C.reset} MLX engine installed`;
    process.stderr.write(
      `\r${mlxDone}${" ".repeat(Math.max(0, 90 - stripAnsi(mlxDone).length))}\n`,
    );
    console.log();
  } else {
    // Install llama.cpp on Linux/Windows
    const engineSpinner = createSpinner("Downloading llama.cpp...");
    enginePath = await downloadEngine(hw, (msg) => {
      const clean = msg.replace(/\n/g, "");
      const pctMatch = clean.match(/(\d+)%/);
      if (pctMatch) {
        engineSpinner.stop();
        const pct = parseInt(pctMatch[1]!, 10);
        const bar = renderProgressBar(pct);
        const detail = clean.replace(/.*?\d+%\s*/, "").trim();
        const line = `    ${C.cyan}↓${C.reset} Engine: ${bar} ${C.dim}${detail}${C.reset}`;
        const pad = Math.max(0, 90 - stripAnsi(line).length);
        process.stderr.write(`\r${line}${" ".repeat(pad)}\r`);
      } else {
        engineSpinner.update(clean);
      }
    });
    engineSpinner.succeed("Engine installed successfully");
    console.log();
  }

  // ═══════════════════════════════════════════════════════════════
  //  Step 4: Model Download
  // ═══════════════════════════════════════════════════════════════

  stepHeader(4, `Downloading ${entry.codename}`);
  console.log();

  // Ask before large / slow downloads. Skip the prompt when:
  //   - user passed --yes or --model explicitly (they know what they want)
  //   - model is already downloaded (not re-downloading anything)
  //   - KCODE_SKIP_DOWNLOAD_CONFIRM=1 is set (CI / scripted installs)
  const modelAlreadyDownloaded =
    !useMlx && isModelDownloaded(entry.codename) && !options?.force;
  const skipConfirm =
    options?.yes ||
    options?.model ||
    modelAlreadyDownloaded ||
    process.env.KCODE_SKIP_DOWNLOAD_CONFIRM === "1";

  if (!skipConfirm) {
    const { createInterface } = await import("node:readline");
    const willUseMmap =
      hw.totalVramMB > 0 && entry.sizeGB * 1024 > hw.totalVramMB * 0.9;
    const warnLine = willUseMmap
      ? `    ${C.yellow}⚠${C.reset} This model (${entry.sizeGB} GB) exceeds your VRAM (${(hw.totalVramMB / 1024).toFixed(0)} GB). It will run via partial GPU + SSD streaming — noticeably slower than a fully-in-VRAM model.`
      : null;
    if (warnLine) {
      console.log(warnLine);
      console.log(
        `    ${C.dim}Consider a smaller model (e.g. mark5-nano, deepseek-coder-v2) with ${C.reset}${C.bold}--model <codename>${C.reset}${C.dim}, or run ${C.reset}${C.bold}kcode cloud${C.reset}${C.dim} for cloud instead.${C.reset}`,
      );
      console.log();
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question(
        `    Download ${entry.codename} (${entry.sizeGB} GB)? [Y/n]: `,
        (a) => {
          rl.close();
          resolve(a.trim().toLowerCase());
        },
      );
    });
    if (answer && !(answer.startsWith("y") || answer === "s" || answer === "si")) {
      console.log();
      console.log(
        `    ${C.yellow}Download cancelled.${C.reset} Re-run ${C.bold}setup${C.reset} with ${C.bold}--model <codename>${C.reset} to pick a different one, or ${C.bold}kcode cloud${C.reset} for cloud setup.`,
      );
      console.log();
      return;
    }
    console.log();
  }

  let modelPath: string;

  if (useMlx) {
    // MLX model download (via HuggingFace)
    console.log(
      `    ${C.dim}Format: MLX ${entry.mlxQuant} — optimized for Apple Silicon${C.reset}`,
    );
    console.log();

    modelPath = await downloadMlxModel(entry, (msg) => {
      process.stderr.write(`${`\r    ${C.cyan}↓${C.reset} ${msg}`.padEnd(90)}\r`);
    });
    process.stderr.write(`${`\r    ${C.green}✓${C.reset} Model downloaded (MLX)`.padEnd(90)}\n`);
    console.log();
  } else if (isModelDownloaded(entry.codename) && !options?.force) {
    console.log(`    ${C.green}✓${C.reset} Model already downloaded`);
    console.log();
    modelPath = getModelPath(entry.codename)!;
  } else {
    console.log(`    ${C.dim}Size: ${entry.sizeGB} GB — this may take a while...${C.reset}`);
    console.log();

    modelPath = await lazyDownloadModel(entry.codename, (msg) => {
      const clean = msg.replace(/\n/g, "");
      const pctMatch = clean.match(/(\d+)%/);
      if (pctMatch) {
        const pct = parseInt(pctMatch[1]!, 10);
        const bar = renderProgressBar(pct, 35);
        const detail = clean.replace(/.*?\d+%\s*/, "").trim();
        const line = `    ${C.cyan}↓${C.reset} Model: ${bar} ${C.dim}${detail}${C.reset}`;
        const pad = Math.max(0, 90 - stripAnsi(line).length);
        process.stderr.write(`\r${line}${" ".repeat(pad)}\r`);
      } else {
        const line = `    ${C.cyan}↓${C.reset} ${clean}`;
        const pad = Math.max(0, 90 - stripAnsi(line).length);
        process.stderr.write(`\r${line}${" ".repeat(pad)}\r`);
      }
    });
    const doneLine = `    ${C.green}✓${C.reset} Model downloaded successfully`;
    const donePad = Math.max(0, 90 - stripAnsi(doneLine).length);
    process.stderr.write(`\r${doneLine}${" ".repeat(donePad)}\n`);
    console.log();
  }

  // ═══════════════════════════════════════════════════════════════
  //  Step 5: Install to PATH
  // ═══════════════════════════════════════════════════════════════

  stepHeader(5, "Installing kcode command");
  console.log();

  const installSpinner = createSpinner("Installing to PATH...");
  const installed = installToPath();
  if (installed) {
    installSpinner.succeed(`Installed: ${C.cyan}${installed}${C.reset}`);
  } else {
    installSpinner.succeed(`Already available as ${C.cyan}kcode${C.reset}`);
  }
  console.log();

  // ═══════════════════════════════════════════════════════════════
  //  Step 6: Configuration
  // ═══════════════════════════════════════════════════════════════

  stepHeader(6, "Configuring concurrency & context");
  console.log();

  const configSpinner = createSpinner("Calculating optimal settings...");

  // Default port for local llama-server
  const port = 10091;

  // Calculate optimal parallel slots based on available VRAM/RAM
  const concurrency = calculateConcurrency(hw, entry, { cacheQuant: "q4_0" });

  configSpinner.succeed("Concurrency calculated");

  // Display concurrency settings
  const freeMemMB =
    (hw.totalVramMB > 0 ? hw.totalVramMB : hw.ramMB) -
    entry.sizeGB * 1024 -
    (hw.platform === "win32" ? 500 : 300);
  const memLabel = hw.totalVramMB > 0 ? "VRAM" : "RAM";

  console.log();
  console.log(`    ${C.dim}┌──────────────────────────────────────────────┐${C.reset}`);
  console.log(
    `    ${C.dim}│${C.reset}  ${C.bold}Parallel Sessions${C.reset}  ${C.cyan}${C.bold}${concurrency.parallelSlots}${C.reset} simultaneous users     ${C.dim}│${C.reset}`,
  );
  console.log(
    `    ${C.dim}│${C.reset}  ${C.bold}Context per Slot${C.reset}   ${C.cyan}${(concurrency.contextPerSlot / 1024).toFixed(0)}K${C.reset} tokens                ${C.dim}│${C.reset}`,
  );
  console.log(
    `    ${C.dim}│${C.reset}  ${C.bold}Total Context${C.reset}      ${C.cyan}${(concurrency.totalContext / 1024).toFixed(0)}K${C.reset} tokens                ${C.dim}│${C.reset}`,
  );
  console.log(
    `    ${C.dim}│${C.reset}  ${C.bold}Free ${memLabel}${C.reset}          ${C.dim}~${(Math.max(0, freeMemMB) / 1024).toFixed(1)} GB after model${C.reset}       ${C.dim}│${C.reset}`,
  );
  console.log(
    `    ${C.dim}│${C.reset}  ${C.bold}KV Cache${C.reset}           ${C.dim}q4_0 quantized (4x smaller)${C.reset}  ${C.dim}│${C.reset}`,
  );
  console.log(`    ${C.dim}└──────────────────────────────────────────────┘${C.reset}`);

  if (concurrency.parallelSlots > 1) {
    console.log(
      `    ${C.green}✓${C.reset} ${concurrency.parallelSlots} users can use the AI simultaneously, each with ${(concurrency.contextPerSlot / 1024).toFixed(0)}K context`,
    );
  } else {
    console.log(
      `    ${C.yellow}⚠${C.reset} Single-user mode — not enough ${memLabel} for multiple parallel sessions`,
    );
    if (hw.totalVramMB > 0) {
      console.log(
        `    ${C.dim}   Tip: add more VRAM or use a smaller model/quantization for multi-user${C.reset}`,
      );
    }
  }
  console.log();

  const writeSpinner = createSpinner("Writing configuration...");

  await addModel({
    name: entry.codename,
    baseUrl: `http://localhost:${port}`,
    contextSize: concurrency.contextPerSlot,
    gpu: hw.gpus.map((g) => g.name).join(" + ") || "CPU",
    capabilities: ["code"],
    description: entry.description,
  });

  await setDefaultModel(entry.codename);

  // For MLX disk offloading: calculate wired memory limit.
  let mlxWiredLimitMB: number | undefined;
  if (useMlx) {
    const modelMB = entry.sizeGB * 1024;
    const ramMB = hw.ramMB;
    if (modelMB > ramMB * 0.8) {
      mlxWiredLimitMB = Math.floor(ramMB * 0.75);
    }
  }

  await Bun.write(
    join(KCODE_HOME, "server.json"),
    `${JSON.stringify(
      {
        enginePath,
        modelPath,
        codename: entry.codename,
        port,
        contextSize: concurrency.totalContext,
        contextPerSlot: concurrency.contextPerSlot,
        parallelSlots: concurrency.parallelSlots,
        gpuLayers: calculateGpuLayers(hw, entry),
        gpus: hw.gpus,
        engine: useMlx ? "mlx" : "llama.cpp",
        mlxRepo: useMlx ? entry.mlxRepo : undefined,
        mlxWiredLimitMB,
      },
      null,
      2,
    )}\n`,
  );

  // Mark setup as complete
  await Bun.write(SETUP_MARKER, `${new Date().toISOString()}\n${entry.codename}\n`);

  writeSpinner.succeed("Configuration saved");
  console.log();

  // ═══════════════════════════════════════════════════════════════
  //  Step 7: Start server & load model into VRAM
  // ═══════════════════════════════════════════════════════════════

  stepHeader(7, "Loading model into VRAM");
  console.log();

  const serverSpinner = createSpinner("Starting inference server...");

  try {
    const { startServer } = await import("./llama-server");
    const { port: srvPort } = await startServer({ port });

    serverSpinner.update("Model loading into VRAM...");

    // Wait for model to be fully loaded and ready to serve
    const maxWait = 180_000; // 3 minutes for large models
    const startTime = Date.now();
    let ready = false;
    while (Date.now() - startTime < maxWait) {
      try {
        const healthResp = await fetch(`http://localhost:${srvPort}/health`, {
          signal: AbortSignal.timeout(3000),
        });
        if (healthResp.ok) {
          const health = (await healthResp.json()) as { status?: string };
          if (health.status === "ok") {
            const modelsResp = await fetch(`http://localhost:${srvPort}/v1/models`, {
              signal: AbortSignal.timeout(3000),
            });
            if (modelsResp.ok) {
              ready = true;
              break;
            }
          }
        }
      } catch (err) {
        log.debug("model-manager", `Server not ready: ${err}`);
      }

      const elapsed = Math.round((Date.now() - startTime) / 1000);
      serverSpinner.update(`Loading model into VRAM... ${C.dim}(${elapsed}s)${C.reset}`);
      await new Promise((r) => setTimeout(r, 500));
    }

    if (ready) {
      serverSpinner.succeed(`Model loaded on port ${C.cyan}${srvPort}${C.reset} — ready to serve`);
    } else {
      serverSpinner.fail("Server started but model may not be fully loaded");
    }
  } catch (err) {
    serverSpinner.fail(`Server failed: ${err instanceof Error ? err.message : err}`);
  }

  console.log();

  // ═══════════════════════════════════════════════════════════════
  //  Complete!
  // ═══════════════════════════════════════════════════════════════

  const slotsLabel =
    concurrency.parallelSlots > 1
      ? `${concurrency.parallelSlots} slots × ${(concurrency.contextPerSlot / 1024).toFixed(0)}K ctx`
      : `1 slot × ${(concurrency.contextPerSlot / 1024).toFixed(0)}K ctx`;
  const successBox = [
    `    ${C.green}╔══════════════════════════════════════════════╗${C.reset}`,
    `    ${C.green}║${C.reset}                                              ${C.green}║${C.reset}`,
    `    ${C.green}║${C.reset}   ${C.bold}${C.green}Setup complete!${C.reset}                           ${C.green}║${C.reset}`,
    `    ${C.green}║${C.reset}                                              ${C.green}║${C.reset}`,
    `    ${C.green}║${C.reset}   Model:   ${C.cyan}${entry.codename.padEnd(33)}${C.reset}${C.green}║${C.reset}`,
    `    ${C.green}║${C.reset}   Port:    ${C.cyan}${port.toString().padEnd(33)}${C.reset}${C.green}║${C.reset}`,
    `    ${C.green}║${C.reset}   Engine:  ${C.dim}${engineLabel.padEnd(33)}${C.reset}${C.green}║${C.reset}`,
    `    ${C.green}║${C.reset}   Concur:  ${C.cyan}${slotsLabel.padEnd(33)}${C.reset}${C.green}║${C.reset}`,
    `    ${C.green}║${C.reset}                                              ${C.green}║${C.reset}`,
    `    ${C.green}╚══════════════════════════════════════════════╝${C.reset}`,
  ];
  console.log(successBox.join("\n"));
  console.log();

  // Pro features hint
  console.log(
    `  ${C.dim}💡 Pro features available: swarm, browser, API server, and more${C.reset}`,
  );
  console.log(`  ${C.dim}   Activate: ${C.cyan}kcode pro activate <your-pro-key>${C.reset}`);
  console.log(`  ${C.dim}   Info:     ${C.cyan}https://kulvex.ai/pro${C.reset}`);
  console.log();

  return { model: entry.codename, enginePath, modelPath };
}
