// Feature Flags System
// Two types: build-time (DCE via Bun's define) and runtime (settings/env overrides)

// ─── Build-time Feature Flags ───────────────────────────────────
// These are replaced by Bun's `define` at build time.
// When false, the bundler eliminates dead branches entirely.
// At dev time (bun run src/index.ts), they default to true.

declare const FEATURE_VOICE: boolean;
declare const FEATURE_BRIDGE: boolean;
declare const FEATURE_REMOTE: boolean;
declare const FEATURE_ENTERPRISE: boolean;
declare const FEATURE_TELEMETRY: boolean;
declare const FEATURE_LSP: boolean;
declare const FEATURE_SWARM: boolean;

/** Check if a build-time feature is enabled. Falls back to true in dev mode. */
export function isBuildFeatureEnabled(name: string): boolean {
  try {
    switch (name) {
      case "FEATURE_VOICE": return typeof FEATURE_VOICE !== "undefined" ? FEATURE_VOICE : true;
      case "FEATURE_BRIDGE": return typeof FEATURE_BRIDGE !== "undefined" ? FEATURE_BRIDGE : true;
      case "FEATURE_REMOTE": return typeof FEATURE_REMOTE !== "undefined" ? FEATURE_REMOTE : true;
      case "FEATURE_ENTERPRISE": return typeof FEATURE_ENTERPRISE !== "undefined" ? FEATURE_ENTERPRISE : true;
      case "FEATURE_TELEMETRY": return typeof FEATURE_TELEMETRY !== "undefined" ? FEATURE_TELEMETRY : true;
      case "FEATURE_LSP": return typeof FEATURE_LSP !== "undefined" ? FEATURE_LSP : true;
      case "FEATURE_SWARM": return typeof FEATURE_SWARM !== "undefined" ? FEATURE_SWARM : true;
      default: return true;
    }
  } catch {
    return true; // Dev mode: globals not defined → default to enabled
  }
}

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
