// KCode - Token Budget Manager
// Hard-caps the system prompt size to prevent context window exhaustion.
// Each section has a priority; low-priority sections are truncated first.

import { log } from "./logger";

// ─── Constants ───────────────────────────────────────────────────

// Hard cap: system prompt must never exceed this fraction of context window
const MAX_SYSTEM_PROMPT_RATIO = 0.30; // 30% of context window
const ABSOLUTE_MAX_TOKENS = 24_000; // Never exceed 24K tokens regardless of context window
const CHARS_PER_TOKEN = 3.5; // Conservative estimate for English text

// Priority levels — higher number = first to be truncated
export enum SectionPriority {
  CRITICAL = 0,    // Identity, tools — never truncated
  HIGH = 1,        // Code guidelines, git, environment
  MEDIUM = 2,      // Project instructions, metacognition, situational awareness
  LOW = 3,         // Learnings, distillation, world model, narrative
  OPTIONAL = 4,    // Extended identity, user model, rules
}

export interface PromptSection {
  content: string;
  priority: SectionPriority;
  label: string;
}

// ─── Token Budget Manager ──────────────────────────────────────

export class TokenBudgetManager {
  private maxTokens: number;

  constructor(contextWindowSize: number) {
    const budgetFromContext = Math.floor(contextWindowSize * MAX_SYSTEM_PROMPT_RATIO);
    this.maxTokens = Math.min(budgetFromContext, ABSOLUTE_MAX_TOKENS);
  }

  /**
   * Estimate token count for a string.
   * Uses character-based heuristic — accurate enough for budget enforcement.
   */
  estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  }

  /**
   * Apply the token budget to a list of sections.
   * Returns the final prompt string, truncating low-priority sections as needed.
   */
  apply(sections: PromptSection[]): string {
    // Sort by priority (CRITICAL first, OPTIONAL last)
    const sorted = [...sections].sort((a, b) => a.priority - b.priority);

    let totalTokens = 0;
    const included: PromptSection[] = [];
    const truncated: string[] = [];

    for (const section of sorted) {
      const sectionTokens = this.estimateTokens(section.content);

      if (totalTokens + sectionTokens <= this.maxTokens) {
        // Fits entirely
        included.push(section);
        totalTokens += sectionTokens;
      } else if (section.priority <= SectionPriority.HIGH) {
        // Critical/High sections: truncate content to fit remaining budget
        const remainingTokens = this.maxTokens - totalTokens;
        if (remainingTokens > 100) {
          const maxChars = Math.floor(remainingTokens * CHARS_PER_TOKEN);
          const truncatedContent = section.content.slice(0, maxChars) + "\n\n[... truncated to fit token budget ...]";
          included.push({ ...section, content: truncatedContent });
          totalTokens += remainingTokens;
          truncated.push(`${section.label} (partial)`);
        }
      } else {
        // Medium/Low/Optional: drop entirely if over budget
        truncated.push(section.label);
      }
    }

    if (truncated.length > 0) {
      log.info("budget", `Token budget ${this.maxTokens} tokens — dropped/truncated: ${truncated.join(", ")}`);
    }

    return included.map((s) => s.content).join("\n\n");
  }

  /**
   * Get the current budget limit.
   */
  getMaxTokens(): number {
    return this.maxTokens;
  }

  /**
   * Get budget usage stats.
   */
  getStats(prompt: string): { tokens: number; maxTokens: number; usage: number } {
    const tokens = this.estimateTokens(prompt);
    return {
      tokens,
      maxTokens: this.maxTokens,
      usage: tokens / this.maxTokens,
    };
  }
}
