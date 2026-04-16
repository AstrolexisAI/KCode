// KCode — Cloud-First Setup Flow
//
// Invoked by the setup wizard when hardware tier is weak/unusable.
// Detects any existing cloud credentials (settings.json, env vars,
// OAuth sessions) and either confirms them or walks the user through
// picking a provider.
//
// Design: this is a plain-text CLI flow (readline), not a TUI — the
// setup wizard runs outside the Ink renderer.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { log } from "./logger";
import { kcodePath } from "./paths";

// ─── Provider catalog ───────────────────────────────────────────

interface CloudProviderOption {
  id: string;
  label: string;
  /** Where to get an API key — a URL the user can visit. */
  signupUrl: string;
  /** Field name in ~/.kcode/settings.json for the API key. */
  settingsField: string;
  /** Environment variable alternative. */
  envVar: string;
  /** Short cost note shown to the user. */
  costNote: string;
  /** Whether this provider supports OAuth via /auth. */
  supportsOAuth: boolean;
  /** Suggested default model IDs for this provider. */
  suggestedModels: string[];
}

const PROVIDERS: CloudProviderOption[] = [
  {
    id: "anthropic",
    label: "Anthropic (Claude — highest quality, subscriber flat-rate or pay-per-token)",
    signupUrl: "https://console.anthropic.com/settings/keys",
    settingsField: "anthropicApiKey",
    envVar: "ANTHROPIC_API_KEY",
    costNote: "$3/MTok in, $15/MTok out for Sonnet; $15/$75 for Opus. Or $20/mo Pro for 5× usage.",
    supportsOAuth: true,
    suggestedModels: ["claude-sonnet-4-6", "claude-opus-4-7", "claude-haiku-4-5"],
  },
  {
    id: "openai",
    label: "OpenAI (GPT-4o, o3 — strong reasoning)",
    signupUrl: "https://platform.openai.com/api-keys",
    settingsField: "openaiApiKey",
    envVar: "OPENAI_API_KEY",
    costNote: "$2.50/MTok in, $10/MTok out for GPT-4o. o3 is ~3× pricier.",
    supportsOAuth: true,
    suggestedModels: ["gpt-4o", "o3-mini"],
  },
  {
    id: "groq",
    label: "Groq (fastest inference, Llama/Qwen models — very cheap)",
    signupUrl: "https://console.groq.com/keys",
    settingsField: "groqApiKey",
    envVar: "GROQ_API_KEY",
    costNote: "$0.59-$0.79/MTok. Fastest tokens/sec in the industry (~500 tok/s).",
    supportsOAuth: false,
    suggestedModels: ["llama-3.3-70b-versatile", "llama-3.1-70b-versatile"],
  },
  {
    id: "deepseek",
    label: "DeepSeek (strong coding, very cheap)",
    signupUrl: "https://platform.deepseek.com/api_keys",
    settingsField: "deepseekApiKey",
    envVar: "DEEPSEEK_API_KEY",
    costNote: "$0.14/MTok in, $0.28/MTok out. Best price/perf for coding.",
    supportsOAuth: false,
    suggestedModels: ["deepseek-r1", "deepseek-v3", "deepseek-coder-v2"],
  },
  {
    id: "together",
    label: "Together AI (many open models, competitive pricing)",
    signupUrl: "https://api.together.xyz/settings/api-keys",
    settingsField: "togetherApiKey",
    envVar: "TOGETHER_API_KEY",
    costNote: "Varies by model. Most 70B models at ~$0.88/MTok.",
    supportsOAuth: false,
    suggestedModels: ["meta-llama/Llama-3.3-70B-Instruct-Turbo"],
  },
];

// ─── Credential detection ───────────────────────────────────────

export interface DetectedCredential {
  providerId: string;
  source: "settings" | "env" | "oauth";
  /** Brief description shown to the user; never the key itself. */
  summary: string;
}

/**
 * Look in all the usual places for pre-configured credentials.
 * Returns every provider that has at least one usable credential so
 * the wizard can ask "use detected X?" instead of asking for a key.
 */
export async function detectExistingCredentials(): Promise<DetectedCredential[]> {
  const detected: DetectedCredential[] = [];

  // settings.json
  try {
    const settingsPath = kcodePath("settings.json");
    if (existsSync(settingsPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      for (const p of PROVIDERS) {
        const key = settings[p.settingsField];
        if (typeof key === "string" && key.length > 0) {
          detected.push({
            providerId: p.id,
            source: "settings",
            summary: `${p.label.split(" (")[0]} — key in ~/.kcode/settings.json`,
          });
        }
      }
    }
  } catch {
    /* malformed settings — skip */
  }

  // Env vars
  for (const p of PROVIDERS) {
    // Don't double-count if already detected via settings
    if (detected.some((d) => d.providerId === p.id)) continue;
    const v = process.env[p.envVar];
    if (v && v.length > 0) {
      detected.push({
        providerId: p.id,
        source: "env",
        summary: `${p.label.split(" (")[0]} — key in $${p.envVar}`,
      });
    }
  }

  // OAuth sessions
  try {
    const { getAuthSessionManager } = await import("./auth/session.js");
    const { resolveProviderConfig } = await import("./auth/oauth-flow.js");
    const manager = getAuthSessionManager();
    for (const p of PROVIDERS) {
      if (!p.supportsOAuth) continue;
      if (detected.some((d) => d.providerId === p.id)) continue;
      try {
        const cfg = resolveProviderConfig(p.id);
        const token = await manager.getAccessToken(p.id, cfg ?? undefined);
        if (token) {
          detected.push({
            providerId: p.id,
            source: "oauth",
            summary: `${p.label.split(" (")[0]} — OAuth session via /auth`,
          });
        }
      } catch {
        /* provider not OAuth-configured — skip */
      }
    }
  } catch {
    /* auth module missing — skip */
  }

  return detected;
}

// ─── CLI prompts ────────────────────────────────────────────────

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function confirm(question: string, defaultYes: boolean = true): Promise<boolean> {
  const suffix = defaultYes ? " [Y/n]: " : " [y/N]: ";
  const answer = (await prompt(question + suffix)).toLowerCase();
  if (!answer) return defaultYes;
  return answer.startsWith("y") || answer === "s" || answer === "si";
}

// ─── Public entry point ─────────────────────────────────────────

export interface CloudSetupResult {
  /** Provider ID the user configured (or picked from existing). */
  providerId: string;
  /** Model to use as the default. */
  defaultModel: string;
  /** Whether setup modified ~/.kcode/settings.json. */
  settingsUpdated: boolean;
  /** If set, user opted out entirely — caller should fall back to local. */
  declined?: boolean;
}

/**
 * Walk the user through picking / confirming a cloud provider. Writes
 * the resulting API key to ~/.kcode/settings.json if they provide one,
 * and returns the chosen provider + default model.
 *
 * If the user declines cloud entirely, returns `{ declined: true }`
 * so the caller can fall back to local (or exit with a clear message).
 */
export async function runCloudSetup(opts?: {
  tierReason?: string;
}): Promise<CloudSetupResult> {
  console.log();
  console.log("\x1b[1m\x1b[36m   Cloud provider setup\x1b[0m");
  console.log();
  if (opts?.tierReason) {
    console.log(`   \x1b[2m${opts.tierReason}\x1b[0m`);
    console.log(
      `   \x1b[2mCloud inference is recommended for your hardware. Setting it up now.\x1b[0m`,
    );
    console.log();
  }

  const existing = await detectExistingCredentials();

  // Fast path: user already has credentials configured somewhere
  if (existing.length > 0) {
    console.log("   \x1b[32m✓\x1b[0m Detected existing credentials:");
    existing.forEach((d, i) => console.log(`     ${i + 1}. ${d.summary}`));
    console.log();
    const useExisting = await confirm(
      `   Use existing credentials${existing.length === 1 ? ` (${existing[0]!.providerId})` : ""}?`,
      true,
    );
    if (useExisting) {
      // If multiple, let user pick
      let chosen = existing[0]!;
      if (existing.length > 1) {
        const pick = await prompt(`   Which one? (1-${existing.length}): `);
        const idx = parseInt(pick, 10) - 1;
        if (!Number.isNaN(idx) && idx >= 0 && idx < existing.length) {
          chosen = existing[idx]!;
        }
      }
      const providerSpec = PROVIDERS.find((p) => p.id === chosen.providerId)!;
      return {
        providerId: chosen.providerId,
        defaultModel: providerSpec.suggestedModels[0]!,
        settingsUpdated: false,
      };
    }
  }

  // Full path: pick a provider from scratch
  console.log("   Available cloud providers:");
  console.log();
  PROVIDERS.forEach((p, i) => {
    console.log(`     ${i + 1}. ${p.label}`);
    console.log(`        \x1b[2m${p.costNote}\x1b[0m`);
  });
  console.log(`     ${PROVIDERS.length + 1}. Skip cloud setup (local only)`);
  console.log();

  const pick = await prompt(`   Pick a provider [1-${PROVIDERS.length + 1}]: `);
  const idx = parseInt(pick, 10) - 1;

  if (idx === PROVIDERS.length) {
    return {
      providerId: "",
      defaultModel: "",
      settingsUpdated: false,
      declined: true,
    };
  }

  if (Number.isNaN(idx) || idx < 0 || idx >= PROVIDERS.length) {
    console.log("   \x1b[31m✗\x1b[0m Invalid choice, skipping cloud setup.");
    return {
      providerId: "",
      defaultModel: "",
      settingsUpdated: false,
      declined: true,
    };
  }

  const spec = PROVIDERS[idx]!;
  console.log();
  console.log(`   Selected: \x1b[1m${spec.label}\x1b[0m`);
  console.log(`   Get an API key from: \x1b[36m${spec.signupUrl}\x1b[0m`);
  console.log();

  // OAuth hint for supported providers
  if (spec.supportsOAuth) {
    console.log(
      `   \x1b[2mTip: you can also log in via browser with \`kcode auth login ${spec.id}\` after setup.\x1b[0m`,
    );
    console.log();
  }

  const apiKey = await prompt("   Paste your API key (or leave blank to skip): ");
  if (!apiKey) {
    console.log("   \x1b[33m!\x1b[0m No key entered — you can run `kcode auth login` later.");
    return {
      providerId: spec.id,
      defaultModel: spec.suggestedModels[0]!,
      settingsUpdated: false,
    };
  }

  // Write to settings.json
  const settingsPath = kcodePath("settings.json");
  let settings: Record<string, unknown> = {};
  try {
    if (existsSync(settingsPath)) {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    }
  } catch {
    /* start fresh */
  }
  settings[spec.settingsField] = apiKey;
  try {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    console.log(
      `   \x1b[32m✓\x1b[0m Saved ${spec.settingsField} to ~/.kcode/settings.json`,
    );
  } catch (err) {
    log.warn("cloud-setup", `failed to write settings.json: ${err}`);
  }

  return {
    providerId: spec.id,
    defaultModel: spec.suggestedModels[0]!,
    settingsUpdated: true,
  };
}

// ─── Export for wizard consumption ──────────────────────────────

export { PROVIDERS as CLOUD_PROVIDER_OPTIONS };
