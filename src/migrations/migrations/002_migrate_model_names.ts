// Migration 002: Migrate legacy model names to current names
// Updates defaultModel, compactionModel, and modelRouter entries in user settings.

import type { Migration } from "../types";

export const MODEL_RENAMES: Record<string, string> = {
  "claude-3-opus": "claude-opus-4",
  "claude-3-sonnet": "claude-sonnet-4",
  "claude-3-haiku": "claude-haiku-4",
  "gpt-4-turbo": "gpt-4o",
};

export const migration: Migration = {
  version: "002",
  name: "migrate_model_names",
  type: "config",
  up: async ({ settings, log }) => {
    const userSettings = settings.getUserSettings();
    let changed = false;

    for (const [oldName, newName] of Object.entries(MODEL_RENAMES)) {
      // Migrate default model
      if (userSettings.defaultModel === oldName) {
        userSettings.defaultModel = newName;
        log.info(`Migrated default model: ${oldName} -> ${newName}`);
        changed = true;
      }
      // Migrate model field (alias)
      if (userSettings.model === oldName) {
        userSettings.model = newName;
        log.info(`Migrated model: ${oldName} -> ${newName}`);
        changed = true;
      }
      // Migrate compaction model
      if (userSettings.compactionModel === oldName) {
        userSettings.compactionModel = newName;
        log.info(`Migrated compaction model: ${oldName} -> ${newName}`);
        changed = true;
      }
      // Migrate models in router
      const router = userSettings.modelRouter as Record<string, unknown> | undefined;
      if (router && typeof router === "object") {
        for (const [task, model] of Object.entries(router)) {
          if (model === oldName) {
            router[task] = newName;
            log.info(`Migrated router model for ${task}: ${oldName} -> ${newName}`);
            changed = true;
          }
        }
      }
    }

    if (changed) {
      settings.setUserSettings(userSettings);
    }
  },
};
