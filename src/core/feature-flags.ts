// Runtime Feature Flags — settings/env overrides for opt-in product behaviors.
//
// CL.5 (v2.10.376) cleanup: this file used to ALSO re-export the build-time
// feature flag system (`Features`, `isFeatureEnabled` from
// ./feature-flags/flags.ts). Nothing in production read those — every
// `Features.X` reference was in docstrings or in the file itself. The
// build-time runtime evaluator was deleted; only the `--define` injection
// at build time (build-defines.ts) remains because build.ts uses it.
//
// What stays is what's actually consumed: runtime flags that gate
// experimental product behaviors based on settings.json + KCODE_FF_*
// env vars. config.ts:906 calls loadRuntimeFlags(); other modules
// call getFeatureFlags() / isFeatureEnabled() to gate features.
//
// The build profile / build-defines re-exports were moved to
// './feature-flags/build-defines' direct imports — only build.ts
// needs them.

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
export function loadRuntimeFlags(
  settingsFlags?: Partial<RuntimeFeatureFlags>,
): RuntimeFeatureFlags {
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
