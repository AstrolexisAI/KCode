// KCode - Cloud Model Detection for Audit Escalation
//
// Finds models tagged [analysis] or [reasoning] in models.json that
// have a valid API key configured. Returns the list for the user to
// choose from — no hardcoded Anthropic priority.

import { makeAuditLlmCallback } from "./llm-callback";

export interface AuditCloudModel {
  name: string;
  baseUrl: string;
  apiKey: string;
  provider: string;
  tags: string[];
}

export interface CloudFallbackConfig {
  available: boolean;
  models: AuditCloudModel[];
}

const AUDIT_TAGS = new Set(["analysis", "reasoning"]);
const LOCAL_PATTERNS = /localhost|127\.0\.0\.1|0\.0\.0\.0/;

/** Load saved API keys from settings.json (populated by /cloud).
 *
 * v303 bug fix: loadUserSettingsRaw() is async (returns Promise),
 * but this function was calling it without await and casting the
 * Promise as Record. Every key came back undefined → String(undefined
 * ?? "") === "" → every non-anthropic/non-openai model got filtered
 * out of the audit list (xAI/Kimi/Groq/DeepSeek/Together). Anthropic
 * survived via the OAuth fallback path; OpenAI survived if its key
 * was set via env var. Making this async fixes the escalation menu. */
async function loadSavedKeys(): Promise<Record<string, string>> {
  try {
    const { loadUserSettingsRaw } = require("../config.js") as typeof import("../config");
    const s = (await loadUserSettingsRaw()) as Record<string, unknown>;
    return {
      anthropic: String(s.anthropicApiKey ?? ""),
      xai:       String(s.xaiApiKey ?? ""),
      openai:    String(s.apiKey ?? ""),
      kimi:      String(s.kimiApiKey ?? ""),
      groq:      String(s.groqApiKey ?? ""),
      deepseek:  String(s.deepseekApiKey ?? ""),
      together:  String(s.togetherApiKey ?? ""),
    };
  } catch {
    return {};
  }
}

/** Resolve API key: env var takes precedence, then settings.json */
function resolveApiKey(baseUrl: string, modelName: string, saved: Record<string, string>): string {
  const url = baseUrl.toLowerCase();
  if (url.includes("anthropic.com")) {
    return process.env.ANTHROPIC_API_KEY ?? process.env.KCODE_ANTHROPIC_KEY ?? saved.anthropic ?? "";
  }
  if (url.includes("api.x.ai") || modelName.toLowerCase().startsWith("grok")) {
    return process.env.XAI_API_KEY ?? saved.xai ?? "";
  }
  if (url.includes("openai.com")) {
    return process.env.OPENAI_API_KEY ?? saved.openai ?? "";
  }
  if (url.includes("moonshot")) {
    return process.env.MOONSHOT_API_KEY ?? saved.kimi ?? "";
  }
  if (url.includes("groq.com")) {
    return process.env.GROQ_API_KEY ?? saved.groq ?? "";
  }
  if (url.includes("deepseek.com")) {
    return process.env.DEEPSEEK_API_KEY ?? saved.deepseek ?? "";
  }
  if (url.includes("together.xyz")) {
    return process.env.TOGETHER_API_KEY ?? saved.together ?? "";
  }
  return "";
}

/**
 * Find all cloud models tagged [analysis] or [reasoning] that have
 * a valid API key configured. Used to populate the escalation model picker.
 */
export async function detectAuditModels(currentApiBase?: string): Promise<CloudFallbackConfig> {
  // If primary model is already cloud, no escalation needed
  if (currentApiBase && !LOCAL_PATTERNS.test(currentApiBase)) {
    return { available: false, models: [] };
  }

  try {
    const { listModels } = await import("../models.js");
    const all = await listModels();
    const savedKeys = await loadSavedKeys();

    // Also check for Anthropic OAuth token
    let oauthKey = "";
    try {
      const { getClaudeCodeToken } = await import("../auth/claude-code-bridge.js");
      oauthKey = (await getClaudeCodeToken()) ?? "";
    } catch { /* not available */ }

    const auditModels: AuditCloudModel[] = [];
    for (const m of all) {
      if (LOCAL_PATTERNS.test(m.baseUrl)) continue;

      const rawTags: string[] = (m as Record<string, unknown>).tags as string[] ?? m.capabilities ?? [];
      const hasAuditTag = rawTags.some((t) => AUDIT_TAGS.has(t));
      if (!hasAuditTag) continue;

      // Resolve API key: env var > settings.json > OAuth token
      let apiKey = resolveApiKey(m.baseUrl, m.name, savedKeys);
      if (!apiKey && m.baseUrl.includes("anthropic.com") && oauthKey) {
        apiKey = oauthKey;
      }
      if (!apiKey) continue; // no key — skip

      auditModels.push({
        name: m.name,
        baseUrl: m.baseUrl,
        apiKey,
        provider: m.provider ?? "cloud",
        tags: rawTags,
      });
    }

    return { available: auditModels.length > 0, models: auditModels };
  } catch {
    return { available: false, models: [] };
  }
}

/**
 * Build an audit LLM callback for the chosen model. Normalizes the
 * registry baseUrl so OpenAI-compatible providers that need a /v1
 * suffix (xAI, OpenAI, OpenRouter, Mistral, …) get one. The
 * registry stores root URLs like "https://api.x.ai" but the audit
 * verifier hits "/chat/completions" directly — without /v1 the call
 * 404s and every candidate gets bucketed as needs_context with a
 * misleading "verifier couldn't decide" label. v2.10.312 fix.
 *
 * Anthropic endpoints (api.anthropic.com) use /messages directly so
 * the /v1 prefix is added there too — Anthropic's actual URL is
 * "https://api.anthropic.com/v1/messages" and the callback computes
 * `${apiBase}/messages` so apiBase must end in /v1 for that to work.
 */
export async function buildAuditCallbackForModel(
  model: AuditCloudModel,
): Promise<(prompt: string) => Promise<string>> {
  return makeAuditLlmCallback({
    model: model.name,
    apiBase: normalizeAuditApiBase(model.baseUrl),
    apiKey: model.apiKey,
    temperature: 0.05,
  });
}

function normalizeAuditApiBase(raw: string): string {
  const trimmed = raw.replace(/\/$/, "");
  // Already has a /vN suffix → keep as-is.
  if (/\/v\d+$/.test(trimmed)) return trimmed;
  return `${trimmed}/v1`;
}

/** Legacy compat — still used by other callers */
export async function detectCloudFallback(currentApiBase?: string) {
  const result = await detectAuditModels(currentApiBase);
  if (!result.available || result.models.length === 0) {
    return { available: false, model: "", apiBase: "", apiKey: "", provider: "none" as const };
  }
  const first = result.models[0]!;
  return {
    available: true,
    model: first.name,
    apiBase: first.baseUrl,
    apiKey: first.apiKey,
    provider: first.provider as "anthropic" | "openai" | "none",
  };
}

export async function buildCloudFallbackCallback(
  currentApiBase?: string,
): Promise<((prompt: string) => Promise<string>) | null> {
  const config = await detectCloudFallback(currentApiBase);
  if (!config.available) return null;
  return makeAuditLlmCallback({
    model: config.model,
    apiBase: config.apiBase,
    apiKey: config.apiKey,
    temperature: 0.05,
  });
}

