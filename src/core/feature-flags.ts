// Feature Flags System
// Two types: build-time (DCE via Bun's define) and runtime (settings/env overrides)
//
// Build-time: src/core/feature-flags/flags.ts (10 flags, 3 profiles)
// Runtime: this file (5 flags, env/settings overrides)

// ─── Build-time Feature Flags ───────────────────────────────────
// Re-export the enhanced build-time flags from feature-flags/
export { Features, activeFeatures, inactiveFeatures, ALL_FEATURE_NAMES } from "./feature-flags/flags";
export { isFeatureEnabled as isBuildFeatureEnabled } from "./feature-flags/flags";
export { getDefinesForProfile, getAvailableProfiles, getProfileFeatures, describeProfile } from "./feature-flags/build-defines";
export type { FeatureName, BuildProfile } from "./feature-flags/types";

// ─── Runtime Feature Flags ──────────────────────────────────────

export interface RuntimeFeatureFlags {
  enableAutoRoute: boolean;
  enableDistillation: boolean;
  enableWorldModel: boolean;
  enableCodebaseIndex: boolean;
  enableExperimentalTools: boolean;
}

const DEFAULTS: RuntimeFeatureFlags = {
  enableAutoRoute: true,
  enableDistillation: true,
  enableWorldModel: true,
  enableCodebaseIndex: true,
  enableExperimentalTools: true,
};

/** Convert a camelCase flag name to the KCODE_FF_ env var name.
 *  e.g. "enableAutoRoute" → "KCODE_FF_ENABLE_AUTO_ROUTE" */
function toEnvVarName(key: string): string {
  // Insert underscore before uppercase letters, then uppercase everything
  const snake = key.replace(/([A-Z])/g, "_$1").toUpperCase();
  return `KCODE_FF_${snake}`;
}

let _cachedFlags: RuntimeFeatureFlags | null = null;

/** Load runtime feature flags. Priority: env vars > settings.json > defaults */
export function loadRuntimeFlags(settingsFlags?: Partial<RuntimeFeatureFlags>): RuntimeFeatureFlags {
  const flags = { ...DEFAULTS };

  // Layer 2: settings.json overrides
  if (settingsFlags) {
    for (const key of Object.keys(flags) as (keyof RuntimeFeatureFlags)[]) {
      if (key in settingsFlags && typeof settingsFlags[key] === "boolean") {
        flags[key] = settingsFlags[key] as boolean;
      }
    }
  }

  // Layer 3: env var overrides (KCODE_FF_*)
  for (const key of Object.keys(flags) as (keyof RuntimeFeatureFlags)[]) {
    const envName = toEnvVarName(key);
    const envVal = process.env[envName];
    if (envVal !== undefined) {
      flags[key] = envVal === "true" || envVal === "1";
    }
  }

  _cachedFlags = flags;
  return flags;
}

/** Get the current runtime feature flags (loads with defaults if not yet initialized) */
export function getFeatureFlags(): RuntimeFeatureFlags {
  if (!_cachedFlags) {
    return loadRuntimeFlags();
  }
  return _cachedFlags;
}

/** Check if a specific runtime feature flag is enabled */
export function isFeatureEnabled(name: keyof RuntimeFeatureFlags): boolean {
  return getFeatureFlags()[name];
}

/** Reset cached flags (for testing) */
export function _resetFlagsCache(): void {
  _cachedFlags = null;
}
