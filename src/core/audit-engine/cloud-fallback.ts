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

/** Map baseUrl → env var name for API key lookup */
function resolveApiKey(baseUrl: string, modelName: string): string {
  const url = baseUrl.toLowerCase();
  if (url.includes("anthropic.com")) {
    return process.env.ANTHROPIC_API_KEY ?? process.env.KCODE_ANTHROPIC_KEY ?? "";
  }
  if (url.includes("api.x.ai") || modelName.toLowerCase().startsWith("grok")) {
    return process.env.XAI_API_KEY ?? "";
  }
  if (url.includes("openai.com")) {
    return process.env.OPENAI_API_KEY ?? "";
  }
  if (url.includes("moonshot")) {
    return process.env.MOONSHOT_API_KEY ?? "";
  }
  if (url.includes("groq.com")) {
    return process.env.GROQ_API_KEY ?? "";
  }
  if (url.includes("deepseek.com")) {
    return process.env.DEEPSEEK_API_KEY ?? "";
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

      // Resolve API key
      let apiKey = resolveApiKey(m.baseUrl, m.name);
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
 * Build an audit LLM callback for the chosen model.
 */
export async function buildAuditCallbackForModel(
  model: AuditCloudModel,
): Promise<(prompt: string) => Promise<string>> {
  return makeAuditLlmCallback({
    model: model.name,
    apiBase: model.baseUrl,
    apiKey: model.apiKey,
    temperature: 0.05,
  });
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

