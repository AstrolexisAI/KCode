// KCode - System Prompt Builder
// Constructs the system prompt sent to the LLM, assembled from modular sections

import { loadLearnings } from "../tools/learn";
import { formatPlanForPrompt, loadLatestPlan } from "../tools/plan";
import { formatPinnedForPrompt } from "./context-pin";
import { loadDistilledExamples } from "./distillation";
import { log } from "./logger";
import { getNarrativeManager } from "./narrative";
import { getCurrentStyle, getStyleInstructions } from "./output-styles";
import { getRulesManager } from "./rules";
import {
  buildAutoMemoryInstructions,
  buildCodeGuidelines,
  buildCoordinatorInstructions,
  buildGitInstructions,
  buildIdentity,
  buildMetacognition,
  buildToneAndOutput,
  buildToolInstructions,
} from "./system-prompt-layers";
import {
  buildEnvironment,
  buildSituationalAwareness,
  extractContextKeywords,
  loadAwarenessModules,
  loadExtensibleIdentity,
  loadMemoryInstructions,
  loadProjectInstructions,
} from "./system-prompt-context";
import { type PromptSection, SectionPriority, TokenBudgetManager } from "./token-budget";
import type { KCodeConfig } from "./types";
import { getUserModel } from "./user-model";
import { getWorldModel } from "./world-model";

// ─── System Prompt Builder ──────────────────────────────────────

export class SystemPromptBuilder {
  /**
   * Build the full system prompt from config and environment context.
   * Each section is independently generated and can be toggled.
   */
  /**
   * Build a minimal system prompt for small models (<10B params).
   * ~200 tokens instead of ~8,000. Focuses on core tool usage only.
   */
  static buildLitePrompt(config: KCodeConfig, version?: string): string {
    const cwd = config.workingDirectory;
    return `You are KCode v${version ?? "?"}, a coding assistant by Astrolexis. Working directory: ${cwd}

TOOLS: Use tools directly — never show JSON to the user.
- Read: read files (absolute paths)
- Write: create/edit files (absolute paths)
- Edit: replace text in files
- Bash: run shell commands
- Glob: find files by pattern
- Grep: search file contents

RULES:
- Be concise. Do one task, show result.
- Never rm -rf directories without asking.
- If data is missing, say so — don't invent.
- End every response with a complete sentence.
- After using tools, summarize what you did.`;
  }

  static async build(
    config: KCodeConfig,
    version?: string,
    toolTokenOverhead = 0,
    userMessage?: string,
  ): Promise<string> {
    // If the user overrides the entire system prompt, return it directly
    if (config.systemPromptOverride) {
      return config.systemPromptOverride;
    }

    // Check if model profile requests lite prompt
    try {
      const { getModelProfile } = await import("./model-profile.js");
      const profile = getModelProfile(config.model);
      if (profile.promptMode === "lite") {
        return SystemPromptBuilder.buildLitePrompt(config, version);
      }
    } catch {
      /* module not loaded */
    }

    // Adaptive prompt for local models: use lite prompt for simple/general queries.
    // Local models degrade with large system prompts (curl with 21 tokens works,
    // but 8K+ tokens causes truncated garbage). Full prompt only for code/reasoning.
    // Resolve apiBase from model registry (config.apiBase is often undefined for registry models).
    // Only use registry lookup, not the fallback — unknown models should not be assumed local.
    let apiBase = config.apiBase ?? "";
    if (!apiBase && config.model) {
      try {
        const { loadModelsConfig } = await import("./models.js");
        const modelsConfig = await loadModelsConfig();
        const entry = modelsConfig.models.find((m: { name: string }) => m.name === config.model);
        if (entry?.baseUrl) apiBase = entry.baseUrl;
      } catch {
        /* models module not loaded */
      }
    }
    const isLocal =
      apiBase.includes("localhost") ||
      apiBase.includes("127.0.0.1") ||
      apiBase.startsWith("http://[::1]");
    if (isLocal && userMessage) {
      try {
        const { classifyTask } = await import("./router.js");
        const taskType = classifyTask(userMessage);
        if (taskType !== "code" && taskType !== "reasoning") {
          return SystemPromptBuilder.buildLitePrompt(config, version);
        }
      } catch {
        /* router not loaded */
      }
    }

    // Local models need a hard cap — 2K tokens (~7K chars) leaves room for response.
    // Without this, the full 24K default consumes most of a 32K context window.
    const maxPromptTokens = isLocal ? 2_000 : undefined;
    const budgetManager = new TokenBudgetManager(
      config.contextWindowSize ?? 32_000,
      toolTokenOverhead,
      maxPromptTokens,
    );
    const sections: PromptSection[] = [];

    // ─── Critical sections (never truncated) ───────────────────
    sections.push({
      content: buildIdentity(version ?? "unknown"),
      priority: SectionPriority.CRITICAL,
      label: "identity",
    });
    sections.push({
      content: buildToolInstructions(),
      priority: SectionPriority.CRITICAL,
      label: "tools",
    });

    // ─── High priority ─────────────────────────────────────────
    sections.push({
      content: buildCodeGuidelines(),
      priority: SectionPriority.HIGH,
      label: "code-guidelines",
    });
    sections.push({
      content: buildGitInstructions(),
      priority: SectionPriority.HIGH,
      label: "git",
    });
    sections.push({
      content: buildToneAndOutput(),
      priority: SectionPriority.HIGH,
      label: "tone",
    });
    if (config.thinking) {
      sections.push({
        content: `## Extended Reasoning
IMPORTANT: Before EVERY response, you MUST first write your internal reasoning inside a <reasoning> block.
ALWAYS start your response with <reasoning> immediately — no exceptions, no preamble before it.

Format:
<reasoning>
your step-by-step analysis, planning, and thought process here
</reasoning>

Then write your final answer after the closing tag.
NEVER skip the reasoning block, even for simple questions. The reasoning block is shown separately in the UI and helps you produce better, more thorough answers.`,
        priority: SectionPriority.HIGH,
        label: "thinking",
      });
    }
    sections.push({
      content: buildEnvironment(config),
      priority: SectionPriority.HIGH,
      label: "environment",
    });

    // ─── Medium priority ───────────────────────────────────────
    sections.push({
      content: buildSituationalAwareness(config),
      priority: SectionPriority.MEDIUM,
      label: "situational",
    });
    sections.push({
      content: buildMetacognition(config),
      priority: SectionPriority.MEDIUM,
      label: "metacognition",
    });
    sections.push({
      content: buildAutoMemoryInstructions(),
      priority: SectionPriority.MEDIUM,
      label: "auto-memory",
    });

    // User-defined identity extensions (~/.kcode/identity.md)
    const identityExt = loadExtensibleIdentity();
    if (identityExt) {
      sections.push({
        content: identityExt,
        priority: SectionPriority.MEDIUM,
        label: "ext-identity",
      });
    }

    // User-defined awareness modules (~/.kcode/awareness/*.md)
    // MEDIUM priority — droppable when token budget is tight (e.g., small context windows)
    for (const mod of loadAwarenessModules()) {
      sections.push({ content: mod, priority: SectionPriority.MEDIUM, label: "awareness-global" });
    }

    // Project-level awareness (.kcode/awareness/*.md in project)
    for (const mod of loadAwarenessModules(config.workingDirectory)) {
      sections.push({ content: mod, priority: SectionPriority.MEDIUM, label: "awareness-project" });
    }

    // Project-specific instructions
    const projectInstructions = loadProjectInstructions(
      config.workingDirectory,
    );
    if (projectInstructions) {
      sections.push({
        content: projectInstructions,
        priority: SectionPriority.MEDIUM,
        label: "project-instructions",
      });
    }

    // Memory system
    const memory = loadMemoryInstructions();
    if (memory) {
      sections.push({ content: memory, priority: SectionPriority.MEDIUM, label: "memory" });
    }

    // Coordinator mode instructions
    const coordinatorSection = buildCoordinatorInstructions();
    if (coordinatorSection) {
      sections.push({
        content: coordinatorSection,
        priority: SectionPriority.HIGH,
        label: "coordinator",
      });
    }

    // ─── Active plan (injected if present) ─────────────────────
    loadLatestPlan(); // restore from DB if not already loaded
    const planPrompt = formatPlanForPrompt();
    if (planPrompt) {
      sections.push({ content: planPrompt, priority: SectionPriority.HIGH, label: "active-plan" });
    }

    // ─── Pinned files (user-pinned, always included) ───────────
    const pinnedPrompt = formatPinnedForPrompt(config.workingDirectory);
    if (pinnedPrompt) {
      sections.push({
        content: pinnedPrompt,
        priority: SectionPriority.HIGH,
        label: "pinned-files",
      });
    }

    // ─── Low priority (first to be dropped) ────────────────────
    const keywords = extractContextKeywords(config);
    const learnings = loadLearnings(config.workingDirectory, keywords);
    if (learnings) {
      sections.push({ content: learnings, priority: SectionPriority.LOW, label: "learnings" });
    }

    // Knowledge distillation
    try {
      const distilled = await loadDistilledExamples(undefined, keywords, config.workingDirectory);
      if (distilled) {
        sections.push({ content: distilled, priority: SectionPriority.LOW, label: "distillation" });
      }
    } catch (err) {
      log.debug("distillation", "Failed to load distilled examples: " + err);
    }

    // World Model — recent discrepancies
    try {
      const discrepancies = getWorldModel().loadRecentDiscrepancies(3);
      if (discrepancies.length > 0) {
        const lines = ["# Recent Prediction Errors", "", "Learn from these past mistakes:"];
        for (const d of discrepancies) {
          lines.push(`- **${d.action}**: expected "${d.expected}" but got different result`);
        }
        sections.push({
          content: lines.join("\n"),
          priority: SectionPriority.LOW,
          label: "world-model",
        });
      }
    } catch (err) {
      log.debug("world-model", "Failed to load recent discrepancies: " + err);
    }

    // Inner Narrative — session continuity
    try {
      const narrative = getNarrativeManager().loadNarrative(3);
      if (narrative) {
        sections.push({ content: narrative, priority: SectionPriority.LOW, label: "narrative" });
      }
    } catch (err) {
      log.debug("narrative", "Failed to load session narrative: " + err);
    }

    // ─── Optional (dropped first) ──────────────────────────────
    // User Model — dynamic profiling
    try {
      const userPrompt = getUserModel().formatForPrompt();
      if (userPrompt) {
        sections.push({
          content: userPrompt,
          priority: SectionPriority.OPTIONAL,
          label: "user-model",
        });
      }
    } catch (err) {
      log.debug("user-model", "Failed to load user model for prompt: " + err);
    }

    // Path-specific rules
    try {
      const rulesPrompt = getRulesManager().formatForPrompt();
      if (rulesPrompt) {
        sections.push({ content: rulesPrompt, priority: SectionPriority.OPTIONAL, label: "rules" });
      }
    } catch (err) {
      log.debug("rules", "Failed to load path-specific rules: " + err);
    }

    // ─── Output Style (user-selected formatting override) ──────
    const styleInstructions = getStyleInstructions();
    if (styleInstructions) {
      sections.push({
        content: `# Output Style Override (${getCurrentStyle()})\n\n${styleInstructions}`,
        priority: SectionPriority.HIGH,
        label: "output-style",
      });
    }

    // Effort-level prompt additions
    if (config.effortLevel === "low") {
      sections.push({
        content: "Be brief and concise.",
        priority: SectionPriority.HIGH,
        label: "effort-low",
      });
    } else if (config.effortLevel === "high") {
      sections.push({
        content: "Be thorough and detailed.",
        priority: SectionPriority.HIGH,
        label: "effort-high",
      });
    } else if (config.effortLevel === "max") {
      sections.push({
        content: "Be exhaustive. Consider all edge cases. Take as many steps as needed.",
        priority: SectionPriority.HIGH,
        label: "effort-max",
      });
    }

    // User-appended system prompt text (--append-system-prompt)
    if (config.systemPromptAppend) {
      sections.push({
        content: config.systemPromptAppend,
        priority: SectionPriority.HIGH,
        label: "user-append",
      });
    }

    // Level 1 skill metadata — lightweight listing always in prompt
    try {
      const { SkillManager } = require("./skills.js");
      const sm = new SkillManager(config.workingDirectory);
      const metadata = sm.getLevel1Metadata();
      if (metadata) {
        sections.push({
          content: `## Skills\n${metadata}`,
          priority: SectionPriority.LOW,
          label: "skill-metadata",
        });
      }
    } catch (err) {
      log.debug("skills", "Failed to load skill metadata: " + err);
    }

    // Apply token budget — drops low-priority sections if over limit
    return budgetManager.apply(sections.filter((s) => s.content));
  }

  // ─── Static method delegates (backward compatibility) ──────────
  // These delegate to the extracted module functions so that existing
  // callers using SystemPromptBuilder.buildIdentity() etc. still work.

  static buildIdentity = buildIdentity;
  static buildToolInstructions = buildToolInstructions;
  static buildCodeGuidelines = buildCodeGuidelines;
  static buildGitInstructions = buildGitInstructions;
  static buildToneAndOutput = buildToneAndOutput;
  static buildAutoMemoryInstructions = buildAutoMemoryInstructions;
  static buildMetacognition = buildMetacognition;
  static buildCoordinatorInstructions = buildCoordinatorInstructions;
  static buildEnvironment = buildEnvironment;
  static buildSituationalAwareness = buildSituationalAwareness;
  static loadProjectInstructions = loadProjectInstructions;
  static loadMemoryInstructions = loadMemoryInstructions;
  static loadExtensibleIdentity = loadExtensibleIdentity;
  static loadAwarenessModules = loadAwarenessModules;
  static extractContextKeywords = extractContextKeywords;
}
