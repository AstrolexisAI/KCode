// KCode - Smart Startup Resolver
//
// Determines the best inference strategy on startup:
// 1. Has local GPU + model → use local (fastest)
// 2. Has local + cloud → ask user preference (remember choice)
// 3. No local hardware → guide to cloud setup
// 4. Remember choice across sessions (don't ask again)

import { existsSync, readFileSync } from "node:fs";
import { log } from "./logger";
import { kcodeHome, kcodePath } from "./paths";

export type InferenceMode = "local" | "cloud" | "none";

export interface StartupDecision {
  mode: InferenceMode;
  /** For cloud: the provider name */
  provider?: string;
  /** Model name to use */
  model?: string;
  /** API base URL */
  apiBase?: string;
  /** Whether we need to prompt user */
  needsPrompt: boolean;
  /** Message to show user */
  message: string;
}

interface HardwareCheck {
  hasGPU: boolean;
  gpuName?: string;
  vramMB?: number;
  ramMB: number;
  canRunLocal: boolean;
  reason?: string;
}

/**
 * Quick hardware check — can this machine run local inference?
 * Requires: GPU with >= 4GB VRAM or >= 16GB RAM (CPU mode)
 */
export async function checkLocalCapability(): Promise<HardwareCheck> {
  const ramMB = Math.round(require("os").totalmem() / 1024 / 1024);
  let hasGPU = false;
  let gpuName: string | undefined;
  let vramMB: number | undefined;

  // Check NVIDIA GPU
  try {
    const { execSync } = require("child_process");
    const output = execSync("nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits", {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (output) {
      const [name, vram] = output.split("\n")[0]!.split(", ");
      hasGPU = true;
      gpuName = name?.trim();
      vramMB = parseInt(vram?.trim() ?? "0", 10);
    }
  } catch { /* no NVIDIA GPU */ }

  // Check Apple Silicon (always has shared memory)
  if (!hasGPU && process.platform === "darwin" && process.arch === "arm64") {
    hasGPU = true;
    gpuName = "Apple Silicon (unified memory)";
    vramMB = ramMB; // shared memory
  }

  // Can run local?
  const minVRAM = 4096; // 4GB minimum for small models
  const minRAM = 16384; // 16GB for CPU-only mode
  const canRunLocal = (hasGPU && (vramMB ?? 0) >= minVRAM) || ramMB >= minRAM;
  const reason = !canRunLocal
    ? hasGPU
      ? `GPU found (${gpuName}) but only ${vramMB}MB VRAM (need ${minVRAM}MB+)`
      : `No GPU detected and only ${ramMB}MB RAM (need ${minRAM}MB+ for CPU mode)`
    : undefined;

  return { hasGPU, gpuName, vramMB, ramMB, canRunLocal, reason };
}

/**
 * Check which cloud providers are configured.
 */
export function checkCloudProviders(): Array<{ name: string; envVar: string; configured: boolean }> {
  return [
    { name: "Anthropic", envVar: "ANTHROPIC_API_KEY", configured: !!(process.env.ANTHROPIC_API_KEY || process.env.KCODE_ANTHROPIC_KEY) },
    { name: "OpenAI", envVar: "OPENAI_API_KEY", configured: !!process.env.OPENAI_API_KEY },
    { name: "Google Gemini", envVar: "GOOGLE_API_KEY", configured: !!(process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY) },
    { name: "Groq", envVar: "GROQ_API_KEY", configured: !!process.env.GROQ_API_KEY },
    { name: "DeepSeek", envVar: "DEEPSEEK_API_KEY", configured: !!process.env.DEEPSEEK_API_KEY },
    { name: "Together AI", envVar: "TOGETHER_API_KEY", configured: !!process.env.TOGETHER_API_KEY },
  ];
}

/**
 * Check if user has a saved inference preference.
 */
export function getSavedPreference(): { mode: InferenceMode; provider?: string } | null {
  try {
    const settingsPath = kcodePath("settings.json");
    if (!existsSync(settingsPath)) return null;
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    if (settings.inferenceMode) {
      return {
        mode: settings.inferenceMode as InferenceMode,
        provider: settings.inferenceProvider as string | undefined,
      };
    }
  } catch { /* no saved preference */ }
  return null;
}

/**
 * Main resolver: determine how to start KCode.
 */
export async function resolveStartup(): Promise<StartupDecision> {
  const hw = await checkLocalCapability();
  const cloudProviders = checkCloudProviders();
  const configuredCloud = cloudProviders.filter(p => p.configured);
  const saved = getSavedPreference();
  const hasLocalModel = existsSync(kcodePath("server.port")) || existsSync(kcodePath("models"));

  log.debug("startup", `Hardware: GPU=${hw.hasGPU} (${hw.gpuName ?? "none"}) VRAM=${hw.vramMB ?? 0}MB RAM=${hw.ramMB}MB canLocal=${hw.canRunLocal}`);
  log.debug("startup", `Cloud: ${configuredCloud.map(p => p.name).join(", ") || "none"}`);
  log.debug("startup", `Saved preference: ${saved?.mode ?? "none"}`);

  // ── Case 1: Saved preference — use it silently ──
  if (saved) {
    if (saved.mode === "local" && hw.canRunLocal) {
      return { mode: "local", needsPrompt: false, message: "" };
    }
    if (saved.mode === "cloud" && configuredCloud.length > 0) {
      return { mode: "cloud", provider: saved.provider, needsPrompt: false, message: "" };
    }
    // Saved preference no longer valid (hardware changed, key removed)
    log.info("startup", `Saved preference '${saved.mode}' no longer valid, re-evaluating`);
  }

  // ── Case 2: Has local + cloud → ask user ──
  if (hw.canRunLocal && configuredCloud.length > 0) {
    return {
      mode: "none",
      needsPrompt: true,
      message: `Local GPU available (${hw.gpuName ?? "CPU"}) and ${configuredCloud.length} cloud provider(s) configured.\nChoose your inference mode:`,
    };
  }

  // ── Case 3: Has local only → use local ──
  if (hw.canRunLocal) {
    return {
      mode: "local",
      needsPrompt: false,
      message: `Using local inference (${hw.gpuName ?? "CPU mode"})`,
    };
  }

  // ── Case 4: Has cloud only → use cloud ──
  if (configuredCloud.length > 0) {
    const provider = configuredCloud[0]!;
    return {
      mode: "cloud",
      provider: provider.name,
      needsPrompt: false,
      message: `No local GPU — using ${provider.name} cloud inference`,
    };
  }

  // ── Case 5: Nothing available → guide to setup ──
  return {
    mode: "none",
    needsPrompt: true,
    message: hw.canRunLocal
      ? "Local hardware available but no model downloaded. Run setup."
      : `No local GPU detected${hw.reason ? " (" + hw.reason + ")" : ""}.\nConfigure a cloud provider to get started:`,
  };
}
