// Migration 003: Add default compaction configuration
// Adds compaction settings to user config if not already present.

import type { Migration } from "../types";

export const migration: Migration = {
  version: "003",
  name: "add_compaction_config",
  type: "config",
  up: async ({ settings }) => {
    const userSettings = settings.getUserSettings();

    // Only add if compaction config does not exist (do not overwrite custom config)
    if (!userSettings.compaction) {
      userSettings.compaction = {
        microCompact: { enabled: true },
        fullCompact: { groupByRounds: true, fileRestoreBudget: 50000 },
        circuitBreaker: { maxFailures: 3 },
        imageStripping: { enabled: true },
      };
      settings.setUserSettings(userSettings);
    }
  },
};
