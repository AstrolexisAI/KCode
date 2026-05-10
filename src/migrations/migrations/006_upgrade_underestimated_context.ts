// Migration 006 — Upgrade `contextSize` entries in ~/.kcode/models.json
// that are SMALLER than what the registry now knows.
//
// Why: migration 005 only filled MISSING values. Users registered before
// the registry knew about MLX/GLM-4.7-Flash got contextSize=32768 stored,
// even though the model actually supports 131072. The smaller value
// triggered aggressive auto-compaction, MLX prompt-processing hangs, and
// 5-min timeouts on real analysis prompts (verified 2026-05-09 on Mac).
//
// We only UPGRADE — never shrink — so users with explicit smaller values
// (set on purpose, e.g. for memory pressure) stay intact unless their
// value matches the old conservative default exactly.

import type { Migration } from "../types";

export const migration: Migration = {
  version: "006",
  name: "upgrade_underestimated_context",
  type: "data",
  up: async ({ log }) => {
    const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
    const { kcodePath } = await import("../../core/paths");
    const { guessContextSize } = await import("../../core/model-context-sizes");

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

    const config = raw as { models: Array<Record<string, unknown>> };
    let upgraded = 0;
    const examples: string[] = [];

    for (const entry of config.models) {
      const name = typeof entry.name === "string" ? entry.name : "";
      if (!name) continue;
      const current = typeof entry.contextSize === "number" ? entry.contextSize : 0;
      const known = guessContextSize(name);
      if (!known || known <= current) continue;
      entry.contextSize = known;
      upgraded++;
      if (examples.length < 3) {
        examples.push(`${name}: ${current.toLocaleString()} → ${known.toLocaleString()}`);
      }
    }

    if (upgraded > 0) {
      try {
        writeFileSync(modelsPath, `${JSON.stringify(config, null, 2)}\n`);
        log.info(
          `Upgraded contextSize on ${upgraded} model entr${upgraded === 1 ? "y" : "ies"}` +
            (examples.length > 0 ? ` (e.g. ${examples.join(", ")})` : ""),
        );
      } catch (err) {
        log.warn(`Could not write models.json: ${err}`);
      }
    }
  },
};
