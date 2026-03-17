// KCode - Configuration System
// Settings hierarchy: user > project > local, plus env vars and KCODE.md loading

import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { readdirSync, statSync } from "node:fs";
import type { KCodeConfig, PermissionMode, PermissionRule, PermissionRuleAction } from "./types";
import { getGitRoot } from "./git";
import { getModelBaseUrl, getModelContextSize, getDefaultModel } from "./models";

// ─── Types ──────────────────────────────────────────────────────

export type EffortLevel = "low" | "medium" | "high";

export interface Settings {
  model?: string;
  maxTokens?: number;
  permissionMode?: PermissionMode;
  autoMemory?: boolean;
  effortLevel?: EffortLevel;
  apiKey?: string;
  apiBase?: string;
  systemPromptExtra?: string;
  autoRoute?: boolean;
  theme?: string;
  permissionRules?: PermissionRule[];
}

// ─── Paths ──────────────────────────────────────────────────────

const KCODE_HOME = join(homedir(), ".kcode");
const USER_SETTINGS_PATH = join(KCODE_HOME, "settings.json");

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
  } catch {
    return null;
  }
}

async function readTextFile(path: string): Promise<string | null> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    return await file.text();
  } catch {
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
    autoMemory: typeof raw.autoMemory === "boolean" ? raw.autoMemory : undefined,
    effortLevel: isEffortLevel(raw.effortLevel) ? raw.effortLevel : undefined,
    apiKey: typeof raw.apiKey === "string" ? raw.apiKey : undefined,
    apiBase: typeof raw.apiBase === "string" ? raw.apiBase : undefined,
    systemPromptExtra: typeof raw.systemPromptExtra === "string" ? raw.systemPromptExtra : undefined,
    autoRoute: typeof raw.autoRoute === "boolean" ? raw.autoRoute : undefined,
    theme: typeof raw.theme === "string" ? raw.theme : undefined,
    permissionRules: parsePermissionRules(raw.permissionRules),
  };
}

function isPermissionMode(v: unknown): v is PermissionMode {
  return v === "ask" || v === "auto" || v === "plan" || v === "deny";
}

function isEffortLevel(v: unknown): v is EffortLevel {
  return v === "low" || v === "medium" || v === "high";
}

function isRuleAction(v: unknown): v is PermissionRuleAction {
  return v === "allow" || v === "deny" || v === "ask";
}

function parsePermissionRules(raw: unknown): PermissionRule[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const rules: PermissionRule[] = [];
  for (const item of raw) {
    if (
      item && typeof item === "object" &&
      typeof item.pattern === "string" &&
      isRuleAction(item.action)
    ) {
      rules.push({ pattern: item.pattern, action: item.action });
    }
  }
  return rules.length > 0 ? rules : undefined;
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
  if (process.env.KCODE_EFFORT_LEVEL && isEffortLevel(process.env.KCODE_EFFORT_LEVEL)) {
    settings.effortLevel = process.env.KCODE_EFFORT_LEVEL;
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

export async function loadSettings(cwd: string): Promise<Settings> {
  const [userRaw, projectRaw, localRaw] = await Promise.all([
    readJsonFile(USER_SETTINGS_PATH),
    readJsonFile(projectSettingsPath(cwd)),
    readJsonFile(localSettingsPath(cwd)),
  ]);

  const user = parseSettings(userRaw);
  const project = parseSettings(projectRaw);
  const local = parseSettings(localRaw);
  const env = envSettings();

  // Precedence: env > local > project > user
  return mergeSettings(user, project, local, env);
}

export async function saveUserSettings(settings: Settings): Promise<void> {
  const dir = KCODE_HOME;
  await Bun.write(join(dir, ".gitkeep"), ""); // ensure dir exists
  await Bun.write(USER_SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
}

export async function saveProjectSettings(cwd: string, settings: Settings): Promise<void> {
  const path = projectSettingsPath(cwd);
  const dir = dirname(path);
  await Bun.write(join(dir, ".gitkeep"), ""); // ensure dir exists
  await Bun.write(path, JSON.stringify(settings, null, 2) + "\n");
}

// ─── Build KCodeConfig ──────────────────────────────────────────

export async function buildConfig(cwd: string): Promise<KCodeConfig> {
  const settings = await loadSettings(cwd);
  const defaultModel = await getDefaultModel();
  const model = settings.model ?? defaultModel;
  const apiBase = await getModelBaseUrl(model, settings.apiBase ?? process.env.KCODE_API_BASE);
  const contextSize = await getModelContextSize(model);

  return {
    apiKey: settings.apiKey ?? process.env.ASTROLEXIS_API_KEY,
    apiBase,
    model,
    maxTokens: settings.maxTokens ?? 16384,
    systemPrompt: "", // Built later by SystemPromptBuilder
    workingDirectory: cwd,
    permissionMode: settings.permissionMode ?? "ask",
    contextWindowSize: contextSize,
    autoRoute: settings.autoRoute ?? true, // enabled by default
    theme: settings.theme,
    permissionRules: settings.permissionRules,
    effortLevel: settings.effortLevel,
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
        parts.push(`# ${filename} (${current === resolve(cwd) ? "project root" : current})\n\n${content}`);
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
  } catch {
    // Directory doesn't exist or not readable
  }
  return results;
}
