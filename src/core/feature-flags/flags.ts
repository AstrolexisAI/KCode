// Feature Flags — Build-time dead code elimination via Bun --define.
//
// In production builds, Bun replaces __FEATURE_*__ constants with true/false
// and tree-shakes dead branches. In development, all features are active.
//
// Usage:
//   import { Features } from './feature-flags/flags';
//   if (Features.swarm) {
//     const { startSwarm } = await import('./swarm');
//     await startSwarm(config);
//   }
//   // If __FEATURE_SWARM__ is false, Bun removes the entire block from bundle.

import type { FeatureName } from "./types";

// Declared as global constants (injected by build.ts via --define)
declare const __FEATURE_VOICE__: boolean;
declare const __FEATURE_BRIDGE__: boolean;
declare const __FEATURE_ENTERPRISE__: boolean;
declare const __FEATURE_TELEMETRY__: boolean;
declare const __FEATURE_LSP__: boolean;
declare const __FEATURE_SWARM__: boolean;
declare const __FEATURE_BROWSER__: boolean;
declare const __FEATURE_MESH__: boolean;
declare const __FEATURE_DISTILLATION__: boolean;
declare const __FEATURE_COLLAB__: boolean;
declare const __FEATURE_RAG__: boolean;

/** Safe evaluation — defaults to true in development (no --define) */
function featureEnabled(flag: boolean | undefined): boolean {
  return flag ?? true;
}

function safeCheck(globalName: string): boolean | undefined {
  try {
    // In built mode, Bun replaces these with literal true/false.
    // In dev mode, the global doesn't exist → undefined → defaults to true.
    return (globalThis as Record<string, unknown>)[globalName] as
      | boolean
      | undefined;
  } catch {
    return undefined;
  }
}

export const Features: Readonly<Record<FeatureName, boolean>> = {
  voice: featureEnabled(
    typeof __FEATURE_VOICE__ !== "undefined"
      ? __FEATURE_VOICE__
      : safeCheck("__FEATURE_VOICE__"),
  ),
  bridge: featureEnabled(
    typeof __FEATURE_BRIDGE__ !== "undefined"
      ? __FEATURE_BRIDGE__
      : safeCheck("__FEATURE_BRIDGE__"),
  ),
  enterprise: featureEnabled(
    typeof __FEATURE_ENTERPRISE__ !== "undefined"
      ? __FEATURE_ENTERPRISE__
      : safeCheck("__FEATURE_ENTERPRISE__"),
  ),
  telemetry: featureEnabled(
    typeof __FEATURE_TELEMETRY__ !== "undefined"
      ? __FEATURE_TELEMETRY__
      : safeCheck("__FEATURE_TELEMETRY__"),
  ),
  lsp: featureEnabled(
    typeof __FEATURE_LSP__ !== "undefined"
      ? __FEATURE_LSP__
      : safeCheck("__FEATURE_LSP__"),
  ),
  swarm: featureEnabled(
    typeof __FEATURE_SWARM__ !== "undefined"
      ? __FEATURE_SWARM__
      : safeCheck("__FEATURE_SWARM__"),
  ),
  browser: featureEnabled(
    typeof __FEATURE_BROWSER__ !== "undefined"
      ? __FEATURE_BROWSER__
      : safeCheck("__FEATURE_BROWSER__"),
  ),
  mesh: featureEnabled(
    typeof __FEATURE_MESH__ !== "undefined"
      ? __FEATURE_MESH__
      : safeCheck("__FEATURE_MESH__"),
  ),
  distillation: featureEnabled(
    typeof __FEATURE_DISTILLATION__ !== "undefined"
      ? __FEATURE_DISTILLATION__
      : safeCheck("__FEATURE_DISTILLATION__"),
  ),
  collab: featureEnabled(
    typeof __FEATURE_COLLAB__ !== "undefined"
      ? __FEATURE_COLLAB__
      : safeCheck("__FEATURE_COLLAB__"),
  ),
  rag: featureEnabled(
    typeof __FEATURE_RAG__ !== "undefined"
      ? __FEATURE_RAG__
      : safeCheck("__FEATURE_RAG__"),
  ),
};

/** List active features (for /doctor and debug) */
export function activeFeatures(): FeatureName[] {
  return (Object.entries(Features) as [FeatureName, boolean][])
    .filter(([, v]) => v)
    .map(([k]) => k);
}

/** List inactive features */
export function inactiveFeatures(): FeatureName[] {
  return (Object.entries(Features) as [FeatureName, boolean][])
    .filter(([, v]) => !v)
    .map(([k]) => k);
}

/** Check if a specific feature is enabled */
export function isFeatureEnabled(name: FeatureName): boolean {
  return Features[name] ?? false;
}

/** All feature names */
export const ALL_FEATURE_NAMES: FeatureName[] = Object.keys(Features) as FeatureName[];
