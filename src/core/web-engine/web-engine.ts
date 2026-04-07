// KCode - Web Engine: Main Orchestrator
//
// Machine generates ALL project files (boilerplate, config, structure).
// LLM ONLY customizes the content-specific files (hero text, features,
// pricing plans, color palette, business logic).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { detectWebIntent, type DetectedIntent } from "./detector";
import { buildProjectTemplate, type FileTemplate, type ProjectTemplate } from "./templates";
import type { SiteType } from "./types";

function getSpecializedTemplate(siteType: SiteType): FileTemplate[] | null {
  const templateMap: Partial<Record<SiteType, () => Promise<FileTemplate[]>>> = {
    "trading-dashboard": async () => (await import("./templates/trading-dashboard.js")).tradingDashboardComponents(),
    "analytics": async () => (await import("./templates/analytics-dashboard.js")).analyticsDashboardComponents(),
    "admin-panel": async () => (await import("./templates/admin-panel.js")).adminPanelComponents(),
    "ecommerce": async () => (await import("./templates/ecommerce.js")).ecommerceComponents(),
    "social-feed": async () => (await import("./templates/social-feed.js")).socialFeedComponents(),
    "crm": async () => (await import("./templates/crm.js")).crmComponents(),
    "project-mgmt": async () => (await import("./templates/project-management.js")).projectManagementComponents(),
    "chat": async () => (await import("./templates/chat-app.js")).chatAppComponents(),
    "education": async () => (await import("./templates/education-lms.js")).educationLmsComponents(),
    "iot": async () => (await import("./templates/iot-monitoring.js")).iotMonitoringComponents(),
  };
  // Synchronous wrapper — templates are sync functions, dynamic import is for lazy loading
  try {
    const loader = templateMap[siteType];
    if (!loader) return null;
    // Use require for sync access (templates are sync)
    const mod = require(`./templates/${siteType === "trading-dashboard" ? "trading-dashboard" : siteType === "admin-panel" ? "admin-panel" : siteType === "social-feed" ? "social-feed" : siteType === "project-mgmt" ? "project-management" : siteType === "analytics" ? "analytics-dashboard" : siteType === "education" ? "education-lms" : siteType === "iot" ? "iot-monitoring" : siteType === "chat" ? "chat-app" : siteType}.ts`);
    const fnName = Object.keys(mod).find(k => typeof mod[k] === "function");
    return fnName ? mod[fnName]() : null;
  } catch { return null; }
}

export interface WebEngineResult {
  intent: DetectedIntent;
  template: ProjectTemplate;
  machineFiles: number;    // files written by machine (0 tokens)
  llmFiles: number;        // files that need LLM customization
  projectPath: string;
  prompt: string;           // focused prompt for LLM to customize
}

/**
 * Run the web engine: detect intent → generate template → write files
 * Returns a focused prompt for the LLM to customize content-specific files.
 */
export function createWebProject(
  userRequest: string,
  cwd: string,
): WebEngineResult {
  // Step 1: Detect intent from natural language
  const intent = detectWebIntent(userRequest);

  // Step 2: Check for specialized template first, fall back to generic
  const specializedFiles = getSpecializedTemplate(intent.siteType);
  const template = specializedFiles ? { files: specializedFiles } : buildProjectTemplate(intent);

  // Step 3: Write all machine-generated files
  const projectPath = join(cwd, intent.name);
  let machineFiles = 0;
  let llmFiles = 0;

  for (const file of template.files) {
    const fullPath = join(projectPath, file.path);
    mkdirSync(dirname(fullPath), { recursive: true });

    if (!file.needsLlm) {
      // Machine writes directly — 0 tokens
      writeFileSync(fullPath, file.content);
      machineFiles++;
    } else {
      // Write the template, LLM will customize
      writeFileSync(fullPath, file.content);
      llmFiles++;
    }
  }

  // Step 4: Build focused LLM prompt (ONLY for content customization)
  const llmFileList = template.files
    .filter(f => f.needsLlm)
    .map(f => f.path);

  const prompt = buildWebPrompt(intent, llmFileList, projectPath);

  return {
    intent,
    template,
    machineFiles,
    llmFiles,
    projectPath,
    prompt,
  };
}

function buildWebPrompt(
  intent: DetectedIntent,
  llmFiles: string[],
  projectPath: string,
): string {
  return `You are customizing a ${intent.siteType} website that was already scaffolded by the machine.

PROJECT: ${intent.name}
TYPE: ${intent.siteType}
STACK: ${intent.stack}
FEATURES: ${intent.features.join(", ")}
PAGES: ${intent.pages.join(", ")}

The machine already created the project structure with all config files,
dependencies, and component templates. You need to CUSTOMIZE these files
with real content:

FILES TO CUSTOMIZE:
${llmFiles.map(f => `- ${f}`).join("\n")}

PROJECT PATH: ${projectPath}

INSTRUCTIONS:
1. Read each file listed above
2. Replace placeholder content with REAL, professional content:
   - Hero: compelling headline + subheadline for a ${intent.siteType}
   - Features: 3-6 real features with icons and descriptions
   - Pricing: realistic pricing tiers (if applicable)
   - Auth: working form with proper validation
   - Dashboard: real metrics layout with proper components
3. Keep the existing Tailwind CSS classes — they're already responsive
4. Use clean, modern design patterns (Apple/Linear/Vercel style)
5. Do NOT change package.json, tsconfig, or config files
6. Do NOT add new dependencies — use what's already in package.json
7. Make it look PRODUCTION-READY, not like a template

After customizing, run: cd ${intent.name} && npm install && npm run dev`;
}

/**
 * Build the prompt for the LLM to customize content files.
 * Used by the classifier/conversation integration.
 */
export function buildWebCreationPrompt(userRequest: string, cwd: string): string {
  const result = createWebProject(userRequest, cwd);
  return result.prompt;
}
