// Migration 007 — Backfill `tags` on cloud model entries in
// ~/.kcode/models.json so the multi-model router can match them.
//
// Why: selectBenchmarkModel walks BENCHMARK_TAG_MAP and looks for
// models with ALL required tags ("analysis"+"reasoning", "coding"+
// "fast", etc.). If a registered cloud model has no `tags` field,
// the array.every() check fails and the router treats the model as
// invisible — multimodel routing silently falls back to the default
// local model on EVERY task, defeating the entire purpose of having
// API keys configured.
//
// Verified 2026-05-10 with Curly: 26 cloud models registered (Claude
// 4.x, Grok 4.x, etc.), all with tags=null. multimodel:true was
// effectively a no-op for any task that should have routed to cloud.
//
// This migration assigns sensible default tags to known model
// families, leaving any model with explicitly-set tags untouched.
// Users can override later via models.json.

import type { Migration } from "../types";

interface ModelEntry {
  name: string;
  baseUrl?: string;
  tags?: string[];
  capabilities?: string[];
  [k: string]: unknown;
}

/**
 * Tag assignment by model-name pattern. Order matters — first match
 * wins. Designed so the base TAG_MAP lookups (analysis+reasoning,
 * coding+fast, etc.) all find at least one cloud candidate when
 * the user has Anthropic / xAI / OpenAI / Gemini / DeepSeek keys set.
 */
const TAG_RULES: Array<{ pattern: RegExp; tags: string[] }> = [
  // Claude family
  { pattern: /^claude-opus-/, tags: ["reasoning", "analysis", "coding", "structured"] },
  { pattern: /^claude-sonnet-/, tags: ["coding", "fast", "structured", "analysis"] },
  { pattern: /^claude-haiku-/, tags: ["fast", "cheap", "coding"] },

  // Grok family
  // Image/video models — skip from chat routing, mark vision-only
  { pattern: /^grok-imagine/, tags: ["vision"] },
  // Reasoning variants
  { pattern: /^grok-(?:4-fast-|4-1-fast-)?reasoning/, tags: ["reasoning", "analysis", "coding"] },
  { pattern: /-reasoning$/, tags: ["reasoning", "analysis", "coding"] },
  // Fast variants
  { pattern: /^grok-(?:4-fast|4-1-fast|3-mini|code-fast)/, tags: ["fast", "coding", "cheap"] },
  // Flagship grok-4 / grok-4.3 / grok-4.20-multi-agent etc.
  { pattern: /^grok-4(?:\.|$|-0709|-multi)/, tags: ["reasoning", "analysis", "coding"] },
  { pattern: /^grok-3$/, tags: ["coding", "fast"] },
  { pattern: /^grok-/, tags: ["coding", "fast"] }, // catch-all grok

  // OpenAI
  { pattern: /^o[134]-?mini/, tags: ["fast", "cheap", "reasoning"] },
  { pattern: /^o[134]/, tags: ["reasoning", "analysis"] },
  { pattern: /^gpt-4o-mini/, tags: ["fast", "cheap", "coding"] },
  { pattern: /^gpt-4o/, tags: ["coding", "fast", "vision"] },
  { pattern: /^gpt-5/, tags: ["reasoning", "analysis", "coding"] },
  { pattern: /^gpt-/, tags: ["coding"] },

  // Gemini
  { pattern: /^gemini-2\.5-pro/, tags: ["reasoning", "analysis", "coding", "vision"] },
  { pattern: /^gemini-2\.5-flash/, tags: ["fast", "coding", "cheap"] },
  { pattern: /^gemini-2/, tags: ["fast", "coding"] },
  { pattern: /^gemini-1\.5-pro/, tags: ["reasoning", "analysis", "coding"] },
  { pattern: /^gemini-1\.5-flash/, tags: ["fast", "coding", "cheap"] },
  { pattern: /^gemini-/, tags: ["coding"] },

  // DeepSeek
  { pattern: /^deepseek-r/, tags: ["reasoning", "analysis"] },
  { pattern: /^deepseek-coder/, tags: ["coding"] },
  { pattern: /^deepseek-/, tags: ["coding", "fast"] },

  // Llama (Together / Groq)
  { pattern: /llama-3\.[123]-70b/i, tags: ["coding", "structured"] },
  { pattern: /llama-3\.[123]-8b/i, tags: ["fast", "coding"] },
  { pattern: /llama-/i, tags: ["coding"] },

  // Mixtral / Mistral
  { pattern: /^mixtral-/, tags: ["coding", "fast"] },
  { pattern: /^mistral-/, tags: ["coding"] },

  // Qwen
  { pattern: /qwen-?2\.5-coder/i, tags: ["coding", "fast"] },
  { pattern: /qwen/i, tags: ["coding"] },
];

function tagsForModel(name: string): string[] | null {
  for (const rule of TAG_RULES) {
    if (rule.pattern.test(name)) return [...rule.tags];
  }
  return null;
}

export const migration: Migration = {
  version: "007",
  name: "backfill_model_tags",
  type: "data",
  up: async ({ log }) => {
    const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
    const { kcodePath } = await import("../../core/paths");

    const modelsPath = kcodePath("models.json");
    if (!existsSync(modelsPath)) {
      log.debug("No models.json — fresh install");
      return;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(modelsPath, "utf-8"));
    } catch (err) {
      log.warn(`models.json malformed, skipping: ${err}`);
      return;
    }
    if (!raw || typeof raw !== "object" || !Array.isArray((raw as { models?: unknown }).models)) {
      return;
    }

    const config = raw as { models: ModelEntry[] };
    let backfilled = 0;
    let skipped = 0;
    const examples: string[] = [];

    for (const entry of config.models) {
      // Skip entries that already have tags or capabilities set
      if (
        (Array.isArray(entry.tags) && entry.tags.length > 0) ||
        (Array.isArray(entry.capabilities) && entry.capabilities.length > 0)
      ) {
        continue;
      }
      // Skip local entries — they have their own routing path via the
      // "local" tag check; they don't need cloud-style capability tags.
      if (entry.baseUrl && /localhost|127\.0\.0\.1/.test(entry.baseUrl)) continue;

      const tags = tagsForModel(entry.name);
      if (!tags) {
        skipped++;
        continue;
      }
      entry.tags = tags;
      backfilled++;
      if (examples.length < 4) {
        examples.push(`${entry.name} → [${tags.join(",")}]`);
      }
    }

    if (backfilled > 0) {
      try {
        writeFileSync(modelsPath, `${JSON.stringify(config, null, 2)}\n`);
        log.info(
          `Backfilled tags on ${backfilled} cloud model entr${backfilled === 1 ? "y" : "ies"}` +
            (examples.length > 0 ? ` (e.g. ${examples.join(", ")})` : "") +
            ` — multimodel routing now functional`,
        );
      } catch (err) {
        log.warn(`Could not write models.json: ${err}`);
      }
    }
    if (skipped > 0) {
      log.debug(
        `Skipped ${skipped} cloud model(s) — no tag rule matched. Add tags manually via models.json or a future migration.`,
      );
    }
  },
};
