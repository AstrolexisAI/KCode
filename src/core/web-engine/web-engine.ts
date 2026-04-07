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

// Import all templates statically — no dynamic require that breaks in bundled builds
import { tradingDashboardComponents } from "./templates/trading-dashboard";
import { analyticsDashboardComponents } from "./templates/analytics-dashboard";
import { adminPanelComponents } from "./templates/admin-panel";
import { ecommerceComponents } from "./templates/ecommerce";
import { socialFeedComponents } from "./templates/social-feed";
import { crmComponents } from "./templates/crm";
import { projectManagementComponents } from "./templates/project-management";
import { chatAppComponents } from "./templates/chat-app";
import { educationLmsComponents } from "./templates/education-lms";
import { iotMonitoringComponents } from "./templates/iot-monitoring";

const SPECIALIZED_TEMPLATES: Partial<Record<SiteType, () => FileTemplate[]>> = {
  "trading-dashboard": tradingDashboardComponents,
  "analytics": analyticsDashboardComponents,
  "admin-panel": adminPanelComponents,
  "ecommerce": ecommerceComponents,
  "social-feed": socialFeedComponents,
  "crm": crmComponents,
  "project-mgmt": projectManagementComponents,
  "chat": chatAppComponents,
  "education": educationLmsComponents,
  "iot": iotMonitoringComponents,
};

function getSpecializedTemplate(siteType: SiteType): FileTemplate[] | null {
  const fn = SPECIALIZED_TEMPLATES[siteType];
  return fn ? fn() : null;
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

  // Step 3: Clean previous project if exists, then write files
  const projectPath = join(cwd, intent.name);

  // Remove old src/ to avoid stale files from different template types
  const srcPath = join(projectPath, "src");
  try { const { rmSync } = require("fs"); rmSync(srcPath, { recursive: true, force: true }); } catch {}

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
