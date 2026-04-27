// KCode — Cloud provider health probe
//
// Powers `kcode doctor --providers`. For every cloud provider the
// user has configured (settings.json OR env var), hit two endpoints:
//
//   1. Auth ping     — /v1/models or the provider's equivalent.
//                      Validates the key + reachability in one
//                      round-trip. Fast, no token spend.
//   2. Content probe — minimal chat/completion request with a tiny
//                      prompt ("say hi in 3 words") and max_tokens=20.
//                      The real reason this command exists: the
//                      "empty response — model returned no text"
//                      class of bug is provider-specific and only
//                      surfaces when you actually do a completion.
//                      Reporting "0 chars returned" for a provider
//                      here tells the user which one's responsible.
//
// Design constraints:
//   - Never log the key. Source is shown (settings / env) but not
//     the value.
//   - Per-provider timeout of 10s. If a provider hangs, we move on.
//   - Zero hard dependencies on the audit engine / conversation
//     layer — this should work on a fresh install before any
//     session has been opened.

import { existsSync, readFileSync } from "node:fs";
import { kcodePath } from "../paths";

export interface ProviderProbeResult {
  id: string;
  name: string;
  configured: boolean;
  /** "env" | "settings" | "none" */
  keySource: "env" | "settings" | "none";
  auth: {
    reachable: boolean;
    status?: number;
    latencyMs?: number;
    error?: string;
  };
  content: {
    ok: boolean;
    chars?: number;
    latencyMs?: number;
    /** Full sanitized response text if small, or a truncated preview. */
    preview?: string;
    error?: string;
  };
}

interface ProviderDef {
  id: string;
  name: string;
  settingsField: string;
  envVars: string[];
  /** Exact completion URL (no trailing slash). */
  completionsUrl: string;
  /** Auth-check URL (GET). */
  modelsUrl: string;
  /** Model to call for the content probe — cheapest available. */
  probeModel: string;
  /** How to shape the auth header. */
  auth: "bearer" | "anthropic";
  /** Whether the request body uses OpenAI-style chat/completions. */
  shape: "openai" | "anthropic";
}

const PROVIDERS: ProviderDef[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    settingsField: "anthropicApiKey",
    envVars: ["ANTHROPIC_API_KEY", "KCODE_ANTHROPIC_KEY"],
    completionsUrl: "https://api.anthropic.com/v1/messages",
    modelsUrl: "https://api.anthropic.com/v1/models",
    probeModel: "claude-haiku-4-5",
    auth: "anthropic",
    shape: "anthropic",
  },
  {
    id: "openai",
    name: "OpenAI",
    settingsField: "openaiApiKey",
    envVars: ["OPENAI_API_KEY"],
    completionsUrl: "https://api.openai.com/v1/chat/completions",
    modelsUrl: "https://api.openai.com/v1/models",
    probeModel: "gpt-4o-mini",
    auth: "bearer",
    shape: "openai",
  },
  {
    id: "groq",
    name: "Groq",
    settingsField: "groqApiKey",
    envVars: ["GROQ_API_KEY"],
    completionsUrl: "https://api.groq.com/openai/v1/chat/completions",
    modelsUrl: "https://api.groq.com/openai/v1/models",
    probeModel: "llama-3.1-8b-instant",
    auth: "bearer",
    shape: "openai",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    settingsField: "deepseekApiKey",
    envVars: ["DEEPSEEK_API_KEY"],
    completionsUrl: "https://api.deepseek.com/v1/chat/completions",
    modelsUrl: "https://api.deepseek.com/v1/models",
    probeModel: "deepseek-chat",
    auth: "bearer",
    shape: "openai",
  },
  {
    id: "xai",
    name: "xAI (Grok)",
    settingsField: "xaiApiKey",
    envVars: ["XAI_API_KEY"],
    completionsUrl: "https://api.x.ai/v1/chat/completions",
    modelsUrl: "https://api.x.ai/v1/models",
    probeModel: "grok-code-fast-1",
    auth: "bearer",
    shape: "openai",
  },
  {
    id: "together",
    name: "Together AI",
    settingsField: "togetherApiKey",
    envVars: ["TOGETHER_API_KEY"],
    completionsUrl: "https://api.together.xyz/v1/chat/completions",
    modelsUrl: "https://api.together.xyz/v1/models",
    probeModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    auth: "bearer",
    shape: "openai",
  },
];

function loadSettings(): Record<string, unknown> {
  try {
    const p = kcodePath("settings.json");
    if (!existsSync(p)) return {};
    return JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function resolveKey(
  prov: ProviderDef,
  settings: Record<string, unknown>,
): { key: string | null; source: ProviderProbeResult["keySource"] } {
  for (const v of prov.envVars) {
    const envVal = process.env[v];
    if (envVal) return { key: envVal, source: "env" };
  }
  const s = settings[prov.settingsField];
  if (typeof s === "string" && s.length > 0) return { key: s, source: "settings" };
  return { key: null, source: "none" };
}

function buildAuthHeaders(prov: ProviderDef, key: string): Record<string, string> {
  if (prov.auth === "anthropic") {
    return {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    };
  }
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${key}`,
  };
}

async function probeAuth(prov: ProviderDef, key: string): Promise<ProviderProbeResult["auth"]> {
  const start = Date.now();
  try {
    const resp = await fetch(prov.modelsUrl, {
      method: "GET",
      headers: buildAuthHeaders(prov, key),
      signal: AbortSignal.timeout(10_000),
    });
    const latencyMs = Date.now() - start;
    // Anthropic specifically rejects GET /v1/models with 401 when
    // the key is invalid, and returns the model list otherwise.
    // Any status under 500 means we reached the API; under 300
    // means the key worked. We only flag "not reachable" on
    // network failure / 5xx.
    return {
      reachable: resp.status < 500,
      status: resp.status,
      latencyMs,
    };
  } catch (err) {
    return {
      reachable: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function probeContent(
  prov: ProviderDef,
  key: string,
): Promise<ProviderProbeResult["content"]> {
  const start = Date.now();
  const body =
    prov.shape === "anthropic"
      ? {
          model: prov.probeModel,
          max_tokens: 20,
          messages: [{ role: "user", content: "Say 'ok' and nothing else." }],
        }
      : {
          model: prov.probeModel,
          max_tokens: 20,
          messages: [{ role: "user", content: "Say 'ok' and nothing else." }],
        };
  try {
    const resp = await fetch(prov.completionsUrl, {
      method: "POST",
      headers: buildAuthHeaders(prov, key),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const latencyMs = Date.now() - start;
    if (!resp.ok) {
      return {
        ok: false,
        latencyMs,
        error: `HTTP ${resp.status}`,
      };
    }
    const data = (await resp.json()) as {
      content?: Array<{ text?: string; type?: string }>;
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text =
      prov.shape === "anthropic"
        ? (data.content ?? [])
            .filter((b) => b.type === "text")
            .map((b) => b.text ?? "")
            .join("")
        : (data.choices?.[0]?.message?.content ?? "");
    const chars = text.length;
    return {
      ok: chars > 0,
      chars,
      latencyMs,
      preview: chars > 0 ? text.slice(0, 60) : undefined,
      error: chars === 0 ? "empty response (0 chars returned)" : undefined,
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Run the full probe across every configured provider. */
export async function probeAllProviders(): Promise<ProviderProbeResult[]> {
  const settings = loadSettings();
  const out: ProviderProbeResult[] = [];
  for (const prov of PROVIDERS) {
    const { key, source } = resolveKey(prov, settings);
    if (!key) {
      out.push({
        id: prov.id,
        name: prov.name,
        configured: false,
        keySource: "none",
        auth: { reachable: false, error: "not configured" },
        content: { ok: false, error: "not configured" },
      });
      continue;
    }
    const auth = await probeAuth(prov, key);
    // Skip content probe if auth failed — saves a wasted completion call
    // on a bad key.
    const content =
      auth.reachable && (auth.status ?? 500) < 300
        ? await probeContent(prov, key)
        : { ok: false, error: auth.status ? `auth failed (HTTP ${auth.status})` : "unreachable" };
    out.push({
      id: prov.id,
      name: prov.name,
      configured: true,
      keySource: source,
      auth,
      content,
    });
  }
  return out;
}

/** Format probe results as a plain-text report for the CLI. */
export function renderProbeReport(results: ProviderProbeResult[]): string {
  const C = {
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    red: "\x1b[31m",
    dim: "\x1b[2m",
    bold: "\x1b[1m",
    reset: "\x1b[0m",
  };

  const lines: string[] = [];
  lines.push(`  ${C.bold}Cloud Provider Probe${C.reset}`);
  lines.push("  " + "─".repeat(60));
  for (const r of results) {
    if (!r.configured) {
      lines.push(`  ${C.dim}○${C.reset} ${r.name.padEnd(16)} ${C.dim}not configured${C.reset}`);
      continue;
    }
    // Auth status
    let authIcon: string, authText: string;
    if (!r.auth.reachable) {
      authIcon = `${C.red}✗${C.reset}`;
      authText = `${C.red}unreachable${C.reset}${r.auth.error ? ` ${C.dim}(${r.auth.error})${C.reset}` : ""}`;
    } else if ((r.auth.status ?? 500) >= 300) {
      authIcon = `${C.red}✗${C.reset}`;
      authText = `${C.red}auth failed HTTP ${r.auth.status}${C.reset}`;
    } else {
      authIcon = `${C.green}✓${C.reset}`;
      authText = `${C.green}auth ok${C.reset} ${C.dim}(${r.auth.latencyMs}ms, key from ${r.keySource})${C.reset}`;
    }
    lines.push(`  ${authIcon} ${r.name.padEnd(16)} ${authText}`);

    // Content status
    if (r.content.ok) {
      const preview = r.content.preview?.replace(/\s+/g, " ").slice(0, 40) ?? "";
      lines.push(
        `    ${C.green}↳${C.reset} ${C.dim}content probe: ${r.content.chars} chars in ${r.content.latencyMs}ms — "${preview}"${C.reset}`,
      );
    } else if (r.auth.reachable && (r.auth.status ?? 500) < 300) {
      // Auth worked but content failed — this is the "empty response" class
      lines.push(
        `    ${C.yellow}↳${C.reset} ${C.yellow}content probe FAILED${C.reset} ${C.dim}(${r.content.error ?? "unknown"})${C.reset}`,
      );
      lines.push(
        `      ${C.dim}→ this provider is the likely source of "empty response" in sessions.${C.reset}`,
      );
    }
  }
  return lines.join("\n");
}
