// KCode - Adaptive Effort Level Classifier
// Auto-detects the appropriate effort level based on question complexity.
// Maps effort levels to reasoning budget, tool filtering, and response depth.

import type { EffortLevel } from "./config";

// ─── Types ──────────────────────────────────────────────────────

export interface EffortProfile {
  level: EffortLevel;
  maxTurns: number;
  /** Reasoning budget multiplier (1.0 = default) */
  reasoningMultiplier: number;
  /** Whether to include all tools or filter to essentials */
  fullToolSet: boolean;
  /** System prompt verbosity hint */
  promptDepth: "minimal" | "standard" | "detailed" | "comprehensive";
}

export interface ClassificationResult {
  level: EffortLevel;
  confidence: number; // 0-1
  signals: string[];
}

// ─── Effort Profiles ───────────────────────────────────────────

export const EFFORT_PROFILES: Record<EffortLevel, EffortProfile> = {
  low: {
    level: "low",
    maxTurns: 5,
    reasoningMultiplier: 0.5,
    fullToolSet: false,
    promptDepth: "minimal",
  },
  medium: {
    level: "medium",
    maxTurns: 25,
    reasoningMultiplier: 1.0,
    fullToolSet: true,
    promptDepth: "standard",
  },
  high: {
    level: "high",
    maxTurns: 40,
    reasoningMultiplier: 1.5,
    fullToolSet: true,
    promptDepth: "detailed",
  },
  max: {
    level: "max",
    maxTurns: 60,
    reasoningMultiplier: 2.0,
    fullToolSet: true,
    promptDepth: "comprehensive",
  },
};

// ─── Classification Logic ──────────────────────────────────────

// Patterns that indicate complexity levels
const LOW_PATTERNS = [
  /^(?:what|who|when|where|which)\s+(?:is|are|was|were)\b/i,
  /^(?:how\s+(?:do|does|did)\s+(?:I|you|we))\b/i,
  /^(?:explain|describe|tell me about|what does)\b/i,
  /^(?:show|list|print|display)\b/i,
  /^(?:rename|move|copy|delete)\s+\w+/i,
  /\?$/, // Simple questions
];

const MEDIUM_PATTERNS = [
  /\b(?:fix|bug|error|issue|broken|failing|crash)\b/i,
  /\b(?:add|implement|create)\s+(?:a|an|the)?\s*(?:function|method|test|endpoint)\b/i,
  /\b(?:update|change|modify)\s+/i,
  /\b(?:write|add)\s+(?:a\s+)?test/i,
  /\b(?:debug|troubleshoot|investigate)\b/i,
];

const HIGH_PATTERNS = [
  /\b(?:refactor|restructure|reorganize|redesign)\b/i,
  /\b(?:multiple\s+files|across\s+(?:the\s+)?(?:codebase|project|repo))\b/i,
  /\b(?:migration|migrate)\b/i,
  /\b(?:performance|optimize|speed up)\b/i,
  /\b(?:security|vulnerability|audit)\b/i,
  /\b(?:end.to.end|integration|e2e)\b/i,
];

const MAX_PATTERNS = [
  /\b(?:architect|architecture|design\s+system)\b/i,
  /\b(?:from\s+scratch|ground\s+up|new\s+(?:project|app|system))\b/i,
  /\b(?:full\s+(?:rewrite|stack)|complete\s+(?:overhaul|redesign))\b/i,
  /\b(?:implement\s+(?:all|every|the\s+entire))\b/i,
];

/**
 * Classify the effort level needed for a user message.
 * Returns the detected level with confidence and signal explanations.
 */
export function classifyEffort(message: string): ClassificationResult {
  const signals: string[] = [];
  let score = 0; // -2 to +2 scale, mapped to effort levels

  // Length-based signals
  const wordCount = message.split(/\s+/).filter(Boolean).length;
  if (wordCount <= 10) {
    score -= 1;
    signals.push("short message");
  } else if (wordCount >= 50) {
    score += 1;
    signals.push("detailed request");
  } else if (wordCount >= 100) {
    score += 2;
    signals.push("very detailed request");
  }

  // Pattern matching (scored independently, patterns can stack)
  for (const pattern of MAX_PATTERNS) {
    if (pattern.test(message)) {
      score += 3;
      signals.push(`architecture/rewrite signal: ${pattern.source.slice(0, 30)}`);
      break;
    }
  }

  for (const pattern of HIGH_PATTERNS) {
    if (pattern.test(message)) {
      score += 2;
      signals.push(`complex task signal: ${pattern.source.slice(0, 30)}`);
      break;
    }
  }

  for (const pattern of MEDIUM_PATTERNS) {
    if (pattern.test(message)) {
      // Medium is the baseline, don't change score
      signals.push("standard task signal");
      break;
    }
  }

  for (const pattern of LOW_PATTERNS) {
    if (pattern.test(message)) {
      score -= 1;
      signals.push("simple query signal");
      break;
    }
  }

  // File count signals (mentions of files suggest multi-file work)
  const fileReferences = message.match(/\b[\w/.-]+\.\w{1,6}\b/g)?.length ?? 0;
  if (fileReferences >= 5) {
    score += 1;
    signals.push(`${fileReferences} file references`);
  }

  // Code block signals
  const codeBlocks = (message.match(/```/g)?.length ?? 0) / 2;
  if (codeBlocks >= 2) {
    score += 1;
    signals.push(`${codeBlocks} code blocks`);
  }

  // Map score to effort level
  const level: EffortLevel =
    score >= 2 ? "max" : score >= 1 ? "high" : score <= -2 ? "low" : "medium";

  // Confidence: higher when signals are clear
  const confidence = signals.length > 0 ? Math.min(1, 0.5 + signals.length * 0.15) : 0.3;

  return { level, confidence, signals };
}

/**
 * Get the effort profile for a given level.
 * If auto-detect is requested, classifies from the message.
 */
export function getEffortProfile(level: EffortLevel | "auto", message?: string): EffortProfile {
  if (level === "auto" && message) {
    const result = classifyEffort(message);
    return EFFORT_PROFILES[result.level];
  }
  return EFFORT_PROFILES[level === "auto" ? "medium" : level];
}
