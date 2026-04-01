// KCode - Configuration System
// Settings hierarchy: user > project > local, plus env vars and KCODE.md loading

import { readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { EnsembleStrategy, EnsembleTrigger } from "./ensemble/types";
import { getGitRoot } from "./git";
import { isWorkspaceTrusted } from "./hook-trust";
import { log } from "./logger";
import type { MarketplaceSettings } from "./marketplace/types";
import type { MeshSettings } from "./mesh/types";
import { getDefaultModel, getModelBaseUrl, getModelContextSize } from "./models";
import type { OfflineSettings } from "./offline/types";
import { kcodeHome, kcodePath } from "./paths";
import { isPro } from "./pro";
import type { KCodeConfig, PermissionMode, PermissionRule, PermissionRuleAction } from "./types";

// ─── Types ──────────────────────────────────────────────────────

export type EffortLevel = "low" | "medium" | "high" | "max";

/** Ensemble configuration for multi-model consensus */
export interface EnsembleSettings {
  enabled?: boolean;
  strategy?: EnsembleStrategy;
  models?: string[];
  judgeModel?: string | null;
  maxParallel?: number;
  timeout?: number;
  minResponses?: number;
  triggerOn?: EnsembleTrigger;
}

/** Structured auto-memory configuration (replaces simple boolean toggle) */
export interface AutoMemorySettings {
  enabled?: boolean;
  model?: string | null;
  minConfidence?: number;
  maxPerTurn?: number;
  cooldownTurns?: number;
  excludeTypes?: string[];
}

export interface Settings {
  model?: string;
  maxTokens?: number;
  permissionMode?: PermissionMode;
  autoMemory?: boolean | AutoMemorySettings;
  effortLevel?: EffortLevel;
  apiKey?: string;
  apiBase?: string;
  systemPromptExtra?: string;
  autoRoute?: boolean;
  theme?: string;
  permissionRules?: PermissionRule[];
  fallbackModel?: string;
  tertiaryModel?: string;
  fallbackModels?: string[];
  maxBudgetUsd?: number;
  compactThreshold?: number; // 0.5–0.95, default 0.8 — trigger auto-compact at this % of context window
  telemetry?: boolean; // Opt-in/out for local analytics tracking
  thinking?: boolean; // Enable extended thinking mode (Qwen3 reasoning_content)
  reasoningBudget?: number; // -1 = unlimited, positive = max thinking tokens
  noCache?: boolean; // Disable response cache (always call the model)
  autoUpdate?: boolean; // Enable/disable automatic update checks (default true)
  updateCheckIntervalDays?: number; // Days between update checks (default 7)
  proKey?: string; // KCode Pro license key (kcode_pro_xxxxx)
  marketplace?: MarketplaceSettings; // Plugin marketplace CDN config
  offline?: OfflineSettings; // Offline mode configuration
  ensemble?: EnsembleSettings; // Multi-model ensemble configuration
  mesh?: MeshSettings; // P2P agent mesh configuration
  hardware?: {
    autoOptimize?: boolean; // Enable hardware auto-optimization
    contextWindow?: number; // Override auto-detected context window
    batchSize?: number; // Override auto-detected batch size
    threads?: number; // Override auto-detected thread count
    gpuLayers?: number; // Override auto-detected GPU layer count
  };
  coordinator?: {
    enabled?: boolean;
    maxWorkers?: number;
    defaultWorkerMode?: "simple" | "complex";
    workerTimeoutMs?: number;
    scratchpadEnabled?: boolean;
    preserveScratchpadOnExit?: boolean;
  };
  featureFlags?: {
    enableAutoRoute?: boolean;
    enableDistillation?: boolean;
    enableWorldModel?: boolean;
    enableCodebaseIndex?: boolean;
    enableExperimentalTools?: boolean;
  };
  voice?: {
    enabled: boolean;
    engine: "local" | "cloud" | "auto";
    model: string; // whisper model name (e.g. "base", "small", "medium")
    language: string; // "auto" | "en" | "es" | etc.
    silenceThresholdMs: number; // silence duration before auto-stop (default 2000)
    maxDurationMs: number; // max recording duration (default 30000)
  };
}

// ─── Managed Policy ──────────────────────────────────────────────
// Organization-level policies that cannot be overridden by users or projects.
// Loaded from ~/.kcode/managed-settings.json or /etc/kcode/policy.json.

export interface ManagedPolicy {
  /** Settings that are enforced and cannot be overridden */
  locked?: Partial<Settings>;
  /** Models users are allowed to use (glob patterns). Empty = no restriction. */
  allowedModels?: string[];
  /** Models explicitly blocked */
  blockedModels?: string[];
  /** Tools that are always blocked at the org level (cannot be overridden) */
  disallowedTools?: string[];
  /** Tools that are always allowed (bypass permission prompts) */
  allowedTools?: string[];
  /** Force a specific permission mode (users cannot change it) */
  permissionMode?: PermissionMode;
  /** Permission rules enforced at org level (prepended, highest priority) */
  permissionRules?: PermissionRule[];
  /** Max session budget (cannot be raised by users) */
  maxBudgetUsd?: number;
  /** Disable web access tools (WebFetch, WebSearch) */
  disableWebAccess?: boolean;
  /** Require audit logging */
  auditLog?: boolean;
  /** Organization identifier for audit trail */
  orgId?: string;
}

// ─── Paths ──────────────────────────────────────────────────────

const KCODE_HOME = kcodeHome();
const USER_SETTINGS_PATH = kcodePath("settings.json");
const MANAGED_SETTINGS_PATHS = [
  "/etc/kcode/policy.json", // System-wide admin policy
  kcodePath("managed-settings.json"), // Per-user admin-deployed policy
];

// Cached managed policy with mtime tracking for invalidation
let _managedPolicy: ManagedPolicy | null = null;
let _managedPolicyMtime: number = 0;
let _managedPolicyPath: string = "";

function projectSettingsPath(cwd: string): string {
  return join(cwd, ".kcode", "settings.json");
}

function localSettingsPath(cwd: string): string {
  return join(cwd, ".kcode", "settings.local.json");
}

function rulesDirectory(cwd: string): string {
  return join(cwd, ".kcode", "rules");
}

// ─── File I/O ───────────────────────────────────────────────────

async function readJsonFile(path: string): Promise<Record<string, unknown> | null> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    return await file.json();
  } catch (err) {
    log.debug("config", `Failed to read JSON file ${path}: ${err}`);
    return null;
  }
}

async function readTextFile(path: string): Promise<string | null> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    return await file.text();
  } catch (err) {
    log.debug("config", `Failed to read text file ${path}: ${err}`);
    return null;
  }
}

// ─── Settings Loading ───────────────────────────────────────────

function parseSettings(raw: Record<string, unknown> | null): Settings {
  if (!raw) return {};
  return {
    model: typeof raw.model === "string" ? raw.model : undefined,
    maxTokens: typeof raw.maxTokens === "number" ? raw.maxTokens : undefined,
    permissionMode: isPermissionMode(raw.permissionMode) ? raw.permissionMode : undefined,
    autoMemory:
      typeof raw.autoMemory === "boolean"
        ? raw.autoMemory
        : raw.autoMemory && typeof raw.autoMemory === "object"
          ? (raw.autoMemory as AutoMemorySettings)
          : undefined,
    effortLevel: isEffortLevel(raw.effortLevel) ? raw.effortLevel : undefined,
    apiKey: typeof raw.apiKey === "string" ? raw.apiKey : undefined,
    apiBase: typeof raw.apiBase === "string" ? raw.apiBase : undefined,
    systemPromptExtra:
      typeof raw.systemPromptExtra === "string" ? raw.systemPromptExtra : undefined,
    autoRoute: typeof raw.autoRoute === "boolean" ? raw.autoRoute : undefined,
    theme: typeof raw.theme === "string" ? raw.theme : undefined,
    permissionRules: mergePermissionRules(
      parsePermissionRules(raw.permissionRules),
      parsePermissionsConfig(raw.permissions),
    ),
    fallbackModel: typeof raw.fallbackModel === "string" ? raw.fallbackModel : undefined,
    tertiaryModel: typeof raw.tertiaryModel === "string" ? raw.tertiaryModel : undefined,
    fallbackModels:
      Array.isArray(raw.fallbackModels) &&
      raw.fallbackModels.every((m: unknown) => typeof m === "string")
        ? (raw.fallbackModels as string[])
        : undefined,
    maxBudgetUsd:
      typeof raw.maxBudgetUsd === "number" && raw.maxBudgetUsd > 0 ? raw.maxBudgetUsd : undefined,
    compactThreshold:
      typeof raw.compactThreshold === "number" &&
      raw.compactThreshold >= 0.5 &&
      raw.compactThreshold <= 0.95
        ? raw.compactThreshold
        : undefined,
    telemetry: typeof raw.telemetry === "boolean" ? raw.telemetry : undefined,
    thinking: typeof raw.thinking === "boolean" ? raw.thinking : undefined,
    reasoningBudget: typeof raw.reasoningBudget === "number" ? raw.reasoningBudget : undefined,
    noCache: typeof raw.noCache === "boolean" ? raw.noCache : undefined,
    offline:
      raw.offline && typeof raw.offline === "object" ? (raw.offline as OfflineSettings) : undefined,
    ensemble:
      raw.ensemble && typeof raw.ensemble === "object"
        ? parseEnsembleSettings(raw.ensemble as Record<string, unknown>)
        : undefined,
    hardware:
      raw.hardware && typeof raw.hardware === "object"
        ? parseHardwareSettings(raw.hardware as Record<string, unknown>)
        : undefined,
  };
}

function parseEnsembleSettings(raw: Record<string, unknown>): EnsembleSettings {
  const settings: EnsembleSettings = {};
  if (typeof raw.enabled === "boolean") settings.enabled = raw.enabled;
  if (typeof raw.strategy === "string") settings.strategy = raw.strategy as EnsembleStrategy;
  if (Array.isArray(raw.models))
    settings.models = raw.models.filter((m: unknown) => typeof m === "string") as string[];
  if (typeof raw.judgeModel === "string") settings.judgeModel = raw.judgeModel;
  if (raw.judgeModel === null) settings.judgeModel = null;
  if (typeof raw.maxParallel === "number") settings.maxParallel = raw.maxParallel;
  if (typeof raw.timeout === "number") settings.timeout = raw.timeout;
  if (typeof raw.minResponses === "number") settings.minResponses = raw.minResponses;
  if (typeof raw.triggerOn === "string") settings.triggerOn = raw.triggerOn as EnsembleTrigger;
  return settings;
}

function parseHardwareSettings(raw: Record<string, unknown>): Settings["hardware"] {
  const settings: NonNullable<Settings["hardware"]> = {};
  if (typeof raw.autoOptimize === "boolean") settings.autoOptimize = raw.autoOptimize;
  if (typeof raw.contextWindow === "number" && raw.contextWindow > 0)
    settings.contextWindow = raw.contextWindow;
  if (typeof raw.batchSize === "number" && raw.batchSize > 0) settings.batchSize = raw.batchSize;
  if (typeof raw.threads === "number" && raw.threads > 0) settings.threads = raw.threads;
  if (typeof raw.gpuLayers === "number") settings.gpuLayers = raw.gpuLayers;
  return Object.keys(settings).length > 0 ? settings : undefined;
}

function isPermissionMode(v: unknown): v is PermissionMode {
  return v === "ask" || v === "auto" || v === "plan" || v === "deny" || v === "acceptEdits";
}

function isEffortLevel(v: unknown): v is EffortLevel {
  return v === "low" || v === "medium" || v === "high" || v === "max";
}

function isRuleAction(v: unknown): v is PermissionRuleAction {
  return v === "allow" || v === "deny" || v === "ask";
}

function parsePermissionRules(raw: unknown): PermissionRule[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const rules: PermissionRule[] = [];
  for (const item of raw) {
    if (
      item &&
      typeof item === "object" &&
      typeof item.pattern === "string" &&
      isRuleAction(item.action)
    ) {
      rules.push({ pattern: item.pattern, action: item.action });
    }
  }
  return rules.length > 0 ? rules : undefined;
}

/**
 * Parse the new `permissions` config format:
 * ```json
 * { "permissions": { "allow": ["Read(*)", ...], "deny": ["Bash(rm -rf *)"], "ask": ["Edit(*)"] } }
 * ```
 * Converts to PermissionRule[] with deny rules first (deny takes precedence).
 */
function parsePermissionsConfig(raw: unknown): PermissionRule[] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const config = raw as Record<string, unknown>;
  const rules: PermissionRule[] = [];

  // Deny rules are added first so they take precedence (first match wins)
  if (Array.isArray(config.deny)) {
    for (const pattern of config.deny) {
      if (typeof pattern === "string") {
        rules.push({ pattern, action: "deny" });
      }
    }
  }

  // Ask rules come next
  if (Array.isArray(config.ask)) {
    for (const pattern of config.ask) {
      if (typeof pattern === "string") {
        rules.push({ pattern, action: "ask" });
      }
    }
  }

  // Allow rules last
  if (Array.isArray(config.allow)) {
    for (const pattern of config.allow) {
      if (typeof pattern === "string") {
        rules.push({ pattern, action: "allow" });
      }
    }
  }

  return rules.length > 0 ? rules : undefined;
}

/** Merge two optional rule arrays, filtering out undefined. */
function mergePermissionRules(
  ...sources: (PermissionRule[] | undefined)[]
): PermissionRule[] | undefined {
  const merged: PermissionRule[] = [];
  for (const src of sources) {
    if (src) merged.push(...src);
  }
  return merged.length > 0 ? merged : undefined;
}

function mergeSettings(...layers: Settings[]): Settings {
  const result: Settings = {};
  for (const layer of layers) {
    if (layer.model !== undefined) result.model = layer.model;
    if (layer.maxTokens !== undefined) result.maxTokens = layer.maxTokens;
    if (layer.permissionMode !== undefined) result.permissionMode = layer.permissionMode;
    if (layer.autoMemory !== undefined) result.autoMemory = layer.autoMemory;
    if (layer.effortLevel !== undefined) result.effortLevel = layer.effortLevel;
    if (layer.apiKey !== undefined) result.apiKey = layer.apiKey;
    if (layer.apiBase !== undefined) result.apiBase = layer.apiBase;
    if (layer.systemPromptExtra !== undefined) result.systemPromptExtra = layer.systemPromptExtra;
    if (layer.autoRoute !== undefined) result.autoRoute = layer.autoRoute;
    if (layer.theme !== undefined) result.theme = layer.theme;
    if (layer.fallbackModel !== undefined) result.fallbackModel = layer.fallbackModel;
    if (layer.tertiaryModel !== undefined) result.tertiaryModel = layer.tertiaryModel;
    if (layer.fallbackModels !== undefined) result.fallbackModels = layer.fallbackModels;
    if (layer.maxBudgetUsd !== undefined) result.maxBudgetUsd = layer.maxBudgetUsd;
    if (layer.compactThreshold !== undefined) result.compactThreshold = layer.compactThreshold;
    if (layer.telemetry !== undefined) result.telemetry = layer.telemetry;
    if (layer.thinking !== undefined) result.thinking = layer.thinking;
    if (layer.reasoningBudget !== undefined) result.reasoningBudget = layer.reasoningBudget;
    if (layer.noCache !== undefined) result.noCache = layer.noCache;
    if (layer.offline !== undefined) result.offline = { ...result.offline, ...layer.offline };
    if (layer.ensemble !== undefined) result.ensemble = { ...result.ensemble, ...layer.ensemble };
    if (layer.hardware !== undefined) result.hardware = { ...result.hardware, ...layer.hardware };
    if (layer.permissionRules !== undefined) {
      // Merge rules: later layers append (higher priority evaluated first)
      result.permissionRules = [...(result.permissionRules ?? []), ...layer.permissionRules];
    }
  }
  return result;
}

function envSettings(): Settings {
  const settings: Settings = {};
  if (process.env.KCODE_MODEL) settings.model = process.env.KCODE_MODEL;
  if (process.env.KCODE_API_KEY) settings.apiKey = process.env.KCODE_API_KEY;
  if (process.env.KCODE_API_BASE) settings.apiBase = process.env.KCODE_API_BASE;
  const effortEnv = process.env.KCODE_EFFORT ?? process.env.KCODE_EFFORT_LEVEL;
  if (effortEnv && isEffortLevel(effortEnv)) {
    settings.effortLevel = effortEnv;
  }
  if (process.env.KCODE_MAX_TOKENS) {
    const n = parseInt(process.env.KCODE_MAX_TOKENS, 10);
    if (!isNaN(n)) settings.maxTokens = n;
  }
  if (process.env.KCODE_PERMISSION_MODE && isPermissionMode(process.env.KCODE_PERMISSION_MODE)) {
    settings.permissionMode = process.env.KCODE_PERMISSION_MODE;
  }
  if (process.env.KCODE_THEME) {
    settings.theme = process.env.KCODE_THEME;
  }
  return settings;
}

// ─── Load All Settings ──────────────────────────────────────────

// ─── Managed Policy Loading ────────────────────────────────────

/**
 * Load managed policy from system or user-deployed policy files.
 * /etc/kcode/policy.json takes precedence over ~/.kcode/managed-settings.json.
 */
export async function loadManagedPolicy(): Promise<ManagedPolicy> {
  // Check cache validity via mtime (invalidate if policy file changed)
  if (_managedPolicy && _managedPolicyPath) {
    try {
      const stat = statSync(_managedPolicyPath);
      if (stat.mtimeMs === _managedPolicyMtime) return _managedPolicy;
      // File changed, reload
      _managedPolicy = null;
    } catch (err) {
      // File gone, reload
      log.debug("config", `Managed policy file stat failed: ${err}`);
      _managedPolicy = null;
    }
  }
  if (_managedPolicy) return _managedPolicy;

  for (const path of MANAGED_SETTINGS_PATHS) {
    try {
      const file = Bun.file(path);
      if (!(await file.exists())) continue;
      // Reject symlinks to prevent policy injection
      try {
        const { lstatSync, realpathSync } = await import("node:fs");
        const lstat = lstatSync(path);
        if (lstat.isSymbolicLink()) {
          console.error(`[config] Managed policy ${path} is a symlink, skipping for security`);
          continue;
        }
      } catch (err) {
        log.debug("config", `Failed to check symlink for managed policy ${path}: ${err}`);
      }
      // Size check: reject policy files > 1 MB
      if (file.size > 1024 * 1024) {
        console.error(`[config] Managed policy file ${path} exceeds 1MB limit, skipping`);
        continue;
      }
      const raw = await file.json();
      if (!raw || typeof raw !== "object") continue;

      const policy: ManagedPolicy = {};

      // Parse locked settings
      if (raw.locked && typeof raw.locked === "object") {
        policy.locked = parseSettings(raw.locked as Record<string, unknown>);
      }

      // Parse model restrictions
      if (
        Array.isArray(raw.allowedModels) &&
        raw.allowedModels.every((m: unknown) => typeof m === "string")
      ) {
        policy.allowedModels = raw.allowedModels;
      }
      if (
        Array.isArray(raw.blockedModels) &&
        raw.blockedModels.every((m: unknown) => typeof m === "string")
      ) {
        policy.blockedModels = raw.blockedModels;
      }

      // Parse tool restrictions
      if (
        Array.isArray(raw.disallowedTools) &&
        raw.disallowedTools.every((t: unknown) => typeof t === "string")
      ) {
        policy.disallowedTools = raw.disallowedTools;
      }
      if (
        Array.isArray(raw.allowedTools) &&
        raw.allowedTools.every((t: unknown) => typeof t === "string")
      ) {
        policy.allowedTools = raw.allowedTools;
      }

      // Parse simple fields
      if (isPermissionMode(raw.permissionMode)) policy.permissionMode = raw.permissionMode;
      if (typeof raw.maxBudgetUsd === "number" && raw.maxBudgetUsd > 0)
        policy.maxBudgetUsd = raw.maxBudgetUsd;
      if (typeof raw.disableWebAccess === "boolean") policy.disableWebAccess = raw.disableWebAccess;
      if (typeof raw.auditLog === "boolean") policy.auditLog = raw.auditLog;
      if (typeof raw.orgId === "string") policy.orgId = raw.orgId;

      // Parse org-level permission rules
      const orgRules = parsePermissionRules(raw.permissionRules);
      if (orgRules) policy.permissionRules = orgRules;

      _managedPolicy = policy;
      _managedPolicyPath = path;
      try {
        _managedPolicyMtime = statSync(path).mtimeMs;
      } catch (err) {
        log.debug("config", `Failed to stat managed policy for mtime: ${err}`);
        _managedPolicyMtime = 0;
      }
      console.error(`[config] Loaded managed policy from ${path}`);
      return policy;
    } catch (err) {
      console.error(
        `[config] Warning: failed to parse managed policy ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  _managedPolicy = {};
  return _managedPolicy;
}

/** Check if a model name is allowed by managed policy */
export function isModelAllowedByPolicy(model: string, policy: ManagedPolicy): boolean {
  // Check blocklist first
  if (policy.blockedModels && policy.blockedModels.length > 0) {
    for (const pattern of policy.blockedModels) {
      if (simpleGlob(pattern, model)) return false;
    }
  }
  // Check allowlist
  if (policy.allowedModels && policy.allowedModels.length > 0) {
    for (const pattern of policy.allowedModels) {
      if (simpleGlob(pattern, model)) return true;
    }
    return false; // Not in allowlist
  }
  return true; // No restrictions
}

/** Simple glob matching for model names */
function simpleGlob(pattern: string, value: string): boolean {
  const regex = pattern.replace(/([.+^${}()|[\]\\])/g, "\\$1").replace(/\*/g, ".*");
  return new RegExp(`^${regex}$`, "i").test(value);
}

/**
 * Apply managed policy enforcement to final settings.
 * Locked settings override everything; org restrictions are enforced.
 */
function applyManagedPolicy(settings: Settings, policy: ManagedPolicy): Settings {
  const result = { ...settings };

  // Override locked settings (highest priority, cannot be changed)
  if (policy.locked) {
    for (const [key, value] of Object.entries(policy.locked)) {
      if (value !== undefined) {
        (result as Record<string, unknown>)[key] = value;
      }
    }
  }

  // Force permission mode if policy sets it
  if (policy.permissionMode) {
    result.permissionMode = policy.permissionMode;
  }

  // Enforce max budget (user can only set lower, not higher)
  if (policy.maxBudgetUsd !== undefined) {
    if (!result.maxBudgetUsd || result.maxBudgetUsd > policy.maxBudgetUsd) {
      result.maxBudgetUsd = policy.maxBudgetUsd;
    }
  }

  // Prepend org-level permission rules (highest priority)
  if (policy.permissionRules && policy.permissionRules.length > 0) {
    result.permissionRules = [...policy.permissionRules, ...(result.permissionRules ?? [])];
  }

  // Validate model against policy
  if (result.model && !isModelAllowedByPolicy(result.model, policy)) {
    console.error(
      `[config] Model "${result.model}" is not allowed by managed policy. Reverting to default.`,
    );
    result.model = undefined;
  }

  // Validate fallback models against policy
  if (result.fallbackModel && !isModelAllowedByPolicy(result.fallbackModel, policy)) {
    console.error(
      `[config] Fallback model "${result.fallbackModel}" is not allowed by managed policy. Removing.`,
    );
    result.fallbackModel = undefined;
  }
  if (result.tertiaryModel && !isModelAllowedByPolicy(result.tertiaryModel, policy)) {
    console.error(
      `[config] Tertiary model "${result.tertiaryModel}" is not allowed by managed policy. Removing.`,
    );
    result.tertiaryModel = undefined;
  }
  if (result.fallbackModels) {
    const allowed = result.fallbackModels.filter((m) => isModelAllowedByPolicy(m, policy));
    if (allowed.length < result.fallbackModels.length) {
      const blocked = result.fallbackModels.filter((m) => !isModelAllowedByPolicy(m, policy));
      console.error(`[config] Blocked fallback models removed by policy: ${blocked.join(", ")}`);
    }
    result.fallbackModels = allowed.length > 0 ? allowed : undefined;
  }

  return result;
}

/**
 * Load dedicated permissions file: ~/.kcode/permissions.json or .kcode/permissions.json
 * Format: { "allow": ["Read(*)"], "deny": ["Bash(rm -rf *)"], "ask": ["Edit(*)"] }
 * or: { "rules": [{ "pattern": "Bash(git *)", "action": "allow" }] }
 */
async function loadPermissionsFile(cwd: string, trusted: boolean): Promise<PermissionRule[]> {
  const sources: Array<{ path: string; isProject: boolean }> = [
    { path: join(KCODE_HOME, "permissions.json"), isProject: false },
    { path: join(cwd, ".kcode", "permissions.json"), isProject: true },
  ];
  const rules: PermissionRule[] = [];
  for (const { path, isProject } of sources) {
    // Skip project-level permissions if workspace is not trusted
    if (isProject && !trusted) continue;

    try {
      const file = Bun.file(path);
      if (!(await file.exists())) continue;
      const raw = await file.json();
      if (!raw || typeof raw !== "object") {
        console.error(`[config] Warning: ${path} is not a valid JSON object, skipping`);
        continue;
      }
      // Support { rules: [...] } format
      const fromRules = parsePermissionRules(raw.rules);
      if (fromRules) rules.push(...fromRules);
      // Support { allow: [...], deny: [...], ask: [...] } format
      const fromConfig = parsePermissionsConfig(raw);
      if (fromConfig) rules.push(...fromConfig);
    } catch (err) {
      console.error(
        `[config] Warning: failed to parse ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return rules;
}

export async function loadSettings(cwd: string): Promise<Settings> {
  const trusted = isWorkspaceTrusted(cwd);

  // Gate project-level config behind workspace trust
  const projectSettingsPromise = trusted
    ? readJsonFile(projectSettingsPath(cwd))
    : warnUntrustedProjectConfig(projectSettingsPath(cwd));
  const localSettingsPromise = trusted
    ? readJsonFile(localSettingsPath(cwd))
    : warnUntrustedProjectConfig(localSettingsPath(cwd));

  const [userRaw, projectRaw, localRaw, permissionFileRules, policy] = await Promise.all([
    readJsonFile(USER_SETTINGS_PATH),
    projectSettingsPromise,
    localSettingsPromise,
    loadPermissionsFile(cwd, trusted),
    loadManagedPolicy(),
  ]);

  const user = parseSettings(userRaw);
  const project = parseSettings(projectRaw);
  const local = parseSettings(localRaw);
  const env = envSettings();

  // Precedence: env > local > project > user
  let merged = mergeSettings(user, project, local, env);

  // Merge permission file rules (prepended so they take precedence)
  if (permissionFileRules.length > 0) {
    merged.permissionRules = [...permissionFileRules, ...(merged.permissionRules ?? [])];
  }

  // Apply managed policy enforcement (highest priority, overrides everything)
  merged = applyManagedPolicy(merged, policy);

  return merged;
}

/** Check if an untrusted project config file exists and warn. Returns null (skipped). */
async function warnUntrustedProjectConfig(path: string): Promise<null> {
  try {
    const file = Bun.file(path);
    if (await file.exists()) {
      console.error(
        `[config] Skipping project .kcode/ config — workspace not trusted. Run \`kcode init --trust\` to trust this workspace.`,
      );
    }
  } catch {
    /* ignore */
  }
  return null;
}

// Promise-based write queue for user settings. Bun is single-threaded, so
// chaining onto a shared promise is sufficient to serialise read-modify-write
// cycles and prevent concurrent writes from losing data (M3 race fix).
let _settingsSaveLock: Promise<void> = Promise.resolve();

export function saveUserSettings(settings: Settings): Promise<void> {
  const op = async () => {
    const dir = KCODE_HOME;
    await Bun.write(join(dir, ".gitkeep"), ""); // ensure dir exists
    await Bun.write(USER_SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
    // Restrict permissions — settings may contain API keys and Pro license keys
    try {
      const { chmodSync } = require("node:fs") as typeof import("node:fs");
      chmodSync(USER_SETTINGS_PATH, 0o600);
    } catch (err) {
      log.debug("config", `Failed to chmod user settings: ${err}`);
    }
  };
  _settingsSaveLock = _settingsSaveLock.then(op, op);
  return _settingsSaveLock;
}

/** Load raw user settings JSON (preserves extra fields like provider-specific API keys). */
export async function loadUserSettingsRaw(): Promise<Record<string, unknown>> {
  return (await readJsonFile(USER_SETTINGS_PATH)) ?? {};
}

/** Save raw user settings JSON (merges with existing to prevent data loss). */
export function saveUserSettingsRaw(raw: Record<string, unknown>): Promise<void> {
  const op = async () => {
    const dir = KCODE_HOME;
    await Bun.write(join(dir, ".gitkeep"), ""); // ensure dir exists
    // Merge with existing settings to prevent losing fields (e.g., proKey) due to concurrent writes
    const existing = (await readJsonFile(USER_SETTINGS_PATH)) ?? {};
    const merged = { ...existing, ...raw };
    // Explicitly delete fields set to undefined (allows intentional removal)
    for (const [k, v] of Object.entries(raw)) {
      if (v === undefined) delete merged[k];
    }
    await Bun.write(USER_SETTINGS_PATH, JSON.stringify(merged, null, 2) + "\n");
    try {
      const { chmodSync } = require("node:fs") as typeof import("node:fs");
      chmodSync(USER_SETTINGS_PATH, 0o600);
    } catch (err) {
      log.debug("config", `Failed to chmod raw user settings: ${err}`);
    }
  };
  _settingsSaveLock = _settingsSaveLock.then(op, op);
  return _settingsSaveLock;
}

export async function saveProjectSettings(cwd: string, settings: Settings): Promise<void> {
  const path = projectSettingsPath(cwd);
  const dir = dirname(path);
  await Bun.write(join(dir, ".gitkeep"), ""); // ensure dir exists
  await Bun.write(path, JSON.stringify(settings, null, 2) + "\n");
  try {
    const { chmodSync } = require("node:fs") as typeof import("node:fs");
    chmodSync(path, 0o600);
  } catch (err) {
    log.debug("config", `Failed to chmod project settings: ${err}`);
  }
}

// ─── Build KCodeConfig ──────────────────────────────────────────

export async function buildConfig(cwd: string): Promise<KCodeConfig> {
  const settings = await loadSettings(cwd);
  const policy = await loadManagedPolicy();
  const defaultModel = await getDefaultModel();
  const model = settings.model ?? defaultModel;

  // Respect locked settings: don't let env vars override policy-locked values
  const lockedApiBase = policy.locked?.apiBase;
  const lockedApiKey = policy.locked?.apiKey;
  const apiBase = await getModelBaseUrl(
    model,
    lockedApiBase ?? settings.apiBase ?? process.env.KCODE_API_BASE,
  );
  const contextSize = await getModelContextSize(model);

  const { getContextWindowCap } = await import("./pro.js");
  const cap = await getContextWindowCap();
  // Don't cap context for local models — the cap only applies to cloud API usage
  const isLocalModel =
    apiBase && /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?/i.test(apiBase);
  const effectiveContextSize =
    cap && !isLocalModel ? Math.min(contextSize ?? 32_000, cap) : (contextSize ?? 32_000);

  // Initialize runtime feature flags (settings → env overrides)
  const { loadRuntimeFlags } = await import("./feature-flags.js");
  loadRuntimeFlags(settings.featureFlags);

  return {
    apiKey: lockedApiKey ?? settings.apiKey ?? process.env.ASTROLEXIS_API_KEY,
    anthropicApiKey:
      process.env.ANTHROPIC_API_KEY ??
      ((await loadUserSettingsRaw()).anthropicApiKey as string | undefined),
    apiBase,
    model,
    maxTokens: settings.maxTokens ?? 16384,
    systemPrompt: "", // Built later by SystemPromptBuilder
    workingDirectory: cwd,
    permissionMode: settings.permissionMode ?? "ask",
    contextWindowSize: effectiveContextSize,
    autoRoute: settings.autoRoute ?? true, // enabled by default
    theme: settings.theme,
    permissionRules: settings.permissionRules,
    effortLevel: settings.effortLevel,
    fallbackModel: settings.fallbackModel,
    tertiaryModel: settings.tertiaryModel,
    fallbackModels: settings.fallbackModels,
    maxBudgetUsd: settings.maxBudgetUsd,
    compactThreshold: settings.compactThreshold,
    telemetry: settings.telemetry,
    thinking: settings.thinking,
    reasoningBudget: settings.reasoningBudget,
    noCache: settings.noCache,
    pro: await isPro(),
    // Managed policy fields
    managedDisallowedTools: policy.disallowedTools,
    managedAllowedTools: policy.allowedTools,
    disableWebAccess: policy.disableWebAccess,
    auditLog: policy.auditLog,
    orgId: policy.orgId,
    offline: settings.offline,
  };
}

// ─── KCODE.md Loading ────────────────────────────────────────────

const INSTRUCTION_FILES = ["KCODE.md"];

/**
 * Load instruction files (KCODE.md) from cwd up to git root.
 * Files closer to cwd take precedence (appended later).
 * Returns concatenated content from all found files.
 */
export async function loadInstructionFiles(cwd: string): Promise<string | null> {
  const gitRoot = await getGitRoot(cwd);
  const stopAt = gitRoot ? resolve(gitRoot) : resolve(cwd);

  const parts: string[] = [];
  let current = resolve(cwd);

  // Walk up from cwd to git root (or stay at cwd if no git)
  while (true) {
    for (const filename of INSTRUCTION_FILES) {
      const content = await readTextFile(join(current, filename));
      if (content) {
        parts.push(
          `# ${filename} (${current === resolve(cwd) ? "project root" : current})\n\n${content}`,
        );
      }
    }

    if (current === stopAt || current === dirname(current)) break;
    current = dirname(current);
  }

  return parts.length > 0 ? parts.join("\n\n---\n\n") : null;
}

// ─── Rules Directory Loading ────────────────────────────────────

/**
 * Recursively load all .md files from .kcode/rules/ directory.
 */
export async function loadRules(cwd: string): Promise<string | null> {
  const rulesDir = rulesDirectory(cwd);
  const files = collectMdFiles(rulesDir);

  if (files.length === 0) return null;

  const parts: string[] = [];
  for (const filePath of files.sort()) {
    const content = await readTextFile(filePath);
    if (content) {
      const relativePath = filePath.slice(rulesDir.length + 1);
      parts.push(`## Rule: ${relativePath}\n\n${content}`);
    }
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}

function collectMdFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...collectMdFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(fullPath);
      }
    }
  } catch (err) {
    log.debug("config", `Failed to read rules directory ${dir}: ${err}`);
  }
  return results;
}
