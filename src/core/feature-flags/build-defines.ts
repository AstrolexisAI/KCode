// Build Defines — Feature profile definitions for Bun.build --define.
//
// Usage in build.ts:
//   import { getDefinesForProfile } from './src/core/feature-flags/build-defines';
//   Bun.build({ define: getDefinesForProfile(process.env.KCODE_BUILD_PROFILE) });

import type { BuildProfile, FeatureName } from "./types";

type DefineMap = Record<string, string>;

const featureProfiles: Record<BuildProfile, Record<FeatureName, boolean>> = {
  full: {
    voice: true,
    bridge: true,
    enterprise: true,
    telemetry: true,
    lsp: true,
    swarm: true,
    browser: true,
    mesh: true,
    distillation: true,
    collab: true,
    rag: true,
  },
  free: {
    voice: false,
    bridge: true,
    enterprise: false,
    telemetry: true,
    lsp: true,
    swarm: false,
    browser: false,
    mesh: false,
    distillation: false,
    collab: false,
    rag: true,
  },
  minimal: {
    voice: false,
    bridge: false,
    enterprise: false,
    telemetry: false,
    lsp: false,
    swarm: false,
    browser: false,
    mesh: false,
    distillation: false,
    collab: false,
    rag: false,
  },
};

/** Convert feature name to the global __FEATURE_*__ constant name */
function toDefineKey(name: FeatureName): string {
  return `__FEATURE_${name.toUpperCase()}__`;
}

/** Get Bun.build --define map for a build profile */
export function getDefinesForProfile(profile?: string): DefineMap {
  const p = (profile ?? "full") as BuildProfile;
  const features = featureProfiles[p] ?? featureProfiles.full;

  const defines: DefineMap = {};
  for (const [name, enabled] of Object.entries(features)) {
    defines[toDefineKey(name as FeatureName)] = String(enabled);
  }
  return defines;
}

/** List available profiles */
export function getAvailableProfiles(): BuildProfile[] {
  return Object.keys(featureProfiles) as BuildProfile[];
}

/** Get feature set for a specific profile */
export function getProfileFeatures(profile: BuildProfile): Record<FeatureName, boolean> {
  return { ...featureProfiles[profile] };
}

/** Describe what a profile includes/excludes (for CLI help) */
export function describeProfile(profile: BuildProfile): string {
  const features = featureProfiles[profile];
  const enabled = Object.entries(features)
    .filter(([, v]) => v)
    .map(([k]) => k);
  const disabled = Object.entries(features)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  return [
    `Profile: ${profile}`,
    `  Enabled:  ${enabled.join(", ") || "none"}`,
    `  Disabled: ${disabled.join(", ") || "none"}`,
  ].join("\n");
}
