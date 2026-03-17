// KCode - Multi-Model Router
// Routes requests to the best model based on message content and task type.
// Supports mid-session model switching for vision, code, and chat tasks.

import { listModels } from "./models";
import { log } from "./logger";

// ─── Task Types ─────────────────────────────────────────────────

export type TaskType = "code" | "vision" | "chat" | "general";

// Image file extensions (mirrors IMAGE_EXTENSIONS from tools/read.ts)
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp"];

// Patterns that indicate image content in message history
const IMAGE_INDICATORS = [
  "data:image/",           // base64 data URIs
  "[Image:",               // Read tool image output header
  "[image/png output]",    // notebook image output
  "[image/jpeg output]",   // notebook image output
];

// Patterns that indicate code-heavy tasks
const CODE_INDICATORS = [
  /\b(refactor|debug|fix bug|implement|write code|create function|unit test|test for)\b/i,
  /\b(compile|build|deploy|migration|schema|endpoint|API)\b/i,
  /```[a-z]+\n/,  // code blocks with language
];

// ─── Detection ──────────────────────────────────────────────────

/**
 * Check whether a string contains signs of image content.
 */
function detectImageContent(text: string): boolean {
  for (const indicator of IMAGE_INDICATORS) {
    if (text.includes(indicator)) return true;
  }

  for (const ext of IMAGE_EXTENSIONS) {
    if (text.includes(ext)) {
      const idx = text.indexOf(ext);
      if (idx > 0 && text[idx - 1] !== " " && text[idx - 1] !== "\n") {
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
 * Classify the task type from a user message.
 */
export function classifyTask(userMessage: string): TaskType {
  if (detectImageContent(userMessage)) return "vision";
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
export async function routeToModel(
  defaultModel: string,
  userMessage: string,
  hasImageContent?: boolean,
): Promise<string> {
  const taskType = hasImageContent ? "vision" : classifyTask(userMessage);

  if (taskType === "general" || taskType === "code") {
    // For code and general tasks, use the default model (typically the most capable)
    return defaultModel;
  }

  const models = await listModels();

  if (taskType === "vision") {
    // Look for a model with "vision" or "ocr" capability
    const visionModel = models.find(
      (m) => m.capabilities?.includes("vision") || m.capabilities?.includes("ocr"),
    );

    if (!visionModel) {
      log.debug("router", "Image content detected but no vision/ocr model registered, using default");
      return defaultModel;
    }

    log.info("router", `Routing to ${visionModel.name} (image content detected)`);
    return visionModel.name;
  }

  return defaultModel;
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
    // All models are general-purpose
    capabilities.general.push(m.name);
  }

  return capabilities;
}
