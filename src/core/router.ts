// KCode - Multi-Model Router
// Routes requests to the best model based on message content and task type.
// Supports mid-session model switching for vision, code, and chat tasks.

import { listModels } from "./models";
import { log } from "./logger";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── Task Types ─────────────────────────────────────────────────

export type TaskType = "code" | "vision" | "chat" | "simple" | "reasoning" | "general";

// Image file extensions (mirrors IMAGE_EXTENSIONS from tools/read.ts)
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp"];

// Patterns that indicate image content in message history
const IMAGE_INDICATORS = [
  "data:image/",           // base64 data URIs
  "[Image:",               // Read tool image output header
  "[image/png output]",    // notebook image output
  "[image/jpeg output]",   // notebook image output
];

// Patterns that indicate simple tasks (can use a faster model)
const SIMPLE_TASK_INDICATORS = [
  /^(show|list|find|search|grep|glob|read|cat|ls)\b/i,
  /^(what is|where is|how many)\b/i,
  /^(git status|git log|git diff|git show)\b/i,
];

/**
 * Detect whether the user message is a simple task that can use a faster model.
 */
function detectSimpleTask(text: string): boolean {
  if (text.length > 200) return false; // Long prompts are likely complex
  for (const pattern of SIMPLE_TASK_INDICATORS) {
    if (pattern.test(text.trim())) return true;
  }
  return false;
}

// Patterns that indicate code-heavy tasks
const CODE_INDICATORS = [
  /\b(refactor|debug|fix bug|implement|write code|create function|unit test|test for)\b/i,
  /\b(compile|build|deploy|migration|schema|endpoint|API)\b/i,
  /```[a-z]+\n/,  // code blocks with language
];

// Patterns that indicate deep reasoning tasks
const REASONING_INDICATORS = [
  /\b(analyz|architect|design|plan|compar|trade.?off|pros?\s+(?:and|&)\s+cons?)\b/i,
  /\b(why does|explain why|root cause|investig|diagnos)\b/i,
  /\b(security audit|code review|performance review|audit)\b/i,
];

// ─── Detection ──────────────────────────────────────────────────

/**
 * Check whether a string contains signs of image content.
 */
function detectImageContent(text: string): boolean {
  for (const indicator of IMAGE_INDICATORS) {
    if (text.includes(indicator)) return true;
  }

  // Only detect image extensions in user-facing image references, not inside
  // code, config text, or file listings. Require the extension to be preceded
  // by a typical filename char and followed by a word boundary (whitespace,
  // end-of-string, quote, paren, bracket, comma).
  for (const ext of IMAGE_EXTENSIONS) {
    const re = new RegExp(`\\w${ext.replace(".", "\\.")}(?=[\\s"')\\],;:]|$)`, "i");
    if (re.test(text)) {
      // Extra guard: skip if the match is clearly inside a config line
      // (e.g. "VISION_SUPPORTED_FORMATS=png,jpg,jpeg")
      const match = text.match(re);
      if (match && match.index !== undefined) {
        const lineStart = text.lastIndexOf("\n", match.index) + 1;
        const line = text.slice(lineStart, text.indexOf("\n", match.index + 1));
        if (/^[A-Z_]+=/.test(line.trim()) || /formats?\s*[:=]/i.test(line)) {
          continue; // Skip env/config lines
        }
        return true;
      }
    }
  }

  return false;
}

/**
 * Detect whether the user message is primarily a code task.
 */
function detectCodeTask(text: string): boolean {
  for (const pattern of CODE_INDICATORS) {
    if (pattern instanceof RegExp ? pattern.test(text) : text.includes(pattern)) {
      return true;
    }
  }
  return false;
}

/**
 * Detect whether the user message requires deep reasoning.
 */
function detectReasoningTask(text: string): boolean {
  for (const pattern of REASONING_INDICATORS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

export function classifyTask(userMessage: string): TaskType {
  if (detectImageContent(userMessage)) return "vision";
  if (detectSimpleTask(userMessage)) return "simple";
  if (detectReasoningTask(userMessage)) return "reasoning";
  if (detectCodeTask(userMessage)) return "code";

  // Default to general
  return "general";
}

// ─── Router ─────────────────────────────────────────────────────

/**
 * Route a request to the most appropriate model based on content.
 * Supports multi-model routing within a single session.
 *
 * @param defaultModel - The currently configured model name
 * @param userMessage  - The latest user message text
 * @param hasImageContent - Optional explicit flag for image content
 * @returns The model name to use (may be the default if no routing needed)
 */
// ─── Custom Routing Rules ─────────────────────────────────────

interface RoutingRule {
  /** Regex pattern to match user message */
  pattern: string;
  /** Pre-compiled regex (cached) */
  compiled: RegExp;
  /** Model name to route to */
  model: string;
  /** Optional description for logging */
  description?: string;
}

const MAX_PATTERN_LENGTH = 200;
let customRules: RoutingRule[] | null = null;
let customRulesLoadedAt = 0;
const RULES_TTL_MS = 30_000; // Re-read settings every 30 seconds

function loadRoutingRules(): RoutingRule[] {
  // Re-read if cache is stale (TTL expired)
  if (customRules !== null && Date.now() - customRulesLoadedAt < RULES_TTL_MS) {
    return customRules;
  }
  customRules = [];
  customRulesLoadedAt = Date.now();

  // Load from ~/.kcode/settings.json → routing.rules
  const settingsPath = join(homedir(), ".kcode", "settings.json");
  try {
    if (existsSync(settingsPath)) {
      const data = JSON.parse(readFileSync(settingsPath, "utf-8"));
      if (Array.isArray(data?.routing?.rules)) {
        for (const rule of data.routing.rules) {
          if (rule.pattern && rule.model && typeof rule.pattern === "string" && rule.pattern.length <= MAX_PATTERN_LENGTH) {
            try {
              const compiled = new RegExp(rule.pattern, "i");
              customRules.push({ ...rule, compiled });
            } catch {
              log.warn("router", `Invalid regex in routing rule: "${rule.pattern}"`);
            }
          }
        }
      }
    }
  } catch (e) {
    log.warn("router", `Failed to load routing rules: ${e instanceof Error ? e.message : e}`);
  }

  return customRules;
}

// ─── Router ─────────────────────────────────────────────────

export async function routeToModel(
  defaultModel: string,
  userMessage: string,
  hasImageContent?: boolean,
): Promise<string> {
  // Phase 12: Check custom routing rules first (pre-compiled, cached with TTL)
  const rules = loadRoutingRules();
  for (const rule of rules) {
    if (rule.compiled.test(userMessage)) {
      log.info("router", `Custom rule matched: "${rule.description ?? rule.pattern}" → ${rule.model}`);
      return rule.model;
    }
  }

  const taskType = hasImageContent ? "vision" : classifyTask(userMessage);

  if (taskType === "general") {
    return defaultModel;
  }

  const models = await listModels();

  // Map task type to capability
  const capabilityMap: Record<string, string[]> = {
    simple: ["fast"],
    code: ["code"],
    reasoning: ["reasoning"],
    vision: ["vision", "ocr"],
  };

  const caps = capabilityMap[taskType];
  if (caps) {
    const matched = models.find(m =>
      caps.some(cap => m.capabilities?.includes(cap))
    );
    if (matched && (taskType === "vision" || matched.name !== defaultModel)) {
      log.info("router", `Routing ${taskType} task to ${matched.name}`);
      return matched.name;
    }
    if (taskType === "vision" && !matched) {
      log.debug("router", "Image content detected but no vision model registered");
    }
  }

  return defaultModel;
}

/** Reset cached routing rules (for testing or after config change). */
export function resetRoutingRules(): void {
  customRules = null;
}

/**
 * Get all available models grouped by capability.
 * Useful for showing the user what models are available for what tasks.
 */
export async function getModelCapabilities(): Promise<Record<string, string[]>> {
  const models = await listModels();
  const capabilities: Record<string, string[]> = {
    code: [],
    vision: [],
    chat: [],
    fast: [],
    reasoning: [],
    general: [],
  };

  for (const m of models) {
    const caps = m.capabilities ?? [];
    if (caps.includes("vision") || caps.includes("ocr")) {
      capabilities.vision.push(m.name);
    }
    if (caps.includes("code")) {
      capabilities.code.push(m.name);
    }
    if (caps.includes("chat")) {
      capabilities.chat.push(m.name);
    }
    if (caps.includes("fast")) {
      capabilities.fast.push(m.name);
    }
    if (caps.includes("reasoning")) {
      capabilities.reasoning.push(m.name);
    }
    // All models are general-purpose
    capabilities.general.push(m.name);
  }

  return capabilities;
}
