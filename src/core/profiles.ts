// KCode - Execution Profiles
// Predefined "modes of work" combining multiple settings into a single intention.
// Profiles are sugar — they set existing config fields, not new mechanisms.

import type { KCodeConfig, PermissionMode } from "./types";

// ─── Types ──────────────────────────────────────────────────────

export interface ExecutionProfile {
  name: string;
  description: string;
  icon: string;
  settings: {
    permissionMode: string;       // ask, auto, plan, deny, acceptEdits
    effortLevel: string;          // low, medium, high, max
    thinking: boolean;
    maxTokens?: number;
    compactThreshold?: number;
    allowedTools?: string[];      // if set, only these tools
    disallowedTools?: string[];   // if set, block these tools
    systemPromptAppend?: string;  // extra instructions for this profile
  };
}

// ─── Built-in Profiles ──────────────────────────────────────────

const BUILTIN_PROFILES: ExecutionProfile[] = [
  {
    name: "safe",
    description: "Read-only analysis mode — no file modifications",
    icon: "\u{1F6E1}",
    settings: {
      permissionMode: "ask",
      effortLevel: "medium",
      thinking: false,
      disallowedTools: ["Write", "Edit", "MultiEdit", "Bash", "GrepReplace", "Rename"],
      systemPromptAppend: "You are in SAFE mode. Do NOT modify any files. Only read, analyze, and explain. Always show diffs before suggesting changes.",
    },
  },
  {
    name: "fast",
    description: "Quick responses with minimal friction",
    icon: "\u26A1",
    settings: {
      permissionMode: "acceptEdits",
      effortLevel: "low",
      thinking: false,
      maxTokens: 4096,
      systemPromptAppend: "Be extremely concise. Skip explanations unless asked. Prioritize speed.",
    },
  },
  {
    name: "review",
    description: "Deep code review — find bugs, security issues, and quality problems",
    icon: "\u{1F50D}",
    settings: {
      permissionMode: "ask",
      effortLevel: "high",
      thinking: true,
      disallowedTools: ["Write", "Edit", "MultiEdit", "Bash"],
      systemPromptAppend: "You are in REVIEW mode. Focus on finding bugs, regressions, security issues, missing tests, and code quality problems. Do not make changes — only analyze and report. Classify issues by severity.",
    },
  },
  {
    name: "implement",
    description: "Full autonomy to read, edit, write, and run tests",
    icon: "\u{1F528}",
    settings: {
      permissionMode: "auto",
      effortLevel: "high",
      thinking: true,
      systemPromptAppend: "You are in IMPLEMENT mode. You have full autonomy to read, edit, write, and run tests. After making changes, always verify by running relevant tests. Track your progress.",
    },
  },
  {
    name: "ops",
    description: "Diagnostics, logs, processes, and deployment tasks",
    icon: "\u{1F527}",
    settings: {
      permissionMode: "ask",
      effortLevel: "medium",
      thinking: false,
      allowedTools: ["Read", "Bash", "Glob", "Grep", "LS"],
      systemPromptAppend: "You are in OPS mode. Focus on diagnostics, logs, processes, ports, deployment, and environment. Prefer reading and running commands over editing files.",
    },
  },
];

// ─── Public API ─────────────────────────────────────────────────

/**
 * Get a profile by name (case-insensitive).
 */
export function getProfile(name: string): ExecutionProfile | undefined {
  return BUILTIN_PROFILES.find((p) => p.name.toLowerCase() === name.toLowerCase());
}

/**
 * List all available profiles.
 */
export function listProfiles(): ExecutionProfile[] {
  return [...BUILTIN_PROFILES];
}

/**
 * Apply a profile's settings to an existing config (mutates config in place).
 * CLI flags applied after this call will override profile settings.
 */
export function applyProfile(config: KCodeConfig, profile: ExecutionProfile): void {
  const s = profile.settings;

  config.permissionMode = s.permissionMode as PermissionMode;
  config.effortLevel = s.effortLevel as KCodeConfig["effortLevel"];
  config.thinking = s.thinking;

  if (s.maxTokens !== undefined) {
    config.maxTokens = s.maxTokens;
  }
  if (s.compactThreshold !== undefined) {
    config.compactThreshold = s.compactThreshold;
  }
  if (s.allowedTools !== undefined) {
    config.allowedTools = [...s.allowedTools];
  }
  if (s.disallowedTools !== undefined) {
    config.disallowedTools = [...s.disallowedTools];
  }
  if (s.systemPromptAppend !== undefined) {
    // Append to any existing systemPromptAppend rather than replacing it
    config.systemPromptAppend = config.systemPromptAppend
      ? config.systemPromptAppend + "\n\n" + s.systemPromptAppend
      : s.systemPromptAppend;
  }

  // Track the active profile name on the config
  config.activeProfile = profile.name;
}

/**
 * Detect which built-in profile matches the current config, if any.
 * Returns the profile name or null if no exact match.
 */
export function getCurrentProfileName(config: KCodeConfig): string | null {
  // Fast path: if we explicitly tracked the profile
  if (config.activeProfile) {
    return config.activeProfile;
  }

  // Heuristic match: check if config matches a profile's key settings
  for (const profile of BUILTIN_PROFILES) {
    const s = profile.settings;
    if (config.permissionMode !== s.permissionMode) continue;
    if ((config.effortLevel ?? "medium") !== s.effortLevel) continue;
    if ((config.thinking ?? false) !== s.thinking) continue;

    // Check tool restrictions match
    if (s.allowedTools) {
      if (!config.allowedTools || !arraysEqual(config.allowedTools, s.allowedTools)) continue;
    } else if (config.allowedTools) {
      continue;
    }
    if (s.disallowedTools) {
      if (!config.disallowedTools || !arraysEqual(config.disallowedTools, s.disallowedTools)) continue;
    } else if (config.disallowedTools) {
      continue;
    }

    return profile.name;
  }

  return null;
}

// ─── Helpers ────────────────────────────────────────────────────

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sorted1 = [...a].sort();
  const sorted2 = [...b].sort();
  return sorted1.every((v, i) => v === sorted2[i]);
}
