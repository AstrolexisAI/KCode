// KCode - Confidence Scoring for Multi-Agent Workflows
// Filters, deduplicates, and aggregates scored issues from parallel agents.

import { randomUUID } from "node:crypto";

// ─── Types ──────────────────────────────────────────────────────

export interface ScoredIssue {
  id: string;
  agentName: string;
  category: "bug" | "security" | "style" | "performance" | "logic";
  severity: "critical" | "high" | "medium" | "low";
  confidence: number; // 0-100
  file?: string;
  line?: number;
  description: string;
  suggestion?: string;
}

export interface ConfidenceConfig {
  /** Minimum confidence score to include (default 80) */
  threshold: number;
  /** Require 2+ agents to flag the same issue (default false) */
  requireMultipleAgents: boolean;
  /** Deduplicate issues that share the same file (default true) */
  deduplicateByFile: boolean;
}

const DEFAULT_CONFIG: ConfidenceConfig = {
  threshold: 80,
  requireMultipleAgents: false,
  deduplicateByFile: true,
};

// ─── Severity Weight ────────────────────────────────────────────

const SEVERITY_WEIGHT: Record<ScoredIssue["severity"], number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const VALID_CATEGORIES = new Set(["bug", "security", "style", "performance", "logic"]);
const VALID_SEVERITIES = new Set(["critical", "high", "medium", "low"]);

// ─── System Prompt Appendix ─────────────────────────────────────

/**
 * Appendix to inject into agent system prompts so they produce scored output.
 */
export const CONFIDENCE_SCORING_PROMPT = `When reporting issues, output each as a JSON block on its own line:
{"confidence": 0-100, "category": "bug|security|style|performance|logic", "severity": "critical|high|medium|low", "file": "path", "line": N, "description": "...", "suggestion": "..."}

Rules:
- confidence: 0-100 reflecting how certain you are this is a real issue
- category: exactly one of bug, security, style, performance, logic
- severity: exactly one of critical, high, medium, low
- file: the relative file path (omit if not file-specific)
- line: the line number (omit if not line-specific)
- description: concise explanation of the issue
- suggestion: how to fix it (omit if obvious)
- Output one JSON object per issue, each on its own line
- Do NOT wrap in markdown code fences — just raw JSON lines`;

// ─── Parser ─────────────────────────────────────────────────────

/**
 * Extract scored issues from raw agent text output.
 * Looks for JSON objects containing the required fields.
 */
export function parseAgentIssues(
  agentOutput: string,
  agentName: string = "unknown",
): ScoredIssue[] {
  const issues: ScoredIssue[] = [];

  // Match JSON objects in the output — handles both inline and fenced blocks
  const jsonPattern = /\{[^{}]*"confidence"\s*:\s*\d+[^{}]*\}/g;
  const matches = agentOutput.match(jsonPattern);
  if (!matches) return issues;

  for (const raw of matches) {
    try {
      const parsed = JSON.parse(raw);

      // Validate required fields
      if (typeof parsed.confidence !== "number" || parsed.confidence < 0 || parsed.confidence > 100)
        continue;
      if (!parsed.description || typeof parsed.description !== "string") continue;
      if (!VALID_CATEGORIES.has(parsed.category)) continue;
      if (!VALID_SEVERITIES.has(parsed.severity)) continue;

      issues.push({
        id: randomUUID().slice(0, 8),
        agentName,
        category: parsed.category,
        severity: parsed.severity,
        confidence: parsed.confidence,
        file: typeof parsed.file === "string" ? parsed.file : undefined,
        line: typeof parsed.line === "number" ? parsed.line : undefined,
        description: parsed.description,
        suggestion: typeof parsed.suggestion === "string" ? parsed.suggestion : undefined,
      });
    } catch {
      // Skip malformed JSON
    }
  }

  return issues;
}

// ─── Filtering ──────────────────────────────────────────────────

/**
 * Filter issues by confidence threshold.
 */
export function filterByConfidence(
  issues: ScoredIssue[],
  config?: Partial<ConfidenceConfig>,
): ScoredIssue[] {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  return issues.filter((issue) => issue.confidence >= cfg.threshold);
}

// ─── Deduplication ──────────────────────────────────────────────

/**
 * Deduplicate issues that describe the same problem.
 * Two issues are considered duplicates if they share the same file+line+category,
 * or if they share the same file+category and have similar descriptions.
 * When duplicates are found, the one with higher confidence wins,
 * and its confidence is boosted by 5 points per corroborating agent (capped at 100).
 */
export function deduplicateIssues(issues: ScoredIssue[]): ScoredIssue[] {
  if (issues.length <= 1) return issues;

  const deduped: ScoredIssue[] = [];
  const seen = new Map<string, ScoredIssue>();

  for (const issue of issues) {
    // Build a dedup key: file + line (if present) + category + normalized description start
    const descNorm = issue.description.toLowerCase().slice(0, 60).trim();
    const key = [issue.file ?? "_", issue.line ?? "_", issue.category, descNorm].join("::");

    const existing = seen.get(key);
    if (existing) {
      // Boost the winner's confidence for corroboration
      if (issue.confidence > existing.confidence) {
        // New issue is better — replace and boost
        const boosted = { ...issue, confidence: Math.min(100, issue.confidence + 5) };
        seen.set(key, boosted);
        // Replace in deduped array
        const idx = deduped.indexOf(existing);
        if (idx !== -1) deduped[idx] = boosted;
      } else {
        // Existing is better — just boost it
        existing.confidence = Math.min(100, existing.confidence + 5);
      }
    } else {
      seen.set(key, issue);
      deduped.push(issue);
    }
  }

  return deduped;
}

// ─── Aggregation ────────────────────────────────────────────────

/**
 * Aggregate results from multiple agents, applying filtering, deduplication,
 * and optional multi-agent corroboration requirements.
 *
 * @param results - Map of agentName -> issues found by that agent
 * @param config - Confidence configuration overrides
 * @returns Sorted list of unique, high-confidence issues
 */
export function aggregateAgentResults(
  results: Map<string, ScoredIssue[]>,
  config?: Partial<ConfidenceConfig>,
): ScoredIssue[] {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // Flatten all issues
  let allIssues: ScoredIssue[] = [];
  for (const [agentName, issues] of results) {
    for (const issue of issues) {
      allIssues.push({ ...issue, agentName });
    }
  }

  // Apply confidence threshold
  allIssues = filterByConfidence(allIssues, cfg);

  // Deduplicate
  if (cfg.deduplicateByFile) {
    allIssues = deduplicateIssues(allIssues);
  }

  // If requireMultipleAgents is set, only keep issues flagged by 2+ different agents
  if (cfg.requireMultipleAgents) {
    const agentCounts = new Map<string, Set<string>>();
    for (const issue of allIssues) {
      const descKey = [
        issue.file ?? "_",
        issue.category,
        issue.description.toLowerCase().slice(0, 60).trim(),
      ].join("::");
      if (!agentCounts.has(descKey)) {
        agentCounts.set(descKey, new Set());
      }
      agentCounts.get(descKey)!.add(issue.agentName);
    }

    allIssues = allIssues.filter((issue) => {
      const descKey = [
        issue.file ?? "_",
        issue.category,
        issue.description.toLowerCase().slice(0, 60).trim(),
      ].join("::");
      return (agentCounts.get(descKey)?.size ?? 0) >= 2;
    });
  }

  // Sort: severity descending, then confidence descending
  allIssues.sort((a, b) => {
    const sevDiff = SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity];
    if (sevDiff !== 0) return sevDiff;
    return b.confidence - a.confidence;
  });

  return allIssues;
}

// ─── Formatting ─────────────────────────────────────────────────

/**
 * Format aggregated issues into a human-readable report.
 */
export function formatIssueReport(issues: ScoredIssue[]): string {
  if (issues.length === 0) {
    return "  No issues found above confidence threshold.";
  }

  const lines: string[] = [`  Found ${issues.length} issue(s):\n`];

  const severityIcon: Record<string, string> = {
    critical: "[CRITICAL]",
    high: "[HIGH]",
    medium: "[MEDIUM]",
    low: "[LOW]",
  };

  for (const issue of issues) {
    const loc = issue.file
      ? issue.line
        ? `${issue.file}:${issue.line}`
        : issue.file
      : "(general)";
    const icon = severityIcon[issue.severity] ?? "[?]";
    lines.push(`  ${icon} ${issue.category} (${issue.confidence}%) — ${loc}`);
    lines.push(`    ${issue.description}`);
    if (issue.suggestion) {
      lines.push(`    Fix: ${issue.suggestion}`);
    }
    lines.push(`    Agent: ${issue.agentName}`);
    lines.push("");
  }

  return lines.join("\n");
}
