// Migration 005 — Backfill missing `contextSize` on entries in
// ~/.kcode/models.json.
//
// Why: before the setup wizard started calling guessContextSize()
// when registering a cloud model, every cloud entry landed in
// models.json without a contextSize field. Downstream,
// config.ts resolves contextWindowSize via
// `contextSize ?? 32_000`, so Claude Sonnet (200k real window)
// was being clamped to 32k at the KCode layer. That caused
// overly-aggressive auto-compaction and eventually "empty
// response" errors once the internal estimate diverged far
// enough from what the provider was actually seeing.
//
// This runs once per install. Users who had `kcode setup` done
// in a prior version get their existing entries upgraded
// silently on next start. Users with an explicit contextSize
// already set are left alone — we never overwrite a user-set
// value.

import type { Migration } from "../types";

export const migration: Migration = {
  version: "005",
  name: "backfill_context_sizes",
  type: "data",
  up: async ({ log }) => {
    const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
    const { kcodePath } = await import("../../core/paths");
    const { guessContextSize } = await import("../../core/model-context-sizes");

    const modelsPath = kcodePath("models.json");
    if (!existsSync(modelsPath)) {
      log.debug("No models.json to backfill — fresh install");
      return;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(modelsPath, "utf-8"));
    } catch (err) {
      log.warn(`models.json is malformed, leaving it alone: ${err}`);
      return;
    }

    if (!raw || typeof raw !== "object" || !Array.isArray((raw as { models?: unknown }).models)) {
      log.debug("models.json has no models array — nothing to backfill");
      return;
    }

    const config = raw as { models: Array<Record<string, unknown>> };
    let filled = 0;
    let skipped = 0;
    const examples: string[] = [];

    for (const entry of config.models) {
      const name = typeof entry.name === "string" ? entry.name : "";
      if (!name) continue;
      if (typeof entry.contextSize === "number" && entry.contextSize > 0) {
        // Already set — respect the user's / previous-migration's value.
        continue;
      }
      const guessed = guessContextSize(name);
      if (guessed === undefined) {
        skipped++;
        continue;
      }
      entry.contextSize = guessed;
      filled++;
      if (examples.length < 3) {
        examples.push(`${name} → ${guessed.toLocaleString()}`);
      }
    }

    if (filled > 0) {
      try {
        writeFileSync(modelsPath, `${JSON.stringify(config, null, 2)}\n`);
        log.info(
          `Backfilled contextSize on ${filled} model entr${filled === 1 ? "y" : "ies"}` +
            (examples.length > 0 ? ` (e.g. ${examples.join(", ")})` : ""),
        );
      } catch (err) {
        log.warn(`Could not write models.json: ${err}`);
      }
    }
    if (skipped > 0) {
      log.debug(
        `Skipped ${skipped} model(s) — no known context size for their name prefix. They stay at the 32k default; set contextSize manually or re-run kcode setup.`,
      );
    }
  },
};
