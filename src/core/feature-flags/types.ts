// Feature flag type definitions

export interface FeatureDefinition {
  name: string;
  description: string;
  /** Default value when not set via --define */
  defaultEnabled: boolean;
  /** Build profile where this feature is included */
  profiles: BuildProfile[];
}

export type BuildProfile = "full" | "free" | "minimal";

export type FeatureName =
  | "voice"
  | "bridge"
  | "enterprise"
  | "telemetry"
  | "lsp"
  | "swarm"
  | "browser"
  | "mesh"
  | "distillation"
  | "collab"
  | "rag";
